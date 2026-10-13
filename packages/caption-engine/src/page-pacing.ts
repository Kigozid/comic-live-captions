import type {
  AudioTime,
  AudioTimebase,
  AudioTimebaseId,
  BubbleId,
  PageId,
  TimeInterval,
} from '@comic-captioner/shared';

export class PagePacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PagePacingError';
  }
}

export type PagePacingSignal =
  | 'mapped-dialogue'
  | 'even-split-fallback'
  | 'gap-distribution'
  | 'overlap-midpoint'
  | 'explicit-override';

export interface PagePacingReason {
  readonly signal: PagePacingSignal;
  /** Normalized signal score in [0, 1]. */
  readonly score: number;
  readonly evidence: string;
}

/** A dialogue segment already mapped to a bubble on a page. */
export interface PageDialogueSegmentRef {
  readonly id: string;
  readonly bubbleId: BubbleId;
  readonly interval: TimeInterval;
}

export interface PacedPageInput {
  readonly id: PageId;
  /** Segments mapped to this page's bubbles, in any order. */
  readonly segments: readonly PageDialogueSegmentRef[];
}

/** A user-chosen interval that wins over the computed proposal for a page. */
export interface PagePacingOverride {
  readonly pageId: PageId;
  readonly start: AudioTime;
  readonly end: AudioTime;
}

export interface PagePacingInput {
  /** Pages in reading order. */
  readonly pages: readonly PacedPageInput[];
  readonly timebase: AudioTimebase;
  /** Full audio span the page sequence covers. */
  readonly audioSpan: TimeInterval;
  readonly overrides?: readonly PagePacingOverride[];
}

/**
 * Automatic page-boundary proposal. Proposals are reviewable suggestions in
 * the audio timebase; they never mutate project state. Overridden pages keep
 * their override interval exactly.
 */
export interface PagePacingProposal {
  readonly id: string;
  readonly pageId: PageId;
  readonly start: AudioTime;
  readonly end: AudioTime;
  readonly confidence: number;
  readonly reasons: readonly PagePacingReason[];
  readonly source: 'dialogue' | 'fallback' | 'override';
  readonly status: 'pending-review';
}

interface Anchor {
  readonly start: number;
  readonly end: number;
  readonly dialogue: boolean;
  readonly overridden: boolean;
  readonly duration: number;
}

/**
 * Propose page intervals covering the audio span so each page covers the
 * dialogue mapped to its bubbles:
 *
 * - A page with mapped dialogue anchors at its earliest segment start and
 *   latest segment end.
 * - Consecutive anchors that overlap clamp to the midpoint of the overlap.
 * - Unmapped gaps between two dialogue-anchored pages distribute
 *   proportionally to the pages' dialogue durations.
 * - Runs of pages without mapped dialogue split the remaining unmapped span
 *   evenly (even-split fallback). When no page has dialogue, the whole span
 *   splits evenly.
 * - Leading and trailing unmapped audio is absorbed by the edge pages.
 * - Explicit overrides win over every computed value; neighbours clamp flush
 *   to the override interval.
 */
export function proposePagePacing(
  input: PagePacingInput,
): readonly PagePacingProposal[] {
  const { timebase, audioSpan } = input;
  validateTimebase(timebase);
  const span = validateInterval(audioSpan, timebase, 'Audio span');
  const pageIds = new Set<string>();
  for (const page of input.pages) {
    if (typeof page.id !== 'string' || page.id.trim().length === 0)
      throw new PagePacingError('Page IDs must be non-empty.');
    if (pageIds.has(page.id))
      throw new PagePacingError('Page IDs must be unique.');
    pageIds.add(page.id);
  }
  const overrides = validateOverrides(input.overrides ?? [], pageIds, timebase);
  const anchors = input.pages.map((page) =>
    anchorForPage(page, span, timebase, overrides.get(page.id) ?? null),
  );
  if (anchors.length === 0) return Object.freeze([]);
  fillEmptyRuns(anchors, span);

  const boundaries: number[] = [anchors[0]!.start];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    boundaries.push(boundaryBetween(anchors[index]!, anchors[index + 1]!));
  }
  boundaries.push(anchors[anchors.length - 1]!.end);

  // Edge pages absorb leading/trailing unmapped audio unless overridden.
  if (!anchors[0]!.overridden) boundaries[0] = span.start;
  if (!anchors[anchors.length - 1]!.overridden)
    boundaries[boundaries.length - 1] = span.end;

  return Object.freeze(
    input.pages.map((page, index) => {
      const anchor = anchors[index]!;
      const start = boundaries[index]!;
      const end = boundaries[index + 1]!;
      return buildProposal(
        page.id,
        index,
        anchor,
        start,
        end,
        timebase,
        boundaries,
        anchors,
      );
    }),
  );
}

function anchorForPage(
  page: PacedPageInput,
  span: { start: number; end: number },
  timebase: AudioTimebase,
  override: { start: number; end: number } | null,
): Anchor {
  if (override) {
    return Object.freeze({
      start: override.start,
      end: override.end,
      dialogue: page.segments.length > 0,
      overridden: true,
      duration: override.end - override.start,
    });
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const segment of page.segments) {
    if (typeof segment.id !== 'string' || segment.id.trim().length === 0)
      throw new PagePacingError('Dialogue segment IDs must be non-empty.');
    if (typeof segment.bubbleId !== 'string' || segment.bubbleId.length === 0)
      throw new PagePacingError('Dialogue segments must name their bubble.');
    const interval = validateInterval(segment.interval, timebase, 'Segment');
    if (
      interval.start < span.start - 1e-9 ||
      interval.end > span.end + 1e-9
    )
      throw new PagePacingError(
        'Mapped dialogue segments must fall inside the audio span.',
      );
    start = Math.min(start, interval.start);
    end = Math.max(end, interval.end);
  }
  if (page.segments.length === 0) {
    return Object.freeze({
      start: Number.NaN,
      end: Number.NaN,
      dialogue: false,
      overridden: false,
      duration: 0,
    });
  }
  return Object.freeze({
    start,
    end,
    dialogue: true,
    overridden: false,
    duration: end - start,
  });
}

function fillEmptyRuns(
  anchors: Anchor[],
  span: { start: number; end: number },
): void {
  let index = 0;
  while (index < anchors.length) {
    if (anchors[index]!.overridden || anchors[index]!.dialogue) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (
      index < anchors.length &&
      !anchors[index]!.overridden &&
      !anchors[index]!.dialogue
    )
      index += 1;
    const runEnd = index; // exclusive
    const leftBoundary =
      runStart > 0 ? anchors[runStart - 1]!.end : span.start;
    const rightBoundary =
      runEnd < anchors.length ? anchors[runEnd]!.start : span.end;
    const available = Math.max(0, rightBoundary - leftBoundary);
    const share = available / (runEnd - runStart);
    for (let cursor = runStart; cursor < runEnd; cursor += 1) {
      const start = leftBoundary + share * (cursor - runStart);
      const end =
        cursor === runEnd - 1 ? leftBoundary + available : start + share;
      anchors[cursor] = Object.freeze({
        start,
        end,
        dialogue: false,
        overridden: false,
        duration: end - start,
      });
    }
  }
}

function boundaryBetween(left: Anchor, right: Anchor): number {
  if (left.overridden) return left.end;
  if (right.overridden) return right.start;
  if (left.end > right.start) {
    // Overlapping mapped dialogue clamps to the midpoint of the overlap.
    return (left.end + right.start) / 2;
  }
  if (left.end < right.start) {
    const gap = right.start - left.end;
    if (left.dialogue && right.dialogue) {
      const total = left.duration + right.duration;
      if (total > 0) return left.end + (gap * left.duration) / total;
    }
    return left.end + gap / 2;
  }
  return left.end;
}

function buildProposal(
  pageId: PageId,
  index: number,
  anchor: Anchor,
  start: number,
  end: number,
  timebase: AudioTimebase,
  boundaries: readonly number[],
  anchors: readonly Anchor[],
): PagePacingProposal {
  const reasons: PagePacingReason[] = [];
  if (anchor.overridden) {
    reasons.push(
      Object.freeze({
        signal: 'explicit-override' as const,
        score: 1,
        evidence: 'Interval supplied by the user and applied verbatim.',
      }),
    );
    return Object.freeze({
      id: `page-pacing:page-${index + 1}`,
      pageId,
      start: freezeAudioTime(start, timebase),
      end: freezeAudioTime(end, timebase),
      confidence: 1,
      reasons: Object.freeze(reasons),
      source: 'override' as const,
      status: 'pending-review' as const,
    });
  }

  if (anchor.dialogue) {
    reasons.push(
      Object.freeze({
        signal: 'mapped-dialogue' as const,
        score: 1,
        evidence: `Anchored to mapped dialogue from ${anchor.start} to ${anchor.end}.`,
      }),
    );
    const leftBoundary = boundaries[index]!;
    const rightBoundary = boundaries[index + 1]!;
    const leftNeighbor = index > 0 ? anchors[index - 1]! : null;
    const rightNeighbor =
      index < anchors.length - 1 ? anchors[index + 1]! : null;
    const grewLeft = leftBoundary < anchor.start - 1e-9;
    const grewRight = rightBoundary > anchor.end + 1e-9;
    const clampedLeft =
      leftNeighbor !== null &&
      !leftNeighbor.overridden &&
      leftBoundary > anchor.start + 1e-9 &&
      leftNeighbor.end > anchor.start;
    const clampedRight =
      rightNeighbor !== null &&
      !rightNeighbor.overridden &&
      rightBoundary < anchor.end - 1e-9 &&
      rightNeighbor.start < anchor.end;
    if (clampedLeft || clampedRight) {
      reasons.push(
        Object.freeze({
          signal: 'overlap-midpoint' as const,
          score: 0.8,
          evidence: 'Overlapping neighbour dialogue clamped to the overlap midpoint.',
        }),
      );
    }
    if (grewLeft || grewRight) {
      reasons.push(
        Object.freeze({
          signal: 'gap-distribution' as const,
          score: 0.75,
          evidence: 'Adjacent unmapped audio absorbed in proportion to dialogue duration.',
        }),
      );
    }
    const confidence = clampedLeft || clampedRight ? 0.75 : 0.85;
    return Object.freeze({
      id: `page-pacing:page-${index + 1}`,
      pageId,
      start: freezeAudioTime(start, timebase),
      end: freezeAudioTime(end, timebase),
      confidence,
      reasons: Object.freeze(reasons),
      source: 'dialogue' as const,
      status: 'pending-review' as const,
    });
  }

  reasons.push(
    Object.freeze({
      signal: 'even-split-fallback' as const,
      score: 0.5,
      evidence:
        'No mapped dialogue on this page; unmapped span split evenly with adjacent empty pages.',
    }),
  );
  return Object.freeze({
    id: `page-pacing:page-${index + 1}`,
    pageId,
    start: freezeAudioTime(start, timebase),
    end: freezeAudioTime(end, timebase),
    confidence: 0.5,
    reasons: Object.freeze(reasons),
    source: 'fallback' as const,
    status: 'pending-review' as const,
  });
}

function validateOverrides(
  overrides: readonly PagePacingOverride[],
  pageIds: ReadonlySet<string>,
  timebase: AudioTimebase,
): Map<string, { start: number; end: number }> {
  const map = new Map<string, { start: number; end: number }>();
  const ordered: { pageId: string; start: number; end: number }[] = [];
  for (const override of overrides) {
    if (!pageIds.has(override.pageId))
      throw new PagePacingError(
        'Page pacing overrides must reference an existing page.',
      );
    if (map.has(override.pageId))
      throw new PagePacingError(
        'Each page may carry at most one pacing override.',
      );
    const interval = validateInterval(override, timebase, 'Override');
    map.set(override.pageId, interval);
    ordered.push({
      pageId: override.pageId,
      start: interval.start,
      end: interval.end,
    });
  }
  ordered.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end)
      throw new PagePacingError('Page pacing overrides must not overlap.');
  }
  return map;
}

function validateTimebase(timebase: AudioTimebase): void {
  if (
    !timebase ||
    typeof timebase.id !== 'string' ||
    timebase.id.trim().length === 0
  )
    throw new PagePacingError('An audio timebase ID is required.');
  if (timebase.unit !== 'seconds' && timebase.unit !== 'samples')
    throw new PagePacingError(
      'Audio timebase unit must be seconds or samples.',
    );
  if (
    timebase.unit === 'samples' &&
    (!Number.isFinite(timebase.sampleRateHz) ||
      (timebase.sampleRateHz ?? 0) <= 0)
  )
    throw new PagePacingError(
      'Sample-based timebases require a positive sample rate.',
    );
}

function validateInterval(
  interval: TimeInterval,
  timebase: AudioTimebase,
  label: string,
): { start: number; end: number } {
  if (
    !interval ||
    !interval.start ||
    !interval.end ||
    interval.start.timebase !== timebase.id ||
    interval.end.timebase !== timebase.id ||
    interval.start.unit !== timebase.unit ||
    interval.end.unit !== timebase.unit
  )
    throw new PagePacingError(
      `${label} endpoints must use the declared audio timebase and unit.`,
    );
  for (const point of [interval.start, interval.end]) {
    if (
      !Number.isFinite(point.value) ||
      point.value < 0 ||
      (timebase.unit === 'samples' && !Number.isSafeInteger(point.value))
    )
      throw new PagePacingError(
        `${label} values must be finite and non-negative in the timebase unit.`,
      );
  }
  if (interval.end.value <= interval.start.value)
    throw new PagePacingError(`${label} must end after it starts.`);
  return { start: interval.start.value, end: interval.end.value };
}

function freezeAudioTime(value: number, timebase: AudioTimebase): AudioTime {
  return Object.freeze({
    value,
    unit: timebase.unit,
    timebase: timebase.id as AudioTimebaseId,
  });
}
