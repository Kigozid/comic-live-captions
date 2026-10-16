import { describe, expect, it } from 'vitest';
import { inspectImglyScene } from '../../apps/web/src/imgly-scene.js';

describe('imgly scene inspection', () => {
  it('records proprietary magic and does not invent scene tracks', () => {
    const payload = Buffer.from('UBQ2-not-a-zip-or-json-payload', 'utf8');
    const inspection = inspectImglyScene(payload);
    expect(inspection.format).toBe('imgly');
    expect(inspection.parseable).toBe(false);
    expect(inspection.extracted.tracks).toEqual([]);
    expect(inspection.extracted.clips).toEqual([]);
    expect(inspection.extracted.canvas).toBeNull();
    expect(inspection.notes.join(' ')).toMatch(/CE\.SDK|proprietary|not ZIP/i);
  });

  it('accepts base64 wrappers and reports decoded size', () => {
    const binary = Buffer.from([0x50, 0x14, 0x36, 0x28, 1, 2, 3, 4]);
    const inspection = inspectImglyScene(binary.toString('base64'));
    expect(inspection.decodedByteLength).toBe(8);
    expect(inspection.magic?.length).toBe(4);
    expect(inspection.encodingGuess).toBeTruthy();
  });

  it('never invents clip timings from the sample advertisement', () => {
    const inspection = inspectImglyScene(
      Buffer.from('UBQ2PROMO CODE LUNAR 1920x1080', 'utf8'),
    );
    expect(inspection.extracted.clips).toEqual([]);
    expect(inspection.extracted.tracks).toEqual([]);
  });
});
