import type { CaptionCue, WordTiming } from './types.js';

/**
 * Deterministic timestamp ↔ frame conversion. Frame time is `frame / fps`,
 * which is the same clock Remotion's `useCurrentFrame()` drives. Visibility
 * uses half-open intervals [start, end) so cues never flicker on shared edges.
 */

export function clampFrame(frame: number, durationInFrames: number): number {
  if (!Number.isFinite(frame)) return 0;
  return Math.min(
    Math.max(0, Math.floor(frame)),
    Math.max(0, durationInFrames - 1),
  );
}

export function durationInFrames(durationSeconds: number, fps: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError('durationSeconds must be finite and positive.');
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError('fps must be finite and positive.');
  }
  return Math.max(1, Math.round(durationSeconds * fps));
}

export function frameToSeconds(frame: number, fps: number): number {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) {
    throw new RangeError('frame and fps must be finite; fps must be positive.');
  }
  return frame / fps;
}

export function secondsToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(
      'seconds and fps must be finite; fps must be positive.',
    );
  }
  return Math.round(seconds * fps);
}

export function isCueVisibleAt(
  cue: Pick<CaptionCue, 'startSeconds' | 'endSeconds'>,
  timeSeconds: number,
): boolean {
  return cue.startSeconds <= timeSeconds && timeSeconds < cue.endSeconds;
}

export function isCueVisibleAtFrame(
  cue: Pick<CaptionCue, 'startSeconds' | 'endSeconds'>,
  frame: number,
  fps: number,
): boolean {
  return isCueVisibleAt(cue, frameToSeconds(frame, fps));
}

/** Words revealed by `timeSeconds` under word-by-word mode (inclusive of start). */
export function visibleWordsAt(
  words: readonly WordTiming[],
  timeSeconds: number,
): readonly WordTiming[] {
  return words.filter((word) => word.startSeconds <= timeSeconds);
}

/** The single word currently spoken for karaoke highlighting, or null. */
export function activeWordAt(
  words: readonly WordTiming[],
  timeSeconds: number,
): WordTiming | null {
  for (const word of words) {
    if (word.startSeconds <= timeSeconds && timeSeconds < word.endSeconds) {
      return word;
    }
  }
  return null;
}

export function cueProgress(
  cue: Pick<CaptionCue, 'startSeconds' | 'endSeconds'>,
  timeSeconds: number,
): number {
  const span = cue.endSeconds - cue.startSeconds;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (timeSeconds - cue.startSeconds) / span));
}

/**
 * Map a cue's character stream onto fitted lines so word reveal and karaoke
 * highlighting stay on the same wrapping the caption fitter produced.
 */
export interface LineWordSpan {
  readonly lineIndex: number;
  readonly wordIndex: number;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Character range within the joined line text. */
  readonly charStart: number;
  readonly charEnd: number;
}

export function mapWordsToLines(
  lines: readonly string[],
  words: readonly WordTiming[],
): readonly LineWordSpan[] {
  const spans: LineWordSpan[] = [];
  let wordIndex = 0;
  for (const [lineIndex, line] of lines.entries()) {
    let cursor = 0;
    while (wordIndex < words.length && cursor < line.length) {
      const word = words[wordIndex]!;
      const raw = word.text;
      const start = line.indexOf(raw, cursor);
      if (start < 0) {
        // Word text does not appear on this line; advance past the word.
        wordIndex += 1;
        continue;
      }
      spans.push({
        lineIndex,
        wordIndex,
        text: raw,
        startSeconds: word.startSeconds,
        endSeconds: word.endSeconds,
        charStart: start,
        charEnd: start + raw.length,
      });
      cursor = start + raw.length;
      wordIndex += 1;
    }
  }
  return spans;
}
