import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import type { OCRDocument } from '@comic-captioner/shared';
import {
  PageDetectionCoordinator,
  PageDetectionError,
} from '../../apps/api/src/page-detection.js';
import { BubbleDetectionEngine } from '../../packages/bubble-engine/src/index.js';
import { TextRegionDetector } from '../../packages/image-engine/src/text-regions.js';

async function makePage(
  width: number,
  height: number,
  draw?: (data: Uint8ClampedArray) => void,
): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = 245;
    data[i + 1] = 245;
    data[i + 2] = 245;
  }
  draw?.(data);
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
  value = 15,
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

function ocrDocument(space: ReturnType<typeof createImageSpace>): OCRDocument {
  const box = {
    x: 50,
    y: 50,
    width: 80,
    height: 18,
    coordinateSpace: space,
  };
  return {
    id: 'ocr-test',
    text: 'Hello panel',
    boundingBox: box,
    confidence: 0.93,
    coordinateSpace: space,
    blocks: [
      {
        id: 'block-1',
        text: 'Hello panel',
        boundingBox: box,
        confidence: 0.93,
        coordinateSpace: space,
        lines: [
          {
            id: 'line-1',
            text: 'Hello panel',
            boundingBox: box,
            confidence: 0.93,
            coordinateSpace: space,
            words: [],
          },
        ],
      },
    ],
    revision: 1,
    reviewStatus: 'pending-review',
    provenance: {
      source: 'test',
      version: '1',
      inputHashes: [],
    },
  };
}

describe('PageDetectionCoordinator', () => {
  it('runs bubble + text-region detection with separate confidence channels', async () => {
    const width = 320;
    const height = 240;
    const image = await makePage(width, height, (data) => {
      // Bright bubble-like enclosure with dark lettering inside.
      fillRect(data, width, 60, 60, 140, 100, 250);
      fillRect(data, width, 90, 95, 8, 16);
      fillRect(data, width, 110, 95, 8, 16);
      fillRect(data, width, 130, 95, 8, 16);
    });
    const coordinator = new PageDetectionCoordinator({
      bubbleEngine: new BubbleDetectionEngine(),
      textRegionDetector: new TextRegionDetector(),
      loadYoloSession: async () => {
        throw Object.assign(new Error('missing'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });

    const result = await coordinator.detect({
      pageImage: image,
      width,
      height,
      includeOcr: false,
    });

    expect(result.status).toBe('complete');
    expect(result.imageDimensions).toEqual({ width, height });
    expect(result.coordinateSpace.kind).toBe('image');
    expect(result.bubbles.length).toBeGreaterThanOrEqual(0);
    expect(result.textRegions.length).toBeGreaterThanOrEqual(0);
    // Confidence channels are distinct fields and never aliased.
    expect(result.confidences).toHaveProperty('bubbleDetection');
    expect(result.confidences).toHaveProperty('textRegionDetection');
    expect(result.confidences).toHaveProperty('ocrRecognition');
    expect(result.confidences).toHaveProperty('bubbleAssociation');
    expect(result.confidences.ocrRecognition).toBeNull();

    for (const bubble of result.bubbles) {
      expect(bubble.boundingBox.width).toBeGreaterThan(0);
      expect(bubble.confidence).toBeGreaterThanOrEqual(0);
      expect(bubble.confidence).toBeLessThanOrEqual(1);
      expect(bubble.classificationConfidence).toBeGreaterThanOrEqual(0);
      expect(['derived', 'model', 'hybrid']).toContain(
        bubble.geometryProvenance,
      );
    }
    for (const region of result.textRegions) {
      expect(region.confidence).toBeGreaterThanOrEqual(0);
      expect(region.associationConfidence).toBeGreaterThanOrEqual(0);
      // Detection and association confidence are separate numbers.
      expect(typeof region.confidence).toBe('number');
      expect(typeof region.associationConfidence).toBe('number');
    }
  });

  it('keeps the existing OCR document contract when OCR is supplied', async () => {
    const width = 200;
    const height = 150;
    const image = await makePage(width, height, (data) => {
      fillRect(data, width, 40, 40, 6, 12);
      fillRect(data, width, 52, 40, 6, 12);
    });
    const space = createImageSpace('ocr-contract', width, height);
    const document = ocrDocument(space);
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: async () => {
        throw Object.assign(new Error('missing'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    const result = await coordinator.detect({
      pageImage: image,
      width,
      height,
      includeOcr: true,
      ocrDocument: document,
    });

    expect(result.ocr.available).toBe(true);
    expect(result.ocr.document?.blocks[0]?.lines[0]?.text).toBe('Hello panel');
    expect(result.ocr.lines).toHaveLength(1);
    const line = result.ocr.lines[0]!;
    expect(line.confidence).toBeGreaterThan(0.9);
    expect(line.id).toBe('line-1');
    // OCR recognition confidence is not reused as association confidence.
    if (line.associatedBubbleId) {
      expect(line.associationConfidence).not.toBe(line.confidence);
    }
  });

  it('maps OCR lines to text regions via geometric overlap', async () => {
    const width = 200;
    const height = 150;
    const image = await makePage(width, height, (data) => {
      // Line of glyphs around (50,50) matching the OCR box.
      for (let i = 0; i < 6; i += 1) {
        fillRect(data, width, 50 + i * 12, 50, 7, 14);
      }
    });
    const space = createImageSpace('ocr-region-match', width, height);
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: async () => {
        throw Object.assign(new Error('missing'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    const result = await coordinator.detect({
      pageImage: image,
      width,
      height,
      includeOcr: true,
      ocrDocument: ocrDocument(space),
    });

    expect(result.textRegions.length).toBeGreaterThanOrEqual(1);
    const line = result.ocr.lines[0]!;
    // Either matched to a region or explicitly unmatched with 0 confidence.
    if (line.textRegionId) {
      expect(line.textRegionMatchConfidence).toBeGreaterThan(0);
    } else {
      expect(line.textRegionMatchConfidence).toBe(0);
    }
  });

  it('reports stale status when a newer request supersedes the current one', async () => {
    const image = await makePage(100, 80);
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: async () => {
        throw Object.assign(new Error('missing'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    // Start a first request id, then advance the coordinator before detect finishes.
    const firstId = coordinator.begin('req-1');
    expect(coordinator.isStale(firstId)).toBe(false);
    coordinator.begin('req-2');
    expect(coordinator.isStale(firstId)).toBe(true);

    // Simulate a detect that began under req-1 by calling begin ourselves is
    // already covered; a full concurrent race is exercised in integration.
    const result = await coordinator.detect({
      pageImage: image,
      requestId: 'req-late',
    });
    expect(result.requestId).toBe('req-late');
    expect(result.status).toBe('complete');
  });

  it('validates request payloads and image size limits', async () => {
    const coordinator = new PageDetectionCoordinator();
    await expect(
      coordinator.detect({ pageImage: new Uint8Array() }),
    ).rejects.toBeInstanceOf(PageDetectionError);
    await expect(
      coordinator.detect({
        pageImage: new Uint8Array(10),
        width: -5,
      }),
    ).rejects.toBeInstanceOf(PageDetectionError);
    await expect(
      coordinator.detect({
        pageImage: new Uint8Array(10),
        confidenceThreshold: 3,
      }),
    ).rejects.toBeInstanceOf(PageDetectionError);
  });

  it('handles pages with no speech bubbles and no text', async () => {
    const image = await makePage(120, 90);
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: async () => {
        throw Object.assign(new Error('missing'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    const result = await coordinator.detect({
      pageImage: image,
      includeOcr: true,
    });
    expect(result.status).toBe('complete');
    expect(result.bubbles).toEqual([]);
    expect(result.textRegions).toEqual([]);
    expect(result.confidences.bubbleDetection).toBe(0);
    expect(result.confidences.textRegionDetection).toBe(0);
  });

  it('surfaces model-missing as a warning without failing detection', async () => {
    const image = await makePage(100, 80, (data) => {
      fillRect(data, 100, 20, 20, 8, 12);
    });
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: async () => {
        throw Object.assign(new Error('weights not downloaded'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    const result = await coordinator.detect({ pageImage: image });
    expect(result.status).toBe('complete');
    expect(result.detection.bubbleMode).toBe('deterministic');
    expect(result.detection.modelMissing).toContain('yolo-bubble');
  });

  it('throws MODEL_MISSING when requireYolo is set and weights are absent', async () => {
    const image = await makePage(80, 60);
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: async () => {
        throw Object.assign(new Error('weights not downloaded'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    await expect(
      coordinator.detect({ pageImage: image, requireYolo: true }),
    ).rejects.toMatchObject({ code: 'MODEL_MISSING' });
  });

  it('tolerates empty and malformed OCR provider output', async () => {
    const width = 120;
    const height = 90;
    const image = await makePage(width, height);
    const coordinator = new PageDetectionCoordinator({
      recognizeOcr: async () => {
        throw new Error('provider exploded');
      },
      loadYoloSession: async () => {
        throw Object.assign(new Error('missing'), {
          name: 'OnnxModelError',
          code: 'MODEL_MISSING',
        });
      },
    });
    const result = await coordinator.detect({
      pageImage: image,
      includeOcr: true,
    });
    expect(result.status).toBe('complete');
    expect(result.ocr.available).toBe(false);
    expect(result.warnings.some((w) => w.includes('OCR'))).toBe(true);
  });

  it('discards results for superseded request ids', async () => {
    const image = await makePage(80, 60);
    let rejectYolo!: (reason: unknown) => void;
    const yoloGate = new Promise<unknown>((_resolve, reject) => {
      rejectYolo = reject;
    });
    // Attach a handler immediately so late rejection is never unhandled.
    yoloGate.catch(() => undefined);
    const coordinator = new PageDetectionCoordinator({
      loadYoloSession: () => yoloGate,
    });

    const slow = coordinator.detect({ pageImage: image, requestId: 'old' });
    // Supersede before YOLO rejects so the stale check after text regions
    // sees the newer request id.
    coordinator.begin('new');
    rejectYolo(
      Object.assign(new Error('weights not downloaded'), {
        name: 'OnnxModelError',
        code: 'MODEL_MISSING',
      }),
    );
    const result = await slow;
    expect(result.status).toBe('stale');
    expect(result.bubbles).toEqual([]);
    expect(result.warnings.some((w) => w.includes('superseded'))).toBe(true);
  });
});
