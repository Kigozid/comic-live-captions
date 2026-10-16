import { createHash } from 'node:crypto';
import type { Bounds, ImageSpace } from '@comic-captioner/shared';

/**
 * TrOCR (transformers.js) page/crop recognition. Stronger than PaddleOCR
 * mobile on stylized comic lettering when weights are available.
 *
 * Detection is still deterministic (bubble contours / ink masks). TrOCR only
 * recognizes text inside supplied regions or the full page.
 */
export interface TrocrRegion {
  readonly id: string;
  readonly bounds: Bounds<ImageSpace>;
}

export interface TrocrSession {
  readonly name: string;
  recognizeCrops(
    image: Uint8Array,
    regions: readonly TrocrRegion[],
    space: ImageSpace,
  ): Promise<readonly {
    readonly regionId: string;
    readonly text: string;
    readonly confidence: number;
  }[]>;
}

export class TrocrOcrError extends Error {
  constructor(
    readonly code: 'MODEL_MISSING' | 'MODEL_LOAD_FAILED' | 'RECOGNIZE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'TrocrOcrError';
  }
}

export interface TrocrOcrOptions {
  readonly session?: TrocrSession;
  readonly modelName?: string;
}

/** Minimal page OCR result in the shape ValidatingOCRService expects. */
export interface TrocrRawResult {
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly blocks: readonly {
    readonly id: string;
    readonly text: string;
    readonly confidence: number;
    readonly boundingBox: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly lines: readonly {
      readonly id: string;
      readonly text: string;
      readonly confidence: number;
      readonly boundingBox: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly words: readonly {
        readonly id: string;
        readonly text: string;
        readonly confidence: number;
        readonly boundingBox: {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
        };
      }[];
    }[];
  }[];
}

/**
 * Build an OCR-shaped payload from TrOCR region recognitions.
 * Word boxes are approximated by splitting the region box evenly — TrOCR is
 * line-level; deterministic geometry still owns bubble/region boxes.
 */
export function trocrRegionsToOcrDocumentInput(
  space: ImageSpace,
  regions: readonly TrocrRegion[],
  recognitions: readonly {
    readonly regionId: string;
    readonly text: string;
    readonly confidence: number;
  }[],
): TrocrRawResult {
  const byId = new Map(recognitions.map((item) => [item.regionId, item]));
  const blocks = regions.map((region, index) => {
    const rec = byId.get(region.id);
    const text = rec?.text.trim() ?? '';
    const confidence = rec?.confidence ?? 0;
    const box = {
      x: region.bounds.x,
      y: region.bounds.y,
      width: region.bounds.width,
      height: region.bounds.height,
    };
    const tokens = text.split(/\s+/u).filter(Boolean);
    const words =
      tokens.length === 0
        ? []
        : tokens.map((token, wordIndex) => {
            const slice = region.bounds.width / tokens.length;
            return {
              id: `${region.id}-w${wordIndex + 1}`,
              text: token,
              confidence,
              boundingBox: {
                x: box.x + wordIndex * slice,
                y: box.y,
                width: slice,
                height: box.height,
              },
            };
          });
    return {
      id: `trocr-block-${index + 1}`,
      text,
      confidence,
      boundingBox: box,
      lines: [
        {
          id: `${region.id}-line-1`,
          text,
          confidence,
          boundingBox: box,
          words,
        },
      ],
    };
  });
  const fullText = blocks
    .map((block) => block.text)
    .filter(Boolean)
    .join(' ');
  const confidences = blocks.map((block) => block.confidence).filter((c) => c > 0);
  return {
    text: fullText,
    confidence:
      confidences.length === 0
        ? 0
        : confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
    boundingBox: {
      x: 0,
      y: 0,
      width: space.dimensions.width,
      height: space.dimensions.height,
    },
    blocks,
  };
}

export class TrocrRecognizer {
  readonly #options: TrocrOcrOptions;
  #sessionPromise: Promise<TrocrSession> | null = null;

  constructor(options: TrocrOcrOptions = {}) {
    this.#options = options;
  }

  get modelName(): string {
    return this.#options.modelName ?? 'Xenova/trocr-small-printed';
  }

  async recognizeRegions(
    image: Uint8Array,
    regions: readonly TrocrRegion[],
    space: ImageSpace,
  ): Promise<TrocrRawResult> {
    const session = await this.#loadSession();
    const recognitions = await session.recognizeCrops(image, regions, space);
    return trocrRegionsToOcrDocumentInput(space, regions, recognitions);
  }

  async #loadSession(): Promise<TrocrSession> {
    if (this.#options.session) return this.#options.session;
    this.#sessionPromise ??= createTransformersTrocrSession(this.modelName);
    try {
      return await this.#sessionPromise;
    } catch (cause) {
      this.#sessionPromise = null;
      throw cause;
    }
  }
}

/** Deterministic full-page fallback regions (whole page) when no bubbles given. */
export function fullPageRegion(space: ImageSpace): readonly TrocrRegion[] {
  return [
    {
      id: 'trocr-page',
      bounds: {
        x: 0,
        y: 0,
        width: space.dimensions.width,
        height: space.dimensions.height,
        coordinateSpace: space,
      },
    },
  ];
}

export async function createTransformersTrocrSession(
  modelName: string,
): Promise<TrocrSession> {
  let pipeline: typeof import('@xenova/transformers').pipeline;
  try {
    ({ pipeline } = await import('@xenova/transformers'));
  } catch (cause) {
    throw new TrocrOcrError(
      'MODEL_MISSING',
      `@xenova/transformers is not available: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }
  let recognizer: Awaited<ReturnType<typeof pipeline>>;
  try {
    recognizer = await pipeline('image-to-text', modelName, {
      quantized: true,
    });
  } catch (cause) {
    throw new TrocrOcrError(
      'MODEL_LOAD_FAILED',
      `Failed to load TrOCR model ${modelName}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  return {
    name: `trocr:${modelName}`,
    async recognizeCrops(image, regions, space) {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(image).metadata();
      const imgW = meta.width ?? space.dimensions.width;
      const imgH = meta.height ?? space.dimensions.height;
      const results: {
        regionId: string;
        text: string;
        confidence: number;
      }[] = [];
      for (const region of regions) {
        try {
          const left = Math.max(0, Math.floor(region.bounds.x));
          const top = Math.max(0, Math.floor(region.bounds.y));
          const width = Math.max(
            1,
            Math.min(imgW - left, Math.ceil(region.bounds.width)),
          );
          const height = Math.max(
            1,
            Math.min(imgH - top, Math.ceil(region.bounds.height)),
          );
          const crop = await sharp(image)
            .extract({ left, top, width, height })
            .resize({ width: 384, withoutEnlargement: false })
            .removeAlpha()
            .raw()
            .toBuffer();
          const outH = Math.max(1, Math.round((height / width) * 384));
          // transformers.js accepts a plain {data,width,height,channels} raster.
          const rgb = {
            data: new Uint8Array(crop),
            width: 384,
            height: outH,
            channels: 3,
          };
          const output = (await recognizer(
            rgb as never,
          )) as {
            generated_text?: string;
            score?: number;
          }[];
          const text = String(output[0]?.generated_text ?? '').trim();
          const score = Number(output[0]?.score ?? (text ? 0.85 : 0));
          results.push({
            regionId: region.id,
            text,
            confidence: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0.5,
          });
        } catch {
          results.push({ regionId: region.id, text: '', confidence: 0 });
        }
      }
      return results;
    },
  };
}

export function trocrProviderId(modelName: string): string {
  return `trocr:${createHash('sha256').update(modelName).digest('hex').slice(0, 8)}`;
}
