import type { Bounds, ImageSpace, OCRDocument } from '@comic-captioner/shared';
import { createImageSpace } from '@comic-captioner/shared';
import {
  analyzeOCRPixels,
  preprocessOCRPixels,
  resizeOCRPixels,
} from './ocr-preprocessing.js';

export interface PaddleOCRStatus {
  readonly phase:
    'preparing' | 'loading-models' | 'recognizing' | 'ready' | 'error';
  readonly message: string;
}

export interface LocalOCRResult {
  readonly document: OCRDocument;
  readonly preprocessing?: 'original' | 'enhanced';
  readonly metrics: {
    readonly initializationMs: number;
    readonly detectionMs: number;
    readonly recognitionMs: number;
    readonly totalMs: number;
    readonly detectedTextRegions: number;
    readonly averageConfidence: number;
  };
}

export interface OCRBubbleRegion {
  readonly id: string;
  readonly polygon: readonly { readonly x: number; readonly y: number }[];
  readonly tail?: readonly { readonly x: number; readonly y: number }[] | null;
  readonly reviewStatus?: string;
  /** Fractional crop margin; higher values preserve context for narrow text boxes. */
  readonly cropPadding?: number;
}

/** Convert SDK polygon edge coordinates to validated page pixel-edge bounds. */
export function paddlePolygonBounds(
  polygon: readonly (readonly [number, number])[],
  imageSpace: ImageSpace,
): Bounds<ImageSpace> | null {
  const points = polygon.filter(
    (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  if (points.length < 3) return null;
  const { width: pageWidth, height: pageHeight } = imageSpace.dimensions;
  const x = Math.max(-0.5, Math.min(pageWidth - 1, ...points.map((p) => p[0])));
  const y = Math.max(
    -0.5,
    Math.min(pageHeight - 1, ...points.map((p) => p[1])),
  );
  const right = Math.min(pageWidth - 0.5, Math.max(...points.map((p) => p[0])));
  const bottom = Math.min(
    pageHeight - 0.5,
    Math.max(...points.map((p) => p[1])),
  );
  return {
    x,
    y,
    width: Math.min(pageWidth - 0.5 - x, Math.max(0.5, right - x)),
    height: Math.min(pageHeight - 0.5 - y, Math.max(0.5, bottom - y)),
    coordinateSpace: imageSpace,
  };
}

/** Map an OCR box in an upscaled bubble crop back to source page pixels. */
export function cropBoundsToImage(
  crop: Bounds<ImageSpace>,
  origin: { readonly x: number; readonly y: number },
  scale: number,
  imageSpace: ImageSpace,
): Bounds<ImageSpace> {
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error('OCR crop scale must be positive and finite.');
  const x = Math.max(-0.5, origin.x + crop.x / scale);
  const y = Math.max(-0.5, origin.y + crop.y / scale);
  const right = Math.min(
    imageSpace.dimensions.width - 0.5,
    origin.x + (crop.x + crop.width) / scale,
  );
  const bottom = Math.min(
    imageSpace.dimensions.height - 0.5,
    origin.y + (crop.y + crop.height) / scale,
  );
  return {
    x,
    y,
    width: Math.max(0.5, right - x),
    height: Math.max(0.5, bottom - y),
    coordinateSpace: imageSpace,
  };
}

type Engine = Awaited<
  ReturnType<typeof import('@paddleocr/paddleocr-js').PaddleOCR.create>
>;

let enginePromise: Promise<Engine> | null = null;
let engineReadyAt: number | null = null;
let engineStartedAt: number | null = null;
const enhancedImageCache = new Map<string, { blob: Blob; bytes: number }>();
let enhancedImageCacheBytes = 0;
const ENHANCED_CACHE_LIMIT = 32 * 1024 * 1024;

function cacheBlob(key: string, blob: Blob): void {
  const previous = enhancedImageCache.get(key);
  if (previous) enhancedImageCacheBytes -= previous.bytes;
  enhancedImageCache.delete(key);
  enhancedImageCache.set(key, { blob, bytes: blob.size });
  enhancedImageCacheBytes += blob.size;
  while (enhancedImageCacheBytes > ENHANCED_CACHE_LIMIT) {
    const oldestKey = enhancedImageCache.keys().next().value as
      string | undefined;
    if (!oldestKey) break;
    enhancedImageCacheBytes -= enhancedImageCache.get(oldestKey)!.bytes;
    enhancedImageCache.delete(oldestKey);
  }
}

function cachedBlob(key: string): Blob | undefined {
  const entry = enhancedImageCache.get(key);
  if (!entry) return undefined;
  // Refresh insertion order to provide an LRU bound for large pages.
  enhancedImageCache.delete(key);
  enhancedImageCache.set(key, entry);
  return entry.blob;
}

async function prepareEnhancedPage(
  source: Blob,
  sourceHash: string,
  imageSpace: ImageSpace,
): Promise<{ blob: Blob; scale: number }> {
  const cacheKey = `page:${sourceHash}:v1`;
  const cached = cachedBlob(cacheKey);
  if (cached) {
    const bitmap = await createImageBitmap(cached);
    try {
      return {
        blob: cached,
        scale: bitmap.width / imageSpace.dimensions.width,
      };
    } finally {
      bitmap.close();
    }
  }
  const bitmap = await createImageBitmap(source);
  try {
    if (
      bitmap.width !== imageSpace.dimensions.width ||
      bitmap.height !== imageSpace.dimensions.height
    )
      throw new Error('Decoded OCR page dimensions do not match ImageSpace.');
    const sourcePixels = await readBitmapPixels(bitmap);
    const maxSide = Math.max(bitmap.width, bitmap.height);
    const scale = maxSide < 1150 ? Math.min(2.5, 1150 / maxSide) : 1;
    const resized =
      scale > 1
        ? await resizeOCRPixels(sourcePixels, scale, 1800)
        : sourcePixels;
    const prepared = await preprocessOCRPixels(resized, {
      grayscale: true,
      contrast: 1.08,
      invert: 'auto',
      adaptiveThreshold: true,
      denoise: false,
    });
    const blob = await pixelsToBlob(prepared.image);
    cacheBlob(cacheKey, blob);
    return { blob, scale: prepared.image.width / bitmap.width };
  } finally {
    bitmap.close();
  }
}

async function readBitmapPixels(bitmap: ImageBitmap): Promise<ImageData> {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OCR preprocessing canvas is unavailable.');
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function pixelsToBlob(pixels: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}): Promise<Blob> {
  const canvas = makeCanvas(pixels.width, pixels.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OCR preprocessing canvas is unavailable.');
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.data),
      pixels.width,
      pixels.height,
    ),
    0,
    0,
  );
  if ('convertToBlob' in canvas)
    return canvas.convertToBlob({ type: 'image/png' });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('Enhanced OCR image could not be created.')),
      'image/png',
    ),
  );
}

function makeCanvas(
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined')
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function resetFailedEngine(
  engine: Engine,
  cause: unknown,
): Promise<never> {
  enginePromise = null;
  engineReadyAt = null;
  engineStartedAt = null;
  try {
    await engine.dispose();
  } catch {
    // Preserve the inference error; disposal is best-effort recovery cleanup.
  }
  const detail = cause instanceof Error ? ` ${cause.message}` : '';
  throw new Error(
    `PaddleOCR inference failed and its local worker was reset.${detail} Retry local OCR to reload the models.`,
    { cause },
  );
}

/** The SDK owns one reusable worker/model instance for the lifetime of this tab. */
async function getEngine(onStatus: (status: PaddleOCRStatus) => void) {
  if (!enginePromise) {
    onStatus({ phase: 'preparing', message: 'Preparing the OCR engine…' });
    engineStartedAt = performance.now();
    enginePromise = import('@paddleocr/paddleocr-js')
      .then(({ PaddleOCR }) =>
        PaddleOCR.create({
          lang: 'en',
          ocrVersion: 'PP-OCRv5',
          textDetectionModelName: 'PP-OCRv5_mobile_det',
          textDetectionModelAsset: {
            url: new URL('/api/ocr-models/detection', window.location.origin)
              .href,
          },
          textRecognitionModelName: 'PP-OCRv5_mobile_rec',
          textRecognitionModelAsset: {
            url: new URL('/api/ocr-models/recognition', window.location.origin)
              .href,
          },
          worker: true,
          ortOptions: {
            backend: 'wasm',
            numThreads: 1,
            simd: true,
            wasmPaths:
              'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
          },
        }),
      )
      .then((engine) => {
        engineReadyAt = performance.now();
        return engine;
      })
      .catch((error: unknown) => {
        enginePromise = null;
        throw error;
      });
    onStatus({
      phase: 'loading-models',
      message:
        'Loading official PaddleOCR English detection and recognition models…',
    });
  }
  return enginePromise;
}

/** Run PaddleOCR locally in its worker and adapt its result to the domain schema. */
export async function recognizeComicPage(
  image: Blob,
  imageSpace: ImageSpace,
  sourceHash: string,
  onStatus: (status: PaddleOCRStatus) => void,
  enhanced = false,
): Promise<LocalOCRResult> {
  if (image.size === 0) throw new Error('The comic image is empty.');
  const totalStarted = performance.now();
  const engine = await getEngine(onStatus);
  const initializationMs =
    engineReadyAt && engineStartedAt ? engineReadyAt - engineStartedAt : 0;
  const prepared = enhanced
    ? await prepareEnhancedPage(image, sourceHash, imageSpace)
    : { blob: image, scale: 1 };
  onStatus({
    phase: 'recognizing',
    message: enhanced
      ? 'Retrying local OCR with resolution-aware enhancement…'
      : 'Reading text on the comic page…',
  });
  let result: Awaited<ReturnType<Engine['predict']>>[number] | undefined;
  try {
    [result] = await engine.predict(prepared.blob, {
      textDetLimitSideLen: 1600,
      textDetLimitType: 'max',
      textRecScoreThresh: 0.2,
    });
  } catch (cause) {
    return resetFailedEngine(engine, cause);
  }
  if (!result) throw new Error('PaddleOCR returned no page result.');
  if (
    result.image.width !==
      Math.round(imageSpace.dimensions.width * prepared.scale) ||
    result.image.height !==
      Math.round(imageSpace.dimensions.height * prepared.scale)
  ) {
    throw new Error(
      'OCR returned coordinates for a different image size; results were rejected to prevent misplaced text boxes.',
    );
  }

  const items = result.items
    .map((item, index) => {
      const points = item.poly.filter(
        (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
      );
      if (!item.text.trim() || !Number.isFinite(item.score)) return null;
      const resultSpace = createImageSpace(
        `ocr-input:${sourceHash.slice(0, 12)}:${prepared.scale}`,
        result.image.width,
        result.image.height,
      );
      const resultBounds = paddlePolygonBounds(points, resultSpace);
      if (!resultBounds) return null;
      const boundingBox = cropBoundsToImage(
        resultBounds,
        { x: 0, y: 0 },
        prepared.scale,
        imageSpace,
      );
      const text = item.text.trim();
      return {
        id: `paddle-line-${index + 1}`,
        text,
        confidence: Math.max(0, Math.min(1, item.score)),
        boundingBox,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .filter(
      (item) =>
        item.text.length > 0 &&
        item.boundingBox.x + item.boundingBox.width <=
          imageSpace.dimensions.width - 0.5 &&
        item.boundingBox.y + item.boundingBox.height <=
          imageSpace.dimensions.height - 0.5,
    )
    .sort((a, b) => {
      const verticalTolerance = Math.max(
        4,
        Math.min(a.boundingBox.height, b.boundingBox.height) * 0.55,
      );
      return Math.abs(a.boundingBox.y - b.boundingBox.y) > verticalTolerance
        ? a.boundingBox.y - b.boundingBox.y
        : a.boundingBox.x - b.boundingBox.x;
    });
  const blocks = items.map((line) => ({
    id: `paddle-block:${line.id}`,
    text: line.text,
    boundingBox: line.boundingBox,
    confidence: line.confidence,
    coordinateSpace: imageSpace,
    lines: [
      {
        ...line,
        coordinateSpace: imageSpace,
        words: [
          {
            id: `paddle-word:${line.id}`,
            text: line.text,
            confidence: line.confidence,
            boundingBox: line.boundingBox,
            coordinateSpace: imageSpace,
          },
        ],
      },
    ],
  }));
  const confidences = items.map((item) => item.confidence);
  const averageConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  const bounds = items.length
    ? {
        x: Math.min(...items.map((item) => item.boundingBox.x)),
        y: Math.min(...items.map((item) => item.boundingBox.y)),
        width:
          Math.max(
            ...items.map((item) => item.boundingBox.x + item.boundingBox.width),
          ) - Math.min(...items.map((item) => item.boundingBox.x)),
        height:
          Math.max(
            ...items.map(
              (item) => item.boundingBox.y + item.boundingBox.height,
            ),
          ) - Math.min(...items.map((item) => item.boundingBox.y)),
        coordinateSpace: imageSpace,
      }
    : {
        x: 0,
        y: 0,
        width: Math.max(0.5, imageSpace.dimensions.width - 0.5),
        height: Math.max(0.5, imageSpace.dimensions.height - 0.5),
        coordinateSpace: imageSpace,
      };
  const document: OCRDocument = {
    id: `paddleocr:${sourceHash.slice(0, 24)}`,
    text: items.map((item) => item.text).join('\n'),
    boundingBox: bounds,
    confidence: averageConfidence,
    coordinateSpace: imageSpace,
    blocks,
    revision: 1,
    reviewStatus: 'pending-review',
    provenance: {
      source: '@paddleocr/paddleocr-js',
      version: '0.4.2 / PP-OCRv5 en',
      inputHashes: [sourceHash],
    },
  };
  onStatus({
    phase: 'ready',
    message: items.length
      ? 'Local OCR completed.'
      : 'PaddleOCR ran but found no readable text on this page. Try a higher-resolution source or scan the bubble interiors.',
  });
  return {
    document,
    preprocessing: enhanced ? 'enhanced' : 'original',
    metrics: {
      initializationMs,
      detectionMs: result.metrics.detMs,
      recognitionMs: result.metrics.recMs,
      totalMs: Math.max(
        result.metrics.totalMs,
        performance.now() - totalStarted,
      ),
      detectedTextRegions: blocks.length,
      averageConfidence,
    },
  };
}

interface PreparedBubbleCrop {
  readonly bubbleId: string;
  readonly blob: Blob;
  readonly origin: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

/** OCR accepted bubble interiors in one worker batch, retaining page geometry. */
export async function recognizeComicBubbles(
  image: Blob,
  imageSpace: ImageSpace,
  sourceHash: string,
  bubbles: readonly OCRBubbleRegion[],
  onStatus: (status: PaddleOCRStatus) => void,
  enhanced = false,
): Promise<LocalOCRResult> {
  const candidates = bubbles
    .filter((bubble) => bubble.reviewStatus !== 'rejected')
    .filter((bubble) => bubble.polygon.length >= 3)
    .sort((left, right) => {
      const leftTop = Math.min(...left.polygon.map((point) => point.y));
      const rightTop = Math.min(...right.polygon.map((point) => point.y));
      const tolerance = Math.min(
        Math.max(1, bubbleHeight(left.polygon) * 0.5),
        Math.max(1, bubbleHeight(right.polygon) * 0.5),
      );
      return Math.abs(leftTop - rightTop) > tolerance
        ? leftTop - rightTop
        : Math.min(...left.polygon.map((point) => point.x)) -
            Math.min(...right.polygon.map((point) => point.x));
    });
  if (candidates.length === 0)
    return recognizeComicPage(
      image,
      imageSpace,
      sourceHash,
      onStatus,
      enhanced,
    );
  if (image.size === 0) throw new Error('The comic image is empty.');
  const totalStarted = performance.now();
  const engine = await getEngine(onStatus);
  const initializationMs =
    engineReadyAt && engineStartedAt ? engineReadyAt - engineStartedAt : 0;
  onStatus({
    phase: 'recognizing',
    message: enhanced
      ? `Retrying OCR on padded, enhanced bubble crops (${candidates.length})…`
      : `Reading the interiors of ${candidates.length} bubble${candidates.length === 1 ? '' : 's'} locally…`,
  });
  const bitmap = await createImageBitmap(image);
  if (
    bitmap.width !== imageSpace.dimensions.width ||
    bitmap.height !== imageSpace.dimensions.height
  ) {
    bitmap.close();
    throw new Error(
      'The browser decoded the comic at a different size than its ImageSpace.',
    );
  }
  let crops: PreparedBubbleCrop[];
  try {
    crops = await Promise.all(
      candidates.map((bubble) =>
        prepareBubbleCrop(bitmap, bubble, enhanced, sourceHash),
      ),
    );
  } finally {
    bitmap.close();
  }
  let results: Awaited<ReturnType<Engine['predict']>>;
  try {
    results = await engine.predict(
      crops.map((crop) => crop.blob),
      {
        textDetLimitSideLen: 1600,
        textDetLimitType: 'max',
        textRecScoreThresh: 0.2,
      },
    );
  } catch (cause) {
    return resetFailedEngine(engine, cause);
  }
  if (results.length !== crops.length)
    throw new Error('PaddleOCR returned an incomplete bubble crop batch.');
  const blocks = results.flatMap((result, cropIndex) => {
    const crop = crops[cropIndex]!;
    if (
      result.image.width !== crop.width ||
      result.image.height !== crop.height
    )
      throw new Error(
        `PaddleOCR returned unexpected dimensions for bubble ${crop.bubbleId}.`,
      );
    const lines = result.items
      .map((item, lineIndex) => {
        if (!item.text.trim() || !Number.isFinite(item.score)) return null;
        const cropSpace = createImageSpace(
          `ocr-crop:${crop.bubbleId}`,
          crop.width,
          crop.height,
        );
        const cropBounds = paddlePolygonBounds(item.poly, cropSpace);
        if (!cropBounds) return null;
        const boundingBox = cropBoundsToImage(
          cropBounds,
          crop.origin,
          crop.scale,
          imageSpace,
        );
        const id = `paddle-${crop.bubbleId}-line-${lineIndex + 1}`;
        const text = item.text.trim();
        const confidence = Math.max(0, Math.min(1, item.score));
        return {
          id,
          text,
          confidence,
          boundingBox,
          coordinateSpace: imageSpace,
          words: [
            {
              id: `paddle-${crop.bubbleId}-word-${lineIndex + 1}`,
              text,
              confidence,
              boundingBox,
              coordinateSpace: imageSpace,
            },
          ],
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null)
      .sort(
        (left, right) =>
          left.boundingBox.y - right.boundingBox.y ||
          left.boundingBox.x - right.boundingBox.x,
      );
    if (lines.length === 0) return [];
    const confidences = lines.map((line) => line.confidence);
    const text = lines.map((line) => line.text).join('\n');
    const bounds = unionOCRBounds(
      lines.map((line) => line.boundingBox),
      imageSpace,
    );
    return [
      {
        id: `paddle-bubble-${crop.bubbleId}`,
        text,
        confidence:
          confidences.reduce((sum, confidence) => sum + confidence, 0) /
          confidences.length,
        boundingBox: bounds,
        coordinateSpace: imageSpace,
        lines,
      },
    ];
  });
  const lines = blocks.flatMap((block) => block.lines);
  const confidence = lines.length
    ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
    : 0;
  const document: OCRDocument = {
    id: `paddleocr:${sourceHash.slice(0, 24)}`,
    text: blocks.map((block) => block.text).join('\n\n'),
    boundingBox: lines.length
      ? unionOCRBounds(
          lines.map((line) => line.boundingBox),
          imageSpace,
        )
      : {
          x: 0,
          y: 0,
          width: Math.max(0.5, imageSpace.dimensions.width - 0.5),
          height: Math.max(0.5, imageSpace.dimensions.height - 0.5),
          coordinateSpace: imageSpace,
        },
    confidence,
    coordinateSpace: imageSpace,
    blocks,
    revision: 1,
    reviewStatus: 'pending-review',
    provenance: {
      source: '@paddleocr/paddleocr-js',
      version: '0.4.2 / PP-OCRv5 en',
      inputHashes: [sourceHash],
    },
  };
  onStatus({
    phase: 'ready',
    message: lines.length
      ? 'Bubble crop OCR completed.'
      : 'PaddleOCR ran but found no readable text in the selected bubble interiors. Check the bubble outlines or use page OCR.',
  });
  const metrics = results[0]?.metrics;
  return {
    document,
    preprocessing: enhanced ? 'enhanced' : 'original',
    metrics: {
      initializationMs,
      detectionMs: metrics?.detMs ?? 0,
      recognitionMs: metrics?.recMs ?? 0,
      totalMs: Math.max(
        metrics?.totalMs ?? 0,
        performance.now() - totalStarted,
      ),
      detectedTextRegions: lines.length,
      averageConfidence: confidence,
    },
  };
}

function bubbleHeight(points: readonly { readonly y: number }[]): number {
  return (
    Math.max(...points.map((point) => point.y)) -
    Math.min(...points.map((point) => point.y))
  );
}

async function prepareBubbleCrop(
  bitmap: ImageBitmap,
  bubble: OCRBubbleRegion,
  enhanced = false,
  sourceHash = '',
): Promise<PreparedBubbleCrop> {
  const boundsLeft = Math.max(
    0,
    Math.floor(Math.min(...bubble.polygon.map((point) => point.x))),
  );
  const boundsTop = Math.max(
    0,
    Math.floor(Math.min(...bubble.polygon.map((point) => point.y))),
  );
  const boundsRight = Math.min(
    bitmap.width,
    Math.ceil(Math.max(...bubble.polygon.map((point) => point.x))),
  );
  const boundsBottom = Math.min(
    bitmap.height,
    Math.ceil(Math.max(...bubble.polygon.map((point) => point.y))),
  );
  const paddingFraction = enhanced
    ? Math.max(0, Math.min(0.35, bubble.cropPadding ?? 0.04))
    : 0;
  const padding = Math.ceil(
    Math.min(boundsRight - boundsLeft, boundsBottom - boundsTop) *
      paddingFraction,
  );
  const left = Math.max(0, boundsLeft - padding);
  const top = Math.max(0, boundsTop - padding);
  const right = Math.min(bitmap.width, boundsRight + padding);
  const bottom = Math.min(bitmap.height, boundsBottom + padding);
  const sourceWidth = right - left;
  const sourceHeight = bottom - top;
  if (sourceWidth < 2 || sourceHeight < 2)
    throw new Error(`Bubble ${bubble.id} is too small to OCR.`);
  const maximumSide = Math.max(sourceWidth, sourceHeight);
  const scale = enhanced
    ? Math.min(3, 1800 / maximumSide, Math.max(1, 620 / maximumSide))
    : Math.min(2, 1800 / maximumSide, Math.max(1, 480 / maximumSide));
  const width = Math.max(2, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));
  const cacheKey = enhanced
    ? `bubble:${sourceHash}:${bubble.id}:${JSON.stringify(bubble.polygon)}:${JSON.stringify(bubble.tail)}:${paddingFraction}:v1`
    : '';
  const existing = enhanced ? cachedBlob(cacheKey) : undefined;
  if (existing)
    return {
      bubbleId: bubble.id,
      blob: existing,
      origin: { x: left, y: top },
      scale,
      width,
      height,
    };
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Bubble crop canvas is unavailable.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.save();
  context.scale(scale, scale);
  context.beginPath();
  bubble.polygon.forEach((point, index) => {
    const x = point.x - left;
    const y = point.y - top;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.closePath();
  if (bubble.tail && bubble.tail.length >= 3) {
    bubble.tail.forEach((point, index) => {
      const x = point.x - left;
      const y = point.y - top;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
  }
  context.clip('evenodd');
  context.drawImage(bitmap, -left, -top);
  context.globalCompositeOperation = 'destination-out';
  if (!enhanced) {
    context.strokeStyle = '#000';
    context.lineWidth =
      Math.min(6, Math.max(1.5, Math.min(sourceWidth, sourceHeight) * 0.015)) *
      2;
    context.lineJoin = 'round';
    context.stroke();
  }
  context.restore();
  let blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value: Blob | null) =>
              value
                ? resolve(value)
                : reject(new Error('Bubble crop image could not be created.')),
            'image/png',
          ),
        );
  if (enhanced) {
    const temporaryBitmap = await createImageBitmap(blob);
    let pixels: ImageData;
    try {
      pixels = await readBitmapPixels(temporaryBitmap);
    } finally {
      temporaryBitmap.close();
    }
    const analysis = analyzeOCRPixels(pixels);
    const prepared = await preprocessOCRPixels(pixels, {
      grayscale: true,
      contrast: analysis.luminanceRange < 70 ? 1.16 : 1.08,
      invert: 'auto',
      adaptiveThreshold: true,
      denoise: false,
    });
    blob = await pixelsToBlob(prepared.image);
    cacheBlob(cacheKey, blob);
  }
  return {
    bubbleId: bubble.id,
    blob,
    origin: { x: left, y: top },
    scale,
    width,
    height,
  };
}

function unionOCRBounds(
  bounds: readonly Bounds<ImageSpace>[],
  imageSpace: ImageSpace,
): Bounds<ImageSpace> {
  const left = Math.min(...bounds.map((bound) => bound.x));
  const top = Math.min(...bounds.map((bound) => bound.y));
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const bottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: imageSpace,
  };
}
