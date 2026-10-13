import type { AudioTime, AudioTimebase, TimeInterval } from '@comic-captioner/shared';
import type { WordTimestamp } from '@comic-captioner/core';

/**
 * wav2vec2 / WhisperX-style forced alignment.
 *
 * Pipeline (mirrors WhisperX):
 *   1. ASR produces rough segment text + intervals (existing providers).
 *   2. A wav2vec2 CTC encoder produces frame-level token posteriors.
 *   3. Viterbi forced-aligns the transcript token sequence to those frames.
 *   4. Token spans collapse into precise word boundaries.
 *
 * The acoustic model is injected (`CtcFramePosteriorsProvider`) so this package
 * has no hard dependency on onnxruntime / torch. Deterministic heuristics
 * remain available as fallback when no acoustic model is configured.
 */

export class ForcedAlignAcousticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForcedAlignAcousticError';
  }
}

/** Frame-rate CTC posteriors from wav2vec2 (or a compatible encoder). */
export interface CtcFramePosteriors {
  /** Frames × tokens log-probabilities or probabilities in [0, 1]. */
  readonly logProbs: Float32Array;
  readonly numFrames: number;
  readonly numTokens: number;
  /** Token vocabulary aligned with the posterior columns. */
  readonly tokens: readonly string[];
  /** Seconds per frame (e.g. 0.02 for wav2vec2 50 Hz). */
  readonly frameShiftSeconds: number;
  /** When true, `logProbs` are log-scaled; when false, raw probabilities. */
  readonly isLogScale: boolean;
  /** CTC blank token index (default 0). */
  readonly blankIndex?: number;
}

/**
 * Injected acoustic frontend. A host that loads wav2vec2-CTC (ONNX or torch)
 * implements this; tests use `SyntheticCtcPosteriorsProvider`.
 */
export interface CtcFramePosteriorsProvider {
  readonly name: string;
  /**
   * Produce frame posteriors covering `interval` of `audio`.
   * `tokens` is the requested vocabulary (usually the CTC alphabet).
   */
  encode(input: {
    readonly pcm: Float32Array;
    readonly sampleRateHz: number;
    readonly interval: TimeInterval;
    readonly tokens: readonly string[];
  }): Promise<CtcFramePosteriors>;
}

export type ForcedAlignTokenMode = 'character' | 'phoneme';

export interface ForcedAlignAcousticInput {
  readonly segments: readonly {
    readonly id?: string;
    readonly text: string;
    readonly interval: TimeInterval;
    readonly speakerId?: string | null;
    /** Optional word texts; when omitted, `text` is split on whitespace. */
    readonly words?: readonly string[];
  }[];
  readonly timebase: AudioTimebase;
  /** PCM covering the whole audio in the timebase unit domain. */
  readonly pcm: Float32Array;
  readonly sampleRateHz: number;
  readonly provider: CtcFramePosteriorsProvider;
  readonly tokenMode?: ForcedAlignTokenMode;
  /**
   * Optional phoneme dictionary for `phoneme` mode:
   * `word -> phoneme symbols`. Unknown words fall back to characters.
   */
  readonly phonemeLexicon?: Readonly<Record<string, readonly string[]>>;
  /** Prefer previous acoustic alignment over energy heuristics (default true). */
  readonly blankToken?: string;
}

export interface ForcedAlignAcousticResult {
  readonly words: readonly WordTimestamp[];
  /** Mean posterior confidence of aligned tokens in [0, 1]. */
  readonly confidence: number;
  readonly framesPerSegment: readonly number[];
  readonly provider: string;
  readonly algorithm: 'ctc-viterbi';
}

const CTC_ALPHABET = [
  '',
  ' ',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  "'",
  '-',
] as const;

/**
 * Align transcript words to acoustic frames with CTC Viterbi forced alignment
 * and return precise word timestamps in the declared timebase.
 */
export async function alignWordsAcoustic(
  input: ForcedAlignAcousticInput,
): Promise<ForcedAlignAcousticResult> {
  validateAcousticInput(input);
  const tokenMode = input.tokenMode ?? 'character';
  const tokens = [...CTC_ALPHABET];
  const words: WordTimestamp[] = [];
  const framesPerSegment: number[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const [segmentIndex, segment] of input.segments.entries()) {
    const interval = validateInterval(segment.interval, input.timebase);
    const pcmSlice = slicePcm(
      input.pcm,
      input.sampleRateHz,
      interval,
      input.timebase,
    );
    const posteriors = await input.provider.encode({
      pcm: pcmSlice,
      sampleRateHz: input.sampleRateHz,
      interval: segment.interval,
      tokens,
    });
    validatePosteriors(posteriors);
    framesPerSegment.push(posteriors.numFrames);

    const wordTexts =
      segment.words && segment.words.length > 0
        ? segment.words.map((word) => word.trim())
        : segment.text
            .split(/\s+/u)
            .map((word) => word.trim())
            .filter(Boolean);
    if (wordTexts.length === 0) {
      throw new ForcedAlignAcousticError(
        'Every segment needs at least one word for acoustic alignment.',
      );
    }

    const sequence = tokenizeWords(wordTexts, tokenMode, input.phonemeLexicon);
    const alignment = viterbiAlign(posteriors, sequence.tokenIds);

    // Map token spans back to words.
    let tokenCursor = 0;
    for (const [wordIndex, word] of wordTexts.entries()) {
      const wordTokenIds = sequence.wordTokenIds[wordIndex]!;
      const startFrame = alignment.tokenSpans[tokenCursor]?.startFrame ?? 0;
      const endFrame =
        alignment.tokenSpans[tokenCursor + wordTokenIds.length - 1]?.endFrame ??
        posteriors.numFrames;
      tokenCursor += wordTokenIds.length;
      const startSeconds =
        interval.start +
        frameToSeconds(startFrame, posteriors, input.timebase);
      const endSeconds =
        interval.start +
        frameToSeconds(Math.max(startFrame + 1, endFrame), posteriors, input.timebase);
      words.push(
        Object.freeze({
          id: `acoustic:${segment.id ?? `segment-${segmentIndex + 1}`}:word-${wordIndex + 1}`,
          text: word,
          start: toAudioTime(startSeconds, input.timebase),
          end: toAudioTime(endSeconds, input.timebase),
          speakerId: segment.speakerId ?? null,
          confidence: alignment.meanConfidence,
        }),
      );
      confidenceSum += alignment.meanConfidence;
      confidenceCount += 1;
    }
  }

  return Object.freeze({
    words: Object.freeze(words),
    confidence: confidenceCount === 0 ? 0 : confidenceSum / confidenceCount,
    framesPerSegment: Object.freeze(framesPerSegment),
    provider: input.provider.name,
    algorithm: 'ctc-viterbi' as const,
  });
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

export interface TokenizedWords {
  /** Flat token ids including inter-word spaces. */
  readonly tokenIds: readonly number[];
  /** Token ids belonging to each word (no inter-word spaces). */
  readonly wordTokenIds: readonly (readonly number[])[];
  readonly tokens: readonly string[];
}

export function tokenizeWords(
  words: readonly string[],
  mode: ForcedAlignTokenMode = 'character',
  lexicon?: Readonly<Record<string, readonly string[]>>,
): TokenizedWords {
  const tokens = [...CTC_ALPHABET];
  const indexOf = new Map(tokens.map((token, index) => [token, index]));
  const wordTokenIds: number[][] = [];
  const flat: number[] = [];

  for (const [wordIndex, word] of words.entries()) {
    const symbols =
      mode === 'phoneme' && lexicon
        ? (lexicon[word.toLowerCase()] ?? [...word.toLowerCase()])
        : [...word.toLowerCase()];
    const ids: number[] = [];
    for (const symbol of symbols) {
      const id = indexOf.get(symbol) ?? indexOf.get(symbol.toLowerCase());
      if (id === undefined) continue;
      ids.push(id);
      flat.push(id);
    }
    if (ids.length === 0) {
      // Keep alignment monotonic even for empty/unknown words: use a space.
      const spaceId = indexOf.get(' ') ?? 1;
      ids.push(spaceId);
      flat.push(spaceId);
    }
    wordTokenIds.push(ids);
    if (wordIndex < words.length - 1) {
      flat.push(indexOf.get(' ') ?? 1);
    }
  }
  return {
    tokenIds: flat,
    wordTokenIds,
    tokens,
  };
}

// ---------------------------------------------------------------------------
// CTC Viterbi forced alignment
// ---------------------------------------------------------------------------

export interface AlignedTokenSpan {
  readonly tokenId: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly confidence: number;
}

export interface CtcAlignment {
  readonly tokenSpans: readonly AlignedTokenSpan[];
  readonly meanConfidence: number;
  readonly pathScore: number;
}

const LOG_FLOOR = -30;

/**
 * Classic CTC forced alignment (Rabiner-style Viterbi over blank+token states),
 * matching the algorithm used by torchaudio forced_align and WhisperX.
 */
export function viterbiAlign(
  posteriors: CtcFramePosteriors,
  tokenIds: readonly number[],
): CtcAlignment {
  const { numFrames, numTokens, blankIndex = 0 } = posteriors;
  if (numFrames <= 0) {
    throw new ForcedAlignAcousticError('Posteriors need at least one frame.');
  }
  if (tokenIds.length === 0) {
    throw new ForcedAlignAcousticError('Token sequence must be non-empty.');
  }
  if (numTokens < 2) {
    throw new ForcedAlignAcousticError('CTC alphabet must include a blank.');
  }
  if (posteriors.logProbs.length < numFrames * numTokens) {
    throw new ForcedAlignAcousticError('CTC posterior tensor is too small.');
  }

  const logProb = (frame: number, token: number): number => {
    const value = posteriors.logProbs[frame * numTokens + token] ?? LOG_FLOOR;
    return posteriors.isLogScale ? value : Math.log(Math.max(1e-8, value));
  };

  // Expanded CTC state sequence: blank, t1, blank, t2, ..., blank.
  const states: number[] = [blankIndex];
  for (const tokenId of tokenIds) {
    states.push(tokenId, blankIndex);
  }
  const S = states.length;

  // DP tables: best log-prob and backpointer per (frame, state).
  const back = new Int32Array(numFrames * S).fill(-1);
  const prev = new Float64Array(S).fill(Number.NEGATIVE_INFINITY);
  const current = new Float64Array(S).fill(Number.NEGATIVE_INFINITY);
  prev[0] = 0;

  for (let frame = 0; frame < numFrames; frame += 1) {
    current.fill(Number.NEGATIVE_INFINITY);
    for (let state = 0; state < S; state += 1) {
      const token = states[state]!;
      const emission = logProb(frame, token);
      // Stay, advance from previous state, or skip (ctc collapse).
      let best = Number.NEGATIVE_INFINITY;
      let bestPrev = -1;
      const stay = prev[state]!;
      if (stay > best) {
        best = stay;
        bestPrev = state;
      }
      if (state > 0 && prev[state - 1]! > best) {
        best = prev[state - 1]!;
        bestPrev = state - 1;
      }
      // CTC skip: jump over a blank when repeating the same token is illegal.
      if (
        state > 1 &&
        states[state] !== blankIndex &&
        states[state] === states[state - 2] &&
        prev[state - 2]! > best
      ) {
        best = prev[state - 2]!;
        bestPrev = state - 2;
      }
      if (best === Number.NEGATIVE_INFINITY && frame === 0 && state > 0) {
        current[state] = Number.NEGATIVE_INFINITY;
        continue;
      }
      current[state] = best + emission;
      back[frame * S + state] = bestPrev;
    }
    prev.set(current);
  }

  // Best end state prefers finishing on the last blank.
  let endState = S - 1;
  let bestScore = prev[S - 1]!;
  for (let state = S - 3; state >= 0; state -= 2) {
    if (prev[state]! > bestScore) {
      bestScore = prev[state]!;
      endState = state;
    }
  }
  if (!Number.isFinite(bestScore)) {
    // Extremely unlikely posteriors: fall back to uniform slicing.
    return uniformAlignment(tokenIds, numFrames);
  }

  // Backtrace.
  const pathStates = new Int32Array(numFrames);
  let state = endState;
  for (let frame = numFrames - 1; frame >= 0; frame -= 1) {
    pathStates[frame] = state;
    state = back[frame * S + state]!;
    if (state < 0) {
      state = 0;
    }
  }

  // Collapse path into token spans (ignore blanks).
  const spans: AlignedTokenSpan[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let index = 0;
  while (index < numFrames) {
    const alignedState = pathStates[index]!;
    const token = states[alignedState]!;
    if (token === blankIndex) {
      index += 1;
      continue;
    }
    let end = index + 1;
    let logSum = logProb(index, token);
    let samples = 1;
    while (end < numFrames && states[pathStates[end]!] === token) {
      logSum += logProb(end, token);
      samples += 1;
      end += 1;
    }
    const meanLog = logSum / samples;
    const confidence = posteriors.isLogScale
      ? Math.exp(meanLog)
      : Math.max(0, Math.min(1, Math.exp(meanLog)));
    spans.push(
      Object.freeze({
        tokenId: token,
        startFrame: index,
        endFrame: end,
        confidence,
      }),
    );
    confidenceSum += confidence;
    confidenceCount += 1;
    index = end;
  }

  if (spans.length === 0) return uniformAlignment(tokenIds, numFrames);

  return Object.freeze({
    tokenSpans: Object.freeze(spans),
    meanConfidence: confidenceCount === 0 ? 0 : confidenceSum / confidenceCount,
    pathScore: bestScore,
  });
}

function uniformAlignment(
  tokenIds: readonly number[],
  numFrames: number,
): CtcAlignment {
  const per = Math.max(1, Math.floor(numFrames / tokenIds.length));
  const spans: AlignedTokenSpan[] = [];
  let frame = 0;
  for (const tokenId of tokenIds) {
    const start = frame;
    const end = Math.min(numFrames, frame + per);
    spans.push(
      Object.freeze({
        tokenId,
        startFrame: start,
        endFrame: Math.max(start + 1, end),
        confidence: 0.2,
      }),
    );
    frame = Math.max(start + 1, end);
  }
  return Object.freeze({
    tokenSpans: Object.freeze(spans),
    meanConfidence: 0.2,
    pathScore: Number.NEGATIVE_INFINITY,
  });
}

// ---------------------------------------------------------------------------
// Synthetic provider (tests + offline)
// ---------------------------------------------------------------------------

/**
 * Deterministic synthetic CTC encoder: places each token at a uniform position
 * inside the interval and emits peaked one-hot posteriors. Enough to exercise
 * the Viterbi path without shipping wav2vec2 weights.
 */
export class SyntheticCtcPosteriorsProvider implements CtcFramePosteriorsProvider {
  readonly name = 'synthetic-ctc';
  readonly #frameShiftSeconds: number;

  constructor(options: { readonly frameShiftSeconds?: number } = {}) {
    this.#frameShiftSeconds = options.frameShiftSeconds ?? 0.02;
    Object.freeze(this);
  }

  async encode(input: {
    readonly pcm: Float32Array;
    readonly sampleRateHz: number;
    readonly interval: TimeInterval;
    readonly tokens: readonly string[];
  }): Promise<CtcFramePosteriors> {
    const duration =
      input.interval.end.value - input.interval.start.value;
    const numFrames = Math.max(
      1,
      Math.round(duration / this.#frameShiftSeconds),
    );
    const numTokens = input.tokens.length;
    const blankIndex = input.tokens.indexOf('');
    const blank = blankIndex >= 0 ? blankIndex : 0;
    const logProbs = new Float32Array(numFrames * numTokens);
    logProbs.fill(Math.log(1e-5));
    // Leave most frames as blank; sparse token peaks along the timeline.
    const peakEvery = Math.max(1, Math.floor(numFrames / 8));
    for (let frame = 0; frame < numFrames; frame += 1) {
      const tokenIndex =
        frame % peakEvery === 0
          ? 1 + (Math.floor(frame / peakEvery) % Math.max(1, numTokens - 1))
          : blank;
      logProbs[frame * numTokens + tokenIndex] = 0; // log(1)
    }
    return {
      logProbs,
      numFrames,
      numTokens,
      tokens: input.tokens,
      frameShiftSeconds: this.#frameShiftSeconds,
      isLogScale: true,
      blankIndex: blank,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slicePcm(
  pcm: Float32Array,
  sampleRateHz: number,
  interval: { start: number; end: number },
  timebase: AudioTimebase,
): Float32Array {
  if (timebase.unit === 'samples') {
    const start = Math.max(0, Math.floor(interval.start));
    const end = Math.min(pcm.length, Math.ceil(interval.end));
    return pcm.slice(start, end);
  }
  const start = Math.max(0, Math.floor(interval.start * sampleRateHz));
  const end = Math.min(pcm.length, Math.ceil(interval.end * sampleRateHz));
  return pcm.slice(start, end);
}

function frameToSeconds(
  frame: number,
  posteriors: CtcFramePosteriors,
  timebase: AudioTimebase,
): number {
  const seconds = frame * posteriors.frameShiftSeconds;
  return timebase.unit === 'samples' ? seconds : seconds;
}

function toAudioTime(value: number, timebase: AudioTimebase): AudioTime {
  const scaled =
    timebase.unit === 'samples'
      ? Math.round(value * (timebase.sampleRateHz ?? 1))
      : value;
  return Object.freeze({
    value: scaled,
    timebase: timebase.id,
    unit: timebase.unit,
  });
}

function validateAcousticInput(input: ForcedAlignAcousticInput): void {
  if (!input.provider?.encode) {
    throw new ForcedAlignAcousticError(
      'A CTC frame posteriors provider is required.',
    );
  }
  if (!Number.isFinite(input.sampleRateHz) || input.sampleRateHz <= 0) {
    throw new ForcedAlignAcousticError('sampleRateHz must be positive.');
  }
  if (!input.pcm || input.pcm.length === 0) {
    throw new ForcedAlignAcousticError('PCM samples are required.');
  }
  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    throw new ForcedAlignAcousticError('At least one segment is required.');
  }
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const segment of input.segments) {
    const interval = validateInterval(segment.interval, input.timebase);
    if (interval.start < previousEnd) {
      throw new ForcedAlignAcousticError(
        'Segment intervals must be monotonic and non-overlapping.',
      );
    }
    previousEnd = interval.end;
  }
}

function validatePosteriors(posteriors: CtcFramePosteriors): void {
  if (
    !posteriors ||
    !Number.isInteger(posteriors.numFrames) ||
    posteriors.numFrames <= 0 ||
    !Number.isInteger(posteriors.numTokens) ||
    posteriors.numTokens < 2
  ) {
    throw new ForcedAlignAcousticError(
      'CTC posteriors need positive frames and at least blank+token columns.',
    );
  }
  if (posteriors.logProbs.length < posteriors.numFrames * posteriors.numTokens) {
    throw new ForcedAlignAcousticError('CTC posterior tensor is too small.');
  }
  if (!Number.isFinite(posteriors.frameShiftSeconds) || posteriors.frameShiftSeconds <= 0) {
    throw new ForcedAlignAcousticError('frameShiftSeconds must be positive.');
  }
}

function validateInterval(
  interval: TimeInterval,
  timebase: AudioTimebase,
): { start: number; end: number } {
  const start = interval.start.value;
  const end = interval.end.value;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    interval.start.timebase !== timebase.id ||
    interval.end.timebase !== timebase.id ||
    interval.start.unit !== timebase.unit ||
    interval.end.unit !== timebase.unit
  ) {
    throw new ForcedAlignAcousticError(
      'Segments need valid intervals in the declared audio timebase.',
    );
  }
  return { start, end };
}
