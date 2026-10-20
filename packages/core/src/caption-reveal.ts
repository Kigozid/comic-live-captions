/**
 * Deterministic caption reveal engine.
 *
 * Single source of truth for progressive caption reveal shared by the live
 * preview and every export path (browser SVG frames and the Remotion
 * composer). The reveal state is a pure function of playback time, so the
 * same timestamp always produces the same visible text — under playback,
 * pause, seeking, replay, and frame-accurate export alike.
 *
 * Default `smooth-phrase` shows readable 2–3 word chunks with a quick fade —
 * natural speech-bubble subtitles. `word-by-word` and `character-by-character`
 * remain available; `phrase` dumps the full sentence at dialogue start.
 *
 * Design rules enforced here (mirroring the product spec):
 *  - A bubble is empty before its dialogue starts.
 *  - Chunks/words appear as they are spoken; earlier text stays visible.
 *  - Punctuation and original spacing are preserved; words are never split.
 *  - Future dialogue is never revealed early; overlapping captions are
 *    independent.
 *  - Completed dialogue persists according to an explicit bubble-reuse policy.
 *  - Layout is computed from the full sentence; reveal only paints a prefix.
 */

/** How the caption text is progressively revealed. */
export type CaptionRevealMode =
  | 'smooth-phrase'
  | 'phrase'
  | 'word-by-word'
  | 'character-by-character';

/** What a bubble shows when it is reused by a later caption. */
export type BubbleReusePolicy = 'retain' | 'replace' | 'clear';

/** Target words per smooth-phrase chunk (readable speech-bubble subtitles). */
export const SMOOTH_PHRASE_MAX_WORDS = 3;
/** Pause length (seconds) that ends a smooth-phrase chunk. */
export const SMOOTH_PHRASE_PAUSE_SECONDS = 0.12;
/** Quick opacity ramp when a chunk appears (no typewriter cursor). */
export const SMOOTH_PHRASE_FADE_SECONDS = 0.09;

/**
 * A timed text token. `text` keeps its own punctuation (e.g. `"attack!"`).
 * `charStart`/`charEnd` (optional) locate the token inside `sourceText` so the
 * revealed string can reproduce the original spacing exactly.
 */
export interface RevealToken {
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** True when timings were estimated rather than acoustically aligned. */
  readonly estimated?: boolean | undefined;
  /** Character offset of this token within `sourceText`, when available. */
  readonly charStart?: number | undefined;
  /** Character offset just past this token within `sourceText`. */
  readonly charEnd?: number | undefined;
}

export interface CaptionRevealOptions {
  /** Default: `smooth-phrase` (2–3 word readable chunks). */
  readonly mode?: CaptionRevealMode | undefined;
  /**
   * Full caption text. When provided together with per-token `charEnd`, the
   * revealed string is a prefix of this exact string (spacing preserved).
   */
  readonly sourceText?: string | undefined;
}

/** Per-token reveal state at a given playback time. */
export interface RevealTokenState {
  readonly index: number;
  readonly token: RevealToken;
  /** Token is fully shown (its text is part of the visible caption). */
  readonly revealed: boolean;
  /** Token is currently spoken — used for karaoke highlight. */
  readonly active: boolean;
  /** Fraction of the token revealed in [0, 1]; 1 once fully revealed. */
  readonly progress: number;
  /**
   * Paint opacity for a soft chunk fade (1 = solid). Smooth-phrase ramps this
   * over `SMOOTH_PHRASE_FADE_SECONDS`; other modes are 0/1.
   */
  readonly opacity: number;
  /** The substring of the token currently shown (empty when not revealed). */
  readonly text: string;
  readonly estimated: boolean;
}

export interface CaptionRevealState {
  readonly mode: CaptionRevealMode;
  readonly tokens: readonly RevealTokenState[];
  /** Number of fully-revealed tokens (prefix length under word reveal). */
  readonly revealedTokenCount: number;
  /** Currently visible caption text, punctuation + spacing preserved. */
  readonly visibleText: string;
  /** Index of the token being spoken right now, or -1. */
  readonly activeTokenIndex: number;
  /** True once the caption's first token has begun. */
  readonly started: boolean;
  /** True once the caption's last token has finished. */
  readonly finished: boolean;
  /** True when nothing is visible yet (empty bubble). */
  readonly isEmpty: boolean;
  /** True when any token timing is estimated rather than aligned. */
  readonly estimated: boolean;
}

function assertFiniteTime(timeSeconds: number): void {
  if (!Number.isFinite(timeSeconds)) {
    throw new RangeError('Caption reveal requires a finite playback time.');
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * One smooth-phrase chunk: a contiguous run of whole words.
 * Never splits a word. Boundaries respect punctuation and pauses.
 */
export interface PhraseChunk {
  readonly startTokenIndex: number;
  readonly endTokenIndex: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

function endsPhrase(token: RevealToken): boolean {
  return /[.!?…;:]["')\]]?$/.test(token.text.trim());
}

/**
 * Group timed words into readable 2–3 word chunks for speech-bubble subtitles.
 *
 * Closes a chunk when it already has `maxWords` words, after punctuation, or
 * when a spoken pause before the next word exceeds `pauseSeconds`. Whole
 * words only — tokens are never split.
 */
export function chunkRevealTokens(
  tokens: readonly RevealToken[],
  options: {
    readonly maxWords?: number;
    readonly pauseSeconds?: number;
  } = {},
): readonly PhraseChunk[] {
  const maxWords = Math.max(1, options.maxWords ?? SMOOTH_PHRASE_MAX_WORDS);
  const pauseSeconds = options.pauseSeconds ?? SMOOTH_PHRASE_PAUSE_SECONDS;
  const chunks: PhraseChunk[] = [];
  if (tokens.length === 0) return chunks;

  let start = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = index + 1 < tokens.length ? tokens[index + 1] : null;
    const count = index - start + 1;
    const pauseBeforeNext = next
      ? next.startSeconds - token.endSeconds
      : Infinity;
    const shouldClose =
      index === tokens.length - 1 ||
      count >= maxWords ||
      endsPhrase(token) ||
      pauseBeforeNext >= pauseSeconds;
    if (shouldClose) {
      chunks.push({
        startTokenIndex: start,
        endTokenIndex: index,
        startSeconds: tokens[start]!.startSeconds,
        endSeconds: token.endSeconds,
      });
      start = index + 1;
    }
  }
  return chunks;
}

function chunkStartForToken(
  chunks: readonly PhraseChunk[],
  tokenIndex: number,
): number {
  for (const chunk of chunks) {
    if (tokenIndex >= chunk.startTokenIndex && tokenIndex <= chunk.endTokenIndex)
      return chunk.startSeconds;
  }
  return Infinity;
}

/**
 * Deterministic reveal state for one caption at `timeSeconds`.
 *
 * - `smooth-phrase` (default): 2–3 word chunks appear together with a quick
 *   fade — natural in-bubble subtitles, no typewriter cursor.
 * - `word-by-word`: each token at its start time.
 * - `phrase`: entire caption at the first token start (legacy).
 * - `character-by-character`: fill across each token's spoken interval.
 */
export function captionRevealAt(
  tokens: readonly RevealToken[],
  timeSeconds: number,
  options: CaptionRevealOptions = {},
): CaptionRevealState {
  assertFiniteTime(timeSeconds);
  const mode: CaptionRevealMode = options.mode ?? 'smooth-phrase';
  const sourceText = options.sourceText;
  const hasSpans =
    typeof sourceText === 'string' &&
    tokens.every(
      (token) =>
        Number.isInteger(token.charStart) && Number.isInteger(token.charEnd),
    );

  const phraseStart =
    tokens.length === 0
      ? Infinity
      : Math.min(...tokens.map((token) => token.startSeconds));

  let activeTokenIndex = -1;
  for (const [index, token] of tokens.entries()) {
    if (token.startSeconds <= timeSeconds && timeSeconds < token.endSeconds) {
      activeTokenIndex = index;
      break;
    }
  }

  const chunks =
    mode === 'smooth-phrase' ? chunkRevealTokens(tokens) : [];
  const fade = Math.max(0.001, SMOOTH_PHRASE_FADE_SECONDS);

  const tokenStates: RevealTokenState[] = tokens.map((token, index) => {
    const span = token.endSeconds - token.startSeconds;
    const estimated = token.estimated === true;
    let progress: number;
    let opacity: number;
    if (mode === 'phrase') {
      progress = timeSeconds >= phraseStart ? 1 : 0;
      opacity = progress;
    } else if (mode === 'smooth-phrase') {
      const chunkStart = chunkStartForToken(chunks, index);
      if (timeSeconds < chunkStart) {
        progress = 0;
        opacity = 0;
      } else {
        // Whole words only: once the chunk starts, text is fully present and
        // opacity ramps quickly so the group fades in instead of popping.
        progress = 1;
        opacity = clamp01((timeSeconds - chunkStart) / fade);
      }
    } else if (mode === 'word-by-word') {
      progress = timeSeconds >= token.startSeconds ? 1 : 0;
      opacity = progress;
    } else {
      // character-by-character: fill across the token's spoken interval.
      if (timeSeconds < token.startSeconds) progress = 0;
      else if (timeSeconds >= token.endSeconds) progress = 1;
      else
        progress = span > 0
          ? clamp01((timeSeconds - token.startSeconds) / span)
          : 1;
      opacity = progress > 0 ? 1 : 0;
    }
    const revealed = progress >= 1;
    const text = revealed
      ? token.text
      : progress <= 0
        ? ''
        : token.text.slice(0, Math.floor(token.text.length * progress));
    return {
      index,
      token,
      revealed,
      active: index === activeTokenIndex,
      progress,
      opacity,
      text,
      estimated,
    };
  });

  const revealedTokens = tokenStates.filter((state) => state.revealed);
  const revealedTokenCount = revealedTokens.length;

  // Reconstruct the visible string. Prefer an exact prefix of sourceText to
  // preserve original spacing; fall back to space-joined token text.
  let visibleText: string;
  const anyPartial = tokenStates.some(
    (state) => !state.revealed && state.progress > 0,
  );
  if (hasSpans && sourceText !== undefined && (revealedTokenCount > 0 || anyPartial)) {
    let end: number;
    const partial = tokenStates.find((state) => !state.revealed && state.progress > 0);
    if (partial) {
      const start = partial.token.charStart ?? 0;
      end = start + Math.floor(partial.text.length);
    } else {
      const last = revealedTokens[revealedTokenCount - 1]!;
      end = last.token.charEnd ?? last.token.charStart ?? 0;
    }
    visibleText = sourceText.slice(0, end);
  } else {
    visibleText = tokenStates
      .filter((state) => state.text.length > 0)
      .map((state) => state.text)
      .join(' ');
  }

  const started = tokens.length > 0 && timeSeconds >= phraseStart;
  const finished =
    tokens.length > 0 && timeSeconds >= tokens[tokens.length - 1]!.endSeconds;

  return {
    mode,
    tokens: tokenStates,
    revealedTokenCount,
    visibleText,
    activeTokenIndex,
    started,
    finished,
    isEmpty: revealedTokenCount === 0 && !anyPartial,
    estimated: tokenStates.some((state) => state.estimated),
  };
}

/**
 * Assign `charStart`/`charEnd` to timed words by locating them in `sourceText`
 * in order, so `captionRevealAt` can reproduce exact spacing. Words that cannot
 * be located keep their span undefined (the reveal then falls back to
 * space-joined text).
 */
export function assignTokenSpans(
  sourceText: string,
  tokens: readonly RevealToken[],
): readonly RevealToken[] {
  const spans: RevealToken[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = sourceText.indexOf(token.text, cursor);
    if (start < 0) {
      spans.push(token);
      continue;
    }
    const end = start + token.text.length;
    spans.push({ ...token, charStart: start, charEnd: end });
    cursor = end;
  }
  return spans;
}

/**
 * Even, word-aligned token timing for a caption that only has sentence-level
 * `[startSeconds, endSeconds]`. Marked `estimated` so diagnostics can tell these
 * apart from real forced-alignment timings — never passed off as accurate.
 */
export function synthesizeRevealTokens(
  text: string,
  startSeconds: number,
  endSeconds: number,
): readonly RevealToken[] {
  const parts = text.split(/\s+/).filter((part) => part.length > 0);
  const span = Math.max(0, endSeconds - startSeconds);
  const slice = span / Math.max(1, parts.length);
  return parts.map((word, index) => ({
    text: word,
    startSeconds: startSeconds + index * slice,
    endSeconds: startSeconds + (index + 1) * slice,
    estimated: true,
  }));
}

/**
 * True when provided word timings can drive a genuine typewriter reveal.
 *
 * Rejects the failure modes that dump a full caption at once:
 *  - non-finite or inverted spans
 *  - every word sharing the same start (collapsed to the cue)
 *  - starts that go backwards
 *  - multi-word cues whose tokens all begin before the first word would finish
 */
export function areProgressiveWordTimings(
  tokens: readonly RevealToken[],
  cueStartSeconds: number,
  cueEndSeconds: number,
): boolean {
  if (tokens.length === 0) return false;
  if (!Number.isFinite(cueStartSeconds) || !Number.isFinite(cueEndSeconds))
    return false;
  if (cueEndSeconds <= cueStartSeconds) return false;
  let previousStart = -Infinity;
  let distinctStarts = 0;
  for (const token of tokens) {
    const { startSeconds, endSeconds } = token;
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      endSeconds < startSeconds
    )
      return false;
    // Allow a tiny tolerance past the cue bounds for ASR rounding.
    if (startSeconds < cueStartSeconds - 0.25) return false;
    if (endSeconds > cueEndSeconds + 0.25) return false;
    if (startSeconds < previousStart) return false;
    if (startSeconds > previousStart) distinctStarts += 1;
    previousStart = startSeconds;
  }
  // A single token is fine (one-word line). Multiple tokens must not all
  // share one start time — that reveals the whole sentence at once.
  if (tokens.length > 1 && distinctStarts < 2) return false;
  return true;
}

/**
 * Prefer acoustic word timings when they actually stagger; otherwise fall
 * back to even slices so the typewriter effect is never replaced by a
 * one-shot full-line dump. Never claims estimated slices are acoustic.
 */
export function normalizeRevealTokens(
  provided: readonly RevealToken[] | undefined,
  text: string,
  cueStartSeconds: number,
  cueEndSeconds: number,
): readonly RevealToken[] {
  if (provided && areProgressiveWordTimings(provided, cueStartSeconds, cueEndSeconds)) {
    return provided;
  }
  return synthesizeRevealTokens(text, cueStartSeconds, cueEndSeconds);
}

/** Minimal shape `activeCaptionsAt` needs from a timed caption. */
export interface RevealCaptionRef {
  readonly id: string;
  readonly bubbleId: string | null;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface ActiveCaptionsOptions {
  /**
   * How a bubble behaves when a later caption reuses it:
   *  - `replace` (default): only the most recently started caption in the
   *    bubble is shown; it persists until superseded.
   *  - `retain`: every started caption stays visible (accumulates).
   *  - `clear`: a caption shows only while it is spoken, then the bubble goes
   *    empty before the next dialogue begins.
   */
  readonly reusePolicy?: BubbleReusePolicy | undefined;
}

/**
 * Which captions should render at `timeSeconds`.
 *
 * Guarantees inactive bubbles stay empty (only started captions are returned)
 * while completed dialogue persists per the reuse policy. Pure in `t`, so
 * seeking reproduces the exact same set.
 */
export function activeCaptionsAt<T extends RevealCaptionRef>(
  captions: readonly T[],
  timeSeconds: number,
  options: ActiveCaptionsOptions = {},
): readonly T[] {
  assertFiniteTime(timeSeconds);
  const policy: BubbleReusePolicy = options.reusePolicy ?? 'replace';

  const started = captions.filter((c) => timeSeconds >= c.startSeconds);
  if (policy === 'clear') {
    // Only the currently-spoken caption(s) are visible; empty once finished.
    return started.filter((c) => timeSeconds < c.endSeconds);
  }

  if (policy === 'retain') return started;

  // 'replace': per bubble keep only the most recently started caption.
  const latestByBubble = new Map<string, T>();
  const unassigned: T[] = [];
  for (const caption of started) {
    if (caption.bubbleId === null) {
      unassigned.push(caption);
      continue;
    }
    const current = latestByBubble.get(caption.bubbleId);
    if (!current || caption.startSeconds >= current.startSeconds) {
      latestByBubble.set(caption.bubbleId, caption);
    }
  }
  return [...latestByBubble.values(), ...unassigned];
}
