import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CleanPageCoordinator,
  CleanPageError,
} from '../../apps/api/src/clean-page.js';
import { createImageSpace } from '@comic-captioner/shared';

const space = createImageSpace('clean-api-test', 32, 24);

function raster(
  width = 32,
  height = 24,
  fill: [number, number, number] = [250, 250, 250],
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('CleanPageCoordinator', () => {
  it('returns cleaned PNG, mask, regions, and never mutates the input', async () => {
    const image = raster();
    // Dark glyph pixels.
    for (let y = 10; y < 14; y += 1) {
      for (let x = 10; x < 14; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 5;
        image.data[i + 1] = 5;
        image.data[i + 2] = 5;
      }
    }
    const snapshot = Uint8ClampedArray.from(image.data);
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    const result = await coordinator.cleanPage({
      image,
      spaceId: space.id,
      textRegions: [
        {
          id: 'text-1',
          boundingBox: {
            x: 9,
            y: 9,
            width: 8,
            height: 8,
            coordinateSpace: space,
          },
          detectionConfidence: 0.9,
        },
      ],
      bubbles: [
        {
          id: 'bubble-1',
          contour: {
            points: [
              { x: 5, y: 5 },
              { x: 25, y: 5 },
              { x: 25, y: 20 },
              { x: 5, y: 20 },
            ],
          },
          interiorHint: 'white-balloon',
        },
      ],
    });
    expect(result.status).toBe('complete');
    expect(result.width).toBe(32);
    expect(result.height).toBe(24);
    expect(result.cleanedPng.byteLength).toBeGreaterThan(0);
    expect(result.removalMask.length).toBe(32 * 24);
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
    expect(result.methodSummary).toBeDefined();
    // Input buffer untouched.
    expect(Buffer.from(image.data).equals(Buffer.from(snapshot))).toBe(true);
  });

  it('erases bubble-interior ink when only bubbles are supplied', async () => {
    const image = raster();
    // Dark glyph pixels inside the balloon.
    for (let y = 10; y < 14; y += 1) {
      for (let x = 10; x < 14; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 5;
        image.data[i + 1] = 5;
        image.data[i + 2] = 5;
      }
    }
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    const result = await coordinator.cleanPage({
      image,
      spaceId: space.id,
      bubbles: [
        {
          id: 'bubble-1',
          contour: {
            points: [
              { x: 5, y: 5 },
              { x: 25, y: 5 },
              { x: 25, y: 20 },
              { x: 5, y: 20 },
            ],
          },
          interiorHint: 'white-balloon',
        },
      ],
    });
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
    expect(result.methodSummary['white-fill'] + result.methodSummary['background-fill'] +
      result.methodSummary['local-reconstruct']).toBeGreaterThanOrEqual(1);
    let erased = 0;
    for (const byte of result.removalMask) if (byte) erased += 1;
    expect(erased).toBeGreaterThan(0);
  });

  it('rejects oversized and malformed rasters', async () => {
    const coordinator = new CleanPageCoordinator();
    await expect(
      coordinator.cleanPage({
        image: { width: 0, height: 10, data: new Uint8ClampedArray(0) },
      }),
    ).rejects.toBeInstanceOf(CleanPageError);
    await expect(
      coordinator.cleanPage({
        image: { width: 2, height: 2, data: new Uint8ClampedArray(3) },
      }),
    ).rejects.toBeInstanceOf(CleanPageError);
  });

  it('discards stale cleaning results', async () => {
    const image = raster();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => {
        await gate;
        return new Uint8Array([1]);
      },
    });
    const first = coordinator.cleanPage({
      image,
      requestId: 'old-page',
    });
    coordinator.begin('new-page');
    release();
    const result = await first;
    expect(result.status).toBe('stale');
    expect(result.cleanedPng.byteLength).toBe(0);
    expect(
      result.warnings.some((warning) =>
        warning.message.includes('superseded'),
      ),
    ).toBe(true);
  });

  it('records failed methods without claiming success', async () => {
    const image = raster();
    for (let y = 8; y < 12; y += 1) {
      for (let x = 8; x < 12; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 3;
        image.data[i + 1] = 3;
        image.data[i + 2] = 3;
      }
    }
    const coordinator = new CleanPageCoordinator({
      generative: {
        name: 'lama-broken',
        available: () => true,
        inpaint: async () => {
          throw new Error('cuda oom');
        },
      },
      encodePng: async () => new Uint8Array([2]),
    });
    const result = await coordinator.cleanPage({
      image,
      textRegions: [
        {
          id: 'art-text',
          boundingBox: {
            x: 6,
            y: 6,
            width: 10,
            height: 10,
            coordinateSpace: space,
          },
          preferredMethod: 'lama',
          approved: true,
          reviewStatus: 'accepted',
        },
      ],
      options: { erasureScope: 'approved' },
    });
    expect(result.complete).toBe(false);
    expect(
      result.warnings.some((warning) => warning.code === 'method-failed'),
    ).toBe(true);
    expect(result.regions[0]!.success).toBe(false);
  });

  it('holds unreviewed free-floating text instead of auto-erasing it', async () => {
    const image = raster();
    for (let y = 8; y < 12; y += 1) {
      for (let x = 8; x < 12; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 3;
        image.data[i + 1] = 3;
        image.data[i + 2] = 3;
      }
    }
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => new Uint8Array([3]),
    });
    const result = await coordinator.cleanPage({
      image,
      textRegions: [
        {
          id: 'sign',
          boundingBox: {
            x: 6,
            y: 6,
            width: 10,
            height: 10,
            coordinateSpace: space,
          },
        },
      ],
      options: { erasureScope: 'bubble-interior' },
    });
    expect(result.regions[0]!.method).toBe('skipped');
    expect(result.regions[0]!.needsReview).toBe(true);
    expect(
      result.warnings.some((warning) => warning.code === 'needs-review'),
    ).toBe(true);
  });

  it('functional: approve held region then erase with approved scope', async () => {
    const image = raster();
    for (let y = 8; y < 14; y += 1) {
      for (let x = 8; x < 14; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 4;
        image.data[i + 1] = 4;
        image.data[i + 2] = 4;
      }
    }
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => new Uint8Array([4]),
    });
    const held = await coordinator.cleanPage({
      image,
      requestId: 'pass-1',
      textRegions: [
        {
          id: 'sfx',
          boundingBox: {
            x: 6,
            y: 6,
            width: 12,
            height: 12,
            coordinateSpace: space,
          },
          detectionConfidence: 0.9,
        },
      ],
      options: { erasureScope: 'bubble-interior', expansionPx: 0 },
    });
    expect(held.regions[0]!.method).toBe('skipped');

    const approved = await coordinator.cleanPage({
      image,
      requestId: 'pass-2',
      textRegions: [
        {
          id: 'sfx',
          boundingBox: {
            x: 6,
            y: 6,
            width: 12,
            height: 12,
            coordinateSpace: space,
          },
          detectionConfidence: 0.9,
          approved: true,
          reviewStatus: 'accepted',
        },
      ],
      options: {
        erasureScope: 'approved',
        expansionPx: 0,
        mergeGapPx: 0,
      },
    });
    expect(approved.regions[0]!.method).toBe('white-fill');
    expect(approved.regions[0]!.success).toBe(true);
  });

  it('functional: bubble ink erases while unreviewed page text stays', async () => {
    const image = raster();
    // Lettering inside balloon.
    for (let y = 10; y < 14; y += 1) {
      for (let x = 10; x < 14; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 5;
        image.data[i + 1] = 5;
        image.data[i + 2] = 5;
      }
    }
    // Unreviewed sign outside balloon.
    for (let y = 20; y < 24; y += 1) {
      for (let x = 24; x < 28; x += 1) {
        const i = (y * 32 + x) * 4;
        image.data[i] = 5;
        image.data[i + 1] = 5;
        image.data[i + 2] = 5;
      }
    }
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => new Uint8Array([5]),
    });
    const result = await coordinator.cleanPage({
      image,
      bubbles: [
        {
          id: 'b1',
          contour: {
            points: [
              { x: 4, y: 4 },
              { x: 20, y: 4 },
              { x: 20, y: 18 },
              { x: 4, y: 18 },
            ],
          },
          interiorHint: 'white-balloon',
        },
      ],
      textRegions: [
        {
          id: 'dialogue',
          boundingBox: {
            x: 8,
            y: 8,
            width: 8,
            height: 8,
            coordinateSpace: space,
          },
          associatedBubbleId: 'b1',
        },
        {
          id: 'sign',
          boundingBox: {
            x: 22,
            y: 18,
            width: 8,
            height: 8,
            coordinateSpace: space,
          },
        },
      ],
      options: {
        erasureScope: 'bubble-interior',
        expansionPx: 0,
        mergeGapPx: 0,
      },
    });
    const dialogue = result.regions.find((r) => r.sourceRegionId === 'dialogue');
    const sign = result.regions.find((r) => r.sourceRegionId === 'sign');
    expect(dialogue?.method).toBe('white-fill');
    expect(sign?.method).toBe('skipped');
  });
});

describe('POST /api/clean-page (HTTP)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const coordinator = new CleanPageCoordinator({
      encodePng: async () => new Uint8Array([0x89, 0x50]),
    });
    server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/clean-page') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          pageImage: string;
          width: number;
          height: number;
          requestId?: string;
          textRegions?: unknown[];
          bubbles?: unknown[];
        };
        const encoded = new Uint8Array(
          Buffer.from(
            body.pageImage.includes(',')
              ? body.pageImage.slice(body.pageImage.indexOf(',') + 1)
              : body.pageImage,
            'base64',
          ),
        );
        const isRaw =
          body.width > 0 &&
          body.height > 0 &&
          encoded.byteLength === body.width * body.height * 4;
        const image = isRaw
          ? {
              width: body.width,
              height: body.height,
              data: new Uint8ClampedArray(
                encoded.buffer,
                encoded.byteOffset,
                encoded.byteLength,
              ),
            }
          : (() => {
              throw new Error('test expects raw RGBA');
            })();
        try {
          const result = await coordinator.cleanPage({
            image,
            ...(body.requestId ? { requestId: body.requestId } : {}),
            textRegions: (body.textRegions ?? []) as never,
            bubbles: (body.bubbles ?? []) as never,
          });
          res.writeHead(result.status === 'stale' ? 409 : 200, {
            'content-type': 'application/json',
          });
          res.end(
            JSON.stringify({
              ...result,
              cleanedPng: Buffer.from(result.cleanedPng).toString('base64'),
            }),
          );
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'CLEAN_PAGE_FAILED',
                message: error instanceof Error ? error.message : 'failed',
              },
            }),
          );
        }
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts raw RGBA, returns cleaned payload, and protects stale requests', async () => {
    const width = 16;
    const height = 12;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
    // Glyphs
    for (let y = 4; y < 8; y += 1) {
      for (let x = 4; x < 8; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
    const pageImage = Buffer.from(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    ).toString('base64');
    const response = await fetch(`${baseUrl}/api/clean-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageImage,
        width,
        height,
        requestId: 'req-1',
        textRegions: [
          {
            id: 't1',
            boundingBox: [3, 3, 6, 6],
            detectionConfidence: 0.95,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      width: number;
      height: number;
      regions: { method: string }[];
      cleanedPng: string;
    };
    expect(body.status).toBe('complete');
    expect(body.width).toBe(width);
    expect(body.height).toBe(height);
    expect(body.regions.length).toBeGreaterThanOrEqual(1);
    expect(body.cleanedPng.length).toBeGreaterThan(0);
  });
});
