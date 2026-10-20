/**
 * Pure helpers for manual word-timing editing.
 *
 * The inspector shows a per-caption cue strip; these functions turn drag
 * gestures into clamped `DialogueWordTiming` updates without touching DOM
 * types so they stay unit-testable.
 */

export interface EditableWordTiming {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface WordDrag {
  /** Index of the word being adjusted. */
  readonly index: number;
  /** New start seconds (omit to keep). */
  readonly start?: number;
  /** New end seconds (omit to keep). */
  readonly end?: number;
  /** Shift both edges by this many seconds (omit for edge-only edits). */
  readonly delta?: number;
}

const MIN_WORD_SPAN = 0.02;

/** Split caption text into display tokens (punctuation stays attached). */
export function splitCaptionWords(text: string): string[] {
  return text.split(/\s+/).filter((part) => part.length > 0);
}

/**
 * Word rows for the editor. Prefers stored timings; otherwise even slices
 * across the cue so the user always has something to drag. Never pretends
 * estimated slices are acoustic.
 */
export function wordsForEditing(
  captionText: string,
  cueStart: number,
  cueEnd: number,
  stored?: readonly EditableWordTiming[],
): EditableWordTiming[] {
  const tokens = splitCaptionWords(captionText);
  if (
    stored &&
    stored.length === tokens.length &&
    stored.every(
      (word) => Number.isFinite(word.start) && Number.isFinite(word.end),
    )
  ) {
    return tokens.map((text, index) => ({
      text,
      start: stored[index]!.start,
      end: stored[index]!.end,
    }));
  }
  const span = Math.max(MIN_WORD_SPAN, cueEnd - cueStart);
  const slice = span / Math.max(1, tokens.length);
  return tokens.map((text, index) => ({
    text,
    start: cueStart + index * slice,
    end: cueStart + (index + 1) * slice,
  }));
}

/**
 * Apply a drag to one word, clamped inside the cue and kept ordered
 * against neighbors so typewriter reveal stays monotonic.
 */
export function applyWordDrag(
  words: readonly EditableWordTiming[],
  drag: WordDrag,
  cueStart: number,
  cueEnd: number,
): EditableWordTiming[] {
  const index = drag.index;
  if (index < 0 || index >= words.length) return [...words];
  if (!(cueEnd > cueStart)) return [...words];

  const current = words[index]!;
  const previous = index > 0 ? words[index - 1] : null;
  const next = index < words.length - 1 ? words[index + 1] : null;

  let start = drag.start ?? current.start;
  let end = drag.end ?? current.end;
  if (drag.delta != null && Number.isFinite(drag.delta)) {
    start += drag.delta;
    end += drag.delta;
  }

  // Keep at least a minimal span.
  if (end - start < MIN_WORD_SPAN) end = start + MIN_WORD_SPAN;

  // Clamp to the cue.
  start = Math.min(Math.max(start, cueStart), cueEnd - MIN_WORD_SPAN);
  end = Math.min(Math.max(end, start + MIN_WORD_SPAN), cueEnd);

  // Stay after the previous word and before the next.
  if (previous) {
    const floor = previous.start + MIN_WORD_SPAN;
    if (start < floor) {
      const shift = floor - start;
      start += shift;
      end += shift;
    }
  }
  if (next) {
    const ceiling = next.end - MIN_WORD_SPAN;
    if (end > ceiling) {
      const shift = end - ceiling;
      start -= shift;
      end -= shift;
    }
    if (start < (previous ? previous.start + MIN_WORD_SPAN : cueStart)) {
      start = previous ? previous.start + MIN_WORD_SPAN : cueStart;
    }
    if (end <= start) end = start + MIN_WORD_SPAN;
    if (end > next.end - MIN_WORD_SPAN) end = Math.max(start + MIN_WORD_SPAN, next.end - MIN_WORD_SPAN);
    if (start < (previous ? previous.end : cueStart) && previous) {
      // Allow overlap only with the immediate neighbor start, not crossing.
      if (start < previous.start + MIN_WORD_SPAN) start = previous.start + MIN_WORD_SPAN;
    }
  } else {
    end = Math.min(end, cueEnd);
    start = Math.min(start, end - MIN_WORD_SPAN);
    start = Math.max(start, previous ? previous.start + MIN_WORD_SPAN : cueStart);
  }

  // Final safety: finite numbers inside the cue.
  start = Math.min(Math.max(Number.isFinite(start) ? start : cueStart, cueStart), cueEnd - MIN_WORD_SPAN);
  end = Math.min(Math.max(Number.isFinite(end) ? end : start + MIN_WORD_SPAN, start + MIN_WORD_SPAN), cueEnd);

  const updated = [...words];
  updated[index] = { text: current.text, start, end };
  return updated;
}

/** Stretch/shrink the whole word row to a new cue interval. */
export function rescaleWordsToCue(
  words: readonly EditableWordTiming[],
  cueStart: number,
  cueEnd: number,
): EditableWordTiming[] {
  if (words.length === 0 || !(cueEnd > cueStart)) return [...words];
  const first = words[0]!.start;
  const last = words[words.length - 1]!.end;
  const span = Math.max(MIN_WORD_SPAN, last - first);
  const target = Math.max(MIN_WORD_SPAN * words.length, cueEnd - cueStart);
  const scale = target / span;
  return words.map((word) => {
    const start = cueStart + (word.start - first) * scale;
    const end = cueStart + (word.end - first) * scale;
    return {
      text: word.text,
      start: Math.max(cueStart, start),
      end: Math.min(cueEnd, Math.max(start + MIN_WORD_SPAN, end)),
    };
  });
}
