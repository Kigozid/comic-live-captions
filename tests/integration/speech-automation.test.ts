import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../../apps/api/src/server';
import { createBubbleFixture } from '../fixtures/bubble-fixtures';

async function withApi<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected an API test server address.');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function upload(
  baseUrl: string,
  role: 'original' | 'cleaned',
  bytes: Buffer,
) {
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(bytes)]), `${role}.png`);
  return fetch(`${baseUrl}/api/images/${role}`, { method: 'POST', body: form });
}

describe('speech automation API', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('detects and fits a manual-review candidate when OCR is unavailable', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    await withApi(async (baseUrl) => {
      const page = await createBubbleFixture('ellipse');
      expect((await upload(baseUrl, 'original', page)).status).toBe(201);
      expect((await upload(baseUrl, 'cleaned', page)).status).toBe(201);
      expect(
        (await fetch(`${baseUrl}/api/alignment`, { method: 'POST' })).status,
      ).toBe(200);

      const timebase = 'audio:fixture';
      const response = await fetch(`${baseUrl}/api/automate-speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transcript: {
            durationSeconds: 2,
            timebase: { id: timebase, unit: 'seconds' },
            segments: [
              {
                id: 'segment-1',
                text: 'A sample spoken line',
                interval: {
                  start: { value: 0.1, timebase, unit: 'seconds' },
                  end: { value: 1.2, timebase, unit: 'seconds' },
                },
                speakerId: 'speaker-1',
                confidence: 0.9,
              },
            ],
          },
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.ocrWarning).toMatch(/run local PaddleOCR/i);
      expect(result.bubbles.length).toBeGreaterThan(0);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].mapping.needsReview).toBe(true);
      expect(result.matches[0].candidateLayouts.length).toBeGreaterThan(0);
      expect(result.matches[0].candidateLayouts[0].layout.text).toBe(
        'A sample spoken line',
      );
    });
  });

  it('detects bubbles without a Gemini key for the browser-local OCR workflow', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    await withApi(async (baseUrl) => {
      const page = await createBubbleFixture('ellipse');
      await upload(baseUrl, 'original', page);
      await upload(baseUrl, 'cleaned', page);
      expect(
        (await fetch(`${baseUrl}/api/alignment`, { method: 'POST' })).status,
      ).toBe(200);
      const response = await fetch(`${baseUrl}/api/analyze-page`, {
        method: 'POST',
      });
      const result = await response.json();
      expect(response.status).toBe(200);
      expect(result.bubbles.length).toBeGreaterThan(0);
      expect(result.ocr.blocks).toEqual([]);
    });
  });

  it('serves only the official PaddleOCR model assets through the same-origin API', async () => {
    const networkFetch = globalThis.fetch.bind(globalThis);
    const upstreamFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) =>
        String(input).startsWith('https://paddle-model-ecology.bj.bcebos.com/')
          ? Promise.resolve(
              new Response(new Uint8Array(1024 * 1024), { status: 200 }),
            )
          : networkFetch(input, init),
      );
    try {
      await withApi(async (baseUrl) => {
        const response = await networkFetch(
          `${baseUrl}/api/ocr-models/detection`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toMatch(/immutable/);
        expect((await response.arrayBuffer()).byteLength).toBe(1024 * 1024);
        expect(upstreamFetch).toHaveBeenCalledTimes(1);
        const unavailable = await networkFetch(
          `${baseUrl}/api/ocr-models/arbitrary-file`,
        );
        expect(unavailable.status).toBe(404);
      });
    } finally {
      upstreamFetch.mockRestore();
    }
  });
});
