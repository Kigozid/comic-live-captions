/**
 * Web-side adapters for geometry/OCR/pacing engines.
 *
 * These wrap deterministic package engines so the editor can call them without
 * owning page geometry. Every result is a proposal the UI can review and edit;
 * nothing here mutates project state.
 */

import type {
  OCRDocument,
  ImageSpace,
  Bounds,
} from '@comic-captioner/shared';
import {
  buildTimelineFromAlignedWords,
  timelineCuesFromDialogueEvents,
  type TimelineCaptionAssignment,
} from '../../../packages/caption-engine/src/timeline-mapping.js';
import type {
  DialogueEvent,
  CaptionLayout,
} from '@comic-captioner/core';
import {
  detectTextRegionsForInpaint,
  inpaintTextRegions,
  type InpaintBubbleInput,
  type InpaintTextObservationInput,
  type InpaintTextMask,
  type InpaintMode,
  type RasterImage,
} from '../../../packages/image-engine/src/inpaint.js';
import {
  buildReviewQueue as buildOcrReviewQueue,
  mergeOcrPasses,
  summarizeTriage,
  type OcrReviewItem,
  type OcrTriageSummary,
} from '../../../packages/image-engine/src/ocr-triage.js';
import {
  HeuristicProposalProvider,
  HybridBubbleDetector,
  type BubbleProposalProvider,
  type HybridBubble,
  type HybridBubbleDetectionResult,
} from '../../../packages/bubble-engine/src/hybrid-detection.js';
import {
  SyntheticYoloSession,
  YoloBubbleProposalProvider,
  createOnnxYoloSession,
  type YoloInferenceSession,
} from '../../../packages/bubble-engine/src/ml-bubble-detector.js';
import {
  detectPanels,
  deriveReadingOrder,
  type Panel,
  type ReadingDirection,
} from '../../../packages/bubble-engine/src/panel-order.js';
import {
  proposePagePacing,
  type PagePacingProposal,
  type PageDialogueSegmentRef,
  type PacedPageInput,
} from '../../../packages/caption-engine/src/page-pacing.js';
import {
  SyntheticCtcPosteriorsProvider,
  alignWordsAcoustic,
  type CtcFramePosteriorsProvider,
  type ForcedAlignAcousticResult,
} from '../../../packages/audio-engine/src/wav2vec2-alignment.js';
import type { Transcript, WordTimestamp } from '@comic-captioner/core';
import type {
  BubbleId,
  PageId,
  AudioTimebaseId,
} from '@comic-captioner/shared';

export interface AutoCleanResult {
  readonly cleaned: RasterImage;
  readonly masks: readonly InpaintTextMask[];
  readonly erasedPixelCount: number;
  readonly modes: readonly {
    readonly bubbleId: string;
    readonly mode: InpaintMode;
    readonly confidence: number;
  }[];
}

/**
 * Detect speech-bubble text on an original page and erase it, producing a
 * cleaned page. The original+cleaned workflow remains available as a pro
 * override when the auto result is not good enough.
 */
export function autoCleanPage(
  original: RasterImage,
  bubbles: readonly InpaintBubbleInput[],
  textObservations?: readonly InpaintTextObservationInput[],
): AutoCleanResult {
  const masks = detectTextRegionsForInpaint(
    original,
    bubbles,
    textObservations,
  );
  const cleaned = inpaintTextRegions(original, masks);
  let erasedPixelCount = 0;
  for (const mask of masks) {
    for (const pixel of mask.pixels) {
      if (pixel) erasedPixelCount += 1;
    }
  }
  return {
    cleaned,
    masks,
    erasedPixelCount,
    modes: masks.map((mask) => ({
      bubbleId: mask.bubbleId,
      mode: mask.suggestedMode,
      confidence: mask.confidence,
    })),
  };
}

/**
 * True when the project has an original page but no cleaned page yet, so
 * auto-inpaint should synthesize one. Hand-imported cleaned pages skip this.
 */
export function needsAutoClean(pagePair: {
  readonly original?: unknown;
  readonly cleaned?: unknown;
}): boolean {
  return Boolean(pagePair.original) && !pagePair.cleaned;
}

/**
 * Human-readable confidence label that reflects hybrid provenance instead of
 * always saying "heuristic".
 */
export function describeBubbleConfidence(input: {
  readonly confidence?: number;
  readonly detectionSources?: readonly string[];
}): string {
  if (input.confidence === undefined) return 'manual region';
  const percent = `${Math.round(input.confidence * 100)}%`;
  const sources = input.detectionSources ?? [];
  const hasMl = sources.includes('ml');
  const hasHeuristic = sources.includes('heuristic');
  const hasDetected = sources.includes('detected');
  if (hasMl && (hasHeuristic || hasDetected)) return `${percent} hybrid`;
  if (hasMl) return `${percent} ML`;
  if (hasHeuristic && hasDetected) return `${percent} hybrid`;
  if (hasHeuristic) return `${percent} heuristic`;
  return `${percent} detected`;
}

export type BubbleProposalSource =
  | { readonly kind: 'heuristic' }
  | { readonly kind: 'synthetic-ml' }
  | {
      readonly kind: 'yolo-session';
      readonly session: YoloInferenceSession;
    }
  | { readonly kind: 'yolo-onnx' };

export interface HybridDetectResult {
  readonly bubbles: readonly HybridBubble[];
  readonly result: HybridBubbleDetectionResult;
  readonly source: 'api' | 'local';
  readonly provider: string | null;
}

/**
 * API detect-bubbles returns flattened bubble fields + sources/support/quality.
 * Normalize to the nested `HybridBubble` shape (`bubble` + provenance).
 */
function normalizeApiHybridBubble(raw: unknown): HybridBubble {
  const record = (raw ?? {}) as Record<string, unknown>;
  if (record.bubble && typeof record.bubble === 'object') {
    return record as unknown as HybridBubble;
  }
  const polygon = record.polygon as HybridBubble['bubble']['polygon'];
  const contour =
    (record.contour as HybridBubble['bubble']['contour'] | undefined) ??
    polygon;
  const bubble = {
    id: String(record.id ?? ''),
    kind: (record.kind ?? 'unknown') as HybridBubble['bubble']['kind'],
    shape: (record.shape ?? 'unknown') as HybridBubble['bubble']['shape'],
    contour,
    polygon,
    confidence: Number(record.confidence ?? 0),
    ...(record.classificationConfidence !== undefined
      ? {
          classificationConfidence: Number(record.classificationConfidence),
        }
      : {}),
    tail: (record.tail ?? null) as HybridBubble['bubble']['tail'],
  };
  const quality = (record.quality ?? {
    areaRatio: 0,
    fillRatio: 0,
    interiorLuminance: 0,
    boundaryContrast: 0,
    edgeContactRatio: 0,
    score: 0,
  }) as HybridBubble['quality'];
  return {
    bubble: bubble as HybridBubble['bubble'],
    sources: ((record.sources as string[] | undefined) ?? [
      'detected',
    ]) as HybridBubble['sources'],
    support: (record.support ?? []) as HybridBubble['support'],
    quality,
  };
}

/**
 * Hybrid bubble detection: proposals boost recall (ML preferred, heuristic
 * fallback), deterministic geometry refines and scores every contour.
 *
 * Production path: `POST /api/detect-bubbles` with the API's ONNX YOLOv10.
 * Offline path: local HybridBubbleDetector with heuristic/synthetic/session.
 */
export async function detectBubblesHybrid(
  pageImage: Uint8Array,
  space: ImageSpace,
  options: {
    readonly proposalSource?: BubbleProposalSource;
  } = {},
): Promise<HybridDetectResult> {
  const source = options.proposalSource ?? { kind: 'heuristic' as const };

  // 1) Server-side YOLO ONNX (real weights) — same pattern as align-words.
  if (source.kind === 'yolo-onnx') {
    try {
      const base64 = bufferToBase64(pageImage);
      const response = await fetch('/api/detect-bubbles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageImage: base64,
          width: space.dimensions.width,
          height: space.dimensions.height,
          spaceId: space.id,
          requireYolo: true,
        }),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          bubbles: readonly unknown[];
          detection: {
            mode: string;
            provider: string | null;
            proposalCount?: number;
            deterministicCount?: number;
            mergedCount?: number;
            refinedCount?: number;
            rejectedCount?: number;
          };
        };
        const bubbles = payload.bubbles.map(normalizeApiHybridBubble);
        return {
          bubbles,
          result: {
            bubbles,
            coordinateSpace: space,
            deterministicCount:
              payload.detection.deterministicCount ?? bubbles.length,
            proposalCount: payload.detection.proposalCount ?? 0,
            mergedCount: payload.detection.mergedCount ?? 0,
            refinedCount: payload.detection.refinedCount ?? 0,
            rejectedCount: payload.detection.rejectedCount ?? 0,
            providerName: payload.detection.provider,
          },
          source: 'api',
          provider: payload.detection.provider,
        };
      }
    } catch {
      // Fall through to local detector.
    }
  }

  // 2) Local hybrid detector.
  const provider = createProposalProvider(source);
  const detector = new HybridBubbleDetector({
    ...(provider ? { provider } : {}),
  });
  const result = await detector.detect(pageImage, space);
  return {
    bubbles: result.bubbles,
    result,
    source: 'local',
    provider: result.providerName,
  };
}

function createProposalProvider(
  source: BubbleProposalSource,
): BubbleProposalProvider | null {
  switch (source.kind) {
    case 'heuristic':
      return new HeuristicProposalProvider();
    case 'synthetic-ml':
      return new YoloBubbleProposalProvider({
        session: new SyntheticYoloSession(),
      });
    case 'yolo-session':
      return new YoloBubbleProposalProvider({ session: source.session });
    case 'yolo-onnx':
      // API path failed; fall back to heuristic recall boost.
      return new HeuristicProposalProvider();
  }
}

/**
 * Load an ONNX YOLO bubble model as a proposal session. The host supplies the
 * loaded inference session (onnxruntime-web in the browser).
 */
export function loadYoloBubbleSession(options: {
  readonly modelPathOrUri: string;
  readonly session: Parameters<typeof createOnnxYoloSession>[0]['session'];
  readonly format?: 'yolov5' | 'yolov8';
  readonly inputWidth?: number;
  readonly inputHeight?: number;
  readonly numClasses?: number;
}): YoloInferenceSession {
  return createOnnxYoloSession({
    modelPathOrUri: options.modelPathOrUri,
    ...(options.session ? { session: options.session } : {}),
    ...(options.format ? { format: options.format } : {}),
    ...(options.inputWidth !== undefined
      ? { inputWidth: options.inputWidth }
      : {}),
    ...(options.inputHeight !== undefined
      ? { inputHeight: options.inputHeight }
      : {}),
    ...(options.numClasses !== undefined
      ? { numClasses: options.numClasses }
      : {}),
  });
}

export interface PanelOrderResult {
  readonly panels: readonly Panel[];
  readonly readingOrder: readonly string[];
}

/** Detect panels and derive bubble reading order with LTR/RTL support. */
export async function detectPanelsAndOrder(
  pageImage: Uint8Array,
  space: ImageSpace,
  bubbleBounds: readonly {
    readonly id: string;
    readonly boundingBox: Bounds<ImageSpace>;
  }[],
  direction: ReadingDirection = 'ltr',
): Promise<PanelOrderResult> {
  const detection = await detectPanels(pageImage, space);
  const readingOrder = deriveReadingOrder(
    bubbleBounds,
    detection.panels,
    direction,
  );
  return {
    panels: detection.panels,
    readingOrder,
  };
}

export interface OcrTriageResult {
  readonly merged: OCRDocument;
  readonly reviewItems: readonly OcrReviewItem[];
  readonly summary: OcrTriageSummary;
}

/**
 * Two-pass OCR triage: merge pass votes and queue only uncertain words/lines.
 * Manually edited words are preserved.
 */
export function triageOcrPasses(
  passA: OCRDocument,
  passB: OCRDocument,
  options: {
    readonly confidenceThreshold?: number;
    readonly maxItems?: number;
    readonly manualWordIds?: readonly string[];
  } = {},
): OcrTriageResult {
  const merged = mergeOcrPasses(passA, passB, {
    ...(options.manualWordIds ? { manualWordIds: options.manualWordIds } : {}),
  });
  const reviewItems = buildOcrReviewQueue(merged, {
    ...(options.confidenceThreshold !== undefined
      ? { confidenceThreshold: options.confidenceThreshold }
      : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
    otherPass: passB,
  });
  const summary = summarizeTriage(merged, reviewItems);
  return { merged, reviewItems, summary };
}

/** Single-pass triage when only one OCR document is available. */
export function triageOcrDocument(
  document: OCRDocument,
  options: {
    readonly confidenceThreshold?: number;
    readonly maxItems?: number;
  } = {},
): { readonly reviewItems: readonly OcrReviewItem[]; readonly summary: OcrTriageSummary } {
  const reviewItems = buildOcrReviewQueue(document, {
    ...(options.confidenceThreshold !== undefined
      ? { confidenceThreshold: options.confidenceThreshold }
      : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  });
  return { reviewItems, summary: summarizeTriage(document, reviewItems) };
}

export interface PagePacingAdapterInput {
  readonly pageIds: readonly string[];
  readonly cuesByPage: Readonly<
    Record<string, readonly { readonly id: string; readonly bubbleId: string; readonly start: number; readonly end: number }[]>
  >;
  readonly timebaseId: AudioTimebaseId;
  readonly audioDurationSeconds: number;
  readonly overrides?: readonly {
    readonly pageId: string;
    readonly start: number;
    readonly end: number;
  }[];
}

/**
 * Propose page boundaries from dialogue mapping. Each page covers the
 * segments mapped to its bubbles; explicit overrides win.
 */
export function proposePagePacingFromDialogues(
  input: PagePacingAdapterInput,
): readonly PagePacingProposal[] {
  const pages: PacedPageInput[] = input.pageIds.map((id) => ({
    id: id as PageId,
    segments: (input.cuesByPage[id] ?? []).map(
      (cue): PageDialogueSegmentRef => ({
        id: cue.id,
        bubbleId: cue.bubbleId as BubbleId,
        interval: {
          start: {
            value: cue.start,
            timebase: input.timebaseId,
            unit: 'seconds',
          },
          end: {
            value: cue.end,
            timebase: input.timebaseId,
            unit: 'seconds',
          },
        },
      }),
    ),
  }));
  return proposePagePacing({
    pages,
    timebase: {
      id: input.timebaseId,
      unit: 'seconds',
    },
    audioSpan: {
      start: { value: 0, timebase: input.timebaseId, unit: 'seconds' },
      end: {
        value: input.audioDurationSeconds,
        timebase: input.timebaseId,
        unit: 'seconds',
      },
    },
    ...(input.overrides
      ? {
          overrides: input.overrides.map((override) => ({
            pageId: override.pageId as PageId,
            start: {
              value: override.start,
              timebase: input.timebaseId,
              unit: 'seconds',
            },
            end: {
              value: override.end,
              timebase: input.timebaseId,
              unit: 'seconds',
            },
          })),
        }
      : {}),
  });
}

/** Decode an ImageBitmap/canvas source into the RasterImage the inpaint engine expects. */
export async function rasterFromImageSource(
  source: Blob | ImageBitmap | HTMLImageElement,
): Promise<RasterImage> {
  let bitmap: ImageBitmap;
  if (source instanceof ImageBitmap) {
    bitmap = source;
  } else if (source instanceof Blob) {
    bitmap = await createImageBitmap(source);
  } else {
    bitmap = await createImageBitmap(source);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close?.();
    throw new Error('Could not create a canvas for page rasterization.');
  }
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
  if (source instanceof Blob) bitmap.close?.();
  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
  };
}

/** Encode a cleaned raster as a PNG Blob for the cleaned-page slot. */
export async function rasterToPngBlob(raster: RasterImage): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas for PNG encoding.');
  const imageData = new ImageData(
    new Uint8ClampedArray(raster.data),
    raster.width,
    raster.height,
  );
  context.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode cleaned page as PNG.'));
    }, 'image/png');
  });
}

export interface AcousticAlignInput {
  readonly segments: readonly {
    readonly id?: string;
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly speakerId?: string | null;
  }[];
  /** Decoded mono PCM. Required for the local provider path. */
  readonly pcm?: Float32Array;
  readonly sampleRateHz: number;
  /** Compressed audio bytes; the API decodes these with FFmpeg. */
  readonly audioBytes?: Uint8Array;
  readonly timebaseId: AudioTimebaseId;
  /**
   * Optional custom wav2vec2/CTC backend. When omitted, this function calls
   * `POST /api/align-words` (server-side ONNX wav2vec2) and only falls back to
   * the synthetic provider if the API is unreachable.
   */
  readonly provider?: CtcFramePosteriorsProvider;
  /** Skip the API and use only the local provider (tests). */
  readonly offline?: boolean;
}

export interface AcousticAlignResult {
  readonly words: readonly WordTimestamp[];
  readonly confidence: number;
  readonly algorithm: string;
  readonly provider: string;
  readonly source: 'api' | 'local';
}

/**
 * WhisperX-style word timestamps: CTC Viterbi forced alignment of transcript
 * tokens to acoustic frames.
 *
 * Production path: `POST /api/align-words` with the API's ONNX wav2vec2.
 * Offline/test path: injected `provider` or synthetic CTC posteriors.
 */
export async function refineWordTimesAcoustic(
  input: AcousticAlignInput,
): Promise<AcousticAlignResult> {
  const segmentPayload = input.segments.map((segment) => ({
    ...(segment.id ? { id: segment.id } : {}),
    text: segment.text,
    start: segment.start,
    end: segment.end,
    ...(segment.speakerId !== undefined
      ? { speakerId: segment.speakerId }
      : {}),
  }));

  // 1) Server-side wav2vec2 (real ONNX weights).
  if (!input.provider && !input.offline) {
    try {
      const body: Record<string, unknown> = {
        sampleRateHz: input.sampleRateHz,
        timebaseId: input.timebaseId,
        segments: segmentPayload,
      };
      if (input.audioBytes && input.audioBytes.length > 0) {
        body.audio = bufferToBase64(input.audioBytes);
      } else if (input.pcm && input.pcm.length > 0) {
        const pcmBuffer = input.pcm.buffer.slice(
          input.pcm.byteOffset,
          input.pcm.byteOffset + input.pcm.byteLength,
        );
        body.pcm = bufferToBase64(new Uint8Array(pcmBuffer));
      } else {
        throw new Error('acoustic alignment needs pcm or audioBytes');
      }
      const response = await fetch('/api/align-words', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          words: WordTimestamp[];
          confidence: number;
          algorithm: string;
          provider: string;
        };
        return {
          words: payload.words,
          confidence: payload.confidence,
          algorithm: payload.algorithm,
          provider: payload.provider,
          source: 'api',
        };
      }
    } catch {
      // Fall through to local provider.
    }
  }

  // 2) Injected provider or synthetic fallback (needs decoded PCM).
  if (!input.pcm || input.pcm.length === 0) {
    throw new Error(
      'Local acoustic alignment requires decoded PCM; provide pcm or use the API path.',
    );
  }
  const provider = input.provider ?? new SyntheticCtcPosteriorsProvider();
  const result: ForcedAlignAcousticResult = await alignWordsAcoustic({
    segments: input.segments.map((segment) => ({
      ...(segment.id ? { id: segment.id } : {}),
      text: segment.text,
      interval: {
        start: {
          value: segment.start,
          timebase: input.timebaseId,
          unit: 'seconds',
        },
        end: {
          value: segment.end,
          timebase: input.timebaseId,
          unit: 'seconds',
        },
      },
      ...(segment.speakerId !== undefined
        ? { speakerId: segment.speakerId }
        : {}),
    })),
    timebase: { id: input.timebaseId, unit: 'seconds' },
    pcm: input.pcm,
    sampleRateHz: input.sampleRateHz,
    provider,
  });
  return {
    words: result.words,
    confidence: result.confidence,
    algorithm: result.algorithm,
    provider: result.provider,
    source: 'local',
  };
}

export interface TranscriptRefineResult {
  readonly transcript: Transcript;
  readonly alignment: AcousticAlignResult | null;
  readonly message?: string;
}

/**
 * Replace transcript segment word timings with CTC Viterbi acoustic alignment.
 * Segment text and ids stay user-editable; only `words` (and segment interval
 * bounds when refined) change. On API/provider failure the original transcript
 * is returned unchanged so the review path is never blocked.
 */
export async function refineTranscriptWordTimes(
  transcript: Transcript,
  options: {
    readonly audioBytes?: Uint8Array;
    readonly pcm?: Float32Array;
    readonly sampleRateHz?: number;
    readonly provider?: CtcFramePosteriorsProvider;
    readonly offline?: boolean;
  } = {},
): Promise<TranscriptRefineResult> {
  const segments = transcript.segments.filter(
    (segment) => segment.text.trim().length > 0,
  );
  if (segments.length === 0) {
    return {
      transcript,
      alignment: null,
      message: 'No transcript segments to align.',
    };
  }
  try {
    const alignment = await refineWordTimesAcoustic({
      segments: segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        start: segment.interval.start.value,
        end: segment.interval.end.value,
        speakerId: segment.speakerId,
      })),
      timebaseId: transcript.timebase.id as AudioTimebaseId,
      sampleRateHz: options.sampleRateHz ?? 16_000,
      ...(options.audioBytes ? { audioBytes: options.audioBytes } : {}),
      ...(options.pcm ? { pcm: options.pcm } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.offline !== undefined ? { offline: options.offline } : {}),
    });

    const bySegment = new Map<string, WordTimestamp[]>();
    for (const word of alignment.words) {
      const match = /^acoustic:(.+):word-\d+$/u.exec(word.id);
      const segmentId = match?.[1];
      if (!segmentId) continue;
      const list = bySegment.get(segmentId);
      if (list) list.push(word);
      else bySegment.set(segmentId, [word]);
    }

    const refinedSegments = transcript.segments.map((segment) => {
      const refinedWords = bySegment.get(segment.id);
      if (!refinedWords || refinedWords.length === 0) return segment;
      const first = refinedWords[0]!;
      const last = refinedWords[refinedWords.length - 1]!;
      return Object.freeze({
        ...segment,
        interval: Object.freeze({
          start: first.start,
          end: last.end,
        }),
        words: Object.freeze(refinedWords),
      });
    });

    return {
      transcript: Object.freeze({
        ...transcript,
        segments: Object.freeze(refinedSegments),
        revision: transcript.revision + 1,
      }),
      alignment,
    };
  } catch (cause) {
    return {
      transcript,
      alignment: null,
      message:
        cause instanceof Error
          ? cause.message
          : 'Acoustic word alignment failed.',
    };
  }
}

function bufferToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(
        ...bytes.subarray(offset, offset + chunkSize),
      );
    }
    return btoa(binary);
  }
  // Node / vitest
  return Buffer.from(bytes).toString('base64');
}

export interface TimelineFromAlignedTranscriptResult {
  readonly events: readonly DialogueEvent[];
  readonly cues: readonly {
    readonly id: string;
    readonly bubbleId: string;
    readonly start: number;
    readonly end: number;
    readonly confidence: number;
  }[];
}

/**
 * Wire acoustically aligned / transcript words onto the caption timeline.
 *
 * This is a pure mapping stage after ASR + optional `/api/align-words`
 * refinement. It never re-transcribes audio. Assignments bind caption units
 * to bubbles + layouts; unassigned units stay off the timeline for review.
 */
export function timelineFromAlignedTranscript(
  transcript: {
    readonly segments: readonly {
      readonly id: string;
      readonly words: readonly WordTimestamp[];
    }[];
  },
  assignment:
    | {
        readonly bubbleId: BubbleId;
        readonly layout: CaptionLayout;
        readonly confidence?: number;
      }
    | readonly TimelineCaptionAssignment[],
): TimelineFromAlignedTranscriptResult {
  const words = transcript.segments.flatMap((segment) => segment.words);
  const { events } = buildTimelineFromAlignedWords(words, assignment);
  return {
    events,
    cues: timelineCuesFromDialogueEvents(events),
  };
}
