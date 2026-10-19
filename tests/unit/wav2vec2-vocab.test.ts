import { describe, expect, it } from 'vitest';
import { WAV2VEC2_BASE_VOCAB } from '../../apps/api/src/onnx-models.js';

/**
 * Regression: the wav2vec2-base-960h logit order is frequency-based, not
 * alphabetical. A wrong vocab table decodes into a substitution cipher
 * ('e'→'a', 't'→'b', …) with intact word boundaries — reads "almost right"
 * but is gibberish, and silently ruins forced alignment. These indices come
 * from facebook/wav2vec2-base-960h vocab.json (Xenova ONNX exports match).
 */
describe('WAV2VEC2_BASE_VOCAB', () => {
  it('matches the canonical wav2vec2-base-960h logit order', () => {
    expect(WAV2VEC2_BASE_VOCAB).toEqual([
      '<pad>',
      '<s>',
      '</s>',
      '<unk>',
      '|',
      // 5..12
      'e',
      't',
      'a',
      'o',
      'n',
      'i',
      'h',
      's',
      // 13..26
      'r',
      'd',
      'l',
      'u',
      'm',
      'w',
      'c',
      'f',
      'g',
      'y',
      'p',
      'b',
      'v',
      'k',
      // 27
      "'",
      // 28..31
      'x',
      'j',
      'q',
      'z',
    ]);
  });

  it('keeps the blank and space at the model special-token slots', () => {
    expect(WAV2VEC2_BASE_VOCAB[0]).toBe('<pad>');
    expect(WAV2VEC2_BASE_VOCAB[4]).toBe('|');
  });
});
