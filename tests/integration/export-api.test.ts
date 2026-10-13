import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApiServer } from '../../apps/api/src/server.js';
import type {
  ExportBubble,
  ExportCaption,
} from '@comic-captioner/rendering';
import type { BubbleId, CoordinateSpaceId, ImageSpace } from '@comic-captioner/shared';

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
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const space: ImageSpace = {
  id: 'image:export-api' as CoordinateSpaceId,
  kind: 'image',
  dimensions: { width: 200, height: 200 },
};

function tinyPngBase64(): string {
  // 1x1 PNG
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]).toString('base64');
}

describe('server-side MP4 export API', () => {
  it('reports FFmpeg availability without pretending encode works', async () => {
    const response = await fetch(`${baseUrl}/api/export/ffmpeg`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ffmpeg: {
        available: boolean;
        installHint: string;
        path: string | null;
      };
    };
    expect(payload.ffmpeg).toHaveProperty('available');
    expect(payload.ffmpeg.installHint.toLowerCase()).toContain('ffmpeg');
  });

  it('rejects incomplete export requests', async () => {
    const response = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fps: 24 }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe('INVALID_EXPORT_REQUEST');
  });

  it('returns typed FFMPEG_MISSING when the binary is absent, or MP4 when present', async () => {
    const captions: ExportCaption[] = [];
    const bubbles: ExportBubble[] = [
      {
        id: 'bubble-1' as BubbleId,
        polygon: {
          points: [
            { x: 10, y: 10, coordinateSpace: space },
            { x: 100, y: 10, coordinateSpace: space },
            { x: 100, y: 100, coordinateSpace: space },
            { x: 10, y: 100, coordinateSpace: space },
          ],
          coordinateSpace: space,
        },
      },
    ];
    const response = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageImage: tinyPngBase64(),
        fps: 2,
        durationSeconds: 0.5,
        resolution: { resolution: 'custom', width: 64, height: 64 },
        captions,
        bubbles,
      }),
    });

    if (response.status === 503) {
      const payload = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe('FFMPEG_MISSING');
      expect(payload.error.message.toLowerCase()).toContain('ffmpeg');
      return;
    }

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(100);
    // ftyp box signature for MP4
    expect(String.fromCharCode(...bytes.slice(4, 8))).toBe('ftyp');
    expect(response.headers.get('x-export-codec')).toBe('h264');
    expect(Number(response.headers.get('x-export-frames'))).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid fps and duration', async () => {
    const response = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageImage: tinyPngBase64(),
        fps: 0,
        durationSeconds: 1,
        resolution: { resolution: '720p' },
        captions: [],
        bubbles: [],
      }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('INVALID_INPUT');
  });
});
