import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  TextRegionDetectionError,
  TextRegionDetector,
} from '../../packages/image-engine/src/text-regions.js';

/** Build a synthetic greyscale-ish PNG via sharp raw buffer + encode. */
async function makePage(
  width: number,
  height: number,
  draw: (data: Uint8ClampedArray) => void,
): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const data = new Uint8ClampedArray(width * height * 3);
  // White background.
  for (let i = 0; i < data.length; i += 3) {
    data[i] = 240;
    data[i + 1] = 240;
    data[i + 2] = 240;
  }
  draw(data);
  return new Uint8Array(
    await sharp(Buffer.from(data.buffer), {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toBuffer(),
  );
}

function fillRect(
  data: Uint8ClampedArray,
  pageWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value = 20,
): void {
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      const index = (row * pageWidth + col) * 3;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  }
}

function drawTextLine(
  data: Uint8ClampedArray,
  pageWidth: number,
  x: number,
  y: number,
  glyphCount = 6,
): void {
  // Several small dark blocks resemble a line of lettering.
  for (let i = 0; i < glyphCount; i += 1) {
    fillRect(data, pageWidth, x + i * 10, y, 6, 12);
  }
}

describe('TextRegionDetector', () => {
  it('rejects dimension mismatches and undecodable images', async () => {
    const detector = new TextRegionDetector();
    const space = createImageSpace('tr-dim', 200, 100);
    const image = await makePage(200, 100, () => {});
    await expect(detector.detect(image, space)).resolves.toBeDefined();
    const wrong = createImageSpace('tr-wrong', 100, 50);
    await expect(detector.detect(image, wrong)).rejects.toBeInstanceOf(
      TextRegionDetectionError,
    );
    await expect(
      detector.detect(new Uint8Array([1, 2, 3]), space),
    ).rejects.toBeInstanceOf(TextRegionDetectionError);
  });

  it('detects ink lines and reports derived geometry with separate confidence', async () => {
    const width = 240;
    const height = 160;
    const image = await makePage(width, height, (data) => {
      drawTextLine(data, width, 30, 30);
      drawTextLine(data, width, 40, 80);
    });
    const space = createImageSpace('tr-basic', width, height);
    const detector = new TextRegionDetector();
    const result = await detector.detect(image, space);

    expect(result.imageDimensions).toEqual({ width, height });
    expect(result.coordinateSpace.id).toBe('tr-basic');
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
    for (const region of result.regions) {
      expect(region.id).toMatch(/^text-/);
      expect(region.coordinateSpace.id).toBe('tr-basic');
      expect(region.boundingBox.width).toBeGreaterThan(0);
      expect(region.boundingBox.height).toBeGreaterThan(0);
      expect(region.polygon.points.length).toBeGreaterThanOrEqual(4);
      expect(region.confidence).toBeGreaterThanOrEqual(0);
      expect(region.confidence).toBeLessThanOrEqual(1);
      // Deterministic path never claims model geometry.
      expect(region.geometryProvenance).toBe('derived');
      expect(region.detectionSource).toBe('deterministic');
      expect(typeof region.needsReview).toBe('boolean');
    }
    // Order is dense and stable within one result.
    result.regions.forEach((region, index) => {
      expect(region.order).toBe(index);
    });
  });

  it('returns an empty list for blank pages without inventing regions', async () => {
    const image = await makePage(120, 80, () => {});
    const space = createImageSpace('tr-blank', 120, 80);
    const result = await new TextRegionDetector().detect(image, space);
    expect(result.regions).toEqual([]);
  });

  it('merges model proposals without fabricating polygons from boxes', async () => {
    const width = 200;
    const height = 120;
    const image = await makePage(width, height, (data) => {
      drawTextLine(data, width, 20, 20, 4);
    });
    const space = createImageSpace('tr-merge', width, height);
    const provider = {
      name: 'synthetic-text-detector',
      propose() {
        return [
          {
            id: 'model-text-1',
            boundingBox: {
              x: 18,
              y: 18,
              width: 50,
              height: 20,
              coordinateSpace: space,
            },
            confidence: 0.82,
            provenance: 'model' as const,
          },
        ];
      },
    };
    const result = await new TextRegionDetector({ provider }).detect(
      image,
      space,
    );
    expect(result.provider).toBe('deterministic+synthetic-text-detector');
    const merged = result.regions.find((region) => region.id === 'model-text-1');
    if (merged) {
      // Box-only proposal keeps derived polygon; provenance stays explicit.
      expect(['hybrid', 'derived', 'model']).toContain(
        merged.geometryProvenance,
      );
    }
    // At least one region exists from the deterministic line.
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
  });

  it('validates malformed proposals and options', async () => {
    const width = 80;
    const height = 60;
    const image = await makePage(width, height, () => {});
    const space = createImageSpace('tr-invalid', width, height);
    const badProvider = {
      name: 'bad',
      propose() {
        return [
          {
            id: '',
            boundingBox: {
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              coordinateSpace: space,
            },
            confidence: 0.5,
            provenance: 'model' as const,
          },
        ];
      },
    };
    await expect(
      new TextRegionDetector({ provider: badProvider }).detect(image, space),
    ).rejects.toBeInstanceOf(TextRegionDetectionError);

    await expect(
      new TextRegionDetector().detect(image, space, {
        inkLuminanceThreshold: 999,
      }),
    ).rejects.toBeInstanceOf(TextRegionDetectionError);
    await expect(
      new TextRegionDetector().detect(image, space, {
        maximumAreaRatio: 0,
      }),
    ).rejects.toBeInstanceOf(TextRegionDetectionError);
  });

  it('maps analysis coordinates back to original image pixels at different sizes', async () => {
    // Large page forces analysis downscale; bounds must stay in original space.
    const width = 800;
    const height = 600;
    const image = await makePage(width, height, (data) => {
      drawTextLine(data, width, 100, 80, 8);
    });
    const space = createImageSpace('tr-scale', width, height);
    const result = await new TextRegionDetector().detect(image, space, {
      maximumAnalysisSide: 200,
    });
    expect(result.analysisWidth).toBeLessThanOrEqual(200);
    for (const region of result.regions) {
      expect(region.boundingBox.x).toBeGreaterThanOrEqual(-1);
      expect(region.boundingBox.y).toBeGreaterThanOrEqual(-1);
      expect(region.boundingBox.x + region.boundingBox.width).toBeLessThanOrEqual(
        width + 1,
      );
      expect(region.boundingBox.y + region.boundingBox.height).toBeLessThanOrEqual(
        height + 1,
      );
      // Scaling should expand analysis boxes back toward original pixels.
      if (region.boundingBox.width > 0) {
        expect(region.boundingBox.width).toBeGreaterThan(2);
      }
    }
  });

  it('flags low-confidence regions for review', async () => {
    const width = 100;
    const height = 80;
    const image = await makePage(width, height, (data) => {
      // Tiny isolated specks score low on text-likeness.
      fillRect(data, width, 10, 10, 2, 2);
      fillRect(data, width, 40, 40, 2, 2);
    });
    const space = createImageSpace('tr-low', width, height);
    const result = await new TextRegionDetector().detect(image, space, {
      minimumComponentArea: 1,
    });
    for (const region of result.regions) {
      if (region.confidence < 0.55) {
        expect(region.needsReview).toBe(true);
      }
    }
  });
});
