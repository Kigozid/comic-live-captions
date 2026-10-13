import { describe, expect, it } from 'vitest';
import {
  createImageSpace,
  type ImageSpace,
  type Polygon,
} from '@comic-captioner/shared';
import {
  detectTextRegionsForInpaint,
  inpaintTextRegions,
  InpaintError,
  type InpaintBubbleInput,
  type RasterImage,
} from '@comic-captioner/image-engine';

const width = 120;
const height = 80;
const pageSpace = createImageSpace('inpaint-page', width, height);

function rectPolygon(
  space: ImageSpace,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
): Polygon<ImageSpace> {
  return {
    points: [
      { x, y, coordinateSpace: space },
      { x: x + rectWidth, y, coordinateSpace: space },
      { x: x + rectWidth, y: y + rectHeight, coordinateSpace: space },
      { x, y: y + rectHeight, coordinateSpace: space },
    ],
    coordinateSpace: space,
  };
}

function createRaster(
  fill: readonly [number, number, number, number],
): { image: RasterImage; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = fill[0];
    data[index * 4 + 1] = fill[1];
    data[index * 4 + 2] = fill[2];
    data[index * 4 + 3] = fill[3];
  }
  return { image: { width, height, data }, data };
}

function fillRect(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: readonly [number, number, number],
): void {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let column = x; column < x + rectWidth; column += 1) {
      const index = (row * width + column) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = 255;
    }
  }
}

function luminanceAt(data: Uint8ClampedArray, x: number, y: number): number {
  const index = (y * width + x) * 4;
  return (
    0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!
  );
}

/** Gray page with one white bubble and a dark text block inside it. */
function createPlainBubblePage(): {
  image: RasterImage;
  bubble: InpaintBubbleInput;
  data: Uint8ClampedArray;
} {
  const { image, data } = createRaster([128, 128, 128, 255]);
  fillRect(data, 20, 15, 80, 50, [255, 255, 255]);
  fillRect(data, 40, 32, 32, 12, [30, 30, 30]);
  return {
    image,
    data,
    bubble: {
      id: 'bubble-plain',
      contour: rectPolygon(pageSpace, 20, 15, 80, 50),
    },
  };
}

describe('detectTextRegionsForInpaint', () => {
  it('detects dark ink inside a plain bubble and suggests solid-fill', () => {
    const { image, bubble } = createPlainBubblePage();
    const masks = detectTextRegionsForInpaint(image, [bubble]);

    expect(masks).toHaveLength(1);
    const mask = masks[0]!;
    expect(mask.bubbleId).toBe('bubble-plain');
    expect(mask.method).toBe('ink-detection');
    expect(mask.suggestedMode).toBe('solid-fill');
    expect(mask.confidence).toBeGreaterThan(0.5);
    expect(mask.pixels).toHaveLength(width * height);
    expect(mask.pixels[35 * width + 45]).toBe(1);
    expect(mask.pixels[20 * width + 30]).toBe(0);
    expect(mask.boundingBox.coordinateSpace.id).toBe(pageSpace.id);
    expect(mask.boundingBox.x).toBeGreaterThan(35);
    expect(mask.boundingBox.width).toBeGreaterThan(20);
  });

  it('uses text observations when provided and falls back to ink detection', () => {
    const { image, bubble } = createPlainBubblePage();
    const observation = {
      id: 'obs-1',
      polygon: rectPolygon(pageSpace, 40, 32, 32, 12),
      associatedBubbleId: 'bubble-plain',
    };
    const masks = detectTextRegionsForInpaint(image, [bubble], [observation]);

    expect(masks).toHaveLength(1);
    expect(masks[0]!.method).toBe('text-observation');
    expect(masks[0]!.pixels[35 * width + 45]).toBe(1);

    // An observation bound to a different bubble must not suppress ink
    // detection on this one.
    const foreign = {
      id: 'obs-2',
      polygon: rectPolygon(pageSpace, 2, 2, 4, 4),
      associatedBubbleId: 'other-bubble',
    };
    const fallback = detectTextRegionsForInpaint(image, [bubble], [foreign]);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.method).toBe('ink-detection');
  });

  it('marks combined method when observations miss part of the detected ink', () => {
    const { image, bubble } = createPlainBubblePage();
    // Cover only the left half of the text block.
    const partial = {
      id: 'obs-partial',
      polygon: rectPolygon(pageSpace, 40, 32, 14, 12),
      associatedBubbleId: 'bubble-plain',
    };
    const masks = detectTextRegionsForInpaint(image, [bubble], [partial]);
    expect(masks[0]!.method).toBe('combined');
    expect(masks[0]!.pixels[35 * width + 45]).toBe(1);
    expect(masks[0]!.pixels[35 * width + 68]).toBe(1);
  });

  it('suggests diffusion for textured bubble interiors', () => {
    const { image, data, bubble } = createPlainBubblePage();
    for (let y = 16; y < 64; y += 1) {
      for (let x = 21; x < 99; x += 1) {
        const index = (y * width + x) * 4;
        const texture = 170 + ((x * 3 + y * 5) % 60);
        data[index] = texture;
        data[index + 1] = texture;
        data[index + 2] = texture;
      }
    }
    fillRect(data, 40, 32, 32, 12, [30, 30, 30]);
    const masks = detectTextRegionsForInpaint(image, [bubble]);
    expect(masks[0]!.suggestedMode).toBe('diffusion');
  });

  it('skips bubbles without erasable text', () => {
    const { image, data } = createRaster([128, 128, 128, 255]);
    fillRect(data, 20, 15, 80, 50, [255, 255, 255]);
    const masks = detectTextRegionsForInpaint(image, [
      { id: 'blank', contour: rectPolygon(pageSpace, 20, 15, 80, 50) },
    ]);
    expect(masks).toEqual([]);
  });

  it('rejects rasters and geometry that disagree', () => {
    const { image, bubble } = createPlainBubblePage();
    expect(() =>
      detectTextRegionsForInpaint(
        { width, height, data: new Uint8ClampedArray(10) },
        [bubble],
      ),
    ).toThrow(InpaintError);
    expect(() => detectTextRegionsForInpaint(image, [])).toThrow(InpaintError);
    const wrongSpace = createImageSpace('wrong', width + 4, height);
    expect(() =>
      detectTextRegionsForInpaint(image, [
        {
          id: 'bubble',
          contour: rectPolygon(wrongSpace, 20, 15, 80, 50),
        },
      ]),
    ).toThrow(/ImageSpace/);
  });
});

describe('inpaintTextRegions', () => {
  it('solid-fills plain-bubble text with the estimated interior background', () => {
    const { image, bubble, data } = createPlainBubblePage();
    const before = Uint8ClampedArray.from(data);
    const masks = detectTextRegionsForInpaint(image, [bubble]);
    const cleaned = inpaintTextRegions(image, masks);

    expect(cleaned.width).toBe(width);
    expect(cleaned.height).toBe(height);
    // Text pixels are replaced by the near-white bubble interior.
    expect(luminanceAt(cleaned.data, 45, 35)).toBeGreaterThan(250);
    expect(luminanceAt(cleaned.data, 60, 40)).toBeGreaterThan(250);
    // Bubble background and page background stay untouched.
    expect(luminanceAt(cleaned.data, 30, 20)).toBeCloseTo(255, 5);
    expect(luminanceAt(cleaned.data, 5, 5)).toBeCloseTo(128, 5);
    // The source raster is never mutated.
    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it('diffusion-fills textured bubble text from surrounding colors', () => {
    const { image, data, bubble } = createPlainBubblePage();
    for (let y = 16; y < 64; y += 1) {
      for (let x = 21; x < 99; x += 1) {
        const index = (y * width + x) * 4;
        const texture = 170 + ((x * 3 + y * 5) % 60);
        data[index] = texture;
        data[index + 1] = texture;
        data[index + 2] = texture;
      }
    }
    fillRect(data, 40, 32, 32, 12, [30, 30, 30]);
    const masks = detectTextRegionsForInpaint(image, [bubble]);
    expect(masks[0]!.suggestedMode).toBe('diffusion');
    const cleaned = inpaintTextRegions(image, masks);

    let erased = 0;
    for (let index = 0; index < width * height; index += 1) {
      if (!masks[0]!.pixels[index]) continue;
      erased += 1;
      const luminance =
        0.2126 * cleaned.data[index * 4]! +
        0.7152 * cleaned.data[index * 4 + 1]! +
        0.0722 * cleaned.data[index * 4 + 2]!;
      // Filled values come from the textured interior, never the text ink.
      expect(luminance).toBeGreaterThan(150);
      expect(luminance).toBeLessThan(245);
    }
    expect(erased).toBeGreaterThan(100);
    // Pixels outside the mask keep their texture exactly.
    const outside = (25 * width + 25) * 4;
    expect(cleaned.data[outside]).toBe(data[outside]);
  });

  it('honors a forced inpaint mode over per-mask suggestions', () => {
    const { image, data, bubble } = createPlainBubblePage();
    for (let y = 16; y < 64; y += 1) {
      for (let x = 21; x < 99; x += 1) {
        const index = (y * width + x) * 4;
        const texture = 170 + ((x * 3 + y * 5) % 60);
        data[index] = texture;
        data[index + 1] = texture;
        data[index + 2] = texture;
      }
    }
    fillRect(data, 40, 32, 32, 12, [30, 30, 30]);
    const masks = detectTextRegionsForInpaint(image, [bubble]);
    const solid = inpaintTextRegions(image, masks, { mode: 'solid-fill' });
    // Solid fill paints one constant color everywhere in the hole.
    const first = masks[0]!.pixels.findIndex((value) => value === 1);
    const firstColor = [
      solid.data[first * 4],
      solid.data[first * 4 + 1],
      solid.data[first * 4 + 2],
    ];
    for (let index = 0; index < width * height; index += 1) {
      if (!masks[0]!.pixels[index]) continue;
      expect([
        solid.data[index * 4],
        solid.data[index * 4 + 1],
        solid.data[index * 4 + 2],
      ]).toEqual(firstColor);
    }
  });

  it('returns an unchanged copy when there is nothing to erase', () => {
    const { image, data } = createPlainBubblePage();
    const cleaned = inpaintTextRegions(image, []);
    expect(Array.from(cleaned.data)).toEqual(Array.from(data));
    expect(cleaned.data).not.toBe(data);
  });

  it('rejects masks that do not match the raster and invalid options', () => {
    const { image, bubble } = createPlainBubblePage();
    const masks = detectTextRegionsForInpaint(image, [bubble]);
    expect(() =>
      inpaintTextRegions(image, [
        { ...masks[0]!, pixels: new Uint8Array(3) },
      ]),
    ).toThrow(/mask dimensions/);
    expect(() =>
      inpaintTextRegions(image, masks, { mode: 'smear' as 'diffusion' }),
    ).toThrow(InpaintError);
    expect(() =>
      inpaintTextRegions(image, masks, { diffusionIterations: 0 }),
    ).toThrow(InpaintError);
    expect(() =>
      inpaintTextRegions(image, masks, { diffusionEpsilon: -1 }),
    ).toThrow(InpaintError);
  });
});
