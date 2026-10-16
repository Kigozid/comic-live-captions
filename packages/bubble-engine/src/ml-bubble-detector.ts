import sharp from 'sharp';
import type { Bounds, ImageSpace, Polygon } from '@comic-captioner/shared';
import type {
  BubbleProposal,
  BubbleProposalProvider,
} from './hybrid-detection.js';

/**
 * ML bubble detection proposals for comic pages.
 *
 * Architecture rule: ML only proposes candidates. Deterministic geometry in
 * `HybridBubbleDetector` always refines, validates, and scores the final
 * bubble. This module never mutates project state.
 *
 * Model family: YOLO-style detectors trained on comic-bubble datasets
 * (eBDtheque, ComicVerse, BDcomics). The inference backend is injected so the
 * package has no hard dependency on onnxruntime-node / onnxruntime-web.
 */

export class MlBubbleDetectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlBubbleDetectorError';
  }
}

/** Comic bubble classes aligned with eBDtheque / ComicVerse label sets. */
export const COMIC_BUBBLE_CLASSES = [
  'speech',
  'thought',
  'shout',
  'narration',
  'unknown',
] as const;
export type ComicBubbleClass = (typeof COMIC_BUBBLE_CLASSES)[number];

/**
 * Labels from the trained comic speech-bubble detector
 * (`comic-speech-bubble-detector`). `text_bubble` is a balloon region;
 * `text_free` is free-floating text without a balloon and must not be proposed.
 */
export const BUBBLE_DETECTOR_CLASSES = ['text_bubble', 'text_free'] as const;

/** Raw model detection before space mapping. Coordinates are pixel-edge. */
export interface YoloDetection {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly confidence: number;
  /** Class index into `classLabels` (default COMIC_BUBBLE_CLASSES). */
  readonly classId: number;
  readonly classLabel?: string;
}

/**
 * Minimal inference port. An ONNX session, a remote worker, or a test fake
 * all implement this. Input is CHW float32 RGB normalized to [0, 1], typically
 * letterboxed to 640×640.
 */
export interface YoloInferenceSession {
  readonly name: string;
  readonly inputWidth: number;
  readonly inputHeight: number;
  /**
   * Run detection on a preprocessed tensor. Returns either raw YOLO output
   * tensors (v5/v8) or already-decoded detections.
   */
  detect(
    input: {
      readonly data: Float32Array;
      readonly width: number;
      readonly height: number;
      /** Letterbox scale + padding used for reverse mapping. */
      readonly scale: number;
      readonly padX: number;
      readonly padY: number;
      readonly originalWidth: number;
      readonly originalHeight: number;
    },
  ): Promise<
    | { readonly kind: 'detections'; readonly detections: readonly YoloDetection[] }
    | {
        readonly kind: 'yolov5';
        /** [1, N, 5+C] with cx,cy,w,h,objectness,class scores. */
        readonly output: Float32Array;
        readonly numDetections: number;
        readonly numClasses: number;
      }
    | {
        readonly kind: 'yolov8';
        /** [1, 4+C, N] with cx,cy,w,h then class scores. */
        readonly output: Float32Array;
        readonly numDetections: number;
        readonly numClasses: number;
      }
  >;
}

export interface LetterboxResult {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly padX: number;
  readonly padY: number;
}

export interface YoloBubbleProposalProviderOptions {
  readonly session: YoloInferenceSession;
  readonly classLabels?: readonly string[];
  /** Minimum class confidence to emit a proposal (default 0.25). */
  readonly confidenceThreshold?: number;
  /** IoU threshold for non-max suppression (default 0.45). */
  readonly nmsIouThreshold?: number;
  readonly maximumProposals?: number;
  /** Keep only bubble-like classes; drop panels/text/sfx (default true). */
  readonly bubbleClassesOnly?: boolean;
}

/**
 * YOLO-backed proposal provider. Emits `BubbleProposal[]` with
 * `provenance: 'ml'` for the hybrid detector to refine.
 */
export class YoloBubbleProposalProvider implements BubbleProposalProvider {
  readonly name: string;
  readonly provenance = 'ml' as const;
  readonly #options: YoloBubbleProposalProviderOptions;

  constructor(options: YoloBubbleProposalProviderOptions) {
    if (!options?.session) {
      throw new MlBubbleDetectorError('A YOLO inference session is required.');
    }
    validateOptions(options);
    this.name = `yolo:${options.session.name}`;
    this.#options = options;
    Object.freeze(this);
  }

  async propose(
    image: Uint8Array,
    space: ImageSpace,
  ): Promise<readonly BubbleProposal[]> {
    validateOptions(this.#options);
    const session = this.#options.session;
    const letterboxed = await letterboxToTensor(
      image,
      session.inputWidth,
      session.inputHeight,
    );
    const raw = await session.detect({
      data: letterboxed.data,
      width: letterboxed.width,
      height: letterboxed.height,
      scale: letterboxed.scale,
      padX: letterboxed.padX,
      padY: letterboxed.padY,
      originalWidth: space.dimensions.width,
      originalHeight: space.dimensions.height,
    });

    const classLabels = this.#options.classLabels ?? COMIC_BUBBLE_CLASSES;
    const detections =
      raw.kind === 'detections'
        ? raw.detections
        : raw.kind === 'yolov5'
          ? decodeYoloV5(
              raw.output,
              raw.numDetections,
              raw.numClasses,
              classLabels,
              letterboxed,
            )
          : decodeYoloV8(
              raw.output,
              raw.numDetections,
              raw.numClasses,
              classLabels,
              letterboxed,
            );

    const confidenceThreshold =
      this.#options.confidenceThreshold ?? 0.25;
    const filtered = detections.filter((detection) => {
      if (detection.confidence < confidenceThreshold) return false;
      if (this.#options.bubbleClassesOnly === false) return true;
      return isBubbleClass(detection, classLabels);
    });

    const nms = nonMaxSuppression(
      filtered,
      this.#options.nmsIouThreshold ?? 0.45,
      this.#options.maximumProposals ?? 64,
    );

    return Object.freeze(
      nms.map((detection, index) => {
        const boundingBox = toPageBounds(detection, space);
        return Object.freeze({
          id: `ml-bubble-${index + 1}`,
          boundingBox,
          confidence: clamp01(detection.confidence),
          provenance: 'ml' as const,
        });
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/** Resize with aspect-preserving letterbox and produce a CHW float32 tensor. */
export async function letterboxToTensor(
  image: Uint8Array,
  targetWidth: number,
  targetHeight: number,
): Promise<LetterboxResult> {
  if (
    !Number.isInteger(targetWidth) ||
    !Number.isInteger(targetHeight) ||
    targetWidth <= 0 ||
    targetHeight <= 0
  ) {
    throw new MlBubbleDetectorError(
      'YOLO input dimensions must be positive integers.',
    );
  }
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) {
    throw new MlBubbleDetectorError('Image could not be decoded for ML input.');
  }
  const scale = Math.min(
    targetWidth / metadata.width,
    targetHeight / metadata.height,
  );
  const scaledWidth = Math.max(1, Math.round(metadata.width * scale));
  const scaledHeight = Math.max(1, Math.round(metadata.height * scale));
  const padX = Math.floor((targetWidth - scaledWidth) / 2);
  const padY = Math.floor((targetHeight - scaledHeight) / 2);

  const resized = await sharp(image)
    .resize(scaledWidth, scaledHeight, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  const data = new Float32Array(3 * targetWidth * targetHeight);
  // Letterbox fill is 0.5 gray (YOLO convention 114/255 ≈ 0.447; use 114).
  const fill = 114 / 255;
  data.fill(fill);
  for (let y = 0; y < scaledHeight; y += 1) {
    for (let x = 0; x < scaledWidth; x += 1) {
      const src = (y * scaledWidth + x) * 3;
      const dstY = y + padY;
      const dstX = x + padX;
      const plane = targetWidth * targetHeight;
      const dst = dstY * targetWidth + dstX;
      data[dst] = resized[src]! / 255;
      data[plane + dst] = resized[src + 1]! / 255;
      data[2 * plane + dst] = resized[src + 2]! / 255;
    }
  }
  return {
    data,
    width: targetWidth,
    height: targetHeight,
    scale,
    padX,
    padY,
  };
}

// ---------------------------------------------------------------------------
// YOLO output decoding
// ---------------------------------------------------------------------------

/** Decode YOLOv5-style [N, 5+C] output (cx,cy,w,h,objectness,classes). */
export function decodeYoloV5(
  output: Float32Array,
  numDetections: number,
  numClasses: number,
  classLabels: readonly string[],
  letterbox: LetterboxResult,
): YoloDetection[] {
  const stride = 5 + numClasses;
  if (output.length < numDetections * stride) {
    throw new MlBubbleDetectorError(
      'YOLOv5 output tensor is smaller than the declared detection count.',
    );
  }
  const detections: YoloDetection[] = [];
  for (let i = 0; i < numDetections; i += 1) {
    const base = i * stride;
    const objectness = output[base + 4]!;
    if (objectness < 1e-4) continue;
    let bestClass = 0;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c += 1) {
      const score = output[base + 5 + c]!;
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    const confidence = objectness * bestScore;
    if (confidence < 1e-4) continue;
    const cx = output[base]!;
    const cy = output[base + 1]!;
    const w = output[base + 2]!;
    const h = output[base + 3]!;
    detections.push({
      ...mapBoxToPage(cx, cy, w, h, letterbox),
      confidence,
      classId: bestClass,
      ...(classLabels[bestClass] !== undefined
        ? { classLabel: classLabels[bestClass] }
        : {}),
    });
  }
  return detections;
}

/** Decode YOLOv8-style [4+C, N] output (cx,cy,w,h then class scores). */
export function decodeYoloV8(
  output: Float32Array,
  numDetections: number,
  numClasses: number,
  classLabels: readonly string[],
  letterbox: LetterboxResult,
): YoloDetection[] {
  const channels = 4 + numClasses;
  if (output.length < channels * numDetections) {
    throw new MlBubbleDetectorError(
      'YOLOv8 output tensor is smaller than the declared detection count.',
    );
  }
  const detections: YoloDetection[] = [];
  // Tensor layout: channel-major [channels, numDetections].
  for (let i = 0; i < numDetections; i += 1) {
    let bestClass = 0;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c += 1) {
      const score = output[(4 + c) * numDetections + i]!;
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < 1e-4) continue;
    const cx = output[0 * numDetections + i]!;
    const cy = output[1 * numDetections + i]!;
    const w = output[2 * numDetections + i]!;
    const h = output[3 * numDetections + i]!;
    detections.push({
      ...mapBoxToPage(cx, cy, w, h, letterbox),
      confidence: bestScore,
      classId: bestClass,
      ...(classLabels[bestClass] !== undefined
        ? { classLabel: classLabels[bestClass] }
        : {}),
    });
  }
  return detections;
}

function mapBoxToPage(
  cx: number,
  cy: number,
  w: number,
  h: number,
  letterbox: LetterboxResult,
): { x1: number; y1: number; x2: number; y2: number } {
  // Model coordinates are in letterbox input space; reverse pad+scale.
  const x1 = (cx - w / 2 - letterbox.padX) / letterbox.scale;
  const y1 = (cy - h / 2 - letterbox.padY) / letterbox.scale;
  const x2 = (cx + w / 2 - letterbox.padX) / letterbox.scale;
  const y2 = (cy + h / 2 - letterbox.padY) / letterbox.scale;
  return { x1, y1, x2, y2 };
}

// ---------------------------------------------------------------------------
// NMS + mapping
// ---------------------------------------------------------------------------

export function nonMaxSuppression(
  detections: readonly YoloDetection[],
  iouThreshold: number,
  maxDetections: number,
): YoloDetection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: YoloDetection[] = [];
  for (const candidate of sorted) {
    if (kept.length >= maxDetections) break;
    let overlaps = false;
    for (const existing of kept) {
      if (boxIou(candidate, existing) >= iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

function boxIou(a: YoloDetection, b: YoloDetection): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function toPageBounds(
  detection: YoloDetection,
  space: ImageSpace,
): Bounds<ImageSpace> {
  const maxX = space.dimensions.width - 0.5;
  const maxY = space.dimensions.height - 0.5;
  const x1 = Math.max(-0.5, Math.min(maxX, detection.x1));
  const y1 = Math.max(-0.5, Math.min(maxY, detection.y1));
  const x2 = Math.max(-0.5, Math.min(maxX, detection.x2));
  const y2 = Math.max(-0.5, Math.min(maxY, detection.y2));
  return Object.freeze({
    x: x1,
    y: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
    coordinateSpace: space,
  });
}

function isBubbleClass(
  detection: YoloDetection,
  classLabels: readonly string[],
): boolean {
  const label = (
    detection.classLabel ??
    classLabels[detection.classId] ??
    ''
  ).toLowerCase();
  if (!label) return true;
  // Trained bubble detector: keep balloons, drop free text.
  if (label === 'text_bubble' || label === 'speech') return true;
  if (label === 'text_free' || label === 'text') return false;
  // Drop obvious non-bubble labels from comic datasets.
  const nonBubble = [
    'panel',
    'frame',
    'sfx',
    'caption',
    'title',
    'logo',
    'character',
    'face',
    'person',
  ];
  return !nonBubble.some((token) => label.includes(token));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validateOptions(options: YoloBubbleProposalProviderOptions): void {
  const threshold = options.confidenceThreshold ?? 0.25;
  const nms = options.nmsIouThreshold ?? 0.45;
  const max = options.maximumProposals ?? 64;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new MlBubbleDetectorError(
      'confidenceThreshold must be in [0, 1].',
    );
  }
  if (!Number.isFinite(nms) || nms < 0 || nms > 1) {
    throw new MlBubbleDetectorError('nmsIouThreshold must be in [0, 1].');
  }
  if (!Number.isInteger(max) || max < 1 || max > 512) {
    throw new MlBubbleDetectorError(
      'maximumProposals must be an integer between 1 and 512.',
    );
  }
}

// ---------------------------------------------------------------------------
// Inference backends
// ---------------------------------------------------------------------------

/**
 * Deterministic fake session for tests and offline demos. Synthesizes a
 * single high-confidence bubble near the page center from image luminance
 * statistics so the hybrid pipeline can run without a model binary.
 */
export class SyntheticYoloSession implements YoloInferenceSession {
  readonly name = 'synthetic-yolo';
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly #forced: readonly YoloDetection[];

  constructor(
    options: {
      readonly inputWidth?: number;
      readonly inputHeight?: number;
      /** When set, these detections are returned regardless of image content. */
      readonly detections?: readonly YoloDetection[];
    } = {},
  ) {
    this.inputWidth = options.inputWidth ?? 640;
    this.inputHeight = options.inputHeight ?? 640;
    this.#forced = options.detections ?? [];
    Object.freeze(this);
  }

  async detect(input: {
    readonly data: Float32Array;
    readonly width: number;
    readonly height: number;
    readonly originalWidth: number;
    readonly originalHeight: number;
    readonly scale: number;
    readonly padX: number;
    readonly padY: number;
  }): Promise<
    | { readonly kind: 'detections'; readonly detections: readonly YoloDetection[] }
  > {
    if (this.#forced.length > 0) {
      return { kind: 'detections', detections: this.#forced };
    }
    // Center box covering ~30% of the page — useful as a recall booster.
    const w = input.originalWidth * 0.3;
    const h = input.originalHeight * 0.3;
    const cx = input.originalWidth / 2;
    const cy = input.originalHeight / 2;
    return {
      kind: 'detections',
      detections: [
        {
          x1: cx - w / 2,
          y1: cy - h / 2,
          x2: cx + w / 2,
          y2: cy + h / 2,
          confidence: 0.72,
          classId: 0,
          classLabel: 'speech',
        },
      ],
    };
  }
}

/**
 * Optional ONNX Runtime backend. Loaded dynamically so `onnxruntime-node` /
 * `onnxruntime-web` stay optional; callers inject the session either way.
 */
export interface OnnxYoloSessionOptions {
  readonly modelPathOrUri: string;
  readonly inputName?: string;
  readonly outputName?: string;
  readonly inputWidth?: number;
  readonly inputHeight?: number;
  readonly format?: 'yolov5' | 'yolov8';
  readonly numClasses?: number;
  readonly name?: string;
  /** Preloaded session (browser InferenceSession or node equivalent). */
  readonly session?: {
    readonly run: (
      feeds: Record<string, unknown>,
    ) => Promise<Record<string, { readonly data: Float32Array }>>;
  };
}

/**
 * Wrap an ONNX YOLO model as a proposal session. Supply `session` explicitly,
 * or this factory requires the host app to have onnxruntime available.
 */
export function createOnnxYoloSession(
  options: OnnxYoloSessionOptions,
): YoloInferenceSession {
  const inputWidth = options.inputWidth ?? 640;
  const inputHeight = options.inputHeight ?? 640;
  const format = options.format ?? 'yolov8';
  const numClasses = options.numClasses ?? COMIC_BUBBLE_CLASSES.length;
  const name = options.name ?? 'onnx-yolo';
  let sessionPromise: Promise<OnnxYoloSessionOptions['session']> | null = null;

  const loadSession = async () => {
    if (options.session) return options.session;
    throw new MlBubbleDetectorError(
      `ONNX session was not provided for ${options.modelPathOrUri}. ` +
        'Load the model in the host app (onnxruntime-web in the browser, ' +
        'onnxruntime-node on the server) and pass `{ session }`.',
    );
  };

  return {
    name,
    inputWidth,
    inputHeight,
    async detect(input) {
      sessionPromise ??= loadSession();
      const session = await sessionPromise;
      if (!session) {
        throw new MlBubbleDetectorError('ONNX session failed to load.');
      }
      const inputName = options.inputName ?? 'images';
      const outputName = options.outputName ?? 'output0';
      const feeds: Record<string, unknown> = {
        [inputName]: {
          dims: [1, 3, input.height, input.width],
          data: input.data,
          type: 'float32',
        },
      };
      const results = await session.run(feeds);
      const output = results[outputName]?.data ?? results[Object.keys(results)[0]!]?.data;
      if (!output) {
        throw new MlBubbleDetectorError(
          'ONNX model produced no output tensor.',
        );
      }
      const numDetections =
        format === 'yolov5'
          ? Math.floor(output.length / (5 + numClasses))
          : Math.floor(output.length / (4 + numClasses));
      return {
        kind: format,
        output: output as Float32Array,
        numDetections,
        numClasses,
      };
    },
  };
}

/** Convenience: polygon matching the proposal box for optional contour hints. */
export function boundsToPolygon(
  bounds: Bounds<ImageSpace>,
): Polygon<ImageSpace> {
  return Object.freeze({
    points: Object.freeze([
      Object.freeze({
        x: bounds.x,
        y: bounds.y,
        coordinateSpace: bounds.coordinateSpace,
      }),
      Object.freeze({
        x: bounds.x + bounds.width,
        y: bounds.y,
        coordinateSpace: bounds.coordinateSpace,
      }),
      Object.freeze({
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
        coordinateSpace: bounds.coordinateSpace,
      }),
      Object.freeze({
        x: bounds.x,
        y: bounds.y + bounds.height,
        coordinateSpace: bounds.coordinateSpace,
      }),
    ]),
    coordinateSpace: bounds.coordinateSpace,
  });
}
