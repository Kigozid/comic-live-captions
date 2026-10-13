import { describe, expect, it } from 'vitest';
import {
  AlignmentError,
  ImageAlignmentEngine,
  ImmutableSourceImage,
  applyManualAlignment,
  renderAlignmentVisualizations,
} from '@comic-captioner/image-engine';
import { createSyntheticAlignmentPair } from '../fixtures/alignment-fixtures';

async function importPair(pair: {
  readonly original: Buffer;
  readonly cleaned: Buffer;
}) {
  const [original, cleaned] = await Promise.all([
    ImmutableSourceImage.import({
      role: 'original',
      filename: 'synthetic-original.png',
      bytes: pair.original,
    }),
    ImmutableSourceImage.import({
      role: 'cleaned',
      filename: 'synthetic-cleaned.png',
      bytes: pair.cleaned,
    }),
  ]);
  return { original, cleaned };
}

describe('ImageAlignmentEngine', () => {
  const engine = new ImageAlignmentEngine();

  it('aligns identical dimensions and exposes a high-confidence identity matrix', async () => {
    const pair = await importPair(await createSyntheticAlignmentPair());
    const result = await engine.align(pair.original, pair.cleaned);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.sourceSpace.dimensions).toEqual({ width: 240, height: 180 });
    expect(result.targetSpace.dimensions).toEqual({ width: 240, height: 180 });
    expect(result.scale).toBeCloseTo(1, 1);
    expect(result.rotation).toBeCloseTo(0, 1);
    expect(result.transformMatrix.values[0]).toBeCloseTo(1, 1);
  });

  it('accounts for different image resolutions with the same page aspect ratio', async () => {
    const pair = await importPair(
      await createSyntheticAlignmentPair({
        sourceWidth: 480,
        sourceHeight: 360,
      }),
    );
    const result = await engine.align(pair.original, pair.cleaned);
    expect(result.sourceSpace.dimensions).toEqual({ width: 480, height: 360 });
    expect(result.scale).toBeCloseTo(0.5, 1);
    expect(result.confidence).toBeGreaterThan(0.75);
  });

  it('estimates a small translation', async () => {
    const pair = await importPair(
      await createSyntheticAlignmentPair({ translateX: 6, translateY: 6 }),
    );
    const result = await engine.align(pair.original, pair.cleaned);
    expect(result.translation.x).toBeCloseTo(-6, 0);
    expect(result.translation.y).toBeCloseTo(-6, 0);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('estimates small uniform scaling and minor rotation', async () => {
    const pair = await importPair(
      await createSyntheticAlignmentPair({ scale: 1.035, rotationDegrees: 2 }),
    );
    const result = await engine.align(pair.original, pair.cleaned);
    expect(result.scale).toBeCloseTo(1 / 1.035, 1);
    expect(result.rotation).toBeCloseTo((-2 * Math.PI) / 180, 1);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('creates coordinate-space-tagged manual corrections and visualizations', async () => {
    const pair = await importPair(await createSyntheticAlignmentPair());
    const initial = await engine.align(pair.original, pair.cleaned);
    const manual = applyManualAlignment(initial, {
      scale: 1.1,
      rotation: 0.1,
      translationX: 3,
      translationY: -2,
    });
    expect(manual.method).toBe('manual');
    expect(manual.confidence).toBe(1);
    expect(manual.translation.coordinateSpace.id).toBe(manual.targetSpace.id);
    const visualization = await renderAlignmentVisualizations(
      pair.original.getBytes(),
      pair.cleaned.getBytes(),
      manual,
    );
    expect(visualization.overlayPng.subarray(1, 4).toString()).toBe('PNG');
    expect(visualization.differencePng.subarray(1, 4).toString()).toBe('PNG');
  });

  it('rejects invalid manual parameters and incompatible page aspect ratios', async () => {
    const pair = await importPair(await createSyntheticAlignmentPair());
    const result = await engine.align(pair.original, pair.cleaned);
    expect(() =>
      applyManualAlignment(result, {
        scale: 0,
        rotation: 0,
        translationX: 0,
        translationY: 0,
      }),
    ).toThrow(AlignmentError);
    const mismatched = await importPair(
      await createSyntheticAlignmentPair({
        sourceWidth: 240,
        sourceHeight: 120,
      }),
    );
    await expect(
      engine.align(mismatched.original, mismatched.cleaned),
    ).rejects.toThrow(AlignmentError);
  });
});
