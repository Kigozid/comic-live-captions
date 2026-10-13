import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  BubbleDetectionEngine,
  createManualBubble,
  deleteBubble,
  editBubble,
} from '@comic-captioner/bubble-engine';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createBlankWhitePanelFixture,
  createBubbleFixture,
} from '../fixtures/bubble-fixtures.js';

const width = 400;
const height = 300;
const imageSpace = createImageSpace('synthetic-page', width, height);
const engine = new BubbleDetectionEngine();

describe('BubbleDetectionEngine', () => {
  it('detects a closed ellipse with page-space geometry, cropped mask, and debug overlay', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    const result = await engine.detect(image, imageSpace);
    const bubble = result.bubbles[0];

    expect(result.bubbles.length).toBeGreaterThan(0);
    expect(bubble?.shape).toBe('ellipse');
    expect(bubble?.confidence).toBeGreaterThanOrEqual(0.45);
    expect(bubble?.boundingBox.coordinateSpace.id).toBe(imageSpace.id);
    expect(bubble?.polygon.coordinateSpace.id).toBe(imageSpace.id);
    expect(bubble?.contour.points.length).toBeGreaterThan(10);
    expect(bubble?.mask.coordinateSpace.kind).toBe('mask');
    expect(bubble?.mask.runs.length).toBeGreaterThan(0);
    expect((await sharp(result.debugPng).metadata()).format).toBe('png');
  });

  it('detects rounded narration boxes and partial balloons', async () => {
    const rounded = await engine.detect(
      await createBubbleFixture('rounded-rectangle', width, height),
      imageSpace,
    );
    expect(rounded.bubbles[0]?.shape).toBe('rounded-rectangle');

    const narration = await engine.detect(
      await createBubbleFixture('narration-box', width, height),
      imageSpace,
    );
    expect(narration.bubbles[0]?.kind).toBe('narration');

    const thought = await engine.detect(
      await createBubbleFixture('thought-cloud', width, height),
      imageSpace,
    );
    // The low-resolution fixture's cloud peaks collapse into an ellipse at the
    // detector's analysis scale, so classification must stay reviewable.
    expect(thought.bubbles[0]?.kind).toBe('unknown');
    expect(thought.bubbles[0]?.classificationConfidence).toBeLessThan(0.5);

    const irregular = await engine.detect(
      await createBubbleFixture('irregular', width, height),
      imageSpace,
    );
    expect(irregular.bubbles[0]?.shape).toBe('irregular');

    const partial = await engine.detect(
      await createBubbleFixture('partial', width, height),
      imageSpace,
    );
    expect(partial.bubbles.some((bubble) => bubble.shape === 'partial')).toBe(
      true,
    );
  });

  it('does not classify a large framed white panel as a speech bubble', async () => {
    const result = await engine.detect(
      await createBlankWhitePanelFixture(width, height),
      imageSpace,
    );
    expect(result.bubbles).toHaveLength(0);
  });

  it('keeps analysis at page resolution for high-resolution scans by default', async () => {
    const pageWidth = 1988;
    const pageHeight = 3056;
    const pageSpace = createImageSpace(
      'high-resolution-page',
      pageWidth,
      pageHeight,
    );
    const image = await createBubbleFixture(
      'rounded-rectangle',
      pageWidth,
      pageHeight,
    );
    const result = await engine.detect(image, pageSpace);

    expect(result.analysisSpace.dimensions).toEqual({
      width: pageWidth,
      height: pageHeight,
    });
  });

  it('combines threshold variants to retain pale balloons and suppress duplicates', async () => {
    const adaptive = createImageSpace('adaptive-threshold-page', width, height);
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#777"/><ellipse cx="125" cy="150" rx="58" ry="48" fill="#d5d5d5" stroke="#111" stroke-width="4"/><ellipse cx="280" cy="150" rx="58" ry="48" fill="#fff" stroke="#111" stroke-width="4"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const result = await engine.detect(image, adaptive);
    const fixed = await engine.detect(image, adaptive, { whiteThreshold: 220 });

    expect(result.bubbles).toHaveLength(2);
    expect(fixed.bubbles).toHaveLength(1);
  });

  it('proposes a tail polygon when a stable tapered protrusion is visible', async () => {
    const result = await engine.detect(
      await createBubbleFixture('speech-tail', width, height),
      imageSpace,
    );
    expect(result.bubbles[0]?.tail?.coordinateSpace.id).toBe(imageSpace.id);
    expect(result.bubbles[0]?.tail?.points).toHaveLength(3);
  });

  it('keeps a large speech balloon and its detached tail as one caption container', async () => {
    const fixturePath = fileURLToPath(
      new URL('../fixtures/simple/cleaned.png', import.meta.url),
    );
    const fixture = new Uint8Array(await readFile(fixturePath));
    const pageSpace = createImageSpace('simple-fixture', 640, 480);
    const result = await engine.detect(fixture, pageSpace);

    expect(result.bubbles).toHaveLength(1);
    expect(result.bubbles[0]?.kind).toBe('speech');
    expect(result.bubbles[0]?.tail).not.toBeNull();
    expect(result.bubbles[0]?.boundingBox.x).toBeLessThan(140);
    expect(result.bubbles[0]?.boundingBox.width).toBeGreaterThan(350);
  });

  it('rejects mismatched image coordinates and invalid thresholds', async () => {
    const image = await createBubbleFixture('ellipse', width, height);
    await expect(
      engine.detect(image, createImageSpace('wrong-size', width + 1, height)),
    ).rejects.toThrow(/dimensions/);
    await expect(
      engine.detect(image, imageSpace, { minimumConfidence: 2 }),
    ).rejects.toThrow(/confidence/);
  });
});

describe('manual bubble editing', () => {
  function polygon(x: number, y: number, size = 30) {
    const points = [
      { x, y, coordinateSpace: imageSpace },
      { x: x + size, y, coordinateSpace: imageSpace },
      { x: x + size, y: y + size, coordinateSpace: imageSpace },
      { x, y: y + size, coordinateSpace: imageSpace },
    ];
    return { points, coordinateSpace: imageSpace } as const;
  }

  it('creates, edits, and deletes bubbles immutably', () => {
    const bubble = createManualBubble({
      id: 'manual-1',
      polygon: polygon(40, 50),
      coordinateSpace: imageSpace,
    });
    expect(bubble.source).toBe('manual');
    expect(bubble.mask.runs.length).toBeGreaterThan(0);
    const edited = editBubble(bubble, {
      polygon: polygon(45, 55, 35),
      kind: 'thought',
    });
    expect(edited.kind).toBe('thought');
    expect(edited.boundingBox.x).toBe(45);
    expect(bubble.boundingBox.x).toBe(40);
    expect(deleteBubble([edited], bubble.id)).toEqual([]);
    expect(() => deleteBubble([], 'missing')).toThrow(/not found/);
  });

  it('rejects user geometry in a different coordinate space', () => {
    const foreignSpace = createImageSpace('foreign', width, height);
    expect(() =>
      createManualBubble({
        id: 'bad',
        coordinateSpace: imageSpace,
        polygon: {
          points: [
            { x: 1, y: 1, coordinateSpace: foreignSpace },
            { x: 20, y: 1, coordinateSpace: foreignSpace },
            { x: 20, y: 20, coordinateSpace: foreignSpace },
          ],
          coordinateSpace: foreignSpace,
        },
      }),
    ).toThrow(/declared ImageSpace/);
  });
});
