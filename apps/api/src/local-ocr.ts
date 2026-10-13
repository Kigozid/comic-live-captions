import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Bounds,
  ImageSpace,
  OCRBlock,
  OCRDocument,
  OCRLine,
  OCRWord,
  SourceImageMetadata,
} from '@comic-captioner/shared';
import {
  analyzeOCRPixels,
  preprocessOCRPixels,
  resizeOCRPixels,
} from '@comic-captioner/shared/ocr-preprocessing';
import { createImageSpace } from '@comic-captioner/shared';

const MODEL_URLS = {
  detection:
    'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar',
  recognition:
    'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
} as const;
const MAX_IMAGE_PIXELS = 40_000_000;
const PAGE_MAX_SIDE = 1800;
const BUBBLE_MAX_SIDE = 1600;
const OCR_PROVIDER = '@paddleocr/paddleocr-js';
const OCR_VERSION = '0.4.2 / PP-OCRv5 mobile English';

export interface OCRBubbleInput {
  readonly id: string;
  readonly polygon: readonly { readonly x: number; readonly y: number }[];
  readonly tail?: readonly { readonly x: number; readonly y: number }[] | null;
  readonly reviewStatus?: string;
  readonly cropPadding?: number;
}

export interface OCRScanOptions {
  readonly enhanced?: boolean;
  readonly coordinateSpaceId?: string;
  readonly bubbles?: readonly OCRBubbleInput[];
}

export interface OCRScanResult {
  readonly document: OCRDocument;
  readonly preprocessing: 'original' | 'enhanced';
  readonly metrics: {
    readonly initializationMs: number;
    readonly detectionMs: number;
    readonly recognitionMs: number;
    readonly totalMs: number;
    readonly detectedTextRegions: number;
    readonly averageConfidence: number;
  };
}

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface Crop {
  readonly id: string;
  readonly origin: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly raster: Raster;
}

interface RecognitionItem {
  readonly text: string;
  readonly score: number;
  readonly poly: readonly (readonly [number, number])[];
}

interface RecognitionResult {
  readonly image: { readonly width: number; readonly height: number };
  readonly items: readonly RecognitionItem[];
  readonly metrics: {
    readonly detMs?: number;
    readonly recMs?: number;
    readonly totalMs?: number;
  };
}

class ServerImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

class ServerCanvas {
  width = 0;
  height = 0;
  pixels = new Uint8ClampedArray();
  private readonly context = {
    putImageData: (image: ServerImageData) => {
      this.pixels = new Uint8ClampedArray(image.data);
    },
    getImageData: () =>
      new ServerImageData(
        new Uint8ClampedArray(this.pixels),
        this.width,
        this.height,
      ),
    drawImage: (source: ServerCanvas | ServerImageData) => {
      this.pixels = new Uint8ClampedArray(
        source instanceof ServerCanvas ? source.pixels : source.data,
      );
    },
  };

  getContext() {
    return this.context;
  }

  close() {}
}

let runtimeConfigured = false;
function configureServerRasterRuntime(): void {
  if (runtimeConfigured) return;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.ImageData = ServerImageData;
  globals.HTMLCanvasElement = ServerCanvas;
  globals.HTMLImageElement = ServerCanvas;
  globals.document = { createElement: () => new ServerCanvas() };
  globals.createImageBitmap = async (source: unknown) => source;
  globals.location = { protocol: 'http:' };
  runtimeConfigured = true;
}

let models: {
  detection: Promise<Buffer>;
  recognition: Promise<Buffer>;
} | null = null;
type PaddleEngine = Awaited<
  ReturnType<typeof import('@paddleocr/paddleocr-js').PaddleOCR.create>
>;
const enginePromise = new Map<string, Promise<PaddleEngine>>();
let engineStartedAt = 0;
let engineReadyAt = 0;
let scanQueue: Promise<void> = Promise.resolve();
const resultCache = new Map<
  string,
  { readonly value: OCRScanResult; readonly bytes: number }
>();
let resultCacheBytes = 0;
const RESULT_CACHE_LIMIT = 24 * 1024 * 1024;

async function fetchModel(kind: keyof typeof MODEL_URLS): Promise<Buffer> {
  if (!models)
    models = {
      detection: fetchModelFromUrl('detection'),
      recognition: fetchModelFromUrl('recognition'),
    };
  return models[kind];
}

async function fetchModelFromUrl(
  kind: keyof typeof MODEL_URLS,
): Promise<Buffer> {
  const modelDirectory = process.env.OCR_MODEL_DIR;
  if (modelDirectory) {
    const filename =
      kind === 'detection'
        ? 'ocr-detection-model.tar'
        : 'ocr-recognition-model.tar';
    const bytes = await readFile(path.join(modelDirectory, filename));
    if (bytes.byteLength < 1024 * 1024)
      throw new Error(
        `The local PaddleOCR ${kind} model archive is incomplete.`,
      );
    return bytes;
  }
  const response = await fetch(MODEL_URLS[kind]);
  if (!response.ok)
    throw new Error(`PaddleOCR model host returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1024 * 1024)
    throw new Error('The PaddleOCR model download was incomplete.');
  return bytes;
}

function sdkFetch() {
  return async (url: string | URL | Request) => {
    const value = String(url);
    const kind = value.includes('detection') ? 'detection' : 'recognition';
    return new Response(Uint8Array.from(await fetchModel(kind)));
  };
}

async function getEngine() {
  let existing = enginePromise.get('en');
  if (existing) return existing;
  configureServerRasterRuntime();
  engineStartedAt = performance.now();
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
  existing = PaddleOCR.create({
    lang: 'en',
    ocrVersion: 'PP-OCRv5',
    textDetectionModelName: 'PP-OCRv5_mobile_det',
    textDetectionModelAsset: { url: 'http://local-ocr/detection' },
    textRecognitionModelName: 'PP-OCRv5_mobile_rec',
    textRecognitionModelAsset: { url: 'http://local-ocr/recognition' },
    worker: false,
    ortOptions: {
      backend: 'wasm',
      numThreads: 1,
      simd: true,
    },
    fetch: sdkFetch(),
  }).then((engine) => {
    engineReadyAt = performance.now();
    return engine;
  });
  enginePromise.set('en', existing);
  void existing.catch(() => enginePromise.delete('en'));
  return existing;
}

/** Runs local OCR once on page pixels or padded bubble crops; source bytes are never modified. */
export async function scanWithLocalOCR(
  bytes: Uint8Array,
  metadata: SourceImageMetadata,
  options: OCRScanOptions = {},
): Promise<OCRScanResult> {
  const cacheKey = createHash('sha256')
    .update(metadata.sha256)
    .update(options.enhanced ? 'enhanced' : 'original')
    .update(JSON.stringify(options.bubbles ?? []))
    .digest('hex');
  const cached = resultCache.get(cacheKey);
  if (cached) {
    resultCache.delete(cacheKey);
    resultCache.set(cacheKey, cached);
    return cached.value;
  }

  let release!: () => void;
  const previous = scanQueue;
  scanQueue = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    const result = await scanUncached(bytes, metadata, options);
    cacheResult(cacheKey, result);
    return result;
  } finally {
    release();
  }
}

async function scanUncached(
  bytes: Uint8Array,
  metadata: SourceImageMetadata,
  options: OCRScanOptions,
): Promise<OCRScanResult> {
  if (!bytes.byteLength) throw new Error('The comic image is empty.');
  if (metadata.dimensions.width * metadata.dimensions.height > MAX_IMAGE_PIXELS)
    throw new Error('Comic pages must be at most 40 megapixels for local OCR.');
  const imageSpace = createImageSpace(
    options.coordinateSpaceId ?? `image:${metadata.id}`,
    metadata.dimensions.width,
    metadata.dimensions.height,
  );
  const initStarted = performance.now();
  const engine = await getEngine();
  const initializationMs =
    engineReadyAt - engineStartedAt || performance.now() - initStarted;
  const totalStarted = performance.now();
  const candidates = (options.bubbles ?? [])
    .filter((bubble) => bubble.reviewStatus !== 'rejected')
    .sort(
      (a, b) =>
        Math.min(...a.polygon.map((point) => point.y)) -
          Math.min(...(b.polygon.map((point) => point.y) || 0)) ||
        Math.min(...a.polygon.map((point) => point.x)) -
          Math.min(...(b.polygon.map((point) => point.x) || 0)),
    );
  const crops = candidates.length
    ? await makeBubbleCrops(
        bytes,
        metadata,
        candidates,
        Boolean(options.enhanced),
      )
    : [await makePageRaster(bytes, metadata, Boolean(options.enhanced))];
  const results = (await engine.predict(
    crops.map(
      (crop) =>
        new ServerImageData(
          crop.raster.data,
          crop.raster.width,
          crop.raster.height,
        ),
    ),
    {
      textDetLimitSideLen: 1600,
      textDetLimitType: 'max',
      textRecScoreThresh: 0.2,
    },
  )) as readonly RecognitionResult[];
  if (results.length !== crops.length)
    throw new Error(
      'PaddleOCR returned an incomplete result batch. Retry local OCR.',
    );

  const blocks: OCRBlock[] = [];
  let detectionMs = 0;
  let recognitionMs = 0;
  let modelTotalMs = 0;
  for (const [cropIndex, result] of results.entries()) {
    const crop = crops[cropIndex]!;
    detectionMs += result.metrics.detMs ?? 0;
    recognitionMs += result.metrics.recMs ?? 0;
    modelTotalMs += result.metrics.totalMs ?? 0;
    if (
      result.image.width !== crop.raster.width ||
      result.image.height !== crop.raster.height
    )
      throw new Error(
        'OCR returned geometry for a different raster size; results were rejected.',
      );
    const lines = result.items
      .flatMap((item, itemIndex) => {
        if (!item.text.trim() || !Number.isFinite(item.score)) return [];
        const validPoints = item.poly.filter(
          (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
        );
        if (validPoints.length < 3) return [];
        const left = Math.min(...validPoints.map((point) => point[0]));
        const top = Math.min(...validPoints.map((point) => point[1]));
        const right = Math.max(...validPoints.map((point) => point[0]));
        const bottom = Math.max(...validPoints.map((point) => point[1]));
        const boundingBox: Bounds<ImageSpace> = {
          x: clamp(
            crop.origin.x + left / crop.scale,
            -0.5,
            imageSpace.dimensions.width - 0.5,
          ),
          y: clamp(
            crop.origin.y + top / crop.scale,
            -0.5,
            imageSpace.dimensions.height - 0.5,
          ),
          width: 0,
          height: 0,
          coordinateSpace: imageSpace,
        };
        const box: Bounds<ImageSpace> = {
          ...boundingBox,
          width: clamp(
            (right - left) / crop.scale,
            0,
            imageSpace.dimensions.width - 0.5 - boundingBox.x,
          ),
          height: clamp(
            (bottom - top) / crop.scale,
            0,
            imageSpace.dimensions.height - 0.5 - boundingBox.y,
          ),
        };
        if (box.width < 0.5 || box.height < 0.5) return [];
        const id = `paddle-${crop.id}-line-${itemIndex + 1}`;
        const text = item.text.trim();
        const confidence = clamp(item.score, 0, 1);
        const word: OCRWord = {
          id: `${id}-word-1`,
          text,
          confidence,
          boundingBox: box,
          coordinateSpace: imageSpace,
        };
        const line: OCRLine = {
          id,
          text,
          confidence,
          boundingBox: box,
          coordinateSpace: imageSpace,
          words: [word],
        };
        return [line];
      })
      .sort(
        (a, b) =>
          a.boundingBox.y - b.boundingBox.y ||
          a.boundingBox.x - b.boundingBox.x,
      );
    if (!lines.length) continue;
    const box = unionBounds(
      lines.map((line) => line.boundingBox),
      imageSpace,
    );
    const text = lines.map((line) => line.text).join('\n');
    blocks.push({
      id: `paddle-${crop.id}-block`,
      text,
      boundingBox: box,
      confidence:
        lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length,
      coordinateSpace: imageSpace,
      lines,
    });
  }
  const lines = blocks.flatMap((block) => block.lines);
  const confidence = lines.length
    ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
    : 0;
  const bounds = lines.length
    ? unionBounds(
        lines.map((line) => line.boundingBox),
        imageSpace,
      )
    : fullBounds(imageSpace);
  const document: OCRDocument = {
    id: `paddleocr:${metadata.sha256.slice(0, 24)}:${options.enhanced ? 'enhanced' : 'original'}`,
    text: blocks.map((block) => block.text).join('\n\n'),
    boundingBox: bounds,
    confidence,
    coordinateSpace: imageSpace,
    blocks,
    revision: 1,
    reviewStatus: 'pending-review',
    provenance: {
      source: OCR_PROVIDER,
      version: OCR_VERSION,
      inputHashes: [metadata.sha256],
    },
  };
  return {
    document,
    preprocessing: options.enhanced ? 'enhanced' : 'original',
    metrics: {
      initializationMs,
      detectionMs,
      recognitionMs,
      totalMs: Math.max(modelTotalMs, performance.now() - totalStarted),
      detectedTextRegions: lines.length,
      averageConfidence: confidence,
    },
  };
}

async function makePageRaster(
  bytes: Uint8Array,
  metadata: SourceImageMetadata,
  enhanced: boolean,
): Promise<Crop> {
  const { data, info } = await sharp(bytes, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== metadata.dimensions.width ||
    info.height !== metadata.dimensions.height
  )
    throw new Error(
      'Decoded OCR page dimensions do not match the source image metadata.',
    );
  const source: Raster = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
  let raster = source;
  if (enhanced) {
    const scale =
      Math.max(source.width, source.height) < 1150
        ? Math.min(2.5, 1150 / Math.max(source.width, source.height))
        : 1;
    raster = await resizeOCRPixels(source, scale, PAGE_MAX_SIDE);
    raster = (
      await preprocessOCRPixels(raster, {
        grayscale: true,
        contrast: 1.08,
        invert: 'auto',
        adaptiveThreshold: true,
      })
    ).image;
  }
  return {
    id: 'page',
    origin: { x: 0, y: 0 },
    scale: raster.width / source.width,
    raster,
  };
}

async function makeBubbleCrops(
  bytes: Uint8Array,
  metadata: SourceImageMetadata,
  bubbles: readonly OCRBubbleInput[],
  enhanced: boolean,
): Promise<Crop[]> {
  const out: Crop[] = [];
  for (const bubble of bubbles) {
    if (bubble.polygon.length < 3) continue;
    const bounds = polygonBounds(
      bubble.polygon,
      metadata.dimensions.width,
      metadata.dimensions.height,
    );
    const padding = clamp(bubble.cropPadding ?? 0.06, 0.02, 0.24);
    const padX = Math.max(8, bounds.width * padding);
    const padY = Math.max(8, bounds.height * padding);
    const left = Math.max(0, Math.floor(bounds.x - padX));
    const top = Math.max(0, Math.floor(bounds.y - padY));
    const right = Math.min(
      metadata.dimensions.width,
      Math.ceil(bounds.x + bounds.width + padX),
    );
    const bottom = Math.min(
      metadata.dimensions.height,
      Math.ceil(bounds.y + bounds.height + padY),
    );
    const width = right - left;
    const height = bottom - top;
    if (width < 8 || height < 8) continue;
    const svgPoints = bubble.polygon
      .map((point) => `${point.x - left},${point.y - top}`)
      .join(' ');
    const mask = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><polygon points="${svgPoints}" fill="white"/></svg>`,
    );
    const { data, info } = await sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .rotate()
      .extract({ left, top, width, height })
      .ensureAlpha()
      .composite([{ input: mask, blend: 'dest-in' }])
      .flatten({ background: '#fff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const source: Raster = {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    };
    const factor = Math.min(
      3,
      BUBBLE_MAX_SIDE / Math.max(width, height),
      Math.max(1, 620 / Math.max(width, height)),
    );
    let raster =
      factor > 1
        ? await resizeOCRPixels(source, factor, BUBBLE_MAX_SIDE)
        : source;
    if (enhanced) {
      const analysis = analyzeOCRPixels(raster);
      raster = (
        await preprocessOCRPixels(raster, {
          grayscale: true,
          contrast: analysis.luminanceRange < 70 ? 1.16 : 1.08,
          invert: 'auto',
          adaptiveThreshold: true,
        })
      ).image;
    }
    out.push({
      id: safeId(bubble.id),
      origin: { x: left, y: top },
      scale: raster.width / width,
      raster,
    });
  }
  return out;
}

function polygonBounds(
  points: readonly { readonly x: number; readonly y: number }[],
  width: number,
  height: number,
) {
  if (
    points.length > 256 ||
    points.some(
      (point) =>
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < -0.5 ||
        point.y < -0.5 ||
        point.x > width - 0.5 ||
        point.y > height - 0.5,
    )
  )
    throw new Error('Bubble crop geometry is outside the source image.');
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  return {
    x: left,
    y: top,
    width: Math.max(0.5, Math.max(...points.map((point) => point.x)) - left),
    height: Math.max(0.5, Math.max(...points.map((point) => point.y)) - top),
  };
}

function unionBounds(
  bounds: readonly Bounds<ImageSpace>[],
  space: ImageSpace,
): Bounds<ImageSpace> {
  const x = Math.min(...bounds.map((box) => box.x));
  const y = Math.min(...bounds.map((box) => box.y));
  const right = Math.max(...bounds.map((box) => box.x + box.width));
  const bottom = Math.max(...bounds.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y, coordinateSpace: space };
}

function fullBounds(space: ImageSpace): Bounds<ImageSpace> {
  return {
    x: 0,
    y: 0,
    width: Math.max(0.5, space.dimensions.width - 0.5),
    height: Math.max(0.5, space.dimensions.height - 0.5),
    coordinateSpace: space,
  };
}

function cacheResult(key: string, value: OCRScanResult) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  resultCache.set(key, { value, bytes });
  resultCacheBytes += bytes;
  while (resultCacheBytes > RESULT_CACHE_LIMIT) {
    const first = resultCache.keys().next().value as string | undefined;
    if (!first) break;
    resultCacheBytes -= resultCache.get(first)!.bytes;
    resultCache.delete(first);
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'region';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
