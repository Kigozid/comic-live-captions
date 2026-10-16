import type {
  AudioTime,
  BubbleId,
  CaptionLayout,
  DialogueEvent,
  WordTimestamp,
} from '@comic-captioner/core';

/**
 * Map acoustic / forced-aligned word timestamps onto the caption timeline.
 *
 * Stage separation is explicit:
 *  1. ASR / `alignWordsAcoustic` produces `WordTimestamp[]`.
 *  2. This module groups words into caption-sized units and attaches bubble +
 *     layout assignments so `TimelineEngine` can play them.
 *
 * It does not re-transcribe or invent dialogue text.
 */

export class TimelineMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineMappingError';
  }
}

/** Caption-sized run of aligned words ready for bubble assignment. */
export interface AlignedCaptionUnit {
  readonly id: string;
  readonly text: string;
  readonly words: readonly WordTimestamp[];
  readonly start: AudioTime;
  readonly end: AudioTime;
  readonly speakerId: string | null;
  readonly confidence: number;
}

export interface ChunkAlignedWordsOptions {
  readonly maxDurationSeconds?: number;
  readonly maxCharacters?: number;
  readonly breakOnSentenceEnd?: boolean;
  readonly idPrefix?: string;
}

export interface TimelineCaptionAssignment {
  /** Caption unit id (or `idPrefix` index key). */
  readonly unitId: string;
  readonly bubbleId: BubbleId;
  readonly layout: CaptionLayout;
  /** Overrides unit text when the editor has a corrected caption. */
  readonly caption?: string;
  /** Event confidence; defaults to the unit's mean word confidence. */
  readonly confidence?: number;
}

const SENTENCE_END = /[.!?…]["'”’)]*$/u;
const DEFAULT_MAX_DURATION = 3;
const DEFAULT_MAX_CHARACTERS = 42;

/**
 * Group aligned words into caption units at sentence ends, speaker changes,
 * pauses > 1.2 s, and duration/character caps. Intervals tile the words
 * exactly and share their timebase.
 */
export function chunkAlignedWordsForTimeline(
  words: readonly WordTimestamp[],
  options: ChunkAlignedWordsOptions = {},
): readonly AlignedCaptionUnit[] {
  if (words.length === 0) return Object.freeze([]);
  const maxDuration = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const breakOnSentenceEnd = options.breakOnSentenceEnd ?? true;
  const idPrefix = options.idPrefix ?? 'timeline-caption';
  if (!Number.isFinite(maxDuration) || maxDuration <= 0)
    throw new TimelineMappingError(
      'maxDurationSeconds must be a positive finite number.',
    );
  if (!Number.isFinite(maxCharacters) || maxCharacters <= 0)
    throw new TimelineMappingError(
      'maxCharacters must be a positive finite number.',
    );

  // Validate order and timebase consistency.
  let previousStart = Number.NEGATIVE_INFINITY;
  for (const word of words) {
    if (!word.text.trim())
      throw new TimelineMappingError('Aligned words must have non-empty text.');
    if (!Number.isFinite(word.start.value) || !Number.isFinite(word.end.value))
      throw new TimelineMappingError('Word times must be finite.');
    if (word.end.value <= word.start.value)
      throw new TimelineMappingError('Word end must be after word start.');
    if (word.start.value < previousStart)
      throw new TimelineMappingError('Word timestamps must be ordered by start.');
    previousStart = word.start.value;
    if (
      word.start.unit !== words[0]!.start.unit ||
      word.start.timebase !== words[0]!.start.timebase
    ) {
      throw new TimelineMappingError(
        'All aligned words must share one timebase and unit.',
      );
    }
  }

  const units: AlignedCaptionUnit[] = [];
  let bucket: WordTimestamp[] = [];
  let characters = 0;

  const flush = (): void => {
    if (bucket.length === 0) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const confidences = bucket.map((w) => w.confidence ?? 0).filter((c) => c > 0);
    const text = bucket
      .map((word) => word.text.trim())
      .join(' ')
      .trim();
    units.push(
      Object.freeze({
        id: `${idPrefix}-${units.length + 1}`,
        text,
        words: Object.freeze([...bucket]),
        start: first.start,
        end: last.end,
        speakerId: first.speakerId,
        confidence:
          confidences.length > 0
            ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
            : 0,
      }),
    );
    bucket = [];
    characters = 0;
  };

  for (const word of words) {
    const token = word.text.trim();
    const previous = bucket[bucket.length - 1];
    if (previous) {
      const pause = word.start.value - previous.end.value;
      const speakerChange = previous.speakerId !== word.speakerId;
      const unitDuration = word.end.value - bucket[0]!.start.value;
      const wouldOverflowChars = characters + token.length + 1 > maxCharacters;
      const wouldOverflowTime = unitDuration > maxDuration;
      if (
        speakerChange ||
        pause > 1.2 ||
        (breakOnSentenceEnd && SENTENCE_END.test(previous.text.trim())) ||
        wouldOverflowChars ||
        wouldOverflowTime
      ) {
        flush();
      }
    }
    bucket.push(word);
    characters += token.length + 1;
  }
  flush();
  return Object.freeze(units);
}

/**
 * Build `DialogueEvent[]` for `TimelineEngine` from caption units and
 * bubble/layout assignments. Unassigned units are skipped (they remain in
 * the review queue rather than appearing on the timeline).
 */
export function mapAlignedCaptionsToTimeline(
  units: readonly AlignedCaptionUnit[],
  assignments: readonly TimelineCaptionAssignment[],
  fallback?: {
    readonly bubbleId: BubbleId;
    readonly layout: CaptionLayout;
    readonly confidence?: number;
  },
): readonly DialogueEvent[] {
  const byUnit = new Map(assignments.map((assignment) => [assignment.unitId, assignment]));
  const events: DialogueEvent[] = [];
  for (const unit of units) {
    const assignment = byUnit.get(unit.id) ?? (fallback
      ? {
          unitId: unit.id,
          bubbleId: fallback.bubbleId,
          layout: fallback.layout,
          ...(fallback.confidence !== undefined
            ? { confidence: fallback.confidence }
            : {}),
        }
      : undefined);
    if (!assignment) continue;
    const caption = assignment.caption ?? unit.text;
    if (!caption.trim()) continue;
    if (assignment.layout.bubbleId !== assignment.bubbleId) {
      throw new TimelineMappingError(
        `Layout ${assignment.layout.id} bubbleId must match assignment bubbleId.`,
      );
    }
    events.push(
      Object.freeze({
        id: `event:${unit.id}`,
        bubbleId: assignment.bubbleId,
        caption,
        start: unit.start,
        end: unit.end,
        layout: assignment.layout,
        confidence: clamp01(assignment.confidence ?? unit.confidence),
      }),
    );
  }
  return Object.freeze(events);
}

/**
 * Convenience: aligned words → caption units → dialogue timeline events.
 * When `assign` is a single assignment it is applied to every unit (one
 * bubble narration); when it is a map keyed by unit id, unmapped units are
 * omitted.
 */
export function buildTimelineFromAlignedWords(
  words: readonly WordTimestamp[],
  assign:
    | {
        readonly bubbleId: BubbleId;
        readonly layout: CaptionLayout;
        readonly confidence?: number;
      }
    | readonly TimelineCaptionAssignment[],
  options: ChunkAlignedWordsOptions = {},
): {
  readonly units: readonly AlignedCaptionUnit[];
  readonly events: readonly DialogueEvent[];
} {
  const units = chunkAlignedWordsForTimeline(words, options);
  const isAssignmentList = (
    value: unknown,
  ): value is readonly TimelineCaptionAssignment[] =>
    Array.isArray(value) && value.length > 0 && 'unitId' in value[0]!;
  if (isAssignmentList(assign)) {
    const events = mapAlignedCaptionsToTimeline(units, assign);
    return { units, events };
  }
  const single = assign as {
    readonly bubbleId: BubbleId;
    readonly layout: CaptionLayout;
    readonly confidence?: number;
  };
  const events = mapAlignedCaptionsToTimeline(units, [], single);
  return { units, events };
}

/**
 * Auto-pipeline timeline cues (seconds) from dialogue events, for
 * `AutoPipelineInput.timelineCues`.
 */
export function timelineCuesFromDialogueEvents(
  events: readonly DialogueEvent[],
): readonly {
  readonly id: string;
  readonly bubbleId: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
}[] {
  return events.map((event) => ({
    id: event.id,
    bubbleId: String(event.bubbleId),
    start: event.start.value,
    end: event.end.value,
    confidence: event.confidence,
  }));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
