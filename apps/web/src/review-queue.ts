import type { DialogueMapping, TextObservation } from '@comic-captioner/core';
import type { BubbleId } from '@comic-captioner/shared';

export type ReviewItemKind =
  | 'ocr-word'
  | 'ocr-line'
  | 'bubble'
  | 'mapping'
  | 'transcript'
  | 'caption-fit';

export type ReviewPriority = 'critical' | 'high' | 'normal';

export interface ReviewQueueItem {
  readonly id: string;
  readonly kind: ReviewItemKind;
  readonly confidence: number;
  readonly priority: ReviewPriority;
  /** Lower sort key reviews first. */
  readonly sortKey: number;
  readonly label: string;
  readonly detail: string;
  readonly bubbleId?: BubbleId | string | null;
  readonly targetId: string;
  readonly suggestedFix?: string;
  readonly reason: string;
}

export interface ReviewQueueOptions {
  readonly confidenceThreshold?: number;
  readonly maxItems?: number;
  readonly includeAccepted?: boolean;
}

export interface ReviewQueueSummary {
  readonly totalCandidates: number;
  readonly queued: number;
  readonly critical: number;
  readonly high: number;
  readonly normal: number;
  readonly averageQueuedConfidence: number;
  readonly byKind: Readonly<Record<ReviewItemKind, number>>;
}

export interface ReviewQueue {
  readonly items: readonly ReviewQueueItem[];
  readonly summary: ReviewQueueSummary;
}

export class ReviewQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewQueueError';
  }
}

const DEFAULTS: Required<ReviewQueueOptions> = {
  confidenceThreshold: 0.85,
  maxItems: 50,
  includeAccepted: false,
};

const EMPTY_BY_KIND: Record<ReviewItemKind, number> = {
  'ocr-word': 0,
  'ocr-line': 0,
  bubble: 0,
  mapping: 0,
  transcript: 0,
  'caption-fit': 0,
};

export interface ReviewCandidateInput {
  readonly id: string;
  readonly kind: ReviewItemKind;
  readonly confidence: number;
  readonly label: string;
  readonly detail?: string;
  readonly bubbleId?: BubbleId | string | null;
  readonly targetId?: string;
  readonly suggestedFix?: string;
  readonly reason?: string;
  readonly reviewStatus?: string;
}

/**
 * Builds a confidence-sorted review queue from multi-stage pipeline output.
 * High-confidence items are omitted so the user reviews uncertainty, not the
 * whole page.
 */
export function buildReviewQueue(
  candidates: readonly ReviewCandidateInput[],
  options: ReviewQueueOptions = {},
): ReviewQueue {
  const config = validateOptions(options);
  const items: ReviewQueueItem[] = [];

  for (const candidate of candidates) {
    if (!candidate.id.trim()) {
      throw new ReviewQueueError('Review candidates require a non-empty id.');
    }
    if (
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      throw new ReviewQueueError(
        'Review candidate confidence must be in [0, 1].',
      );
    }
    if (
      !config.includeAccepted &&
      (candidate.reviewStatus === 'accepted' ||
        candidate.reviewStatus === 'rejected')
    ) {
      continue;
    }
    if (candidate.confidence >= config.confidenceThreshold) continue;

    const priority = priorityFor(candidate.confidence);
    items.push(
      Object.freeze({
        id: candidate.id,
        kind: candidate.kind,
        confidence: candidate.confidence,
        priority,
        sortKey: candidate.confidence,
        label: candidate.label,
        detail: candidate.detail ?? '',
        bubbleId: candidate.bubbleId ?? null,
        targetId: candidate.targetId ?? candidate.id,
        ...(candidate.suggestedFix
          ? { suggestedFix: candidate.suggestedFix }
          : {}),
        reason:
          candidate.reason ??
          `Confidence ${Math.round(candidate.confidence * 100)}% is below the review threshold.`,
      }),
    );
  }

  items.sort(
    (a, b) =>
      a.sortKey - b.sortKey ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.id.localeCompare(b.id),
  );

  const limited = config.maxItems > 0 ? items.slice(0, config.maxItems) : items;
  return Object.freeze({
    items: Object.freeze(limited),
    summary: summarize(candidates.length, limited),
  });
}

/** Collect low-confidence OCR words/lines for the review queue. */
export function candidatesFromObservations(
  observations: readonly TextObservation[],
): ReviewCandidateInput[] {
  const out: ReviewCandidateInput[] = [];
  for (const observation of observations) {
    if (!observation.text.trim()) continue;
    out.push({
      id: observation.id,
      kind: 'ocr-line',
      confidence: observation.confidence,
      label: observation.text.slice(0, 48) || '(empty text)',
      detail: observation.rawText && observation.rawText !== observation.text
        ? `OCR: “${observation.rawText}”`
        : observation.text,
      bubbleId: observation.associatedBubbleId ?? null,
      targetId: observation.id,
      ...(observation.reviewStatus
        ? { reviewStatus: observation.reviewStatus }
        : {}),
      reason: observation.manuallyEdited
        ? 'Manually edited — verify against source.'
        : `OCR confidence ${Math.round(observation.confidence * 100)}%.`,
    });
  }
  return out;
}

/** Collect low-confidence dialogue mappings for the review queue. */
export function candidatesFromMappings(
  mappings: readonly DialogueMapping[],
): ReviewCandidateInput[] {
  return mappings
    .filter((mapping) => mapping.needsReview || mapping.status === 'pending-review')
    .map((mapping) => {
      const top = mapping.alternatives[0];
      return {
        id: mapping.id,
        kind: 'mapping' as const,
        confidence: mapping.confidence,
        label: mapping.bubbleId
          ? `Map → ${mapping.bubbleId}`
          : 'Unmapped transcript turn',
        detail: mapping.reasons[0]?.evidence ?? mapping.reviewFlag,
        bubbleId: mapping.bubbleId,
        targetId: mapping.transcriptSegmentId,
        reviewStatus: mapping.status,
        ...(top && top.bubbleId !== mapping.bubbleId
          ? { suggestedFix: `Try ${top.bubbleId} (${Math.round(top.confidence * 100)}%)` }
          : {}),
        reason:
          mapping.reviewFlag === 'ambiguous'
            ? 'Multiple bubbles are plausible; content scores are close.'
            : mapping.reviewFlag === 'low-confidence'
              ? 'No bubble has sufficient content match against the transcript.'
              : 'Mapping awaits review.',
      };
    });
}

/** Collect bubble candidates with low classification confidence. */
export function candidatesFromBubbles(
  bubbles: readonly {
    readonly id: string;
    readonly kind: string;
    readonly confidence?: number;
    readonly classificationConfidence?: number;
    readonly reviewStatus?: string;
  }[],
): ReviewCandidateInput[] {
  return bubbles.map((bubble) => {
    const confidence = Math.min(
      bubble.confidence ?? 1,
      bubble.classificationConfidence ?? 1,
    );
    return {
      id: `bubble:${bubble.id}`,
      kind: 'bubble' as const,
      confidence,
      label: `Bubble ${bubble.id}`,
      detail: `Detected as ${bubble.kind}`,
      bubbleId: bubble.id,
      targetId: bubble.id,
      ...(bubble.reviewStatus ? { reviewStatus: bubble.reviewStatus } : {}),
      reason:
        confidence < 0.7
          ? 'Bubble geometry or classification is uncertain.'
          : 'Bubble awaits review.',
    };
  });
}

function priorityFor(confidence: number): ReviewPriority {
  if (confidence < 0.35) return 'critical';
  if (confidence < 0.7) return 'high';
  return 'normal';
}

function priorityRank(priority: ReviewPriority): number {
  return priority === 'critical' ? 0 : priority === 'high' ? 1 : 2;
}

function summarize(
  totalCandidates: number,
  items: readonly ReviewQueueItem[],
): ReviewQueueSummary {
  const byKind = { ...EMPTY_BY_KIND };
  let critical = 0;
  let high = 0;
  let normal = 0;
  let confidenceSum = 0;
  for (const item of items) {
    byKind[item.kind] += 1;
    confidenceSum += item.confidence;
    if (item.priority === 'critical') critical += 1;
    else if (item.priority === 'high') high += 1;
    else normal += 1;
  }
  return Object.freeze({
    totalCandidates,
    queued: items.length,
    critical,
    high,
    normal,
    averageQueuedConfidence:
      items.length === 0 ? 1 : confidenceSum / items.length,
    byKind: Object.freeze(byKind),
  });
}

function validateOptions(
  options: ReviewQueueOptions,
): Required<ReviewQueueOptions> {
  const config = { ...DEFAULTS, ...options };
  if (
    !Number.isFinite(config.confidenceThreshold) ||
    config.confidenceThreshold < 0 ||
    config.confidenceThreshold > 1
  ) {
    throw new ReviewQueueError(
      'confidenceThreshold must be a number in [0, 1].',
    );
  }
  if (!Number.isInteger(config.maxItems) || config.maxItems < 0) {
    throw new ReviewQueueError('maxItems must be a non-negative integer.');
  }
  return config;
}
