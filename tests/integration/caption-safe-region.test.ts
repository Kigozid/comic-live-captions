import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createImageSpace,
  type Bounds,
  type ImageSpace,
  type Polygon,
} from '@comic-captioner/shared';
import {
  CaptionSafeRegionEngine,
  createManualBubble,
  type Bubble,
} from '@comic-captioner/bubble-engine';
import { createImage } from '../fixtures/image-fixtures.js';

const engine = new CaptionSafeRegionEngine();
const pageWidth = 180;
const pageHeight = 150;
const pageSpace = createImageSpace(
  'safe-region-test-page',
  pageWidth,
  pageHeight,
);

function polygon(
  points: readonly [number, number][],
  space: ImageSpace = pageSpace,
): Polygon<ImageSpace> {
  return {
    points: points.map(([x, y]) => ({ x, y, coordinateSpace: space })),
    coordinateSpace: space,
  };
}

function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): Polygon<ImageSpace> {
  return polygon(
    Array.from({ length: 48 }, (_, index) => {
      const angle = (index / 48) * Math.PI * 2;
      return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry] as [
        number,
        number,
      ];
    }),
  );
}

function makeBubble(
  id: string,
  boundary: Polygon<ImageSpace>,
  tail: Polygon<ImageSpace> | null = null,
  shape: Bubble['shape'] = 'irregular',
): Bubble {
  return createManualBubble({
    id,
    coordinateSpace: pageSpace,
    polygon: boundary,
    tail,
    shape,
  });
}

function textBounds(
  x: number,
  y: number,
  width = 18,
  height = 10,
): Bounds<ImageSpace> {
  return { x, y, width, height, coordinateSpace: pageSpace };
}

async function compute(
  bubble: Bubble,
  bounds = textBounds(82, 65),
  padding = 6,
) {
  return engine.compute({
    bubble,
    originalTextBounds: bounds,
    pageImage: await createImage(pageWidth, pageHeight),
    coordinateSpace: pageSpace,
    internalPaddingPx: padding,
  });
}

function maskContains(
  region: Awaited<ReturnType<typeof compute>>['region'],
  x: number,
  y: number,
): boolean {
  const scaleX =
    region.coordinateSpace.dimensions.width /
    region.mask.coordinateSpace.dimensions.width;
  const scaleY =
    region.coordinateSpace.dimensions.height /
    region.mask.coordinateSpace.dimensions.height;
  const maskX = Math.round((x + 0.5) / scaleX - 0.5) - region.mask.origin.x;
  const maskY = Math.round((y + 0.5) / scaleY - 0.5) - region.mask.origin.y;
  return region.mask.runs.some(
    (run) => run.y === maskY && maskX >= run.x && maskX < run.x + run.length,
  );
}

describe('CaptionSafeRegionEngine', () => {
  it.each([
    ['ellipse', ellipse(90, 75, 52, 42), 'ellipse'],
    [
      'rounded rectangle',
      polygon([
        [38, 42],
        [142, 42],
        [142, 108],
        [38, 108],
      ]),
      'rounded-rectangle',
    ],
    [
      'irregular bubble',
      polygon([
        [90, 28],
        [130, 47],
        [143, 77],
        [123, 105],
        [87, 120],
        [51, 100],
        [37, 70],
        [58, 42],
      ]),
      'irregular',
    ],
  ] as const)(
    'creates a binary inset mask for an %s',
    async (_label, boundary, shape) => {
      const result = await compute(
        makeBubble(`bubble-${shape}`, boundary, null, shape),
      );
      expect(result.region.status).toBe('ready');
      expect(result.region.mask.runs.length).toBeGreaterThan(0);
      expect(maskContains(result.region, 90, 75)).toBe(true);
      expect(maskContains(result.region, 39, 75)).toBe(false);
      expect(result.region.boundingBox).not.toBeNull();
      expect((await sharp(result.debugPng).metadata()).format).toBe('png');
    },
  );

  it('excludes the tail and preserves the original text center when it remains safe', async () => {
    const tail = polygon([
      [82, 83],
      [98, 83],
      [90, 112],
    ]);
    const result = await compute(
      makeBubble('with-tail', ellipse(90, 75, 52, 48), tail),
      textBounds(82, 62),
    );
    expect(result.region.tailExcluded).toBe(true);
    expect(maskContains(result.region, 90, 100)).toBe(false);
    expect(result.region.placementPreserved).toBe(true);
    expect(result.region.preferredAnchor).toMatchObject({ x: 91, y: 67 });
  });

  it('detects a cropped bubble and keeps the safe mask inside the page', async () => {
    const boundary = polygon([
      [0, 36],
      [70, 36],
      [92, 52],
      [92, 103],
      [62, 118],
      [0, 118],
    ]);
    const result = await compute(
      makeBubble('cropped', boundary),
      textBounds(34, 68),
    );
    expect(result.region.croppedBubble).toBe(true);
    expect(result.region.status).toBe('ready');
    expect(result.region.boundingBox!.x).toBeGreaterThan(0);
  });

  it('returns an empty mask for a bubble too small for the requested padding', async () => {
    const result = await compute(
      makeBubble(
        'small',
        polygon([
          [82, 68],
          [98, 68],
          [98, 82],
          [82, 82],
        ]),
      ),
      textBounds(84, 70, 8, 6),
      8,
    );
    expect(result.region.status).toBe('no-safe-area');
    expect(result.region.mask.runs).toEqual([]);
    expect(result.region.preferredAnchor).toBeNull();
  });
});
