import { describe, expect, it } from 'vitest';
import {
  applyWordDrag,
  rescaleWordsToCue,
  splitCaptionWords,
  wordsForEditing,
} from '../../apps/web/src/word-timing-edit.js';

const TEXT = 'The city is under attack!';

describe('word-timing-edit', () => {
  it('splits caption tokens', () => {
    expect(splitCaptionWords(TEXT)).toEqual([
      'The',
      'city',
      'is',
      'under',
      'attack!',
    ]);
  });

  it('creates even slices when no stored timings exist', () => {
    const rows = wordsForEditing(TEXT, 1, 2);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.start).toBeCloseTo(1);
    expect(rows[4]!.end).toBeCloseTo(2);
    expect(rows[1]!.start).toBeGreaterThan(rows[0]!.start);
  });

  it('keeps stored timings when token count matches', () => {
    const stored = [
      { text: 'The', start: 1, end: 1.1 },
      { text: 'city', start: 1.1, end: 1.2 },
      { text: 'is', start: 1.2, end: 1.3 },
      { text: 'under', start: 1.3, end: 1.5 },
      { text: 'attack!', start: 1.5, end: 2 },
    ];
    const rows = wordsForEditing(TEXT, 1, 2, stored);
    expect(rows[0]!.start).toBe(1);
    expect(rows[3]!.end).toBe(1.5);
  });

  it('dragging a word body shifts it without inverting neighbors', () => {
    const rows = wordsForEditing(TEXT, 1, 2);
    const next = applyWordDrag(rows, { index: 1, delta: 0.05 }, 1, 2);
    expect(next[1]!.start).toBeGreaterThan(rows[1]!.start);
    expect(next[1]!.end).toBeGreaterThan(rows[1]!.end);
    // Neighbors unchanged.
    expect(next[0]).toEqual(rows[0]);
    expect(next[2]).toEqual(rows[2]);
  });

  it('resizing edges clamps inside the cue and against neighbors', () => {
    const rows = wordsForEditing(TEXT, 1, 2);
    const lateStart = applyWordDrag(rows, { index: 1, start: 0.5 }, 1, 2);
    expect(lateStart[1]!.start).toBeGreaterThanOrEqual(1);
    // Must stay after previous word.
    expect(lateStart[1]!.start).toBeGreaterThanOrEqual(rows[0]!.start + 0.02);

    const lateEnd = applyWordDrag(rows, { index: 3, end: 99 }, 1, 2);
    expect(lateEnd[3]!.end).toBeLessThanOrEqual(2);
  });

  it('keeps a minimal word span', () => {
    const rows = wordsForEditing(TEXT, 1, 2);
    const collapsed = applyWordDrag(
      rows,
      { index: 2, start: 1.5, end: 1.5 },
      1,
      2,
    );
    expect(collapsed[2]!.end - collapsed[2]!.start).toBeGreaterThanOrEqual(0.02);
  });

  it('rescales stored words when the cue interval changes', () => {
    const stored = [
      { text: 'The', start: 1, end: 1.2 },
      { text: 'city', start: 1.2, end: 2 },
    ];
    const scaled = rescaleWordsToCue(stored, 0, 4);
    expect(scaled[0]!.start).toBeCloseTo(0);
    expect(scaled[scaled.length - 1]!.end).toBeCloseTo(4);
    expect(scaled[1]!.start).toBeGreaterThan(scaled[0]!.start);
  });
});
