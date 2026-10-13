import sharp from 'sharp';
import {
  createImageSpace,
  type AffineMatrix,
  type AlignmentParameters,
  type AlignmentResult,
  type ImageSpace,
} from '@comic-captioner/shared';
import type { ImmutableSourceImage } from './index.js';

const ANALYSIS_SIZE = 80;
const SEARCH_STEP = 2;
const MAX_ANALYSIS_PIXELS = ANALYSIS_SIZE * ANALYSIS_SIZE;
const MAX_VISUALIZATION_SIDE = 2048;

interface Raster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sourceToAnalysisScale: number;
  readonly sourceToAnalysisX: number;
  readonly sourceToAnalysisY: number;
}

interface Candidate {
  readonly scale: number;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/** Estimates a deterministic cleaned-image-to-original-image similarity transform. */
export class ImageAlignmentEngine {
  async align(
    original: ImmutableSourceImage,
    cleaned: ImmutableSourceImage,
  ): Promise<AlignmentResult> {
    const originalSpace = imageSpaceFor(original);
    const cleanedSpace = imageSpaceFor(cleaned);
    const targetRatio =
      originalSpace.dimensions.width / originalSpace.dimensions.height;
    const sourceRatio =
      cleanedSpace.dimensions.width / cleanedSpace.dimensions.height;
    if (
      Math.abs(targetRatio - sourceRatio) >
      Math.max(targetRatio, sourceRatio) * 0.015
    ) {
      throw new AlignmentError(
        'These image aspect ratios cannot be represented by a uniform-scale alignment.',
      );
    }
    const [originalRaster, cleanedRaster] = await Promise.all([
      analysisRaster(original.getBytes(), originalSpace),
      analysisRaster(cleaned.getBytes(), cleanedSpace),
    ]);

    let best: Candidate | undefined;
    const translations = translationCandidates(ANALYSIS_SIZE);
    for (let scaleIndex = -6; scaleIndex <= 6; scaleIndex += 1) {
      const scale = 1 + scaleIndex * 0.01;
      for (let rotationIndex = -6; rotationIndex <= 6; rotationIndex += 1) {
        const rotation = (rotationIndex * Math.PI) / 180;
        for (const y of translations) {
          for (const x of translations) {
            const score = correlationScore(
              originalRaster,
              cleanedRaster,
              scale,
              rotation,
              x,
              y,
              SEARCH_STEP,
            );
            if (!best || score > best.score) {
              best = { scale, rotation, x, y, score };
            }
          }
        }
      }
    }
    if (!best || best.score < -0.5) {
      throw new AlignmentError(
        'Images do not contain enough matching visual information.',
      );
    }

    // Refine translation around the coarse winner to one analysis pixel.
    const coarse = best;
    for (let y = coarse.y - 3; y <= coarse.y + 3; y += 1) {
      for (let x = coarse.x - 3; x <= coarse.x + 3; x += 1) {
        const score = correlationScore(
          originalRaster,
          cleanedRaster,
          coarse.scale,
          coarse.rotation,
          x,
          y,
          1,
        );
        if (score > best.score) best = { ...coarse, x, y, score };
      }
    }
    return buildResult(originalSpace, cleanedSpace, {
      scale: best.scale,
      rotation: best.rotation,
      x: best.x,
      y: best.y,
      confidence: confidenceFromCorrelation(best.score),
      originalRaster,
      cleanedRaster,
      method: 'automatic',
    });
  }
}

export class AlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignmentError';
  }
}

/** Creates a new immutable result from a user-supplied cleaned-to-original transform. */
export function applyManualAlignment(
  current: AlignmentResult,
  parameters: AlignmentParameters,
): AlignmentResult {
  validateParameters(parameters);
  const scale = parameters.scale;
  const rotation = parameters.rotation;
  const translation = Object.freeze({
    x: parameters.translationX,
    y: parameters.translationY,
    coordinateSpace: current.targetSpace,
  });
  return Object.freeze({
    ...current,
    scale,
    rotation,
    translation,
    confidence: 1,
    transformMatrix: Object.freeze({
      values: Object.freeze(
        similarityMatrix(scale, rotation, translation.x, translation.y),
      ),
    }),
    method: 'manual',
  });
}

/** Renders a 50% overlay and absolute grayscale difference in original pixel space. */
export async function renderAlignmentVisualizations(
  originalBytes: Uint8Array,
  cleanedBytes: Uint8Array,
  result: AlignmentResult,
): Promise<{ readonly overlayPng: Buffer; readonly differencePng: Buffer }> {
  const outputScale = Math.min(
    1,
    MAX_VISUALIZATION_SIDE / result.targetSpace.dimensions.width,
    MAX_VISUALIZATION_SIDE / result.targetSpace.dimensions.height,
  );
  const width = Math.max(
    1,
    Math.round(result.targetSpace.dimensions.width * outputScale),
  );
  const height = Math.max(
    1,
    Math.round(result.targetSpace.dimensions.height * outputScale),
  );
  const sourceWidth = Math.max(
    1,
    Math.round(result.sourceSpace.dimensions.width * outputScale),
  );
  const sourceHeight = Math.max(
    1,
    Math.round(result.sourceSpace.dimensions.height * outputScale),
  );
  const [original, cleaned] = await Promise.all([
    decodeRgba(originalBytes, width, height, true),
    decodeRgba(cleanedBytes, sourceWidth, sourceHeight, true),
  ]);
  const aligned = warpRgba(
    cleaned,
    sourceWidth,
    sourceHeight,
    width,
    height,
    scaleOutputTranslation(result.transformMatrix, outputScale),
  );
  const overlay = Buffer.alloc(width * height * 3);
  const difference = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const rgbOffset = pixel * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      overlay[rgbOffset + channel] = Math.round(
        original[offset + channel]! * 0.5 + aligned[offset + channel]! * 0.5,
      );
    }
    difference[pixel] = Math.round(
      (Math.abs(original[offset]! - aligned[offset]!) +
        Math.abs(original[offset + 1]! - aligned[offset + 1]!) +
        Math.abs(original[offset + 2]! - aligned[offset + 2]!)) /
        3,
    );
  }
  const [overlayPng, differencePng] = await Promise.all([
    sharp(overlay, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
    sharp(difference, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer(),
  ]);
  return { overlayPng, differencePng };
}

/** Warps cleaned pixels into original page space, bounded for downstream analysis. */
export async function renderAlignedCleanedImage(
  cleanedBytes: Uint8Array,
  result: AlignmentResult,
  maximumSide = 1600,
): Promise<Buffer> {
  const targetWidth = result.targetSpace.dimensions.width;
  const targetHeight = result.targetSpace.dimensions.height;
  const outputScale = Math.min(
    1,
    maximumSide / targetWidth,
    maximumSide / targetHeight,
  );
  const width = Math.max(1, Math.round(targetWidth * outputScale));
  const height = Math.max(1, Math.round(targetHeight * outputScale));
  const sourceWidth = Math.max(
    1,
    Math.round(result.sourceSpace.dimensions.width * outputScale),
  );
  const sourceHeight = Math.max(
    1,
    Math.round(result.sourceSpace.dimensions.height * outputScale),
  );
  const source = await decodeRgba(
    cleanedBytes,
    sourceWidth,
    sourceHeight,
    true,
  );
  const aligned = warpRgba(
    source,
    sourceWidth,
    sourceHeight,
    width,
    height,
    scaleOutputTranslation(result.transformMatrix, outputScale),
  );
  return sharp(aligned, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

function buildResult(
  targetSpace: ImageSpace,
  sourceSpace: ImageSpace,
  input: {
    readonly scale: number;
    readonly rotation: number;
    readonly x: number;
    readonly y: number;
    readonly confidence: number;
    readonly originalRaster: Raster;
    readonly cleanedRaster: Raster;
    readonly method: AlignmentResult['method'];
  },
): AlignmentResult {
  const cleanAnalysisToOriginalAnalysis = similarityMatrix(
    input.scale,
    input.rotation,
    input.x,
    input.y,
  );
  const sourceToTarget = compose(
    inverseRasterMap(input.originalRaster),
    compose(cleanAnalysisToOriginalAnalysis, rasterMap(input.cleanedRaster)),
  );
  const scaleX = Math.hypot(sourceToTarget[0], sourceToTarget[3]);
  const scaleY = Math.hypot(sourceToTarget[1], sourceToTarget[4]);
  const scale = (scaleX + scaleY) / 2;
  const rotation = Math.atan2(sourceToTarget[3], sourceToTarget[0]);
  const translation = Object.freeze({
    x: sourceToTarget[2],
    y: sourceToTarget[5],
    coordinateSpace: targetSpace,
  });
  return Object.freeze({
    sourceSpace,
    targetSpace,
    scale,
    rotation,
    translation,
    confidence: input.confidence,
    transformMatrix: Object.freeze({ values: Object.freeze(sourceToTarget) }),
    method: input.method,
    algorithmVersion: 'gray-ncc-grid-v1',
  });
}

function imageSpaceFor(image: ImmutableSourceImage): ImageSpace {
  return createImageSpace(
    `image:${image.metadata.id}`,
    image.metadata.dimensions.width,
    image.metadata.dimensions.height,
  );
}

async function analysisRaster(
  bytes: Uint8Array,
  space: ImageSpace,
): Promise<Raster> {
  const scale = Math.min(
    ANALYSIS_SIZE / space.dimensions.width,
    ANALYSIS_SIZE / space.dimensions.height,
  );
  const renderedWidth = space.dimensions.width * scale;
  const renderedHeight = space.dimensions.height * scale;
  const edgeOffsetX = (ANALYSIS_SIZE - renderedWidth) / 2;
  const edgeOffsetY = (ANALYSIS_SIZE - renderedHeight) / 2;
  const data = await sharp(bytes)
    .rotate()
    .greyscale()
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .raw()
    .toBuffer();
  return {
    data,
    width: ANALYSIS_SIZE,
    height: ANALYSIS_SIZE,
    sourceToAnalysisScale: scale,
    sourceToAnalysisX: edgeOffsetX + (scale - 1) / 2,
    sourceToAnalysisY: edgeOffsetY + (scale - 1) / 2,
  };
}

function translationCandidates(size: number): number[] {
  const limit = Math.round(size * 0.08);
  const values: number[] = [];
  for (let value = -limit; value <= limit; value += 4) values.push(value);
  if (!values.includes(limit)) values.push(limit);
  if (!values.includes(0)) values.push(0);
  return values.sort((a, b) => a - b);
}

function correlationScore(
  target: Raster,
  source: Raster,
  scale: number,
  rotation: number,
  translationX: number,
  translationY: number,
  sampleStep: number,
): number {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const centerX = (target.width - 1) / 2;
  const centerY = (target.height - 1) / 2;
  const tx =
    centerX + translationX - scale * (cosine * centerX - sine * centerY);
  const ty =
    centerY + translationY - scale * (sine * centerX + cosine * centerY);
  let sumTarget = 0;
  let sumSource = 0;
  let sumTargetSq = 0;
  let sumSourceSq = 0;
  let sumProduct = 0;
  let sumTargetGray = 0;
  let sumSourceGray = 0;
  let sumTargetGraySq = 0;
  let sumSourceGraySq = 0;
  let sumGrayProduct = 0;
  let count = 0;
  for (let y = 1; y < target.height - 1; y += sampleStep) {
    for (let x = 1; x < target.width - 1; x += sampleStep) {
      const dx = x - tx;
      const dy = y - ty;
      const sourceX = (cosine * dx + sine * dy) / scale;
      const sourceY = (-sine * dx + cosine * dy) / scale;
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= source.width ||
        sourceY >= source.height
      )
        continue;
      const targetValue = gradientAt(target, x, y);
      const sourceValue = gradientSample(source, sourceX, sourceY);
      const targetGray = target.data[y * target.width + x]!;
      const sourceGray = sampleGray(source, sourceX, sourceY);
      sumTarget += targetValue;
      sumSource += sourceValue;
      sumTargetSq += targetValue * targetValue;
      sumSourceSq += sourceValue * sourceValue;
      sumProduct += targetValue * sourceValue;
      sumTargetGray += targetGray;
      sumSourceGray += sourceGray;
      sumTargetGraySq += targetGray * targetGray;
      sumSourceGraySq += sourceGray * sourceGray;
      sumGrayProduct += targetGray * sourceGray;
      count += 1;
    }
  }
  if (count < MAX_ANALYSIS_PIXELS * 0.08) return -1;
  const covariance = sumProduct - (sumTarget * sumSource) / count;
  const targetVariance = sumTargetSq - (sumTarget * sumTarget) / count;
  const sourceVariance = sumSourceSq - (sumSource * sumSource) / count;
  if (targetVariance <= 0 || sourceVariance <= 0) return -1;
  const gradientCorrelation =
    covariance / Math.sqrt(targetVariance * sourceVariance);
  const grayCovariance =
    sumGrayProduct - (sumTargetGray * sumSourceGray) / count;
  const targetGrayVariance =
    sumTargetGraySq - (sumTargetGray * sumTargetGray) / count;
  const sourceGrayVariance =
    sumSourceGraySq - (sumSourceGray * sumSourceGray) / count;
  const grayCorrelation =
    targetGrayVariance > 0 && sourceGrayVariance > 0
      ? grayCovariance / Math.sqrt(targetGrayVariance * sourceGrayVariance)
      : gradientCorrelation;
  return gradientCorrelation * 0.55 + grayCorrelation * 0.45;
}

function gradientAt(raster: Raster, x: number, y: number): number {
  const center = raster.data[y * raster.width + x]!;
  const right = raster.data[y * raster.width + x + 1]!;
  const down = raster.data[(y + 1) * raster.width + x]!;
  return Math.abs(center - right) + Math.abs(center - down);
}

function gradientSample(raster: Raster, x: number, y: number): number {
  return (
    Math.abs(sampleGray(raster, x + 1, y) - sampleGray(raster, x, y)) +
    Math.abs(sampleGray(raster, x, y + 1) - sampleGray(raster, x, y))
  );
}

function sampleGray(raster: Raster, x: number, y: number): number {
  x = Math.max(0, Math.min(raster.width - 1, x));
  y = Math.max(0, Math.min(raster.height - 1, y));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(raster.width - 1, x0 + 1);
  const y1 = Math.min(raster.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const top =
    raster.data[y0 * raster.width + x0]! * (1 - fx) +
    raster.data[y0 * raster.width + x1]! * fx;
  const bottom =
    raster.data[y1 * raster.width + x0]! * (1 - fx) +
    raster.data[y1 * raster.width + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

function confidenceFromCorrelation(score: number): number {
  return Math.max(0, Math.min(1, (score - 0.15) / 0.85));
}

function similarityMatrix(
  scale: number,
  rotation: number,
  x: number,
  y: number,
): [number, number, number, number, number, number] {
  const cosine = Math.cos(rotation) * scale;
  const sine = Math.sin(rotation) * scale;
  return [cosine, -sine, x, sine, cosine, y];
}

function scaleOutputTranslation(
  matrix: AffineMatrix,
  scale: number,
): AffineMatrix {
  const [a, b, c, d, e, f] = matrix.values;
  return { values: [a, b, c * scale, d, e, f * scale] };
}

function validateParameters(parameters: AlignmentParameters): void {
  if (
    ![
      parameters.scale,
      parameters.rotation,
      parameters.translationX,
      parameters.translationY,
    ].every(Number.isFinite) ||
    parameters.scale <= 0
  ) {
    throw new AlignmentError(
      'Manual alignment values must be finite and scale must be positive.',
    );
  }
}

function rasterMap(
  raster: Raster,
): [number, number, number, number, number, number] {
  return [
    raster.sourceToAnalysisScale,
    0,
    raster.sourceToAnalysisX,
    0,
    raster.sourceToAnalysisScale,
    raster.sourceToAnalysisY,
  ];
}

function inverseRasterMap(
  raster: Raster,
): [number, number, number, number, number, number] {
  const inverseScale = 1 / raster.sourceToAnalysisScale;
  return [
    inverseScale,
    0,
    -raster.sourceToAnalysisX * inverseScale,
    0,
    inverseScale,
    -raster.sourceToAnalysisY * inverseScale,
  ];
}

function compose(
  a: readonly [number, number, number, number, number, number],
  b: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

async function decodeRgba(
  bytes: Uint8Array,
  width: number,
  height: number,
  rotate: boolean,
): Promise<Buffer> {
  let pipeline = sharp(bytes);
  if (rotate) pipeline = pipeline.rotate();
  return pipeline
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

function warpRgba(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  matrix: AffineMatrix,
): Buffer {
  const output = Buffer.alloc(width * height * 4, 255);
  const [a, b, c, d, e, f] = matrix.values;
  const determinant = a * e - b * d;
  if (Math.abs(determinant) < 1e-12)
    throw new AlignmentError('Transform matrix is not invertible.');
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tx = x - c;
      const ty = y - f;
      const sx = (e * tx - b * ty) / determinant;
      const sy = (-d * tx + a * ty) / determinant;
      if (sx < 0 || sy < 0 || sx > sourceWidth - 1 || sy > sourceHeight - 1)
        continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const y1 = Math.min(sourceHeight - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const outOffset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          source[(y0 * sourceWidth + x0) * 4 + channel]! * (1 - fx) +
          source[(y0 * sourceWidth + x1) * 4 + channel]! * fx;
        const bottom =
          source[(y1 * sourceWidth + x0) * 4 + channel]! * (1 - fx) +
          source[(y1 * sourceWidth + x1) * 4 + channel]! * fx;
        output[outOffset + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return output;
}
