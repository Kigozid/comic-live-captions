import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../apps/api/src/server';
import {
  createImage,
  createOversizedPngHeader,
} from '../fixtures/image-fixtures';

async function withApi<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function uploadImage(
  baseUrl: string,
  role: 'original' | 'cleaned',
  filename: string,
  bytes: Buffer,
) {
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(bytes)]), filename);
  return fetch(`${baseUrl}/api/images/${role}`, { method: 'POST', body: form });
}

describe('API health endpoint', () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it('reports readiness as JSON', async () => {
    const server = createApiServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'comic-captioner-api',
      configuration: {
        geminiTranscriptionConfigured: Boolean(process.env.GEMINI_API_KEY),
      },
    });
  });

  it('routes transcription requests to the configured server-side provider', async () => {
    const server = createApiServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP address');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/transcribe`,
      { method: 'POST' },
    );
    expect([400, 503]).toContain(response.status);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const server = createApiServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/missing`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('imports immutable original and cleaned sources and reports dimension mismatch', async () => {
    await withApi(async (baseUrl) => {
      const originalBytes = await createImage(4, 3);
      const originalResponse = await uploadImage(
        baseUrl,
        'original',
        'original.png',
        originalBytes,
      );
      expect(originalResponse.status).toBe(201);
      const originalResult = await originalResponse.json();
      expect(originalResult.image).toMatchObject({
        role: 'original',
        filename: 'original.png',
        format: 'PNG',
        dimensions: { width: 4, height: 3 },
        sizeBytes: originalBytes.byteLength,
      });

      const cleanedResponse = await uploadImage(
        baseUrl,
        'cleaned',
        'cleaned.png',
        await createImage(5, 3),
      );
      expect(cleanedResponse.status).toBe(201);
      expect((await cleanedResponse.json()).pair.dimensionsMatch).toBe(false);

      const restoredBytes = await fetch(
        `${baseUrl}/api/images/original/content`,
      );
      expect(Buffer.from(await restoredBytes.arrayBuffer())).toEqual(
        originalBytes,
      );
    });
  });

  it('scans one imported page for bubble candidates without requiring a pair or alignment', async () => {
    await withApi(async (baseUrl) => {
      const bytes = await createImage(32, 24);
      const uploaded = await uploadImage(
        baseUrl,
        'cleaned',
        'single-page.png',
        bytes,
      );
      expect(uploaded.status).toBe(201);
      const response = await fetch(`${baseUrl}/api/analyze-page`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'cleaned', alignPair: false }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        coordinateSpace: { dimensions: { width: 32, height: 24 } },
        bubbles: [],
        ocr: { blocks: [] },
      });
    });
  });

  it('rejects unsupported, corrupt, and oversized image uploads', async () => {
    await withApi(async (baseUrl) => {
      const unsupported = await uploadImage(
        baseUrl,
        'original',
        'page.gif',
        Buffer.from('GIF89a'),
      );
      expect(unsupported.status).toBe(415);
      expect((await unsupported.json()).error.code).toBe('UNSUPPORTED_FORMAT');

      const corrupt = await uploadImage(
        baseUrl,
        'original',
        'broken.png',
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      );
      expect(corrupt.status).toBe(422);
      expect((await corrupt.json()).error.code).toBe('CORRUPT_IMAGE');

      const oversized = await uploadImage(
        baseUrl,
        'original',
        'too-large.png',
        await createOversizedPngHeader(),
      );
      expect(oversized.status).toBe(413);
      expect((await oversized.json()).error.code).toBe('IMAGE_TOO_LARGE');
    });
  });
});
