import { describe, expect, it } from 'vitest';
import { createImageSpace, type ImageSpace } from '@comic-captioner/shared';
import {
  LetteringRemovalError,
  LetteringRemover,
  type LetteringSourceRegion,
  type RasterImage,
} from '../../packages/image-engine/src/lettering-removal.js';

const space: ImageSpace = createImageSpace('lettering-test', 64, 48);

function makeRaster(
  width = 64,
  height = 48,
  fill: [number, number, number] = [250, 250, 250],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function paintRect(
  raster: RasterImage,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: [number, number, number],
): void {
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      const i = (row * raster.width + col) * 4;
      raster.data[i] = colour[0];
      raster.data[i + 1] = colour[1];
      raster.data[i + 2] = colour[2];
      raster.data[i + 3] = 255;
    }
  }
}

function boxRegion(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  bubbleId: string | null = null,
): LetteringSourceRegion {
  return {
    id,
    boundingBox: { x, y, width: w, height: h, coordinateSpace: space },
    associatedBubbleId: bubbleId,
    detectionConfidence: 0.9,
    associationConfidence: bubbleId ? 0.85 : 0,
  };
}

function rectContour(x: number, y: number, w: number, h: number) {
  return {
    points: [
      { x, y, coordinateSpace: space },
      { x: x + w, y, coordinateSpace: space },
      { x: x + w, y: y + h, coordinateSpace: space },
      { x, y: y + h, coordinateSpace: space },
    ],
    coordinateSpace: space,
  };
}

function pixelAt(raster: RasterImage, x: number, y: number) {
  const i = (y * raster.width + x) * 4;
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2]] as const;
}

function countDark(raster: RasterImage): number {
  let count = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (raster.data[i]! < 80 && raster.data[i + 1]! < 80) count += 1;
  }
  return count;
}

describe('LetteringRemover', () => {
  it('1. removes black lettering from a white balloon and keeps dimensions', async () => {
    const raster = makeRaster();
    // White balloon interior already; black glyphs.
    paintRect(raster, 20, 20, 4, 8, [10, 10, 10]);
    paintRect(raster, 26, 20, 4, 8, [10, 10, 10]);
    const before = countDark(raster);
    expect(before).toBeGreaterThan(0);

    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'bubble-1',
          contour: rectContour(10, 10, 40, 28),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('text-1', 18, 18, 14, 12, 'bubble-1')],
    });

    expect(result.cleaned.width).toBe(64);
    expect(result.cleaned.height).toBe(48);
    expect(result.cleaned.data.length).toBe(raster.data.length);
    expect(countDark(result.cleaned)).toBe(0);
    // Untouched background stays white-ish.
    expect(pixelAt(result.cleaned, 5, 5)).toEqual([250, 250, 250]);
    expect(result.regions[0]!.method).toBe('white-fill');
    expect(result.regions[0]!.success).toBe(true);
    expect(result.methodSummary['white-fill']).toBe(1);
  });

  it('2. reduces expansion near a bubble outline and flags the region', async () => {
    const raster = makeRaster();
    // Glyphs pressed against the outline at x=12.
    paintRect(raster, 13, 20, 3, 8, [10, 10, 10]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'bubble-outline',
          contour: rectContour(12, 12, 30, 24),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('near-edge', 13, 18, 6, 12, 'bubble-outline')],
      options: {
        expansionPx: 3,
        maximumOutlineAdjacentExpansionPx: 0,
      },
    });
    expect(
      result.warnings.some((warning) => warning.code === 'near-outline'),
    ).toBe(true);
    expect(result.cleaned.width).toBe(64);
    expect(result.regions[0]!.success).toBe(true);
  });

  it('3. fills a coloured balloon with the sampled interior colour', async () => {
    const raster = makeRaster(64, 48, [200, 220, 255]);
    paintRect(raster, 22, 22, 6, 8, [5, 5, 5]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'blue-balloon',
          contour: rectContour(10, 10, 40, 28),
          interiorHint: 'coloured-balloon',
        },
      ],
      textRegions: [boxRegion('text-blue', 20, 20, 12, 12, 'blue-balloon')],
    });
    expect(result.regions[0]!.method).toBe('background-fill');
    const filled = pixelAt(result.cleaned, 24, 24);
    expect(filled[0]).toBeGreaterThan(150);
    expect(filled[2]).toBeGreaterThan(200);
    expect(countDark(result.cleaned)).toBe(0);
  });

  it('4. reconstructs text over textured artwork without claiming white fill', async () => {
    const raster = makeRaster();
    // Textured background.
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const v = 120 + ((x * 3 + y * 5) % 80);
        paintRect(raster, x, y, 1, 1, [v, v - 10, v - 20]);
      }
    }
    paintRect(raster, 24, 24, 8, 6, [5, 5, 5]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [],
      textRegions: [
        {
          ...boxRegion('artwork-text', 22, 22, 12, 10),
          approved: true,
          reviewStatus: 'accepted' as const,
        },
      ],
      options: {
        preferLamaForArtwork: false,
        erasureScope: 'approved',
      },
    });
    expect(['local-reconstruct', 'background-fill']).toContain(
      result.regions[0]!.method,
    );
    expect(result.regions[0]!.method).not.toBe('white-fill');
    expect(countDark(result.cleaned)).toBe(0);
  });

  it('5. cleans multiple balloons independently', async () => {
    const raster = makeRaster();
    paintRect(raster, 14, 14, 4, 6, [10, 10, 10]);
    paintRect(raster, 44, 28, 4, 6, [10, 10, 10]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'b1',
          contour: rectContour(8, 8, 20, 16),
          interiorHint: 'white-balloon',
        },
        {
          id: 'b2',
          contour: rectContour(38, 22, 20, 16),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [
        boxRegion('t1', 12, 12, 8, 10, 'b1'),
        boxRegion('t2', 42, 26, 8, 10, 'b2'),
      ],
    });
    expect(result.regions).toHaveLength(2);
    expect(result.regions.every((region) => region.success)).toBe(true);
    expect(countDark(result.cleaned)).toBe(0);
  });

  it('6. clips text that crosses a bubble boundary and warns', async () => {
    const raster = makeRaster();
    // Text block straddling the right edge of the balloon.
    paintRect(raster, 40, 20, 10, 6, [10, 10, 10]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'edge-balloon',
          contour: rectContour(10, 10, 35, 28),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('crossing', 38, 18, 14, 10, 'edge-balloon')],
      options: { expansionPx: 1, maximumOutlineAdjacentExpansionPx: 0 },
    });
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === 'crosses-boundary' || warning.code === 'near-outline',
      ),
    ).toBe(true);
  });

  it('7. handles an irregular balloon with a pointed tail', async () => {
    const raster = makeRaster();
    paintRect(raster, 24, 18, 5, 7, [10, 10, 10]);
    const diamondWithTail = {
      points: [
        { x: 32, y: 10, coordinateSpace: space },
        { x: 50, y: 22, coordinateSpace: space },
        { x: 40, y: 30, coordinateSpace: space },
        { x: 32, y: 40, coordinateSpace: space },
        { x: 24, y: 30, coordinateSpace: space },
        { x: 14, y: 22, coordinateSpace: space },
      ],
      coordinateSpace: space,
    };
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'tail-balloon',
          contour: diamondWithTail,
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('tail-text', 22, 16, 10, 12, 'tail-balloon')],
    });
    expect(result.regions[0]!.success).toBe(true);
    expect(countDark(result.cleaned)).toBe(0);
  });

  it('8. returns a clean page with no regions when there is no text', async () => {
    const raster = makeRaster();
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'empty-bubble',
          contour: rectContour(10, 10, 30, 20),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [],
    });
    expect(result.regions).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.cleaned.width).toBe(64);
    // Untouched pixels remain identical.
    expect(pixelAt(result.cleaned, 1, 1)).toEqual(pixelAt(raster, 1, 1));
  });

  it('9. rejects invalid or empty source masks', async () => {
    const raster = makeRaster();
    const remover = new LetteringRemover();
    await expect(
      remover.removeLettering({
        image: raster,
        coordinateSpace: space,
        textRegions: [
          {
            id: 'bad-mask',
            mask: new Uint8Array(3),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LetteringRemovalError);

    await expect(
      remover.removeLettering({
        image: raster,
        coordinateSpace: space,
        textRegions: [{ id: 'no-geometry' }],
      }),
    ).rejects.toBeInstanceOf(LetteringRemovalError);
  });

  it('10. reports failed generative inpainting without marking success', async () => {
    const raster = makeRaster();
    paintRect(raster, 20, 20, 8, 6, [5, 5, 5]);
    const failing = {
      name: 'lama-fail',
      available: () => true,
      inpaint: async () => {
        throw new Error('model exploded');
      },
    };
    const result = await new LetteringRemover({
      generative: failing,
    }).removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'art-bubble',
          contour: rectContour(8, 8, 40, 30),
          interiorHint: 'artwork',
        },
      ],
      textRegions: [
        {
          ...boxRegion('art-text', 18, 18, 12, 10, 'art-bubble'),
          preferredMethod: 'lama',
        },
      ],
    });
    const region = result.regions[0]!;
    expect(region.success).toBe(false);
    expect(region.method).toBe('skipped');
    expect(result.complete).toBe(false);
    expect(
      result.warnings.some((warning) => warning.code === 'method-failed'),
    ).toBe(true);
    // Original dark pixels remain — never a silent unchanged success.
    expect(countDark(result.cleaned)).toBeGreaterThan(0);
  });

  it('10b. falls back when LaMa is unavailable and still cleans deterministically', async () => {
    const raster = makeRaster();
    paintRect(raster, 20, 20, 6, 6, [5, 5, 5]);
    const unavailable = {
      name: 'lama-missing',
      available: () => false,
      inpaint: async () => raster,
    };
    const result = await new LetteringRemover({
      generative: unavailable,
    }).removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [],
      textRegions: [
        {
          ...boxRegion('fallback-text', 18, 18, 12, 12),
          preferredMethod: 'lama',
          approved: true,
          reviewStatus: 'accepted' as const,
        },
      ],
      options: { erasureScope: 'approved' },
    });
    expect(result.regions[0]!.method).toBe('local-reconstruct');
    expect(
      result.warnings.some((warning) => warning.code === 'method-unavailable'),
    ).toBe(true);
    expect(countDark(result.cleaned)).toBe(0);
  });

  it('11. applies manual add and exclude mask edits', async () => {
    const raster = makeRaster();
    paintRect(raster, 20, 20, 6, 6, [5, 5, 5]);
    paintRect(raster, 36, 20, 4, 4, [5, 5, 5]);
    const add = new Uint8Array(64 * 48);
    // Manually add the second glyph block.
    for (let y = 20; y < 24; y += 1) {
      for (let x = 36; x < 40; x += 1) add[y * 64 + x] = 1;
    }
    const exclude = new Uint8Array(64 * 48);
    // Protect a corner of the original text from erasure.
    for (let y = 20; y < 22; y += 1) {
      for (let x = 20; x < 24; x += 1) exclude[y * 64 + x] = 1;
    }
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'edit-bubble',
          contour: rectContour(8, 8, 48, 32),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('edit-text', 18, 18, 10, 10, 'edit-bubble')],
      manualEdits: [{ regionId: 'edit-text', addPixels: add, excludePixels: exclude }],
      options: { expansionPx: 0, mergeGapPx: 0 },
    });
    // Excluded pixels keep dark colour.
    expect(pixelAt(result.cleaned, 21, 21)[0]).toBe(5);
    // Manually added region is erased.
    expect(pixelAt(result.cleaned, 38, 22)[0]).toBeGreaterThan(200);
  });

  it('10c. refuses generative inpainting on oversized masks', async () => {
    const raster = makeRaster();
    paintRect(raster, 8, 8, 40, 30, [5, 5, 5]);
    let called = false;
    const generative = {
      name: 'lama-big',
      available: () => true,
      inpaint: async () => {
        called = true;
        return raster;
      },
    };
    const result = await new LetteringRemover({ generative }).removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [],
      textRegions: [
        {
          ...boxRegion('huge', 4, 4, 50, 40),
          preferredMethod: 'lama',
          approved: true,
          reviewStatus: 'accepted' as const,
        },
      ],
      options: {
        maximumGenerativeMaskPixels: 100,
        expansionPx: 0,
        mergeGapPx: 0,
        erasureScope: 'approved',
      },
    });
    expect(called).toBe(false);
    expect(result.regions[0]!.method).toBe('local-reconstruct');
    expect(
      result.warnings.some((warning) => warning.code === 'method-unavailable'),
    ).toBe(true);
  });

  it('13. default scope never auto-erases unreviewed free-floating text', async () => {
    const raster = makeRaster();
    // Dark "sign" text outside any balloon.
    paintRect(raster, 50, 10, 8, 6, [5, 5, 5]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'balloon',
          contour: rectContour(8, 20, 30, 20),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [
        boxRegion('sign-text', 48, 8, 12, 10, null),
      ],
    });
    const region = result.regions[0]!;
    expect(region.method).toBe('skipped');
    expect(region.needsReview).toBe(true);
    // Artwork/sign pixels untouched.
    expect(pixelAt(result.cleaned, 53, 12)[0]).toBe(5);
    expect(
      result.warnings.some((warning) => warning.code === 'needs-review'),
    ).toBe(true);
  });

  it('13b. bubble-interior lettering still erases under the default scope', async () => {
    const raster = makeRaster();
    paintRect(raster, 16, 26, 6, 6, [5, 5, 5]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'balloon',
          contour: rectContour(8, 20, 30, 20),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('dialogue', 14, 24, 10, 10, 'balloon')],
      options: { expansionPx: 0, mergeGapPx: 0 },
    });
    expect(result.regions[0]!.method).toBe('white-fill');
    expect(pixelAt(result.cleaned, 18, 28)[0]).toBeGreaterThan(200);
  });

  it('13c. approved free-floating text erases only with erasureScope approved', async () => {
    const raster = makeRaster();
    paintRect(raster, 50, 10, 8, 6, [5, 5, 5]);
    const region = {
      ...boxRegion('sfx', 48, 8, 12, 10, null),
      approved: true,
      reviewStatus: 'accepted' as const,
    };

    const held = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      textRegions: [region],
      options: { erasureScope: 'bubble-interior', expansionPx: 0 },
    });
    expect(held.regions[0]!.method).toBe('skipped');
    expect(pixelAt(held.cleaned, 53, 12)[0]).toBe(5);

    const erased = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      textRegions: [region],
      options: { erasureScope: 'approved', expansionPx: 0, mergeGapPx: 0 },
    });
    expect(erased.regions[0]!.method).toBe('white-fill');
    expect(pixelAt(erased.cleaned, 53, 12)[0]).toBeGreaterThan(200);
  });

  it('13d. rejected regions are never erased even inside a bubble', async () => {
    const raster = makeRaster();
    paintRect(raster, 16, 26, 6, 6, [5, 5, 5]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'balloon',
          contour: rectContour(8, 20, 30, 20),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [
        {
          ...boxRegion('keep-me', 14, 24, 10, 10, 'balloon'),
          reviewStatus: 'rejected' as const,
        },
      ],
    });
    expect(result.regions[0]!.method).toBe('skipped');
    expect(pixelAt(result.cleaned, 18, 28)[0]).toBe(5);
  });

  it('12. supports repeated cleaning; original buffer is never mutated', async () => {
    const raster = makeRaster();
    paintRect(raster, 20, 20, 5, 5, [5, 5, 5]);
    const snapshot = Uint8ClampedArray.from(raster.data);
    const remover = new LetteringRemover();
    const first = await remover.removeLettering({
      image: raster,
      coordinateSpace: space,
      textRegions: [
        {
          ...boxRegion('repeat', 18, 18, 10, 10),
          approved: true,
          reviewStatus: 'accepted' as const,
        },
      ],
      options: { expansionPx: 0, erasureScope: 'approved', mergeGapPx: 0 },
    });
    const second = await remover.removeLettering({
      image: raster,
      coordinateSpace: space,
      textRegions: [
        {
          ...boxRegion('repeat', 18, 18, 10, 10),
          approved: true,
          reviewStatus: 'accepted' as const,
        },
      ],
      options: { expansionPx: 0, erasureScope: 'approved', mergeGapPx: 0 },
    });
    expect(Buffer.from(raster.data).equals(Buffer.from(snapshot))).toBe(true);
    expect(first.cleaned.width).toBe(second.cleaned.width);
    // Deterministic fills are stable across identical requests.
    expect(countDark(first.cleaned)).toBe(countDark(second.cleaned));
  });

  it('preserves panel borders and artwork outside the text mask', async () => {
    const raster = makeRaster();
    // Panel border.
    paintRect(raster, 2, 2, 60, 2, [0, 0, 0]);
    paintRect(raster, 2, 2, 2, 44, [0, 0, 0]);
    paintRect(raster, 22, 22, 5, 5, [5, 5, 5]);
    const result = await new LetteringRemover().removeLettering({
      image: raster,
      coordinateSpace: space,
      bubbles: [
        {
          id: 'panel-bubble',
          contour: rectContour(12, 12, 30, 24),
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [boxRegion('inner-text', 20, 20, 10, 10, 'panel-bubble')],
      options: { expansionPx: 1 },
    });
    // Border stays black.
    expect(pixelAt(result.cleaned, 3, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(result.cleaned, 3, 20)).toEqual([0, 0, 0]);
    // Lettering removed.
    expect(pixelAt(result.cleaned, 23, 23)[0]).toBeGreaterThan(200);
  });
});
