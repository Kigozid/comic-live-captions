import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import type {
  SourceImageFormat,
  SourceImageMetadata,
  SourceImageRole,
} from '@comic-captioner/shared';

export type {
  SourceImageFormat,
  SourceImageMetadata,
  SourceImageRole,
} from '@comic-captioner/shared';
export type {
  OCRBlock,
  OCRCorrection,
  OCRDocument,
  OCRLine,
  OCRWord,
} from '@comic-captioner/shared';

export {
  AlignmentError,
  ImageAlignmentEngine,
  applyManualAlignment,
  renderAlignedCleanedImage,
  renderAlignmentVisualizations,
} from './alignment.js';
export {
  TextDifferenceEngine,
  TextDifferenceError,
} from './text-difference.js';
export type {
  TextDifferenceOptions,
  TextDifferenceResult,
} from './text-difference.js';
export {
  applyOCRCorrection,
  OCRError,
  parseOCRDocument,
  ValidatingOCRService,
} from './ocr.js';
export type { OCRInput, OCRProvider, OCRService } from './ocr.js';
export type {
  AffineMatrix,
  AlignmentParameters,
  AlignmentResult,
  AlignmentTranslation,
} from '@comic-captioner/shared';

export const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_IMAGE_PIXELS = 40_000_000;
export const MAX_SOURCE_IMAGE_SIDE = 30_000;

export interface SourceImageUpload {
  readonly role: SourceImageRole;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export type SourceImageImportErrorCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'CORRUPT_IMAGE'
  | 'IMAGE_TOO_LARGE';

export class SourceImageImportError extends Error {
  constructor(
    readonly code: SourceImageImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceImageImportError';
  }
}

/** Immutable source bytes plus validated, display-ready metadata. */
export class ImmutableSourceImage {
  readonly metadata: SourceImageMetadata;
  readonly #sourceBytes: Buffer;

  private constructor(metadata: SourceImageMetadata, sourceBytes: Buffer) {
    this.metadata = Object.freeze({
      ...metadata,
      dimensions: Object.freeze({ ...metadata.dimensions }),
    });
    this.#sourceBytes = Buffer.from(sourceBytes);
    Object.freeze(this);
  }

  static async import(
    upload: SourceImageUpload,
  ): Promise<ImmutableSourceImage> {
    const bytes = Buffer.from(upload.bytes);
    if (bytes.length === 0) {
      throw new SourceImageImportError(
        'EMPTY_FILE',
        'Choose a non-empty image file.',
      );
    }
    if (bytes.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new SourceImageImportError(
        'FILE_TOO_LARGE',
        `Image files must be ${formatBytes(MAX_SOURCE_IMAGE_BYTES)} or smaller.`,
      );
    }

    const detectedFormat = detectFormat(bytes);
    if (!detectedFormat) {
      throw new SourceImageImportError(
        'UNSUPPORTED_FORMAT',
        'Choose a PNG, JPEG, or WebP image.',
      );
    }

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(bytes, {
        failOn: 'error',
        limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
      }).metadata();
    } catch (error) {
      if (
        error instanceof Error &&
        /pixel limit|limitInputPixels/i.test(error.message)
      ) {
        throw new SourceImageImportError(
          'IMAGE_TOO_LARGE',
          `Images must be at most ${MAX_SOURCE_IMAGE_PIXELS.toLocaleString()} pixels.`,
        );
      }
      throw new SourceImageImportError(
        'CORRUPT_IMAGE',
        'The image file could not be decoded.',
      );
    }

    const decodedFormat = mapSharpFormat(metadata.format);
    if (!decodedFormat || decodedFormat !== detectedFormat) {
      throw new SourceImageImportError(
        'CORRUPT_IMAGE',
        'The image data does not match its file signature.',
      );
    }

    const rawWidth = metadata.width;
    const rawHeight = metadata.height;
    if (!rawWidth || !rawHeight) {
      throw new SourceImageImportError(
        'CORRUPT_IMAGE',
        'The image does not contain valid dimensions.',
      );
    }
    const orientationSwapsDimensions = [5, 6, 7, 8].includes(
      metadata.orientation ?? 1,
    );
    const width = orientationSwapsDimensions ? rawHeight : rawWidth;
    const height = orientationSwapsDimensions ? rawWidth : rawHeight;
    if (
      width > MAX_SOURCE_IMAGE_SIDE ||
      height > MAX_SOURCE_IMAGE_SIDE ||
      width * height > MAX_SOURCE_IMAGE_PIXELS
    ) {
      throw new SourceImageImportError(
        'IMAGE_TOO_LARGE',
        `Images must be at most ${MAX_SOURCE_IMAGE_PIXELS.toLocaleString()} pixels and ${MAX_SOURCE_IMAGE_SIDE.toLocaleString()} pixels on each side.`,
      );
    }

    try {
      await sharp(bytes, {
        failOn: 'error',
        limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
      }).stats();
    } catch {
      throw new SourceImageImportError(
        'CORRUPT_IMAGE',
        'The image file could not be fully decoded.',
      );
    }

    const mediaType = mediaTypeFor(detectedFormat);
    return new ImmutableSourceImage(
      {
        id: randomUUID(),
        role: upload.role,
        filename: safeFilename(upload.filename),
        format: detectedFormat,
        mediaType,
        dimensions: { width, height },
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    );
  }

  /** A defensive copy prevents callers from mutating the retained source. */
  getBytes(): Buffer {
    return Buffer.from(this.#sourceBytes);
  }
}

export function dimensionsMatch(
  first: SourceImageMetadata | null,
  second: SourceImageMetadata | null,
): boolean | null {
  if (!first || !second) return null;
  return (
    first.dimensions.width === second.dimensions.width &&
    first.dimensions.height === second.dimensions.height
  );
}

function detectFormat(bytes: Buffer): SourceImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'PNG';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'JPEG';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'WEBP';
  }
  return null;
}

function mapSharpFormat(format: string | undefined): SourceImageFormat | null {
  switch (format) {
    case 'png':
      return 'PNG';
    case 'jpeg':
      return 'JPEG';
    case 'webp':
      return 'WEBP';
    default:
      return null;
  }
}

function mediaTypeFor(
  format: SourceImageFormat,
): SourceImageMetadata['mediaType'] {
  switch (format) {
    case 'PNG':
      return 'image/png';
    case 'JPEG':
      return 'image/jpeg';
    case 'WEBP':
      return 'image/webp';
  }
}

function safeFilename(filename: string): string {
  const basename = path.posix.basename(filename.replaceAll('\\', '/'));
  const normalized = basename
    .normalize('NFC')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(code <= 31 || (code >= 127 && code <= 159));
    })
    .join('');
  return (normalized.slice(0, 255) || 'comic-page').trim() || 'comic-page';
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MiB`;
}
