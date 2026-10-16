import { createHash, randomUUID } from 'node:crypto';
import {
  LetteringRemovalError,
  LetteringRemover,
  type GenerativeInpaintProvider,
  type LetteringRemovalResult,
  type LetteringSourceRegion,
  type ManualMaskEdit,
  type RasterImage,
} from '@comic-captioner/image-engine';
import {
  createImageSpace,
  type ImageSpace,
} from '@comic-captioner/shared';

/**
 * Server-side lettering-removal orchestration.
 *
 * Accepts an original page raster plus detected text/bubble geometry and
 * optional manual mask edits. Produces a cleaned raster, removal mask,
 * per-region method record, and warnings. Never mutates or overwrites the
 * original uploaded image. Stale requests are discarded so an old page
 * version cannot overwrite the current result.
 */

export interface CleanPageRequest {
  /** RGBA raster of the original page. Copied; never retained as the source. */
  readonly image: RasterImage;
  readonly spaceId?: string;
  readonly requestId?: string;
  readonly textRegions?: readonly LetteringSourceRegion[];
  readonly bubbles?: readonly {
    readonly id: string;
    readonly contour: {
      readonly points: readonly { readonly x: number; readonly y: number }[];
    };
    readonly boundingBox?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly interiorHint?:
      | 'white-balloon'
      | 'coloured-balloon'
      | 'textured-balloon'
      | 'artwork'
      | 'unknown';
    readonly outlineMask?: Uint8Array | null;
  }[];
  readonly manualEdits?: readonly ManualMaskEdit[];
  readonly options?: {
    readonly expansionPx?: number;
    readonly preferLamaForArtwork?: boolean;
    readonly mergeGapPx?: number;
    /**
     * Default `bubble-interior`. Use `approved` only to also erase text
     * regions the user explicitly accepted. Unreviewed free-floating text
     * is never auto-erased.
     */
    readonly erasureScope?: 'bubble-interior' | 'approved';
  };
}

export interface CleanPageResponse {
  readonly requestId: string;
  readonly status: 'complete' | 'stale';
  readonly width: number;
  readonly height: number;
  /** PNG bytes of the cleaned page (same dimensions as the source). */
  readonly cleanedPng: Uint8Array;
  readonly removalMask: Uint8Array;
  readonly regions: LetteringRemovalResult['regions'];
  readonly warnings: LetteringRemovalResult['warnings'];
  readonly methodSummary: LetteringRemovalResult['methodSummary'];
  readonly complete: boolean;
  readonly lamaAvailable: boolean;
}

export class CleanPageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'IMAGE_TOO_LARGE'
      | 'DIMENSION_MISMATCH'
      | 'CLEAN_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CleanPageError';
  }
}

export interface CleanPageDependencies {
  readonly generative?: GenerativeInpaintProvider | null;
  readonly encodePng?: (image: RasterImage) => Promise<Uint8Array>;
}

const MAX_PIXELS = 40_000_000;

export class CleanPageCoordinator {
  readonly #remover: LetteringRemover;
  readonly #encodePng: (image: RasterImage) => Promise<Uint8Array>;
  #latestRequestId: string | null = null;
  /** Serializes expensive cleans so 8 GB machines stay stable. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: CleanPageDependencies = {}) {
    this.#remover = new LetteringRemover({
      generative: deps.generative ?? null,
    });
    this.#encodePng = deps.encodePng ?? defaultEncodePng;
  }

  begin(requestId?: string): string {
    const id = requestId?.trim() || `clean-${randomUUID()}`;
    this.#latestRequestId = id;
    return id;
  }

  isStale(requestId: string): boolean {
    return this.#latestRequestId !== requestId;
  }

  async cleanPage(request: CleanPageRequest): Promise<CleanPageResponse> {
    const requestId = this.begin(request.requestId);
    validateRequest(request);
    const space = resolveSpace(request);
    const run = this.#queue.then(() =>
      this.#runClean(request, requestId, space),
    );
    // Keep the chain alive even when a run rejects.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #runClean(
    request: CleanPageRequest,
    requestId: string,
    space: ImageSpace,
  ): Promise<CleanPageResponse> {
    if (this.isStale(requestId)) {
      return this.#staleResponse(requestId, request.image);
    }
    const image: RasterImage = {
      width: request.image.width,
      height: request.image.height,
      // Defensive copy: never hold or mutate the caller's buffer.
      data: Uint8ClampedArray.from(request.image.data),
    };
    const bubbles = (request.bubbles ?? []).map((bubble) => ({
      id: bubble.id,
      contour: {
        points: bubble.contour.points.map((point) => ({
          x: point.x,
          y: point.y,
          coordinateSpace: space,
        })),
        coordinateSpace: space,
      },
      ...(bubble.boundingBox
        ? {
            boundingBox: {
              x: bubble.boundingBox.x,
              y: bubble.boundingBox.y,
              width: bubble.boundingBox.width,
              height: bubble.boundingBox.height,
              coordinateSpace: space,
            },
          }
        : {}),
      ...(bubble.interiorHint ? { interiorHint: bubble.interiorHint } : {}),
      ...(bubble.outlineMask ? { outlineMask: bubble.outlineMask } : {}),
    }));

    let result: LetteringRemovalResult;
    try {
      result = await this.#remover.removeLettering({
        image,
        coordinateSpace: space,
        bubbles,
        textRegions: request.textRegions ?? [],
        manualEdits: request.manualEdits ?? [],
        ...(request.options ? { options: request.options } : {}),
      });
    } catch (error) {
      if (error instanceof LetteringRemovalError) {
        throw new CleanPageError(
          error.code === 'DIMENSION_MISMATCH'
            ? 'DIMENSION_MISMATCH'
            : 'CLEAN_FAILED',
          error.message,
        );
      }
      throw new CleanPageError(
        'CLEAN_FAILED',
        error instanceof Error ? error.message : 'Lettering removal failed.',
      );
    }

    if (this.isStale(requestId)) {
      return this.#staleResponse(requestId, request.image);
    }

    const cleanedPng = await this.#encodePng(result.cleaned);
    return Object.freeze({
      requestId,
      status: 'complete' as const,
      width: result.width,
      height: result.height,
      cleanedPng,
      removalMask: result.removalMask,
      regions: result.regions,
      warnings: result.warnings,
      methodSummary: result.methodSummary,
      complete: result.complete,
      lamaAvailable: false,
    });
  }

  #staleResponse(
    requestId: string,
    image: RasterImage,
  ): CleanPageResponse {
    return Object.freeze({
      requestId,
      status: 'stale' as const,
      width: image.width,
      height: image.height,
      cleanedPng: new Uint8Array(),
      removalMask: new Uint8Array(image.width * image.height),
      regions: Object.freeze([]),
      warnings: Object.freeze([
        {
          code: 'method-failed' as const,
          regionId: '*',
          message:
            'A newer cleaning request superseded this one; discard these results.',
        },
      ]),
      methodSummary: Object.freeze({
        'white-fill': 0,
        'background-fill': 0,
        'local-reconstruct': 0,
        lama: 0,
        skipped: 0,
        manual: 0,
      }),
      complete: false,
      lamaAvailable: false,
    });
  }
}

function validateRequest(request: CleanPageRequest): void {
  const image = request.image;
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new CleanPageError(
      'INVALID_REQUEST',
      'image must be an RGBA raster with positive integer dimensions.',
    );
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new CleanPageError(
      'INVALID_REQUEST',
      'image data must contain exactly width × height RGBA pixels.',
    );
  }
  if (image.width * image.height > MAX_PIXELS) {
    throw new CleanPageError(
      'IMAGE_TOO_LARGE',
      'Page exceeds 40 megapixels.',
    );
  }
  if (request.textRegions && request.textRegions.length > 512) {
    throw new CleanPageError(
      'INVALID_REQUEST',
      'At most 512 text regions are accepted per cleaning request.',
    );
  }
}

function resolveSpace(request: CleanPageRequest): ImageSpace {
  return createImageSpace(
    request.spaceId?.trim() ||
      `image:clean-${request.image.width}x${request.image.height}`,
    request.image.width,
    request.image.height,
  );
}

async function defaultEncodePng(image: RasterImage): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const buffer = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

export function hashRaster(image: RasterImage): string {
  return createHash('sha256')
    .update(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength))
    .digest('hex')
    .slice(0, 16);
}
