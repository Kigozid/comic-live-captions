import type {
  AudioTime,
  AudioTimebase,
  AudioTimebaseId,
  TimeInterval,
} from '@comic-captioner/shared';
import type { WordTimestamp } from '@comic-captioner/core';

export class ForcedAlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForcedAlignmentError';
  }
}

/** One transcript word with optional rough times in the alignment timebase. */
export interface AlignmentWordInput {
  readonly text: string;
  readonly id?: string;
  readonly speakerId?: string | null;
  readonly confidence?: number | null;
  /** Optional rough start; when supplied, `end` must be supplied too. */
  readonly start?: AudioTime;
  readonly end?: AudioTime;
}

/** A rough dialogue segment: word text plus an approximate audio interval. */
export interface AlignmentSegmentInput {
  readonly id?: string;
  readonly words: readonly AlignmentWordInput[];
  readonly interval: TimeInterval;
  readonly speakerId?: string | null;
  readonly confidence?: number | null;
}

/**
 * Mean RMS amplitude over `interval`, on any non-negative finite scale.
 * Relative magnitudes within one alignment call drive word weights.
 */
export type EnergyEnvelope = (interval: TimeInterval) => number;

export interface ForcedAlignmentInput {
  /** Segments in playback order. */
  readonly segments: readonly AlignmentSegmentInput[];
  readonly timebase: AudioTimebase;
  readonly energyEnvelope?: EnergyEnvelope;
}

export interface ForcedAlignmentOptions {
  /** Prefix for generated word IDs. Defaults to `aligned`. */
  readonly idPrefix?: string;
}

/** A caption-sized run of aligned words that belongs inside one speech bubble. */
export interface CaptionChunk {
  readonly id: string;
  readonly text: string;
  readonly words: readonly WordTimestamp[];
  readonly start: AudioTime;
  readonly end: AudioTime;
  readonly speakerId: string | null;
}

export interface CaptionChunkOptions {
  /** Hard cap on chunk duration in the words' time unit. Defaults to 3 seconds. */
  readonly maxDurationSeconds?: number;
  /** Hard cap on joined caption length in characters. Defaults to 42. */
  readonly maxCharacters?: number;
  /** Close a chunk after a sentence-final word. Defaults to true. */
  readonly breakOnSentenceEnd?: boolean;
  /** Close a chunk after a comma-final word. Defaults to true. */
  readonly breakOnComma?: boolean;
  /** Prefix for generated chunk IDs. Defaults to `caption-chunk`. */
  readonly idPrefix?: string;
  /**
   * Required to apply `maxDurationSeconds` when the words use a sample-based
   * timebase; ignored for seconds-based words.
   */
  readonly sampleRateHz?: number;
}

const SENTENCE_END = /[.!?…]["'”’)]*$/u;
const COMMA_END = /[,，、;；]["'”’)]*$/u;
const DEFAULT_MAX_DURATION_SECONDS = 3;
const DEFAULT_MAX_CHARACTERS = 42;

/**
 * Deterministic word-level forced alignment. Words tile each segment interval
 * contiguously. Durations are allocated from a character-length baseline
 * refined by a syllable (phoneme-length) heuristic, blended with rough word
 * times when the whole segment supplies them, and optionally reweighted by an
 * RMS energy envelope. Every timestamp carries the declared timebase; no audio
 * samples are read here. Sample-based timebases receive integer boundaries.
 */
export function alignWords(
  input: ForcedAlignmentInput,
  options: ForcedAlignmentOptions = {},
): readonly WordTimestamp[] {
  validateTimebase(input.timebase);
  const idPrefix = options.idPrefix ?? 'aligned';
  if (typeof idPrefix !== 'string' || idPrefix.trim().length === 0)
    throw new ForcedAlignmentError('Alignment ID prefix must be non-empty.');
  const words: WordTimestamp[] = [];
  let previousSegmentStart = Number.NEGATIVE_INFINITY;
  let previousSegmentEnd = Number.NEGATIVE_INFINITY;
  for (const [segmentIndex, segment] of input.segments.entries()) {
    const interval = validateInterval(segment.interval, input.timebase);
    if (
      interval.start < previousSegmentStart ||
      interval.start < previousSegmentEnd
    )
      throw new ForcedAlignmentError(
        'Segment intervals must be monotonic and must not overlap.',
      );
    previousSegmentStart = interval.start;
    previousSegmentEnd = interval.end;
    if (segment.words.length === 0)
      throw new ForcedAlignmentError(
        'Every segment must contain at least one word.',
      );
    validateSpeakerId(segment.speakerId, 'Segment');
    validateConfidence(segment.confidence, 'Segment');
    const weights = computeWordWeights(
      segment,
      interval,
      input.timebase,
      input.energyEnvelope,
    );
    const boundaries = allocateBoundaries(
      interval.start,
      interval.end,
      weights,
      input.timebase.unit,
    );
    for (const [wordIndex, word] of segment.words.entries()) {
      words.push(
        Object.freeze({
          id:
            word.id ??
            `${idPrefix}:${segment.id ?? `segment-${segmentIndex + 1}`}:word-${wordIndex + 1}`,
          text: word.text.trim(),
          start: freezeAudioTime(boundaries[wordIndex]!, input.timebase),
          end: freezeAudioTime(boundaries[wordIndex + 1]!, input.timebase),
          speakerId: word.speakerId ?? segment.speakerId ?? null,
          confidence: word.confidence ?? segment.confidence ?? null,
        }),
      );
    }
  }
  return Object.freeze(words);
}

/**
 * Group aligned words into caption units at sentence ends, commas, speaker
 * changes, and the configured duration/character caps. Chunk intervals tile
 * their words exactly and share the words' timebase and unit.
 */
export function chunkCaptionUnits(
  words: readonly WordTimestamp[],
  options: CaptionChunkOptions = {},
): readonly CaptionChunk[] {
  const maxDuration =
    options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const breakOnSentenceEnd = options.breakOnSentenceEnd ?? true;
  const breakOnComma = options.breakOnComma ?? true;
  const idPrefix = options.idPrefix ?? 'caption-chunk';
  if (!Number.isFinite(maxDuration) || maxDuration <= 0)
    throw new ForcedAlignmentError(
      'Chunk duration limit must be a positive finite number.',
    );
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1)
    throw new ForcedAlignmentError(
      'Chunk character limit must be a positive integer.',
    );
  if (typeof idPrefix !== 'string' || idPrefix.trim().length === 0)
    throw new ForcedAlignmentError('Chunk ID prefix must be non-empty.');
  if (words.length === 0) return Object.freeze([]);
  const timebaseId = words[0]!.start.timebase;
  const unit = words[0]!.start.unit;
  for (const [index, word] of words.entries()) {
    if (
      word.start.timebase !== timebaseId ||
      word.end.timebase !== timebaseId ||
      word.start.unit !== unit ||
      word.end.unit !== unit
    )
      throw new ForcedAlignmentError(
        'All words must share one timebase and unit before chunking.',
      );
    if (
      !Number.isFinite(word.start.value) ||
      !Number.isFinite(word.end.value) ||
      word.start.value < 0 ||
      word.end.value <= word.start.value
    )
      throw new ForcedAlignmentError(
        'Word intervals must be finite, non-negative, and non-empty.',
      );
    if (index > 0 && word.start.value < words[index - 1]!.end.value)
      throw new ForcedAlignmentError(
        'Word intervals must be monotonic and must not overlap.',
      );
    if (!word.text.trim())
      throw new ForcedAlignmentError('Word text must be non-empty.');
    validateConfidence(word.confidence, 'Word');
    validateSpeakerId(word.speakerId, 'Word');
  }

  const chunks: CaptionChunk[] = [];
  let open: WordTimestamp[] = [];
  const flush = (): void => {
    if (open.length === 0) return;
    const first = open[0]!;
    const last = open[open.length - 1]!;
    chunks.push(
      Object.freeze({
        id: `${idPrefix}:${chunks.length + 1}`,
        text: open.map((word) => word.text).join(' '),
        words: Object.freeze([...open]),
        start: first.start,
        end: last.end,
        speakerId: first.speakerId,
      }),
    );
    open = [];
  };

  for (const word of words) {
    const previous = open[open.length - 1];
    if (previous && previous.speakerId !== word.speakerId) flush();
    if (open.length > 0) {
      const joinedLength = [...open, word]
        .map((entry) => entry.text)
        .join(' ').length;
      const duration =
        unit === 'samples'
          ? (word.end.value - open[0]!.start.value) / chunkSampleRate(options)
          : word.end.value - open[0]!.start.value;
      if (duration > maxDuration + 1e-9 || joinedLength > maxCharacters) flush();
    }
    open.push(word);
    const naturalEnd =
      (breakOnSentenceEnd && SENTENCE_END.test(word.text)) ||
      (breakOnComma && COMMA_END.test(word.text));
    if (naturalEnd) flush();
  }
  flush();
  return Object.freeze(chunks);
}

function chunkSampleRate(options: CaptionChunkOptions): number {
  const sampleRateHz = options.sampleRateHz ?? 0;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0)
    throw new ForcedAlignmentError(
      'Chunking sample-based words requires a positive sample rate.',
    );
  return sampleRateHz;
}

function computeWordWeights(
  segment: AlignmentSegmentInput,
  interval: { start: number; end: number },
  timebase: AudioTimebase,
  energyEnvelope: EnergyEnvelope | undefined,
): number[] {
  const heuristic: number[] = [];
  const rough: (number | null)[] = [];
  let previousRoughStart = Number.NEGATIVE_INFINITY;
  let previousRoughEnd = Number.NEGATIVE_INFINITY;
  for (const [index, word] of segment.words.entries()) {
    const text = word.text.trim();
    if (!text)
      throw new ForcedAlignmentError(`Word ${index + 1} text must be non-empty.`);
    validateConfidence(word.confidence, `Word ${index + 1}`);
    validateSpeakerId(word.speakerId, `Word ${index + 1}`);
    heuristic.push(estimateSpeechWeight(text));
    const hasStart = word.start !== undefined;
    const hasEnd = word.end !== undefined;
    if (hasStart !== hasEnd)
      throw new ForcedAlignmentError(
        'Rough word times must supply both start and end.',
      );
    if (!hasStart) {
      if (previousRoughEnd !== Number.NEGATIVE_INFINITY)
        throw new ForcedAlignmentError(
          'Rough word times must be supplied for every word in a segment, or for none.',
        );
      rough.push(null);
      continue;
    }
    const start = validateIntervalPoint(word.start!, timebase);
    const end = validateIntervalPoint(word.end!, timebase);
    if (end <= start)
      throw new ForcedAlignmentError(
        'Rough word times must be ordered with end after start.',
      );
    if (start < interval.start - 1e-9 || end > interval.end + 1e-9)
      throw new ForcedAlignmentError(
        'Rough word times must fall inside their segment interval.',
      );
    if (start < previousRoughStart || start < previousRoughEnd)
      throw new ForcedAlignmentError(
        'Rough word times must be monotonic and must not overlap.',
      );
    previousRoughStart = start;
    previousRoughEnd = end;
    rough.push(end - start);
  }
  if (rough.some((value) => value !== null) && rough.some((value) => value === null))
    throw new ForcedAlignmentError(
      'Rough word times must be supplied for every word in a segment, or for none.',
    );

  let weights =
    rough.length > 0 && rough[0] !== null
      ? blendWeights(heuristic, rough as number[])
      : [...heuristic];

  if (energyEnvelope) {
    const boundaries = allocateBoundaries(
      interval.start,
      interval.end,
      weights,
      timebase.unit,
    );
    const energies = weights.map((_, index) =>
      measureEnergy(
        energyEnvelope,
        timebase,
        boundaries[index]!,
        boundaries[index + 1]!,
      ),
    );
    const peak = Math.max(...energies);
    if (peak > 0) {
      weights = weights.map((weight, index) => {
        const ratio = energies[index]! / peak;
        return weight * (0.6 + 0.4 * ratio);
      });
    }
  }
  return weights;
}

/**
 * Split [start, end] proportionally to `weights`. Sample-based timebases get
 * integer boundaries via cumulative rounding so words never gain fractional
 * sample positions.
 */
function allocateBoundaries(
  start: number,
  end: number,
  weights: readonly number[],
  unit: AudioTimebase['unit'],
): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = end - start;
  const boundaries: number[] = [start];
  let cumulative = 0;
  for (let index = 0; index < weights.length - 1; index += 1) {
    cumulative += weights[index]!;
    const raw = start + (span * cumulative) / total;
    const value = unit === 'samples' ? Math.round(raw) : raw;
    const previous = boundaries[boundaries.length - 1]!;
    boundaries.push(Math.max(previous, Math.min(end, value)));
  }
  boundaries.push(end);
  return boundaries;
}

function blendWeights(
  heuristic: readonly number[],
  rough: readonly number[],
): number[] {
  const heuristicMean =
    heuristic.reduce((sum, value) => sum + value, 0) / heuristic.length;
  const roughMean = rough.reduce((sum, value) => sum + value, 0) / rough.length;
  return heuristic.map((value, index) => {
    const heuristicPart = roughMean > 0 ? value / heuristicMean : 1;
    const roughPart = roughMean > 0 ? rough[index]! / roughMean : 1;
    return 0.5 * heuristicPart + 0.5 * roughPart;
  });
}

/**
 * Character-length baseline refined by a syllable count (a phoneme-length
 * proxy). Longer and more syllabic words receive proportionally more time.
 */
function estimateSpeechWeight(text: string): number {
  const letters = [...text].filter((character) =>
    /[\p{L}\p{N}]/u.test(character),
  );
  const charCount = Math.max(1, letters.length);
  const syllables = estimateSyllableCount(text);
  return Math.max(0.25, 0.35 * charCount + 1.15 * syllables);
}

function estimateSyllableCount(text: string): number {
  const latin = text.toLowerCase().replace(/[^a-z']/gu, '');
  if (latin.length === 0) {
    // Non-Latin text (for example CJK) is roughly one syllable per character.
    const characters = [...text].filter((character) => /\p{L}/u.test(character));
    return Math.max(1, characters.length);
  }
  const vowelGroups = latin.match(/[aeiouy]+/gu)?.length ?? 0;
  let count = vowelGroups;
  // Silent trailing "e", except consonant+"le" which keeps its syllable.
  if (/[^aeiouy]e$/u.test(latin) && !/[^aeiouy]le$/u.test(latin)) count -= 1;
  return Math.max(1, count);
}

function measureEnergy(
  energyEnvelope: EnergyEnvelope,
  timebase: AudioTimebase,
  start: number,
  end: number,
): number {
  const value = energyEnvelope(
    Object.freeze({
      start: freezeAudioTime(start, timebase),
      end: freezeAudioTime(end, timebase),
    }),
  );
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new ForcedAlignmentError(
      'Energy envelope must return a non-negative finite number.',
    );
  return value;
}

function validateTimebase(timebase: AudioTimebase): void {
  if (
    !timebase ||
    typeof timebase.id !== 'string' ||
    timebase.id.trim().length === 0
  )
    throw new ForcedAlignmentError('An audio timebase ID is required.');
  if (timebase.unit !== 'seconds' && timebase.unit !== 'samples')
    throw new ForcedAlignmentError(
      'Audio timebase unit must be seconds or samples.',
    );
  if (
    timebase.unit === 'samples' &&
    (!Number.isFinite(timebase.sampleRateHz) || (timebase.sampleRateHz ?? 0) <= 0)
  )
    throw new ForcedAlignmentError(
      'Sample-based timebases require a positive sample rate.',
    );
}

function validateInterval(
  interval: TimeInterval,
  timebase: AudioTimebase,
): { start: number; end: number } {
  if (
    !interval ||
    interval.start.timebase !== timebase.id ||
    interval.end.timebase !== timebase.id ||
    interval.start.unit !== timebase.unit ||
    interval.end.unit !== timebase.unit
  )
    throw new ForcedAlignmentError(
      'Interval endpoints must use the declared audio timebase and unit.',
    );
  const start = validateIntervalPoint(interval.start, timebase);
  const end = validateIntervalPoint(interval.end, timebase);
  if (end <= start)
    throw new ForcedAlignmentError(
      'Segment intervals must be finite, non-negative, and non-empty.',
    );
  return { start, end };
}

function validateIntervalPoint(time: AudioTime, timebase: AudioTimebase): number {
  if (
    !Number.isFinite(time.value) ||
    time.value < 0 ||
    time.timebase !== timebase.id ||
    time.unit !== timebase.unit
  )
    throw new ForcedAlignmentError(
      'Audio times must be finite, non-negative, and use the declared timebase.',
    );
  if (timebase.unit === 'samples' && !Number.isSafeInteger(time.value))
    throw new ForcedAlignmentError('Sample-based audio times must be integers.');
  return time.value;
}

function validateConfidence(
  confidence: number | null | undefined,
  label: string,
): void {
  if (
    confidence !== undefined &&
    confidence !== null &&
    (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  )
    throw new ForcedAlignmentError(
      `${label} confidence must be between 0 and 1.`,
    );
}

function validateSpeakerId(
  speakerId: string | null | undefined,
  label: string,
): void {
  if (
    speakerId !== undefined &&
    speakerId !== null &&
    !/^[A-Za-z0-9_-]{1,64}$/.test(speakerId)
  )
    throw new ForcedAlignmentError(
      `${label} speaker IDs must be 1–64 characters using letters, digits, underscores, or hyphens.`,
    );
}

function freezeAudioTime(value: number, timebase: AudioTimebase): AudioTime {
  return Object.freeze({
    value,
    unit: timebase.unit,
    timebase: timebase.id as AudioTimebaseId,
  });
}
