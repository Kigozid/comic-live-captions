/**
 * Deterministic caption reveal engine.
 *
 * Single source of truth for progressive (word-by-word / character) caption
 * reveal shared by the live preview and every export path (browser SVG frames
 * and the Remotion composer). The reveal state is a pure function of playback
 * time, so the same timestamp always produces the same visible text — under
 * playback, pause, seeking, replay, and frame-accurate export alike.
 *
 * Design rules enforced here (mirroring the product spec):
 *  - A bubble is empty before its dialogue starts.
 *  - Words appear as they are spoken; earlier words stay visible.
 *  - Punctuation and original spacing are preserved.
 *  - Future dialogue is never revealed early; overlapping captions are
 *    independent.
 *  - Completed dialogue persists according to an explicit bubble-reuse policy.
 */

/** How the caption text is progressively revealed. */
export type CaptionRevealMode =
  | 'phrase'
  | 'word-by-word'
  | 'character-by-character';

/** What a bubble shows when it is reused by a later caption. */
export type BubbleReusePolicy = 'retain' | 'replace' | 'clear';

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
  /** Default: `word-by-word`. */
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
 * Deterministic reveal state for one caption at `timeSeconds`.
 *
 * Word-by-word (default) reveals each whole token the instant its start time is
 * reached. Character mode fills a token across its `[start, end)` interval so it
 * is complete by the spoken word's end. Phrase mode shows the whole caption at
 * the caption's first token start.
 */
export function captionRevealAt(
  tokens: readonly RevealToken[],
  timeSeconds: number,
  options: CaptionRevealOptions = {},
): CaptionRevealState {
  assertFiniteTime(timeSeconds);
  const mode: CaptionRevealMode = options.mode ?? 'word-by-word';
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

  const tokenStates: RevealTokenState[] = tokens.map((token, index) => {
    const span = token.endSeconds - token.startSeconds;
    const estimated = token.estimated === true;
    let progress: number;
    if (mode === 'phrase') {
      progress = timeSeconds >= phraseStart ? 1 : 0;
    } else if (mode === 'word-by-word') {
      progress = timeSeconds >= token.startSeconds ? 1 : 0;
    } else {
      // character-by-character: fill across the token's spoken interval.
      if (timeSeconds < token.startSeconds) progress = 0;
      else if (timeSeconds >= token.endSeconds) progress = 1;
      else progress = span > 0 ? clamp01((timeSeconds - token.startSeconds) / span) : 1;
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
