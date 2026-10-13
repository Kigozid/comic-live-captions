import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createImageSpace } from '@comic-captioner/shared';
import {
  TextDifferenceEngine,
  TextDifferenceError,
} from '@comic-captioner/image-engine';
import { createSyntheticTextRemovalPair } from '../fixtures/alignment-fixtures';

describe('TextDifferenceEngine', () => {
  const engine = new TextDifferenceEngine();
  const pageSpace = createImageSpace('page:synthetic-text', 320, 180);

  it('detects removed text and separates it from a solid unrelated edit and isolated noise', async () => {
    const pair = await createSyntheticTextRemovalPair();
    const result = await engine.detect(pair.original, pair.cleaned, pageSpace);
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0]!;
    expect(region.confidence).toBeGreaterThan(0.48);
    expect(region.coordinateSpace.id).toBe(pageSpace.id);
    expect(region.polygon.coordinateSpace.id).toBe(pageSpace.id);
    expect(region.boundingBox.y).toBeLessThan(60);
    expect(region.boundingBox.x).toBeLessThan(160);
    expect(region.mask.coordinateSpace.kind).toBe('mask');
    expect(region.mask.coordinateSpace.imageSpaceId).toBe(pageSpace.id);
    expect(region.mask.coordinateSpace.maskToImageScaleX).toBeCloseTo(1);
    expect(region.mask.runs.length).toBeGreaterThan(0);
    expect(result.maskSpace).toEqual(region.mask.coordinateSpace);
  });

  it('returns no candidates for identical aligned images', async () => {
    const pair = await createSyntheticTextRemovalPair();
    const result = await engine.detect(pair.original, pair.original, pageSpace);
    expect(result.regions).toEqual([]);
    expect(result.differencePng.length).toBeGreaterThan(0);
  });

  it('maps analysis masks and bounds back from a different raster resolution', async () => {
    const pair = await createSyntheticTextRemovalPair();
    const original = await sharp(pair.original)
      .resize(640, 360)
      .png()
      .toBuffer();
    const cleaned = await sharp(pair.cleaned).resize(640, 360).png().toBuffer();
    const result = await engine.detect(original, cleaned, pageSpace);
    expect(result.maskSpace.dimensions).toEqual({ width: 640, height: 360 });
    expect(result.maskSpace.maskToImageScaleX).toBeCloseTo(0.5);
    expect(result.regions[0]?.boundingBox.width).toBeGreaterThan(0);
  });

  it('accepts a downscaled aligned raster when page aspect and coordinates match', async () => {
    const pair = await createSyntheticTextRemovalPair();
    const cleaned = await sharp(pair.cleaned).resize(160, 90).png().toBuffer();
    const result = await engine.detect(pair.original, cleaned, pageSpace);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.coordinateSpace.id).toBe(pageSpace.id);
  });

  it('rejects rasters with mismatched aspect ratio', async () => {
    const pair = await createSyntheticTextRemovalPair();
    const wrongSize = await sharp(pair.cleaned)
      .resize(100, 80)
      .png()
      .toBuffer();
    await expect(
      engine.detect(pair.original, wrongSize, pageSpace),
    ).rejects.toThrow(TextDifferenceError);
    const wrongSpace = createImageSpace('page:wrong-aspect', 320, 120);
    await expect(
      engine.detect(pair.original, pair.cleaned, wrongSpace),
    ).rejects.toThrow(TextDifferenceError);
  });

  it('creates a debug image with directional changes and text candidates highlighted', async () => {
    const pair = await createSyntheticTextRemovalPair();
    const result = await engine.detect(pair.original, pair.cleaned, pageSpace);
    const metadata = await sharp(result.debugPng).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(180);
    const debug = await sharp(result.debugPng).raw().toBuffer();
    const textPixel = (35 * 320 + 33) * 3;
    const solidEditPixel = (80 * 320 + 220) * 3;
    expect([...debug.subarray(textPixel, textPixel + 3)]).toEqual([
      255, 45, 35,
    ]);
    expect([...debug.subarray(solidEditPixel, solidEditPixel + 3)]).toEqual([
      30, 190, 255,
    ]);
    expect(result.differencePng.subarray(1, 4).toString()).toBe('PNG');
  });
});
