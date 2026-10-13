import { describe, expect, it } from 'vitest';
import {
  autoCleanPage,
  proposePagePacingFromDialogues,
  triageOcrDocument,
} from '../../apps/web/src/engine-adapters.js';
import type {
  OCRDocument,
  CoordinateSpaceId,
  ImageSpace,
  AudioTimebaseId,
} from '@comic-captioner/shared';

const space: ImageSpace = {
  id: 'image:adapter' as CoordinateSpaceId,
  kind: 'image',
  dimensions: { width: 40, height: 40 },
};

function solidRaster(
  width: number,
  height: number,
  fill: [number, number, number, number],
  textPixels?: readonly number[],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  if (textPixels) {
    for (const index of textPixels) {
      data[index * 4] = 10;
      data[index * 4 + 1] = 10;
      data[index * 4 + 2] = 10;
    }
  }
  return { width, height, data };
}

describe('engine-adapters', () => {
  it('auto-cleans bubble text from an original page raster', () => {
    const width = 40;
    const height = 40;
    const interior = [];
    for (let y = 10; y < 30; y += 1) {
      for (let x = 10; x < 30; x += 1) interior.push(y * width + x);
    }
    // A few dark "glyph" pixels inside the bubble.
    const glyphPixels = [15 * width + 15, 15 * width + 16, 16 * width + 15];
    const original = solidRaster(width, height, [255, 255, 255, 255], glyphPixels);
    const result = autoCleanPage(
      original,
      [
        {
          id: 'bubble-1',
          contour: {
            points: [
              { x: 8, y: 8, coordinateSpace: space },
              { x: 32, y: 8, coordinateSpace: space },
              { x: 32, y: 32, coordinateSpace: space },
              { x: 8, y: 32, coordinateSpace: space },
            ],
            coordinateSpace: space,
          },
        },
      ],
    );
    expect(result.cleaned.width).toBe(width);
    expect(result.masks.length).toBeGreaterThanOrEqual(0);
    expect(result.erasedPixelCount).toBeGreaterThanOrEqual(0);
  });

  it('queues only low-confidence OCR for review', () => {
    const document: OCRDocument = {
      id: 'ocr-doc',
      text: 'Hello world',
      boundingBox: {
        x: 0,
        y: 0,
        width: 20,
        height: 10,
        coordinateSpace: space,
      },
      confidence: 0.7,
      revision: 1,
      coordinateSpace: space,
      provenance: {
        source: 'test',
        version: '1',
        inputHashes: [],
      },
      reviewStatus: 'pending-review',
      blocks: [
        {
          id: 'block-1',
          text: 'Hello world',
          boundingBox: {
            x: 0,
            y: 0,
            width: 20,
            height: 10,
            coordinateSpace: space,
          },
          confidence: 0.9,
          coordinateSpace: space,
          lines: [
            {
              id: 'line-1',
              text: 'Hello',
              boundingBox: {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                coordinateSpace: space,
              },
              confidence: 0.4,
              coordinateSpace: space,
              words: [
                {
                  id: 'word-1',
                  text: 'Hello',
                  boundingBox: {
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10,
                    coordinateSpace: space,
                  },
                  confidence: 0.4,
                  coordinateSpace: space,
                },
              ],
            },
            {
              id: 'line-2',
              text: 'world',
              boundingBox: {
                x: 10,
                y: 0,
                width: 10,
                height: 10,
                coordinateSpace: space,
              },
              confidence: 0.97,
              coordinateSpace: space,
              words: [
                {
                  id: 'word-2',
                  text: 'world',
                  boundingBox: {
                    x: 10,
                    y: 0,
                    width: 10,
                    height: 10,
                    coordinateSpace: space,
                  },
                  confidence: 0.97,
                  coordinateSpace: space,
                },
              ],
            },
          ],
        },
      ],
    };
    const triage = triageOcrDocument(document, {
      confidenceThreshold: 0.85,
      maxItems: 10,
    });
    expect(triage.reviewItems.length).toBeGreaterThan(0);
    expect(triage.reviewItems.every((item) => item.confidence < 0.85)).toBe(
      true,
    );
    expect(triage.summary.uncertainCount).toBeGreaterThan(0);
  });

  it('proposes page pacing from dialogue cues', () => {
    const proposals = proposePagePacingFromDialogues({
      pageIds: ['p1', 'p2'],
      cuesByPage: {
        p1: [{ id: 'c1', bubbleId: 'b1', start: 0, end: 3 }],
        p2: [{ id: 'c2', bubbleId: 'b2', start: 5, end: 8 }],
      },
      timebaseId: 'audio:test' as AudioTimebaseId,
      audioDurationSeconds: 10,
    });
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.start.value).toBe(0);
    expect(proposals[0]?.end.value).toBeCloseTo(4);
  });
});

describe('refineWordTimesAcoustic', () => {
  it('aligns words offline with the synthetic CTC provider', async () => {
    const { refineWordTimesAcoustic } = await import(
      '../../apps/web/src/engine-adapters.js'
    );
    const sampleRateHz = 16_000;
    const pcm = new Float32Array(sampleRateHz).fill(0.1);
    const result = await refineWordTimesAcoustic({
      segments: [
        {
          id: 'seg-1',
          text: 'hello world',
          start: 0,
          end: 0.8,
        },
      ],
      pcm,
      sampleRateHz,
      timebaseId: 'audio:adapter-align' as never,
      offline: true,
    });
    expect(result.source).toBe('local');
    expect(result.algorithm).toBe('ctc-viterbi');
    expect(result.words.map((w) => w.text)).toEqual(['hello', 'world']);
    expect(result.words[0]!.start.value).toBeLessThan(result.words[0]!.end.value);
  });
});
