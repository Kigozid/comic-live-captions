import { describe, expect, it } from 'vitest';
import {
  activeCaptionsAt,
  areProgressiveWordTimings,
  assignTokenSpans,
  captionRevealAt,
  chunkRevealTokens,
  normalizeRevealTokens,
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

describe('captionRevealAt — word-by-word', () => {
  it('1. keeps the bubble empty before the dialogue starts', () => {
    const state = captionRevealAt(attackWords(), -0.5, {
      sourceText: SOURCE,
      mode: 'word-by-word',
    });
    expect(state.isEmpty).toBe(true);
    expect(state.visibleText).toBe('');
    expect(state.revealedTokenCount).toBe(0);
    expect(state.started).toBe(false);
  });

  it('2. reveals only the first word at its timestamp', () => {
    const state = captionRevealAt(attackWords(), 0.0, {
      sourceText: SOURCE,
      mode: 'word-by-word',
    });
    expect(state.visibleText).toBe('The');
    expect(state.revealedTokenCount).toBe(1);
  });

  it('3. reveals additional words progressively', () => {
    const words = attackWords();
    const opts = { sourceText: SOURCE, mode: 'word-by-word' as const };
    expect(captionRevealAt(words, 0.3, opts).visibleText).toBe('The city');
    expect(captionRevealAt(words, 0.7, opts).visibleText).toBe(
      'The city is under',
    );
    expect(captionRevealAt(words, 1.2, opts).visibleText).toBe(SOURCE);
  });

  it('4. preserves punctuation and original spacing', () => {
    const words = attackWords();
    const opts = { sourceText: SOURCE, mode: 'word-by-word' as const };
    const state = captionRevealAt(words, 1.2, opts);
    expect(state.visibleText).toBe('The city is under attack!');
    // Partial step keeps the trailing space out of the revealed prefix.
    const mid = captionRevealAt(words, 0.3, opts);
    expect(mid.visibleText).toBe('The city');
    expect(mid.visibleText.startsWith('The city is')).toBe(false);
  });

  it('marks the spoken word active for karaoke and keeps others inactive', () => {
    const state = captionRevealAt(attackWords(), 0.3, {
      sourceText: SOURCE,
      mode: 'word-by-word',
    });
    expect(state.activeTokenIndex).toBe(1);
    expect(state.tokens.filter((t) => t.active)).toHaveLength(1);
    expect(state.tokens[1]!.active).toBe(true);
    expect(state.tokens[1]!.text).toBe('city');
  });

  it('reports finished only after the last word ends', () => {
    const words = attackWords();
    const opts = { sourceText: SOURCE, mode: 'word-by-word' as const };
    expect(captionRevealAt(words, 1.29, opts).finished).toBe(false);
    expect(captionRevealAt(words, 1.3, opts).finished).toBe(true);
  });
});

describe('captionRevealAt — smooth-phrase (default bubble subtitles)', () => {
  it('chunks 2–3 words and never splits a word', () => {
    const chunks = chunkRevealTokens(attackWords());
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(3);
    for (const chunk of chunks) {
      const count = chunk.endTokenIndex - chunk.startTokenIndex + 1;
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    }
    // "attack!" stays whole as the final chunk.
    const last = chunks[chunks.length - 1]!;
    expect(attackWords()[last.endTokenIndex]!.text).toBe('attack!');
  });

  it('reveals readable chunks instead of a typewriter word stream', () => {
    const words = attackWords();
    const opts = { sourceText: SOURCE, mode: 'smooth-phrase' as const };
    // First chunk is 2–3 words at t=0, not a single word.
    const atStart = captionRevealAt(words, 0.05, opts);
    expect(atStart.revealedTokenCount).toBeGreaterThanOrEqual(2);
    expect(atStart.revealedTokenCount).toBeLessThanOrEqual(3);
    // Still progressive — not the full sentence immediately.
    expect(atStart.visibleText).not.toBe(SOURCE);
    // Later another chunk appears; full text after the last word.
    expect(captionRevealAt(words, 1.4, opts).visibleText).toBe(SOURCE);
  });

  it('fades chunk opacity quickly without a typewriter cursor', () => {
    const words = attackWords();
    const state = captionRevealAt(words, 0.01, {
      sourceText: SOURCE,
      mode: 'smooth-phrase',
    });
    const shown = state.tokens.filter((token) => token.opacity > 0);
    expect(shown.length).toBeGreaterThanOrEqual(2);
    // Mid-fade opacity is between 0 and 1; no partial letters.
    for (const token of state.tokens) {
      expect(token.opacity).toBeGreaterThanOrEqual(0);
      expect(token.opacity).toBeLessThanOrEqual(1);
      expect(token.text === '' || token.text === token.token.text).toBe(true);
    }
  });

  it('ends chunks at punctuation and pauses', () => {
    const timed = assignTokenSpans('Hello, world. Wait! Okay then', [
      { text: 'Hello,', startSeconds: 0, endSeconds: 0.2 },
      { text: 'world.', startSeconds: 0.2, endSeconds: 0.4 },
      { text: 'Wait!', startSeconds: 0.6, endSeconds: 0.8 },
      { text: 'Okay', startSeconds: 0.8, endSeconds: 0.95 },
      { text: 'then', startSeconds: 0.95, endSeconds: 1.1 },
    ]);
    const chunks = chunkRevealTokens(timed);
    // Hello, world. | Wait! | Okay then  — pause + punctuation boundaries.
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.endTokenIndex).toBe(1);
    expect(chunks[1]!.endTokenIndex).toBe(2);
    expect(chunks[2]!.startTokenIndex).toBe(3);
  });
});

describe('captionRevealAt — determinism & seeking', () => {
  it('8. is a pure function of time (seek back/forward reproduces state)', () => {
    const words = attackWords();
    const opts = { sourceText: SOURCE, mode: 'word-by-word' as const };
    const first = captionRevealAt(words, 0.7, opts);
    const later = captionRevealAt(words, 1.2, opts);
    const backAgain = captionRevealAt(words, 0.7, opts);
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

describe('normalizeRevealTokens — never dump a full line at cue start', () => {
  const staggered: readonly RevealToken[] = [
    { text: 'The', startSeconds: 1, endSeconds: 1.2 },
    { text: 'city', startSeconds: 1.2, endSeconds: 1.4 },
    { text: 'is', startSeconds: 1.4, endSeconds: 1.55 },
    { text: 'under', startSeconds: 1.55, endSeconds: 1.75 },
    { text: 'attack!', startSeconds: 1.75, endSeconds: 2 },
  ];

  it('accepts staggered acoustic timings', () => {
    expect(areProgressiveWordTimings(staggered, 1, 2)).toBe(true);
    expect(normalizeRevealTokens(staggered, SOURCE, 1, 2)).toBe(staggered);
  });

  it('rejects collapsed timings where every word starts at the cue', () => {
    const collapsed = staggered.map((word) => ({
      ...word,
      startSeconds: 1,
      endSeconds: 2,
    }));
    expect(areProgressiveWordTimings(collapsed, 1, 2)).toBe(false);
    const normalized = normalizeRevealTokens(collapsed, SOURCE, 1, 2);
    expect(normalized.every((token) => token.estimated)).toBe(true);
    // Progressive: first token starts at cue start, last ends at cue end.
    expect(normalized[0]!.startSeconds).toBe(1);
    expect(normalized[normalized.length - 1]!.endSeconds).toBe(2);
    expect(normalized[1]!.startSeconds).toBeGreaterThan(
      normalized[0]!.startSeconds,
    );
  });

  it('rejects non-monotonic and inverted spans', () => {
    expect(
      areProgressiveWordTimings(
        [
          { text: 'a', startSeconds: 1.5, endSeconds: 1.6 },
          { text: 'b', startSeconds: 1.1, endSeconds: 1.2 },
        ],
        1,
        2,
      ),
    ).toBe(false);
    expect(
      areProgressiveWordTimings(
        [{ text: 'a', startSeconds: 1.5, endSeconds: 1.2 }],
        1,
        2,
      ),
    ).toBe(false);
  });

  it('falls back to even slices when timings are missing', () => {
    const tokens = normalizeRevealTokens(undefined, SOURCE, 1, 2);
    expect(tokens).toHaveLength(5);
    expect(tokens.every((token) => token.estimated)).toBe(true);
  });

  it('reveals only the first word at cue start after normalization', () => {
    const collapsed = staggered.map((word) => ({
      ...word,
      startSeconds: 1,
      endSeconds: 2,
    }));
    const tokens = normalizeRevealTokens(collapsed, SOURCE, 1, 2);
    const atStart = captionRevealAt(tokens, 1.0, { mode: 'word-by-word' });
    expect(atStart.revealedTokenCount).toBe(1);
    expect(atStart.visibleText).toBe('The');
    const later = captionRevealAt(tokens, 1.5, { mode: 'word-by-word' });
    expect(later.revealedTokenCount).toBeGreaterThan(1);
    expect(later.revealedTokenCount).toBeLessThan(5);
  });
});
