import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  binaryMaskIoU,
  boundsIoU,
  coordinateError,
  FIXTURE_TOLERANCES,
  timingBoundaryError,
} from '../fixtures/score.js';
import { COMIC_FIXTURE_NAMES } from '../fixtures/suite.js';
import type { ComicFixtureGroundTruth } from '../fixtures/suite.js';

const root = path.resolve(process.cwd(), 'tests/fixtures');

describe('comic processing fixture corpus', () => {
  it('contains paired page images and schema-shaped numerical labels for each required case', async () => {
    const schema = JSON.parse(
      await readFile(path.join(root, 'ground-truth.schema.json'), 'utf8'),
    ) as { $schema?: string; $defs?: Record<string, unknown> };
    expect(schema.$schema).toContain('json-schema.org/draft/2020-12');
    expect(schema.$defs).toHaveProperty('bubble');

    for (const name of COMIC_FIXTURE_NAMES) {
      const directory = path.join(root, name);
      const truth = JSON.parse(
        await readFile(path.join(directory, 'ground-truth.json'), 'utf8'),
      ) as ComicFixtureGroundTruth;
      expect(truth.schemaVersion).toBe(1);
      expect(truth.id).toBe(name);
      expect(truth.dimensions).toEqual({ width: 640, height: 480 });
      expect(truth.coordinateSpace).toMatchObject({
        kind: 'image',
        pixelCenters: 'integer',
        origin: 'top-left',
        xAxis: 'right',
        yAxis: 'down',
      });
      expect(truth.expected.bubbles.length).toBeGreaterThan(0);
      expect(truth.expected.textRegions.length).toBe(
        truth.expected.bubbles.length,
      );
      expect(truth.expected.ocr.length).toBe(truth.expected.bubbles.length);
      expect(truth.expected.dialogueMappings.length).toBe(
        truth.expected.bubbles.length,
      );

      const originalPath = path.join(directory, truth.sourceFiles.original);
      const cleanedPath = path.join(directory, truth.sourceFiles.cleaned);
      const original = await sharp(originalPath)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const cleaned = await sharp(cleanedPath)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(original.info).toMatchObject({
        width: truth.dimensions.width,
        height: truth.dimensions.height,
      });
      expect(cleaned.info).toMatchObject({
        width: truth.dimensions.width,
        height: truth.dimensions.height,
      });
      expect(Buffer.compare(original.data, cleaned.data)).not.toBe(0);

      const bubbleIds = new Set(
        truth.expected.bubbles.map((bubble) => bubble.id),
      );
      for (const bubble of truth.expected.bubbles) {
        expect(bubble.polygon.length).toBeGreaterThanOrEqual(3);
        expect(bubble.maskFile.startsWith('expected/')).toBe(true);
        const mask = await sharp(
          path.join(directory, bubble.maskFile),
        ).metadata();
        expect(mask).toMatchObject({ width: 640, height: 480 });
        expect(bubble.boundingBox.width).toBeGreaterThan(0);
        expect(bubble.boundingBox.height).toBeGreaterThan(0);
      }
      for (const region of truth.expected.textRegions) {
        expect(bubbleIds.has(region.bubbleId)).toBe(true);
        const mask = await sharp(
          path.join(directory, region.maskFile),
        ).metadata();
        expect(mask).toMatchObject({ width: 640, height: 480 });
      }
      for (const item of truth.expected.ocr) {
        expect(bubbleIds.has(item.bubbleId)).toBe(true);
        expect(item.coordinateSpaceId).toBe(truth.coordinateSpace.id);
        expect(item.text.trim().length).toBeGreaterThan(0);
        expect(item.confidence).toBeGreaterThanOrEqual(0);
        expect(item.confidence).toBeLessThanOrEqual(1);
      }
      for (const mapping of truth.expected.dialogueMappings) {
        expect(bubbleIds.has(mapping.bubbleId)).toBe(true);
        expect(mapping.expectedIntervalSeconds.end).toBeGreaterThan(
          mapping.expectedIntervalSeconds.start,
        );
      }
      expect(await readdir(directory)).toContain('ground-truth.json');
    }
  });

  it('covers overlap, cropping, narration, thought bubbles, long dialogue, and difficult lettering numerically', async () => {
    const read = async (name: string) =>
      JSON.parse(
        await readFile(path.join(root, name, 'ground-truth.json'), 'utf8'),
      ) as ComicFixtureGroundTruth;
    const cropped = await read('cropped');
    expect(
      Math.min(...cropped.expected.bubbles[0]!.polygon.map((point) => point.x)),
    ).toBeLessThan(0);
    const narration = await read('narration');
    expect(narration.expected.bubbles[0]!.kind).toBe('narration');
    const thought = await read('thought-bubble');
    expect(thought.expected.bubbles[0]!.kind).toBe('thought');
    const long = await read('long-dialogue');
    expect(long.expected.ocr[0]!.text.length).toBeGreaterThan(50);
    const overlapping = await read('overlapping');
    const [first, second] = overlapping.expected.dialogueMappings;
    expect(first!.expectedIntervalSeconds.end).toBeGreaterThan(
      second!.expectedIntervalSeconds.start,
    );
    expect((await read('difficult-lettering')).expected.ocr[0]!.text).toBe(
      'KRAK!!',
    );
  });
});

describe('fixture scoring functions', () => {
  it('scores masks, bounds, point alignment, and timing with explicit numeric errors', () => {
    expect(
      binaryMaskIoU(Uint8Array.of(1, 1, 0, 0), Uint8Array.of(1, 0, 1, 0)),
    ).toBeCloseTo(1 / 3);
    expect(
      boundsIoU(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 5, y: 0, width: 10, height: 10 },
      ),
    ).toBeCloseTo(1 / 3);
    expect(
      coordinateError(
        [
          { x: 0, y: 0 },
          { x: 3, y: 4 },
        ],
        [
          { x: 0, y: 0 },
          { x: 6, y: 8 },
        ],
      ),
    ).toEqual({ rmsPixels: Math.sqrt(12.5), maximumPixels: 5 });
    expect(
      timingBoundaryError({ start: 1, end: 2 }, { start: 1.04, end: 2.06 }),
    ).toBeCloseTo(0.06);
    expect(FIXTURE_TOLERANCES.bubbleMaskIoU).toBe(0.9);
    expect(FIXTURE_TOLERANCES.difficultBubbleMaskIoU).toBe(0.82);
    expect(FIXTURE_TOLERANCES.timingBoundarySeconds).toBe(0.08);
  });
});
