import { describe, expect, it } from 'vitest';
import {
  activeCaptionsAt,
  assignTokenSpans,
  captionRevealAt,
  type RevealToken,
} from '@comic-captioner/core';

/** "The city is under attack!" with realistic monotonic word timings. */
const SOURCE = 'The city is under attack!';
function attackWords(): readonly RevealToken[] {
  return assignTokenSpans(SOURCE, [
    { text: 'The', startSeconds: 0.0, endSeconds: 0.24 },
    { text: 'city', startSeconds: 0.24, endSeconds: 0.5 },
    { text: 'is', startSeconds: 0.5, endSeconds: 0.62 },
    { text: 'under', startSeconds: 0.62, endSeconds: 0.9 },
    { text: 'attack!', startSeconds: 0.9, endSeconds: 1.3 },
  ]);
}

describe('captionRevealAt — word-by-word (default)', () => {
  it('1. keeps the bubble empty before the dialogue starts', () => {
    const state = captionRevealAt(attackWords(), -0.5, { sourceText: SOURCE });
    expect(state.isEmpty).toBe(true);
    expect(state.visibleText).toBe('');
    expect(state.revealedTokenCount).toBe(0);
    expect(state.started).toBe(false);
  });

  it('2. reveals only the first word at its timestamp', () => {
    const state = captionRevealAt(attackWords(), 0.0, { sourceText: SOURCE });
    expect(state.visibleText).toBe('The');
    expect(state.revealedTokenCount).toBe(1);
  });

  it('3. reveals additional words progressively', () => {
    const words = attackWords();
    expect(captionRevealAt(words, 0.3, { sourceText: SOURCE }).visibleText).toBe(
      'The city',
    );
    expect(captionRevealAt(words, 0.7, { sourceText: SOURCE }).visibleText).toBe(
      'The city is under',
    );
    expect(captionRevealAt(words, 1.2, { sourceText: SOURCE }).visibleText).toBe(
      SOURCE,
    );
  });

  it('4. preserves punctuation and original spacing', () => {
    const words = attackWords();
    const state = captionRevealAt(words, 1.2, { sourceText: SOURCE });
    expect(state.visibleText).toBe('The city is under attack!');
    // Partial step keeps the trailing space out of the revealed prefix.
    const mid = captionRevealAt(words, 0.3, { sourceText: SOURCE });
    expect(mid.visibleText).toBe('The city');
    expect(mid.visibleText.startsWith('The city is')).toBe(false);
  });

  it('marks the spoken word active for karaoke and keeps others inactive', () => {
    const state = captionRevealAt(attackWords(), 0.3, { sourceText: SOURCE });
    expect(state.activeTokenIndex).toBe(1);
    expect(state.tokens.filter((t) => t.active)).toHaveLength(1);
    expect(state.tokens[1]!.active).toBe(true);
    expect(state.tokens[1]!.text).toBe('city');
  });

  it('reports finished only after the last word ends', () => {
    const words = attackWords();
    expect(captionRevealAt(words, 1.29, { sourceText: SOURCE }).finished).toBe(
      false,
    );
    expect(captionRevealAt(words, 1.3, { sourceText: SOURCE }).finished).toBe(
      true,
    );
  });
});

describe('captionRevealAt — determinism & seeking', () => {
  it('8. is a pure function of time (seek back/forward reproduces state)', () => {
    const words = attackWords();
    const first = captionRevealAt(words, 0.7, { sourceText: SOURCE });
    const later = captionRevealAt(words, 1.2, { sourceText: SOURCE });
    const backAgain = captionRevealAt(words, 0.7, { sourceText: SOURCE });
    expect(backAgain).toEqual(first);
    expect(later.visibleText).not.toBe(first.visibleText);
  });

  it('9. yields identical results for identical timestamps (preview == export)', () => {
    const words = attackWords();
    const a = captionRevealAt(words, 0.55, { sourceText: SOURCE });
    const b = captionRevealAt(words, 0.55, { sourceText: SOURCE });
    expect(a.visibleText).toBe(b.visibleText);
    expect(a.revealedTokenCount).toBe(b.revealedTokenCount);
    expect(a.activeTokenIndex).toBe(b.activeTokenIndex);
  });

  it('throws on non-finite playback time', () => {
    expect(() => captionRevealAt(attackWords(), NaN)).toThrow(RangeError);
  });
});

describe('captionRevealAt — reveal modes', () => {
  it('phrase mode shows the whole caption at once at the caption start', () => {
    const words = attackWords();
    expect(
      captionRevealAt(words, 0.05, { sourceText: SOURCE, mode: 'phrase' })
        .visibleText,
    ).toBe(SOURCE);
    expect(
      captionRevealAt(words, -0.1, { sourceText: SOURCE, mode: 'phrase' })
        .visibleText,
    ).toBe('');
  });

  it('character mode fills each word across its interval, complete by word end', () => {
    const words = attackWords();
    // At the start of "attack!" (0.9) nothing of it shows yet; by 1.3 all does.
    const atStart = captionRevealAt(words, 0.9, {
      sourceText: SOURCE,
      mode: 'character-by-character',
    });
    const partial = captionRevealAt(words, 1.1, {
      sourceText: SOURCE,
      mode: 'character-by-character',
    });
    const atEnd = captionRevealAt(words, 1.3, {
      sourceText: SOURCE,
      mode: 'character-by-character',
    });
    expect(atEnd.visibleText).toBe(SOURCE);
    expect(partial.visibleText.length).toBeGreaterThan(atStart.visibleText.length);
    expect(partial.visibleText.length).toBeLessThan(atEnd.visibleText.length);
    expect(atEnd.finished).toBe(true);
  });
});

describe('activeCaptionsAt — inactive empty, persistence, reuse', () => {
  type C = { id: string; bubbleId: string | null; startSeconds: number; endSeconds: number };
  const a: C = { id: 'a', bubbleId: 'b1', startSeconds: 0, endSeconds: 1 };
  const b: C = { id: 'b', bubbleId: 'b1', startSeconds: 2, endSeconds: 3 };
  const other: C = { id: 'c', bubbleId: 'b2', startSeconds: 0.5, endSeconds: 1.5 };

  it('5. keeps a bubble empty until its dialogue begins', () => {
    const ids = activeCaptionsAt([a, b], 0.2).map((c) => c.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
  });

  it('6. replace policy keeps completed text until superseded', () => {
    const during = activeCaptionsAt([a, b], 0.5).map((c) => c.id);
    expect(during).toEqual(['a']);
    const after = activeCaptionsAt([a, b], 1.5).map((c) => c.id); // a done, b not started
    expect(after).toEqual(['a']); // persists
    const superseded = activeCaptionsAt([a, b], 2.5).map((c) => c.id); // b replaced a
    expect(superseded).toEqual(['b']);
  });

  it('6. retain policy accumulates every started caption in the bubble', () => {
    const ids = activeCaptionsAt([a, b], 2.5, { reusePolicy: 'retain' }).map(
      (c) => c.id,
    );
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('6. clear policy empties the bubble after the dialogue finishes', () => {
    const during = activeCaptionsAt([a, b], 0.5, { reusePolicy: 'clear' }).map(
      (c) => c.id,
    );
    expect(during).toEqual(['a']);
    const after = activeCaptionsAt([a, b], 1.5, { reusePolicy: 'clear' }).map(
      (c) => c.id,
    );
    expect(after).toEqual([]);
  });

  it('7. overlapping dialogue stays independent across bubbles', () => {
    const ids = activeCaptionsAt([a, other], 1.0).map((c) => c.id).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('is pure in time (seeking reproduces the same active set)', () => {
    expect(activeCaptionsAt([a, b], 1.5)).toEqual(activeCaptionsAt([a, b], 1.5));
    expect(activeCaptionsAt([a, b], 0.5).map((c) => c.id)).toEqual(['a']);
    expect(activeCaptionsAt([a, b], 1.5).map((c) => c.id)).toEqual(['a']);
    expect(activeCaptionsAt([a, b], 0.5).map((c) => c.id)).toEqual(['a']);
  });
});

describe('helpers', () => {
  it('assignTokenSpans locates words in the source text in order', () => {
    const spans = assignTokenSpans(SOURCE, [
      { text: 'The', startSeconds: 0, endSeconds: 0.2 },
      { text: 'attack!', startSeconds: 0.9, endSeconds: 1.3 },
    ]);
    expect(spans[0]!.charStart).toBe(0);
    expect(spans[0]!.charEnd).toBe(3);
    expect(spans[1]!.charStart).toBe(18);
    expect(SOURCE.slice(spans[1]!.charStart!, spans[1]!.charEnd!)).toBe('attack!');
  });

  it('falls back to space-joined text when spans are unavailable', () => {
    const state = captionRevealAt(
      [
        { text: 'Hello,', startSeconds: 0, endSeconds: 0.5 },
        { text: 'world!', startSeconds: 0.5, endSeconds: 1 },
      ],
      1.0,
    );
    expect(state.visibleText).toBe('Hello, world!');
  });

  it('flags estimated timings', () => {
    const state = captionRevealAt(
      [{ text: 'hi', startSeconds: 0, endSeconds: 1, estimated: true }],
      0.5,
    );
    expect(state.estimated).toBe(true);
    expect(state.tokens[0]!.estimated).toBe(true);
  });
});
