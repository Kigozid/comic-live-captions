import { describe, expect, it } from 'vitest';
import {
  ForcedAlignAcousticError,
  SyntheticCtcPosteriorsProvider,
  alignWordsAcoustic,
  tokenizeWords,
  viterbiAlign,
  type CtcFramePosteriors,
} from '../../packages/audio-engine/src/wav2vec2-alignment.js';
import type { AudioTimebase, AudioTimebaseId } from '@comic-captioner/shared';

const timebase: AudioTimebase = {
  id: 'audio:acoustic' as AudioTimebaseId,
  unit: 'seconds',
};

function pcm(seconds = 2, sampleRateHz = 16000): Float32Array {
  return new Float32Array(Math.floor(seconds * sampleRateHz)).fill(0.1);
}

describe('tokenizeWords', () => {
  it('tokenizes words into character ids with inter-word spaces', () => {
    const tokenized = tokenizeWords(['hi', 'there'], 'character');
    expect(tokenized.wordTokenIds).toHaveLength(2);
    expect(tokenized.tokenIds.length).toBeGreaterThan(2);
    // last id of first word + space + first id of second word
    expect(tokenized.tokens[tokenized.tokenIds[0]!]).toBe('h');
  });

  it('supports phoneme lexicon lookups with character fallback', () => {
    const tokenized = tokenizeWords(['hello', 'zzz'], 'phoneme', {
      hello: ['hh', 'ah', 'l', 'ow'],
    });
    expect(tokenized.wordTokenIds[0]!.length).toBeGreaterThan(0);
    expect(tokenized.wordTokenIds[1]!.length).toBeGreaterThan(0);
  });
});

describe('viterbiAlign', () => {
  function peakedPosteriors(
    numFrames: number,
    tokenAt: (frame: number) => number,
  ): CtcFramePosteriors {
    const tokens = ['', 'h', 'i', ' '];
    const numTokens = tokens.length;
    const logProbs = new Float32Array(numFrames * numTokens);
    logProbs.fill(Math.log(1e-5));
    for (let frame = 0; frame < numFrames; frame += 1) {
      logProbs[frame * numTokens + tokenAt(frame)] = 0;
    }
    return {
      logProbs,
      numFrames,
      numTokens,
      tokens,
      frameShiftSeconds: 0.02,
      isLogScale: true,
      blankIndex: 0,
    };
  }

  it('aligns a token sequence to peaked frame posteriors', () => {
    // Frames 0-9 blank, 10-14 'h', 15-19 blank, 20-24 'i'
    const posteriors = peakedPosteriors(30, (frame) => {
      if (frame >= 10 && frame < 15) return 1;
      if (frame >= 20 && frame < 25) return 2;
      return 0;
    });
    const alignment = viterbiAlign(posteriors, [1, 2]); // 'h','i'
    expect(alignment.tokenSpans.length).toBeGreaterThanOrEqual(1);
    expect(alignment.meanConfidence).toBeGreaterThan(0.5);
    // The path should cover the non-blank region roughly.
    const first = alignment.tokenSpans[0]!;
    expect(first.startFrame).toBeGreaterThanOrEqual(8);
  });

  it('rejects empty sequences and undersized tensors', () => {
    const posteriors = peakedPosteriors(5, () => 0);
    expect(() => viterbiAlign(posteriors, [])).toThrow(ForcedAlignAcousticError);
    expect(() =>
      viterbiAlign(
        {
          ...posteriors,
          logProbs: new Float32Array(2),
          numFrames: 5,
          numTokens: 4,
        },
        [1],
      ),
    ).toThrow(ForcedAlignAcousticError);
  });
});

describe('alignWordsAcoustic', () => {
  it('produces word timestamps from CTC posteriors', async () => {
    const provider = new SyntheticCtcPosteriorsProvider();
    const result = await alignWordsAcoustic({
      segments: [
        {
          id: 'seg-1',
          text: 'hello world',
          interval: {
            start: { value: 0, timebase: timebase.id, unit: 'seconds' },
            end: { value: 1.0, timebase: timebase.id, unit: 'seconds' },
          },
        },
      ],
      timebase,
      pcm: pcm(2),
      sampleRateHz: 16000,
      provider,
    });
    expect(result.algorithm).toBe('ctc-viterbi');
    expect(result.provider).toBe('synthetic-ctc');
    expect(result.words).toHaveLength(2);
    expect(result.words[0]!.text).toBe('hello');
    expect(result.words[1]!.text).toBe('world');
    expect(result.words[0]!.start.value).toBeLessThan(result.words[0]!.end.value);
    expect(result.words[0]!.end.value).toBeLessThanOrEqual(
      result.words[1]!.end.value + 1e-6,
    );
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('honors explicit word lists and speaker ids', async () => {
    const provider = new SyntheticCtcPosteriorsProvider();
    const result = await alignWordsAcoustic({
      segments: [
        {
          id: 'seg-2',
          text: 'alpha beta gamma',
          words: ['alpha', 'beta'],
          speakerId: 'speaker-a',
          interval: {
            start: { value: 0.5, timebase: timebase.id, unit: 'seconds' },
            end: { value: 1.5, timebase: timebase.id, unit: 'seconds' },
          },
        },
      ],
      timebase,
      pcm: pcm(3),
      sampleRateHz: 16000,
      provider,
    });
    expect(result.words.map((w) => w.text)).toEqual(['alpha', 'beta']);
    expect(result.words[0]!.speakerId).toBe('speaker-a');
  });

  it('rejects invalid PCM and overlapping segments', async () => {
    const provider = new SyntheticCtcPosteriorsProvider();
    await expect(
      alignWordsAcoustic({
        segments: [
          {
            text: 'x',
            interval: {
              start: { value: 0, timebase: timebase.id, unit: 'seconds' },
              end: { value: 1, timebase: timebase.id, unit: 'seconds' },
            },
          },
        ],
        timebase,
        pcm: new Float32Array(0),
        sampleRateHz: 16000,
        provider,
      }),
    ).rejects.toThrow(ForcedAlignAcousticError);

    await expect(
      alignWordsAcoustic({
        segments: [
          {
            text: 'x',
            interval: {
              start: { value: 0, timebase: timebase.id, unit: 'seconds' },
              end: { value: 1, timebase: timebase.id, unit: 'seconds' },
            },
          },
          {
            text: 'y',
            interval: {
              start: { value: 0.5, timebase: timebase.id, unit: 'seconds' },
              end: { value: 1.5, timebase: timebase.id, unit: 'seconds' },
            },
          },
        ],
        timebase,
        pcm: pcm(2),
        sampleRateHz: 16000,
        provider,
      }),
    ).rejects.toThrow(ForcedAlignAcousticError);
  });

  it('requires a provider', async () => {
    await expect(
      alignWordsAcoustic({
        segments: [
          {
            text: 'x',
            interval: {
              start: { value: 0, timebase: timebase.id, unit: 'seconds' },
              end: { value: 1, timebase: timebase.id, unit: 'seconds' },
            },
          },
        ],
        timebase,
        pcm: pcm(1),
        sampleRateHz: 16000,
        provider: undefined as never,
      }),
    ).rejects.toThrow(ForcedAlignAcousticError);
  });
});
