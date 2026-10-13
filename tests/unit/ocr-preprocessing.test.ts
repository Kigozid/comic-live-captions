import { describe, expect, it } from 'vitest';
import {
  analyzeOCRPixels,
  preprocessOCRPixels,
  resizeOCRPixels,
} from '../../apps/web/src/ocr-preprocessing';

function raster(width: number, height: number, value = 245) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = data[index + 1] = data[index + 2] = value;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

describe('OCR preprocessing', () => {
  it('leaves the original pixel buffer untouched', async () => {
    const source = raster(6, 6);
    source.data[0] = 17;
    const before = new Uint8ClampedArray(source.data);
    await preprocessOCRPixels(source, { grayscale: true, contrast: 1.2 });
    expect(source.data).toEqual(before);
  });

  it('detects dark backgrounds and inverts them only in auto mode', async () => {
    const source = raster(8, 8, 35);
    source.data[3] = 255;
    const automatic = await preprocessOCRPixels(source, { invert: 'auto' });
    const never = await preprocessOCRPixels(source, { invert: 'never' });
    expect(automatic.inverted).toBe(true);
    expect(never.inverted).toBe(false);
    expect(automatic.image.data[0]).toBeGreaterThan(never.image.data[0]!);
  });

  it('only applies adaptive threshold when requested and the crop is low contrast', async () => {
    const source = raster(24, 24, 185);
    for (let y = 8; y < 16; y += 1)
      for (let x = 5; x < 18; x += 1) {
        const offset = (y * source.width + x) * 4;
        source.data[offset] =
          source.data[offset + 1] =
          source.data[offset + 2] =
            160;
      }
    const analysis = analyzeOCRPixels(source);
    const defaultResult = await preprocessOCRPixels(source);
    const thresholdResult = await preprocessOCRPixels(source, {
      adaptiveThreshold: true,
    });
    expect(analysis.luminanceRange).toBeLessThan(92);
    expect(defaultResult.thresholded).toBe(false);
    expect(thresholdResult.thresholded).toBe(true);
  });

  it('preserves edge pixels and scales small lettering with a hard maximum side', async () => {
    const source = raster(20, 10, 255);
    source.data[(0 * 20 + 0) * 4] = 0;
    const enlarged = await resizeOCRPixels(source, 4, 60);
    expect(enlarged.width).toBe(60);
    expect(enlarged.height).toBe(30);
    expect(enlarged.data.some((value) => value < 200)).toBe(true);
    expect(source.width).toBe(20);
  });

  it('does not denoise clean imagery unless isolated extreme noise is present', async () => {
    const clean = raster(10, 10, 240);
    const cleanResult = await preprocessOCRPixels(clean, { denoise: true });
    expect(cleanResult.denoised).toBe(false);
    const noiseOffset = (4 * 10 + 4) * 4;
    clean.data[noiseOffset] =
      clean.data[noiseOffset + 1] =
      clean.data[noiseOffset + 2] =
        0;
    const noisyResult = await preprocessOCRPixels(clean, { denoise: true });
    expect(noisyResult.denoised).toBe(true);
  });
});
