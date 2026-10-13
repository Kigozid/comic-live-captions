import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../../apps/api/src/server';

async function withApi<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function importPage(baseUrl: string) {
  const bytes = await readFile(
    path.resolve('tests/fixtures/simple/original.png'),
  );
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(bytes)]), 'page.png');
  const response = await fetch(`${baseUrl}/api/images/original`, {
    method: 'POST',
    body: form,
  });
  return (await response.json()) as {
    readonly image: {
      readonly id: string;
      readonly sha256: string;
      readonly dimensions: { readonly width: number; readonly height: number };
    };
  };
}

describe('local OCR API request safety', () => {
  it('rejects an OCR request with a stale source hash before inference', async () => {
    await withApi(async (baseUrl) => {
      const { image } = await importPage(baseUrl);
      const response = await fetch(`${baseUrl}/api/ocr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role: 'original',
          sourceHash: '0'.repeat(64),
          coordinateSpaceId: `workspace:${image.id}`,
          enhanced: false,
          bubbles: [],
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'OCR_SOURCE_CHANGED' },
      });
    });
  });

  it('rejects page geometry that does not match the active ImageSpace', async () => {
    await withApi(async (baseUrl) => {
      const { image } = await importPage(baseUrl);
      const response = await fetch(`${baseUrl}/api/ocr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role: 'original',
          sourceHash: image.sha256,
          coordinateSpaceId: `workspace:stale-${image.id}`,
          enhanced: false,
          bubbles: [],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'INVALID_OCR_COORDINATE_SPACE' },
      });
    });
  });
});
