import { describe, expect, it } from 'vitest';
import { createApiServer } from '../../apps/api/src/server';
import {
  createSyntheticAlignmentPair,
  createSyntheticTextRemovalPair,
} from '../fixtures/alignment-fixtures';

async function withApi<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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

describe('alignment API integration', () => {
  it('estimates, visualizes, and accepts a manual alignment correction', async () => {
    await withApi(async (baseUrl) => {
      const pair = await createSyntheticAlignmentPair({
        width: 120,
        height: 90,
        translateX: 3,
        translateY: 2,
      });
      expect((await upload(baseUrl, 'original', pair.original)).status).toBe(
        201,
      );
      expect((await upload(baseUrl, 'cleaned', pair.cleaned)).status).toBe(201);

      const response = await fetch(`${baseUrl}/api/alignment`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({
        method: 'automatic',
        sourceSpace: { kind: 'image', dimensions: { width: 120, height: 90 } },
        targetSpace: { kind: 'image', dimensions: { width: 120, height: 90 } },
      });
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.transformMatrix.values).toHaveLength(6);

      for (const mode of ['overlay', 'difference']) {
        const visualization = await fetch(
          `${baseUrl}/api/alignment/visualization/${mode}`,
        );
        expect(visualization.status).toBe(200);
        expect(visualization.headers.get('content-type')).toBe('image/png');
        expect(
          Buffer.from(await visualization.arrayBuffer())
            .subarray(1, 4)
            .toString(),
        ).toBe('PNG');
      }

      const correction = await fetch(`${baseUrl}/api/alignment/manual`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scale: result.scale,
          rotation: result.rotation,
          translationX: result.translation.x + 1,
          translationY: result.translation.y - 1,
        }),
      });
      expect(correction.status).toBe(200);
      expect(await correction.json()).toMatchObject({
        method: 'manual',
        confidence: 1,
      });
    });
  });

  it('requires both images and rejects malformed manual corrections', async () => {
    await withApi(async (baseUrl) => {
      expect(
        (await fetch(`${baseUrl}/api/alignment`, { method: 'POST' })).status,
      ).toBe(409);
      const pair = await createSyntheticAlignmentPair({
        width: 100,
        height: 75,
      });
      await upload(baseUrl, 'original', pair.original);
      await upload(baseUrl, 'cleaned', pair.cleaned);
      await fetch(`${baseUrl}/api/alignment`, { method: 'POST' });
      const invalid = await fetch(`${baseUrl}/api/alignment/manual`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scale: 0,
          rotation: 0,
          translationX: 0,
          translationY: 0,
        }),
      });
      expect(invalid.status).toBe(422);
      expect((await invalid.json()).error.code).toBe('INVALID_ALIGNMENT');
    });
  });

  it('detects removed-text regions after alignment and serves the debug visualization', async () => {
    await withApi(async (baseUrl) => {
      const pair = await createSyntheticTextRemovalPair();
      await upload(baseUrl, 'original', pair.original);
      await upload(baseUrl, 'cleaned', pair.cleaned);
      expect(
        (await fetch(`${baseUrl}/api/text-differences`, { method: 'POST' }))
          .status,
      ).toBe(409);

      await fetch(`${baseUrl}/api/alignment`, { method: 'POST' });
      const manualAlignment = await fetch(`${baseUrl}/api/alignment/manual`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scale: 1,
          rotation: 0,
          translationX: 0,
          translationY: 0,
        }),
      });
      expect(manualAlignment.status).toBe(200);

      const response = await fetch(`${baseUrl}/api/text-differences`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.regions).toHaveLength(1);
      expect(result.regions[0].coordinateSpace.kind).toBe('image');
      expect(result.regions[0].mask.coordinateSpace.kind).toBe('mask');

      const debug = await fetch(`${baseUrl}/api/text-differences/debug`);
      expect(debug.status).toBe(200);
      expect(debug.headers.get('content-type')).toBe('image/png');
    });
  });
});
