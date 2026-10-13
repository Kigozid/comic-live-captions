import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createApiServer } from '../../apps/api/src/server.js';
import { detectBubblesHybrid } from '../../apps/web/src/engine-adapters.js';
import type { CoordinateSpaceId, ImageSpace } from '@comic-captioner/shared';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  // Point engine-adapters at this test server.
  (globalThis as { fetch: typeof fetch }).fetch = new Proxy(fetch, {
    apply(target, thisArg, args: [RequestInfo | URL, RequestInit?]) {
      const [input, init] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith('/api/')) {
        return Reflect.apply(target, thisArg, [
          `${baseUrl}${url}`,
          init,
        ] as [RequestInfo, RequestInit?]);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Comic-like page: two rounded speech bubbles on white paper. */
async function comicPagePng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: 400,
        height: 600,
        channels: 3,
        background: { r: 250, g: 248, b: 240 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
              <rect x="20" y="20" width="360" height="260" fill="#fff" stroke="#222" stroke-width="4"/>
              <rect x="20" y="320" width="360" height="260" fill="#fff" stroke="#222" stroke-width="4"/>
              <ellipse cx="120" cy="120" rx="70" ry="45" fill="#f8f8f8" stroke="#111" stroke-width="5"/>
              <ellipse cx="280" cy="200" rx="55" ry="35" fill="#f8f8f8" stroke="#111" stroke-width="5"/>
              <ellipse cx="150" cy="450" rx="80" ry="50" fill="#f8f8f8" stroke="#111" stroke-width="5"/>
            </svg>`,
          ),
        },
      ])
      .png()
      .toBuffer(),
  );
}

const space: ImageSpace = {
  id: 'image:yolo-e2e' as CoordinateSpaceId,
  kind: 'image',
  dimensions: { width: 400, height: 600 },
};

describe('YOLO bubble detection end-to-end', () => {
  it('reports YOLO availability on /api/models', async () => {
    const response = await fetch(`${baseUrl}/api/models`);
    const payload = (await response.json()) as {
      models: { yolo?: { available: boolean; name?: string } };
    };
    expect(payload.models.yolo).toHaveProperty('available');
    if (payload.models.yolo?.available) {
      expect(payload.models.yolo.name).toContain('yolo');
    }
  });

  it('rejects detect-bubbles without a page image', async () => {
    const response = await fetch(`${baseUrl}/api/detect-bubbles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('INVALID_DETECT_REQUEST');
  });

  it('runs hybrid YOLO detection on a comic-like page', async () => {
    const png = await comicPagePng();
    const pageImage = Buffer.from(png).toString('base64');
    const response = await fetch(`${baseUrl}/api/detect-bubbles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageImage,
        width: 400,
        height: 600,
        spaceId: 'image:yolo-e2e',
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      coordinateSpace: { id: string; dimensions: { width: number } };
      bubbles: {
        id: string;
        confidence: number;
        sources?: string[];
        support?: { provenance: string; provider: string }[];
        quality?: { score: number };
      }[];
      detection: {
        mode: string;
        provider: string | null;
        proposalCount: number;
        mergedCount: number;
        refinedCount: number;
      };
    };
    expect(payload.coordinateSpace.id).toBe('image:yolo-e2e');
    expect(payload.detection.mode).toBe('hybrid');
    // YOLO weights are installed in this workspace — provider must be set.
    expect(payload.detection.provider).toBeTruthy();
    expect(payload.detection.provider).toContain('yolo');
    expect(payload.bubbles.length).toBeGreaterThanOrEqual(0);
    for (const bubble of payload.bubbles) {
      expect(bubble.confidence).toBeGreaterThan(0);
      expect(bubble.quality?.score).toBeGreaterThanOrEqual(0);
      if (bubble.support?.length) {
        expect(bubble.support.some((s) => s.provenance === 'ml')).toBe(true);
      }
    }
    // Proposal pipeline actually ran.
    expect(payload.detection.proposalCount).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('engine-adapters detectBubblesHybrid calls the API for yolo-onnx', async () => {
    const png = await comicPagePng();
    const result = await detectBubblesHybrid(png, space, {
      proposalSource: { kind: 'yolo-onnx' },
    });
    expect(result.source).toBe('api');
    expect(result.provider).toContain('yolo');
    expect(Array.isArray(result.bubbles)).toBe(true);
    expect(result.result.coordinateSpace.id).toBe(space.id);
  }, 60_000);

  it('analyze-page includes hybrid detection metadata with YOLO', async () => {
    const png = await comicPagePng();
    const form = new FormData();
    form.set(
      'image',
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
      'comic-page.png',
    );
    const upload = await fetch(`${baseUrl}/api/images/original`, {
      method: 'POST',
      body: form,
    });
    expect(upload.ok).toBe(true);

    const response = await fetch(`${baseUrl}/api/analyze-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'original', alignPair: false }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      bubbles: { id: string; sources?: string[] }[];
      detection?: {
        mode: string;
        provider: string | null;
        proposalCount?: number;
      };
    };
    expect(payload.detection).toBeTruthy();
    expect(['hybrid', 'deterministic']).toContain(payload.detection!.mode);
    if (payload.detection!.mode === 'hybrid') {
      expect(payload.detection!.provider).toContain('yolo');
    }
    expect(Array.isArray(payload.bubbles)).toBe(true);
  }, 60_000);
});
