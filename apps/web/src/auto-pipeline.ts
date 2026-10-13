/**
 * Auto-everything pipeline orchestrator.
 *
 * Runs import → detect → OCR → transcribe → map → fit → timeline as a single
 * pass and returns a confidence-sorted review queue so the user only looks at
 * uncertain items.
 *
 * Stage implementations are injected so the web app can call the API / local
 * engines while tests use deterministic fakes. This module never mutates
 * project state; it produces proposals and a review queue only.
 */

import type {
  BubbleDialogueReference,
  DialogueMapping,
  Transcript,
  TranscriptSegment,
} from '@comic-captioner/core';
import type { BubbleId, ImageSpace } from '@comic-captioner/shared';
import { DialogueMappingEngine } from '@comic-captioner/ai';
import {
  buildReviewQueue,
  candidatesFromBubbles,
  candidatesFromMappings,
  candidatesFromObservations,
  type ReviewQueue,
  type ReviewCandidateInput,
} from './review-queue.js';

export type AutoStageName =
  | 'import'
  | 'detect'
  | 'ocr'
  | 'transcribe'
  | 'map'
  | 'fit'
  | 'timeline';

export type AutoStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AutoStageResult {
  readonly name: AutoStageName;
  readonly status: AutoStageStatus;
  readonly confidence: number;
  readonly message?: string;
  readonly durationMs?: number;
}

export interface AutoBubbleProposal {
  readonly id: string;
  readonly kind: 'speech' | 'thought' | 'narration' | 'unknown';
  readonly confidence: number;
  readonly classificationConfidence?: number;
  readonly reviewStatus?: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface AutoOcrLine {
  readonly id: string;
  readonly text: string;
  readonly confidence: number;
  readonly reviewStatus?: string;
  readonly bubbleId?: BubbleId | string | null;
  readonly manuallyEdited?: boolean;
}

export interface AutoCaptionFit {
  readonly bubbleId: string;
  readonly text: string;
  readonly fitConfidence: number;
  readonly overflow: boolean;
  readonly warnings: readonly string[];
}

export interface AutoTimelineCue {
  readonly id: string;
  readonly bubbleId: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
}

export interface AutoPipelineInput {
  readonly hasOriginalPage: boolean;
  readonly hasCleanedPage?: boolean;
  readonly hasAudio: boolean;
  readonly imageSpace: ImageSpace;
  readonly bubbles: readonly AutoBubbleProposal[];
  readonly ocrLines: readonly AutoOcrLine[];
  readonly transcript: Transcript | null;
  readonly readingOrder?: readonly (BubbleId | string)[];
  readonly captionFits?: readonly AutoCaptionFit[];
  readonly timelineCues?: readonly AutoTimelineCue[];
}

export interface AutoPipelineResult {
  readonly stages: readonly AutoStageResult[];
  readonly mappings: readonly DialogueMapping[];
  readonly reviewQueue: ReviewQueue;
  readonly readyForExport: boolean;
  readonly overallConfidence: number;
  readonly messages: readonly string[];
}

export interface AutoPipelineOptions {
  readonly confidenceThreshold?: number;
  readonly maxReviewItems?: number;
  readonly readingDirection?: 'ltr' | 'rtl';
}

/**
 * Runs the deterministic portions of the auto pipeline (mapping + review
 * queue). Image/OCR/transcription stages must already be provided as results;
 * this function validates completeness and scores stage confidence.
 */
export function runAutoPipeline(
  input: AutoPipelineInput,
  options: AutoPipelineOptions = {},
): AutoPipelineResult {
  const messages: string[] = [];
  const stages: AutoStageResult[] = [];

  // import
  stages.push(
    scoreStage(
      'import',
      input.hasOriginalPage && input.hasAudio,
      input.hasOriginalPage
        ? input.hasAudio
          ? 'Page and audio assets are ready.'
          : 'Import an audio track to continue.'
        : 'Import an original comic page to continue.',
    ),
  );

  // detect
  const detectOk = input.bubbles.length > 0;
  stages.push(
    scoreStage(
      'detect',
      detectOk,
      detectOk
        ? `Detected ${input.bubbles.length} bubble candidate(s).`
        : 'No bubbles detected. Run bubble detection or add bubbles manually.',
      input.bubbles.length === 0
        ? 0
        : average(input.bubbles.map((b) => b.confidence)),
    ),
  );

  // ocr
  const ocrOk = input.ocrLines.some((line) => line.text.trim());
  stages.push(
    scoreStage(
      'ocr',
      ocrOk,
      ocrOk
        ? `Recognized ${input.ocrLines.filter((l) => l.text.trim()).length} text line(s).`
        : 'No OCR text yet. Run Detect bubbles + OCR.',
      ocrOk
        ? average(input.ocrLines.map((l) => l.confidence))
        : 0,
    ),
  );

  // transcribe
  const transcriptOk = Boolean(input.transcript?.segments.length);
  stages.push(
    scoreStage(
      'transcribe',
      transcriptOk,
      transcriptOk
        ? `Transcript has ${input.transcript!.segments.length} segment(s).`
        : 'No transcript yet. Transcribe the imported audio.',
      transcriptOk ? (input.transcript!.confidence ?? 0.8) : 0,
    ),
  );

  // map
  let mappings: readonly DialogueMapping[] = [];
  if (ocrOk && transcriptOk) {
    try {
      mappings = mapDialogue(input);
      stages.push(
        scoreStage(
          'map',
          true,
          `Proposed ${mappings.length} dialogue-to-bubble mapping(s).`,
          average(mappings.map((m) => m.confidence)),
        ),
      );
    } catch (cause) {
      messages.push(
        cause instanceof Error ? cause.message : 'Dialogue mapping failed.',
      );
      stages.push(
        scoreStage(
          'map',
          false,
          'Dialogue mapping failed. Review OCR text and transcript.',
          0,
        ),
      );
    }
  } else {
    stages.push(
      scoreStage(
        'map',
        false,
        'Mapping needs both OCR text and a transcript.',
        0,
      ),
    );
  }

  // fit
  const fits = input.captionFits ?? [];
  const fitOk = fits.length > 0 && fits.every((fit) => !fit.overflow);
  stages.push(
    scoreStage(
      'fit',
      fitOk,
      fits.length === 0
        ? 'No caption fits yet. Map dialogue first.'
        : fitOk
          ? `Fitted ${fits.length} caption(s) inside bubble safe regions.`
          : `${fits.filter((f) => f.overflow).length} caption(s) overflow their bubble.`,
      fits.length === 0 ? 0 : average(fits.map((f) => f.fitConfidence)),
    ),
  );

  // timeline
  const cues = input.timelineCues ?? [];
  const timelineOk = cues.length > 0 && input.hasAudio;
  stages.push(
    scoreStage(
      'timeline',
      timelineOk,
      cues.length === 0
        ? 'No timeline cues yet. Map and fit captions to build timing.'
        : `Timeline has ${cues.length} cue(s) in the audio timebase.`,
      cues.length === 0 ? 0 : average(cues.map((c) => c.confidence)),
    ),
  );

  const reviewQueue = buildReviewQueue(collectCandidates(input, mappings), {
    ...(options.confidenceThreshold !== undefined
      ? { confidenceThreshold: options.confidenceThreshold }
      : {}),
    ...(options.maxReviewItems !== undefined
      ? { maxItems: options.maxReviewItems }
      : {}),
  });

  const readyForExport =
    stages.every(
      (stage) =>
        stage.status === 'succeeded' ||
        stage.name === 'import' ||
        stage.name === 'detect',
    ) && cues.length > 0;

  const overallConfidence = average(
    stages.map((stage) => stage.confidence),
  );

  return Object.freeze({
    stages: Object.freeze(stages),
    mappings,
    reviewQueue,
    readyForExport,
    overallConfidence,
    messages: Object.freeze(messages),
  });
}

function mapDialogue(input: AutoPipelineInput): readonly DialogueMapping[] {
  const references = buildReferences(input);
  if (!references.length) return [];
  const readingOrder =
    input.readingOrder && input.readingOrder.length === references.length
      ? (input.readingOrder as BubbleId[])
      : (references.map((ref) => ref.bubbleId) as BubbleId[]);
  return new DialogueMappingEngine().map({
    bubbleReferences: references,
    readingOrder,
    transcriptSegments: input.transcript!.segments,
  }).mappings;
}

function buildReferences(
  input: AutoPipelineInput,
): BubbleDialogueReference[] {
  const bubbleById = new Map(input.bubbles.map((b) => [b.id, b]));
  const refs: BubbleDialogueReference[] = [];
  for (const line of input.ocrLines) {
    if (!line.text.trim()) continue;
    const bubbleId = (line.bubbleId ?? line.id.replace(/^ocr:/, '')) as BubbleId;
    const bubble = bubbleById.get(String(bubbleId));
    if (!bubble || bubble.points.length < 3) continue;
    const xs = bubble.points.map((p) => p.x);
    const ys = bubble.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    refs.push({
      id: `ref:${line.id}`,
      bubbleId,
      textRegionIds: [line.id],
      originalText: line.text,
      originalTextBounds: {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
        coordinateSpace: input.imageSpace,
      },
      lineCount: line.text.split(/\n/).length,
      alignment: 'unknown',
      confidence: line.confidence,
      status: line.reviewStatus === 'accepted' ? 'accepted' : 'pending-review',
      method: 'spatial',
      revision: 1,
    });
  }
  // One reference per bubble: prefer the highest-confidence OCR line.
  const byBubble = new Map<string, BubbleDialogueReference>();
  for (const ref of refs) {
    const key = String(ref.bubbleId);
    const previous = byBubble.get(key);
    if (!previous || ref.confidence > previous.confidence) {
      byBubble.set(key, ref);
    }
  }
  return [...byBubble.values()];
}

function collectCandidates(
  input: AutoPipelineInput,
  mappings: readonly DialogueMapping[],
): ReviewCandidateInput[] {
  return [
    ...candidatesFromBubbles(input.bubbles),
    ...candidatesFromObservations(
      input.ocrLines.map((line) => ({
        id: line.id,
        text: line.text,
        rawText: line.text,
        polygon: {
          points: [],
          coordinateSpace: input.imageSpace,
        },
        confidence: line.confidence,
        coordinateSpace: input.imageSpace,
        ...(line.reviewStatus ? { reviewStatus: line.reviewStatus as 'pending-review' | 'accepted' | 'rejected' } : {}),
        ...(line.manuallyEdited ? { manuallyEdited: true } : {}),
        ...(line.bubbleId ? { associatedBubbleId: line.bubbleId as BubbleId } : {}),
      })),
    ),
    ...candidatesFromMappings(mappings),
  ];
}

function scoreStage(
  name: AutoStageName,
  ok: boolean,
  message: string,
  confidence?: number,
): AutoStageResult {
  return Object.freeze({
    name,
    status: ok ? 'succeeded' : 'failed',
    confidence: ok ? (confidence ?? 1) : 0,
    message,
  });
}

function average(values: readonly number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
