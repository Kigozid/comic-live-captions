import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  dimensionsMatch,
  ImmutableSourceImage,
  MAX_SOURCE_IMAGE_PIXELS,
} from '@comic-captioner/image-engine';
import {
  createImage,
  createOversizedPngHeader,
} from '../fixtures/image-fixtures';

describe('immutable source image import', () => {
  it.each([
    ['PNG', 'png', 'page.png'],
    ['JPEG', 'jpeg', 'page.jpg'],
    ['WEBP', 'webp', 'page.webp'],
  ] as const)(
    'imports a valid %s image',
    async (format, sharpFormat, filename) => {
      const bytes = await createImage(4, 3, sharpFormat);
      const source = await ImmutableSourceImage.import({
        role: 'original',
        filename,
        bytes,
      });

      expect(source.metadata).toMatchObject({
        role: 'original',
        filename,
        format,
        dimensions: { width: 4, height: 3 },
        sizeBytes: bytes.byteLength,
      });
      expect(source.metadata.sha256).toHaveLength(64);
      expect(source.getBytes()).toEqual(bytes);
    },
  );

  it('rejects unsupported file formats', async () => {
    await expect(
      ImmutableSourceImage.import({
        role: 'original',
        filename: 'page.gif',
        bytes: Buffer.from('GIF89a'),
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('rejects corrupt image data with a supported signature', async () => {
    const corruptPng = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
    ]);
    await expect(
      ImmutableSourceImage.import({
        role: 'cleaned',
        filename: 'broken.png',
        bytes: corruptPng,
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT_IMAGE' });
  });

  it('reports different original and cleaned dimensions without rejecting either image', async () => {
    const original = await ImmutableSourceImage.import({
      role: 'original',
      filename: 'original.png',
      bytes: await createImage(4, 3),
    });
    const cleaned = await ImmutableSourceImage.import({
      role: 'cleaned',
      filename: 'cleaned.png',
      bytes: await createImage(5, 3),
    });

    expect(dimensionsMatch(original.metadata, cleaned.metadata)).toBe(false);
  });

  it('reports EXIF-oriented dimensions as users see them', async () => {
    const bytes = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 235, g: 231, b: 224, alpha: 1 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const source = await ImmutableSourceImage.import({
      role: 'original',
      filename: 'rotated.jpg',
      bytes,
    });

    expect(source.metadata.dimensions).toEqual({ width: 3, height: 4 });
  });

  it('rejects images whose declared dimensions exceed the decoded pixel budget', async () => {
    const tooLarge = await createOversizedPngHeader();
    await expect(
      ImmutableSourceImage.import({
        role: 'original',
        filename: 'oversized.png',
        bytes: tooLarge,
      }),
    ).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE',
      message: expect.stringContaining(
        MAX_SOURCE_IMAGE_PIXELS.toLocaleString(),
      ),
    });
  });

  it('keeps source bytes and metadata immutable through defensive copies', async () => {
    const input = await createImage(3, 2);
    const originalBytes = Buffer.from(input);
    const source = await ImmutableSourceImage.import({
      role: 'cleaned',
      filename: 'folder\\cleaned.png',
      bytes: input,
    });

    input.fill(0);
    const exposedBytes = source.getBytes();
    exposedBytes.fill(0);

    expect(source.getBytes()).toEqual(originalBytes);
    expect(source.metadata.filename).toBe('cleaned.png');
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.metadata)).toBe(true);
    expect(Object.isFrozen(source.metadata.dimensions)).toBe(true);
  });
});
