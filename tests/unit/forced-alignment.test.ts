import { describe, expect, it } from 'vitest';
import {
  alignWords,
  chunkCaptionUnits,
  ForcedAlignmentError,
  type AlignmentSegmentInput,
  type CaptionChunk,
  type EnergyEnvelope,
} from '@comic-captioner/audio-engine';
import type {
  AudioTime,
  AudioTimebase,
  AudioTimebaseId,
  TimeInterval,
} from '@comic-captioner/shared';

const secondsBase: AudioTimebase = Object.freeze({
  id: 'audio:forced-alignment-test' as AudioTimebaseId,
  unit: 'seconds',
});

const samplesBase: AudioTimebase = Object.freeze({
  id: 'audio:forced-alignment-samples' as AudioTimebaseId,
  unit: 'samples',
  sampleRateHz: 100,
});

function at(value: number, timebase: AudioTimebase = secondsBase): AudioTime {
  return { value, timebase: timebase.id, unit: timebase.unit };
}

function interval(
  start: number,
  end: number,
  timebase: AudioTimebase = secondsBase,
): TimeInterval {
  return { start: at(start, timebase), end: at(end, timebase) };
}

function segment(
  words: readonly string[],
  start: number,
  end: number,
  extra: Partial<AlignmentSegmentInput> = {},
): AlignmentSegmentInput {
  return {
    words: words.map((text) => ({ text })),
    interval: interval(start, end),
    ...extra,
  };
}

describe('alignWords', () => {
  it('returns no words for empty input', () => {
    expect(alignWords({ segments: [], timebase: secondsBase })).toEqual([]);
  });

  it('tiles a single word across its whole segment', () => {
    const words = alignWords({
      segments: [segment(['Hello.'], 1, 3)],
      timebase: secondsBase,
    });
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({
      text: 'Hello.',
      start: { value: 1, timebase: secondsBase.id, unit: 'seconds' },
      end: { value: 3, timebase: secondsBase.id, unit: 'seconds' },
    });
  });

  it('distributes equal words evenly and keeps every timestamp in the declared timebase', () => {
    const words = alignWords({
      segments: [segment(['aa', 'bb'], 0, 2)],
      timebase: secondsBase,
    });
    expect(words.map((word) => [word.start.value, word.end.value])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    for (const word of words) {
      expect(word.start.timebase).toBe(secondsBase.id);
      expect(word.start.unit).toBe('seconds');
    }
    expect(Object.isFrozen(words)).toBe(true);
    expect(Object.isFrozen(words[0])).toBe(true);
  });

  it('weights words by character length refined by syllable estimates', () => {
    const words = alignWords({
      segments: [segment(['Hi', 'internationalization'], 0, 3)],
      timebase: secondsBase,
    });
    expect(words).toHaveLength(2);
    const short = words[0]!.end.value - words[0]!.start.value;
    const long = words[1]!.end.value - words[1]!.start.value;
    expect(long).toBeGreaterThan(short * 2);
    expect(words[1]!.end.value).toBeCloseTo(3, 10);
  });

  it('aligns multiple segments inside their own intervals without crossing gaps', () => {
    const words = alignWords({
      segments: [segment(['aa', 'bb'], 0, 2), segment(['cc', 'dd'], 3, 5)],
      timebase: secondsBase,
    });
    expect(words.map((word) => [word.text, word.start.value, word.end.value])).toEqual([
      ['aa', 0, 1],
      ['bb', 1, 2],
      ['cc', 3, 4],
      ['dd', 4, 5],
    ]);
  });

  it('blends rough word times into the allocation when the whole segment supplies them', () => {
    const words = alignWords({
      segments: [
        {
          words: [
            { text: 'aa', start: at(0), end: at(1.5) },
            { text: 'bb', start: at(1.5), end: at(2) },
          ],
          interval: interval(0, 2),
        },
      ],
      timebase: secondsBase,
    });
    const first = words[0]!.end.value - words[0]!.start.value;
    const second = words[1]!.end.value - words[1]!.start.value;
    // Rough timings say the first word is longer; without them the equal
    // texts would split the segment evenly.
    expect(first).toBeGreaterThan(second);
    expect(first + second).toBeCloseTo(2, 10);
  });

  it('rejects non-monotonic rough word times', () => {
    expect(() =>
      alignWords({
        segments: [
          {
            words: [
              { text: 'aa', start: at(1), end: at(1.5) },
              { text: 'bb', start: at(0.5), end: at(2) },
            ],
            interval: interval(0, 2),
          },
        ],
        timebase: secondsBase,
      }),
    ).toThrow(ForcedAlignmentError);
  });

  it('rejects partial rough word times within a segment', () => {
    expect(() =>
      alignWords({
        segments: [
          {
            words: [{ text: 'aa' }, { text: 'bb', start: at(1), end: at(2) }],
            interval: interval(0, 2),
          },
        ],
        timebase: secondsBase,
      }),
    ).toThrow(ForcedAlignmentError);
  });

  it('rejects non-monotonic and overlapping segment intervals', () => {
    expect(() =>
      alignWords({
        segments: [segment(['aa'], 2, 4), segment(['bb'], 1, 3)],
        timebase: secondsBase,
      }),
    ).toThrow(ForcedAlignmentError);
    expect(() =>
      alignWords({
        segments: [segment(['aa'], 0, 3), segment(['bb'], 2, 5)],
        timebase: secondsBase,
      }),
    ).toThrow(ForcedAlignmentError);
  });

  it('rejects mismatched timebases and malformed timebases', () => {
    expect(() =>
      alignWords({
        segments: [
          {
            words: [{ text: 'aa' }],
            interval: {
              start: at(0, samplesBase),
              end: at(1, samplesBase),
            },
          },
        ],
        timebase: secondsBase,
      }),
    ).toThrow(ForcedAlignmentError);
    expect(() =>
      alignWords({
        segments: [segment(['aa'], 0, 1)],
        timebase: {
          id: '' as AudioTimebaseId,
          unit: 'seconds',
        },
      }),
    ).toThrow(ForcedAlignmentError);
    expect(() =>
      alignWords({
        segments: [
          {
            words: [{ text: 'aa' }],
            interval: interval(0, 100, {
              id: 'audio:missing-rate' as AudioTimebaseId,
              unit: 'samples',
            }),
          },
        ],
        timebase: {
          id: 'audio:missing-rate' as AudioTimebaseId,
          unit: 'samples',
        },
      }),
    ).toThrow(ForcedAlignmentError);
  });

  it('emits integer boundaries for sample-based timebases', () => {
    const words = alignWords({
      segments: [
        {
          words: [{ text: 'a' }, { text: 'internationalization' }],
          interval: interval(0, 100, samplesBase),
        },
      ],
      timebase: samplesBase,
    });
    expect(words).toHaveLength(2);
    for (const word of words) {
      expect(Number.isSafeInteger(word.start.value)).toBe(true);
      expect(Number.isSafeInteger(word.end.value)).toBe(true);
      expect(word.start.unit).toBe('samples');
    }
    expect(words[0]!.start.value).toBe(0);
    expect(words[1]!.end.value).toBe(100);
    expect(words[0]!.end.value).toBe(words[1]!.start.value);
  });

  it('reweights words with the optional RMS energy envelope', () => {
    const energy: EnergyEnvelope = (span) =>
      span.start.value < 1 ? 1 : 0;
    const words = alignWords({
      segments: [segment(['aa', 'bb'], 0, 2)],
      timebase: secondsBase,
      energyEnvelope: energy,
    });
    const first = words[0]!.end.value - words[0]!.start.value;
    const second = words[1]!.end.value - words[1]!.start.value;
    expect(first).toBeGreaterThan(second);
    expect(first).toBeCloseTo(1.25, 10);
    expect(second).toBeCloseTo(0.75, 10);
  });

  it('rejects an energy envelope that returns invalid values', () => {
    expect(() =>
      alignWords({
        segments: [segment(['aa'], 0, 1)],
        timebase: secondsBase,
        energyEnvelope: () => Number.NaN,
      }),
    ).toThrow(ForcedAlignmentError);
  });

  it('propagates speaker and confidence onto aligned words', () => {
    const words = alignWords({
      segments: [
        segment(['aa', 'bb'], 0, 2, {
          speakerId: 'spk_1',
          confidence: 0.5,
          words: [{ text: 'aa' }, { text: 'bb', confidence: 0.9 }],
        }),
      ],
      timebase: secondsBase,
    });
    expect(words[0]).toMatchObject({ speakerId: 'spk_1', confidence: 0.5 });
    expect(words[1]).toMatchObject({ speakerId: 'spk_1', confidence: 0.9 });
  });
});

describe('chunkCaptionUnits', () => {
  function aligned(texts: readonly string[], start = 0, step = 0.5) {
    return alignWords({
      segments: [
        {
          words: texts.map((text) => ({ text })),
          interval: interval(start, start + step * texts.length),
        },
      ],
      timebase: secondsBase,
    });
  }

  it('returns no chunks for empty input', () => {
    expect(chunkCaptionUnits([])).toEqual([]);
  });

  it('keeps a single word as one chunk', () => {
    const chunks = chunkCaptionUnits(aligned(['Hello.']));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      text: 'Hello.',
      start: { value: 0 },
      end: { value: 0.5 },
    });
  });

  it('breaks chunks at sentence ends and commas', () => {
    const words = aligned(['Hello,', 'friend.', 'Goodbye!']);
    const chunks = chunkCaptionUnits(words);
    expect(chunks.map((chunk: CaptionChunk) => chunk.text)).toEqual([
      'Hello,',
      'friend.',
      'Goodbye!',
    ]);
  });

  it('breaks chunks at the character and duration caps', () => {
    const many = Array.from({ length: 20 }, (_, index) => `word${index}`);
    const byChars = chunkCaptionUnits(aligned(many), { maxCharacters: 42 });
    expect(byChars.length).toBeGreaterThan(1);
    for (const chunk of byChars) expect(chunk.text.length).toBeLessThanOrEqual(42);

    const byDuration = chunkCaptionUnits(aligned(many, 0, 0.4), {
      maxDurationSeconds: 2,
      breakOnSentenceEnd: false,
      breakOnComma: false,
    });
    expect(byDuration.length).toBeGreaterThan(1);
    for (const chunk of byDuration)
      expect(chunk.end.value - chunk.start.value).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('breaks chunks when the speaker changes', () => {
    const words = alignWords({
      segments: [
        segment(['aa', 'bb'], 0, 1, { speakerId: 'spk_1' }),
        segment(['cc', 'dd'], 1, 2, { speakerId: 'spk_2' }),
      ],
      timebase: secondsBase,
    });
    const chunks = chunkCaptionUnits(words);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['aa bb', 'cc dd']);
    expect(chunks.map((chunk) => chunk.speakerId)).toEqual(['spk_1', 'spk_2']);
  });

  it('tiles chunk intervals over their words in one timebase', () => {
    const words = aligned(['One', 'two', 'three']);
    const chunks = chunkCaptionUnits(words, {
      breakOnSentenceEnd: false,
      breakOnComma: false,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.words).toHaveLength(3);
    expect(chunks[0]!.start.value).toBe(words[0]!.start.value);
    expect(chunks[0]!.end.value).toBe(words[2]!.end.value);
    expect(Object.isFrozen(chunks[0])).toBe(true);
  });

  it('rejects non-monotonic or mismatched words', () => {
    const words = aligned(['aa', 'bb']);
    expect(() =>
      chunkCaptionUnits([words[1]!, words[0]!]),
    ).toThrow(ForcedAlignmentError);
    expect(() =>
      chunkCaptionUnits([
        words[0]!,
        { ...words[1]!, start: at(0.5, samplesBase) },
      ]),
    ).toThrow(ForcedAlignmentError);
    expect(() =>
      chunkCaptionUnits([], { maxCharacters: 0 }),
    ).toThrow(ForcedAlignmentError);
  });
});
