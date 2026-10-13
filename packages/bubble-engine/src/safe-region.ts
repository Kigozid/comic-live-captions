import sharp from 'sharp';
import type { Bubble } from './index.js';
import type {
  AlignmentResult,
  BinaryMask,
  Bounds,
  ImageSpace,
  MaskRun,
  MaskSpace,
  Point,
  Polygon,
} from '@comic-captioner/shared';
import { createMaskSpace } from '@comic-captioner/shared';

export interface CaptionSafeRegion {
  readonly id: string;
  readonly bubbleId: string;
  /** Binary mask is the authoritative placement geometry. */
  readonly mask: BinaryMask;
  readonly coordinateSpace: ImageSpace;
  /** Summary only; caption fitting must use mask pixels, not this rectangle. */
  readonly boundingBox: Bounds<ImageSpace> | null;
  readonly originalTextBounds: Bounds<ImageSpace>;
  readonly preferredAnchor: Point<ImageSpace> | null;
  readonly placementPreserved: boolean;
  readonly internalPaddingPx: number;
  readonly tailExcluded: boolean;
  readonly croppedBubble: boolean;
  readonly status: 'ready' | 'no-safe-area';
  readonly confidence: number;
}

export interface CaptionSafeRegionInput {
  readonly bubble: Bubble;
  readonly originalTextBounds: Bounds<ImageSpace>;
  readonly pageImage: Uint8Array;
  readonly coordinateSpace: ImageSpace;
  readonly alignment?: AlignmentResult;
  readonly internalPaddingPx?: number;
  readonly maximumAnalysisSide?: number;
}

export interface CaptionSafeRegionResult {
  readonly region: CaptionSafeRegion;
  readonly debugPng: Buffer;
}

export class CaptionSafeRegionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionSafeRegionError';
  }
}

const MAX_PIXELS = 40_000_000;
const DEFAULT_ANALYSIS_SIDE = 1400;

/** Derives an inset, tail-free mask suitable for downstream caption fitting. */
export class CaptionSafeRegionEngine {
  async compute(
    input: CaptionSafeRegionInput,
  ): Promise<CaptionSafeRegionResult> {
    const pageMetadata = await sharp(input.pageImage).metadata();
    if (!pageMetadata.width || !pageMetadata.height) {
      throw new CaptionSafeRegionError('The page image is not decodable.');
    }
    const swapsDimensions = [5, 6, 7, 8].includes(
      pageMetadata.orientation ?? 1,
    );
    const pageWidth = swapsDimensions
      ? pageMetadata.height
      : pageMetadata.width;
    const pageHeight = swapsDimensions
      ? pageMetadata.width
      : pageMetadata.height;
    if (pageWidth * pageHeight > MAX_PIXELS) {
      throw new CaptionSafeRegionError('The page image exceeds 40 megapixels.');
    }
    if (
      pageWidth !== input.coordinateSpace.dimensions.width ||
      pageHeight !== input.coordinateSpace.dimensions.height
    ) {
      throw new CaptionSafeRegionError(
        'The page image does not match the declared ImageSpace.',
      );
    }
    validateInput(input);
    const maxSide = input.maximumAnalysisSide ?? DEFAULT_ANALYSIS_SIDE;
    if (!Number.isFinite(maxSide) || maxSide < 128) {
      throw new CaptionSafeRegionError(
        'Maximum analysis side must be at least 128 pixels.',
      );
    }
    const scale = Math.min(1, maxSide / Math.max(pageWidth, pageHeight));
    const width = Math.max(1, Math.round(pageWidth * scale));
    const height = Math.max(1, Math.round(pageHeight * scale));
    const scaleX = pageWidth / width;
    const scaleY = pageHeight / height;
    const maskSpace = createMaskSpace(
      `caption-safe:${input.coordinateSpace.id}:${input.bubble.id}:${width}x${height}`,
      input.coordinateSpace,
      width,
      height,
    );
    const bubbleMask = new Uint8Array(width * height);
    const sourceMaskSpace = input.bubble.mask.coordinateSpace;
    const alignment = input.alignment;
    let minimumBubbleX = Number.POSITIVE_INFINITY;
    let minimumBubbleY = Number.POSITIVE_INFINITY;
    let maximumBubbleX = Number.NEGATIVE_INFINITY;
    let maximumBubbleY = Number.NEGATIVE_INFINITY;
    for (const run of input.bubble.mask.runs) {
      for (let offset = 0; offset < run.length; offset += 1) {
        const maskX = input.bubble.mask.origin.x + run.x + offset;
        const maskY = input.bubble.mask.origin.y + run.y;
        const sourcePoint = {
          x: (maskX + 0.5) * sourceMaskSpace.maskToImageScaleX - 0.5,
          y: (maskY + 0.5) * sourceMaskSpace.maskToImageScaleY - 0.5,
          coordinateSpace: input.bubble.coordinateSpace,
        } satisfies Point<ImageSpace>;
        const targetPoint = alignment
          ? transformPoint(sourcePoint, alignment)
          : sourcePoint;
        minimumBubbleX = Math.min(minimumBubbleX, targetPoint.x);
        minimumBubbleY = Math.min(minimumBubbleY, targetPoint.y);
        maximumBubbleX = Math.max(maximumBubbleX, targetPoint.x);
        maximumBubbleY = Math.max(maximumBubbleY, targetPoint.y);
        const x = Math.round((targetPoint.x + 0.5) / scaleX - 0.5);
        const y = Math.round((targetPoint.y + 0.5) / scaleY - 0.5);
        if (x >= 0 && x < width && y >= 0 && y < height) {
          bubbleMask[y * width + x] = 1;
        }
      }
    }
    const targetTail = input.bubble.tail
      ? alignment
        ? transformPolygon(input.bubble.tail, alignment)
        : input.bubble.tail
      : null;
    if (targetTail) {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          if (!bubbleMask[index]) continue;
          const imagePoint = {
            x: (x + 0.5) * scaleX - 0.5,
            y: (y + 0.5) * scaleY - 0.5,
            coordinateSpace: input.coordinateSpace,
          } satisfies Point<ImageSpace>;
          if (pointInPolygon(imagePoint.x, imagePoint.y, targetTail.points)) {
            bubbleMask[index] = 0;
          }
        }
      }
    }
    const padded = erodeMask(
      bubbleMask,
      width,
      height,
      input.internalPaddingPx ?? 6,
      scaleX,
      scaleY,
    );
    const crop = maskCrop(padded, width, height);
    const outputMask = buildMask(padded, width, crop, maskSpace);
    const outputBounds = crop
      ? Object.freeze({
          x: crop.minX * scaleX - 0.5,
          y: crop.minY * scaleY - 0.5,
          width: (crop.maxX - crop.minX + 1) * scaleX,
          height: (crop.maxY - crop.minY + 1) * scaleY,
          coordinateSpace: input.coordinateSpace,
        })
      : null;
    const anchorResult = chooseAnchor(
      padded,
      width,
      height,
      input.originalTextBounds,
      input.coordinateSpace,
      scaleX,
      scaleY,
    );
    const bubbleBounds = alignment
      ? transformBounds(input.bubble.boundingBox, alignment)
      : input.bubble.boundingBox;
    const croppedBubble =
      bubbleBounds.x <= 0 ||
      bubbleBounds.y <= 0 ||
      bubbleBounds.x + bubbleBounds.width >= pageWidth - 1 ||
      bubbleBounds.y + bubbleBounds.height >= pageHeight - 1 ||
      minimumBubbleX < 0 ||
      minimumBubbleY < 0 ||
      maximumBubbleX > pageWidth - 1 ||
      maximumBubbleY > pageHeight - 1;
    const fractionRetained = bubbleMask.reduce((sum, value) => sum + value, 0)
      ? padded.reduce((sum, value) => sum + value, 0) /
        bubbleMask.reduce((sum, value) => sum + value, 0)
      : 0;
    const region: CaptionSafeRegion = Object.freeze({
      id: `safe:${input.bubble.id}:${input.coordinateSpace.id}`,
      bubbleId: input.bubble.id,
      mask: outputMask,
      coordinateSpace: input.coordinateSpace,
      boundingBox: outputBounds,
      originalTextBounds: input.originalTextBounds,
      preferredAnchor: anchorResult.anchor,
      placementPreserved: anchorResult.preserved,
      internalPaddingPx: input.internalPaddingPx ?? 6,
      tailExcluded: targetTail !== null,
      croppedBubble,
      status: crop ? 'ready' : 'no-safe-area',
      confidence: Math.max(0, Math.min(1, fractionRetained)),
    });
    const debugPng = await renderVisualization(
      input.pageImage,
      region,
      maskSpace,
      targetTail,
    );
    return Object.freeze({ region, debugPng });
  }
}

function validateInput(input: CaptionSafeRegionInput): void {
  if (
    !Number.isFinite(input.internalPaddingPx ?? 6) ||
    (input.internalPaddingPx ?? 6) < 0
  ) {
    throw new CaptionSafeRegionError(
      'Internal padding must be a non-negative finite number.',
    );
  }
  const textBox = input.originalTextBounds;
  if (
    textBox.coordinateSpace.id !== input.coordinateSpace.id ||
    textBox.coordinateSpace.dimensions.width !==
      input.coordinateSpace.dimensions.width ||
    textBox.coordinateSpace.dimensions.height !==
      input.coordinateSpace.dimensions.height ||
    ![textBox.x, textBox.y, textBox.width, textBox.height].every(
      Number.isFinite,
    ) ||
    textBox.width <= 0 ||
    textBox.height <= 0 ||
    textBox.x < -0.5 ||
    textBox.y < -0.5 ||
    textBox.x + textBox.width > input.coordinateSpace.dimensions.width - 0.5 ||
    textBox.y + textBox.height > input.coordinateSpace.dimensions.height - 0.5
  ) {
    throw new CaptionSafeRegionError(
      'Original text bounds must be valid geometry in the target ImageSpace.',
    );
  }
  const bubble = input.bubble;
  if (
    bubble.mask.coordinateSpace.imageSpaceId !== bubble.coordinateSpace.id ||
    bubble.mask.coordinateSpace.kind !== 'mask' ||
    bubble.mask.origin.coordinateSpace.id !== bubble.mask.coordinateSpace.id
  ) {
    throw new CaptionSafeRegionError(
      'Bubble mask must declare its source image and mask spaces.',
    );
  }
  if (bubble.coordinateSpace.id !== input.coordinateSpace.id) {
    if (
      !input.alignment ||
      input.alignment.sourceSpace.id !== bubble.coordinateSpace.id ||
      input.alignment.targetSpace.id !== input.coordinateSpace.id
    ) {
      throw new CaptionSafeRegionError(
        'Bubble geometry requires an alignment into the target page.',
      );
    }
  } else if (
    bubble.coordinateSpace.dimensions.width !==
      input.coordinateSpace.dimensions.width ||
    bubble.coordinateSpace.dimensions.height !==
      input.coordinateSpace.dimensions.height
  ) {
    throw new CaptionSafeRegionError(
      'Bubble geometry conflicts with the target ImageSpace dimensions.',
    );
  }
  if (
    input.alignment &&
    input.alignment.targetSpace.id !== input.coordinateSpace.id
  ) {
    throw new CaptionSafeRegionError(
      'Alignment target does not match the target ImageSpace.',
    );
  }
  if (
    input.alignment &&
    input.alignment.sourceSpace.id !== bubble.coordinateSpace.id
  ) {
    throw new CaptionSafeRegionError(
      'Alignment source does not match the bubble ImageSpace.',
    );
  }
  if (
    bubble.mask.origin.x < 0 ||
    bubble.mask.origin.y < 0 ||
    bubble.mask.origin.x + bubble.mask.width >
      bubble.mask.coordinateSpace.dimensions.width ||
    bubble.mask.origin.y + bubble.mask.height >
      bubble.mask.coordinateSpace.dimensions.height
  ) {
    throw new CaptionSafeRegionError(
      'Bubble mask crop exceeds its declared MaskSpace.',
    );
  }
  for (const run of bubble.mask.runs) {
    if (
      !Number.isInteger(run.x) ||
      !Number.isInteger(run.y) ||
      !Number.isInteger(run.length) ||
      run.x < 0 ||
      run.y < 0 ||
      run.length <= 0 ||
      run.x + run.length > bubble.mask.width ||
      run.y >= bubble.mask.height
    ) {
      throw new CaptionSafeRegionError('Bubble mask contains an invalid run.');
    }
  }
  if (bubble.tail) {
    if (
      bubble.tail.coordinateSpace.id !== bubble.coordinateSpace.id ||
      bubble.tail.points.some(
        (point) => point.coordinateSpace.id !== bubble.coordinateSpace.id,
      )
    ) {
      throw new CaptionSafeRegionError(
        'Bubble tail must use the bubble ImageSpace.',
      );
    }
  }
}

function erodeMask(
  source: Uint8Array,
  width: number,
  height: number,
  paddingPx: number,
  scaleX: number,
  scaleY: number,
): Uint8Array {
  if (paddingPx === 0) return Uint8Array.from(source);
  const distance = new Float32Array(source.length);
  const diagonal = Math.hypot(scaleX, scaleY);
  for (let index = 0; index < source.length; index += 1) {
    distance[index] = source[index] ? Number.POSITIVE_INFINITY : 0;
  }
  // Treat the page edge as exterior so a cropped bubble cannot claim padding
  // that extends beyond the available source image.
  for (let x = 0; x < width; x += 1) {
    if (source[x]) distance[x] = Math.min(distance[x]!, scaleY / 2);
    const bottom = (height - 1) * width + x;
    if (source[bottom])
      distance[bottom] = Math.min(distance[bottom]!, scaleY / 2);
  }
  for (let y = 0; y < height; y += 1) {
    const left = y * width;
    const right = left + width - 1;
    if (source[left]) distance[left] = Math.min(distance[left]!, scaleX / 2);
    if (source[right]) distance[right] = Math.min(distance[right]!, scaleX / 2);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let best = distance[index]!;
      if (x > 0) best = Math.min(best, distance[index - 1]! + scaleX);
      if (y > 0) best = Math.min(best, distance[index - width]! + scaleY);
      if (x > 0 && y > 0)
        best = Math.min(best, distance[index - width - 1]! + diagonal);
      if (x + 1 < width && y > 0)
        best = Math.min(best, distance[index - width + 1]! + diagonal);
      distance[index] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let best = distance[index]!;
      if (x + 1 < width) best = Math.min(best, distance[index + 1]! + scaleX);
      if (y + 1 < height)
        best = Math.min(best, distance[index + width]! + scaleY);
      if (x + 1 < width && y + 1 < height)
        best = Math.min(best, distance[index + width + 1]! + diagonal);
      if (x > 0 && y + 1 < height)
        best = Math.min(best, distance[index + width - 1]! + diagonal);
      distance[index] = best;
    }
  }
  const result = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    result[index] = source[index] && distance[index]! > paddingPx ? 1 : 0;
  }
  return result;
}

interface MaskCrop {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function maskCrop(
  mask: Uint8Array,
  width: number,
  height: number,
): MaskCrop | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function buildMask(
  pixels: Uint8Array,
  width: number,
  crop: MaskCrop | null,
  space: MaskSpace,
): BinaryMask {
  if (!crop) {
    return Object.freeze({
      width: 0,
      height: 0,
      runs: Object.freeze([]),
      origin: Object.freeze({ x: 0, y: 0, coordinateSpace: space }),
      coordinateSpace: space,
    });
  }
  const runs: MaskRun[] = [];
  for (let y = crop.minY; y <= crop.maxY; y += 1) {
    let start = -1;
    for (let x = crop.minX; x <= crop.maxX; x += 1) {
      const present = pixels[y * width + x] === 1;
      if (present && start < 0) start = x;
      if ((!present || x === crop.maxX) && start >= 0) {
        const endExclusive = present && x === crop.maxX ? x + 1 : x;
        runs.push(
          Object.freeze({
            y: y - crop.minY,
            x: start - crop.minX,
            length: endExclusive - start,
          }),
        );
        start = -1;
      }
    }
  }
  return Object.freeze({
    width: crop.maxX - crop.minX + 1,
    height: crop.maxY - crop.minY + 1,
    runs: Object.freeze(runs),
    origin: Object.freeze({
      x: crop.minX,
      y: crop.minY,
      coordinateSpace: space,
    }),
    coordinateSpace: space,
  });
}

function chooseAnchor(
  mask: Uint8Array,
  width: number,
  height: number,
  textBounds: Bounds<ImageSpace>,
  space: ImageSpace,
  scaleX: number,
  scaleY: number,
): { readonly anchor: Point<ImageSpace> | null; readonly preserved: boolean } {
  const originalX = textBounds.x + textBounds.width / 2;
  const originalY = textBounds.y + textBounds.height / 2;
  const gridX = Math.round((originalX + 0.5) / scaleX - 0.5);
  const gridY = Math.round((originalY + 0.5) / scaleY - 0.5);
  if (
    gridX >= 0 &&
    gridX < width &&
    gridY >= 0 &&
    gridY < height &&
    mask[gridY * width + gridX]
  ) {
    return {
      anchor: Object.freeze({
        x: originalX,
        y: originalY,
        coordinateSpace: space,
      }),
      preserved: true,
    };
  }
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const imageX = (x + 0.5) * scaleX - 0.5;
    const imageY = (y + 0.5) * scaleY - 0.5;
    const distance = (imageX - originalX) ** 2 + (imageY - originalY) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) return { anchor: null, preserved: false };
  const x = bestIndex % width;
  const y = Math.floor(bestIndex / width);
  return {
    anchor: Object.freeze({
      x: (x + 0.5) * scaleX - 0.5,
      y: (y + 0.5) * scaleY - 0.5,
      coordinateSpace: space,
    }),
    preserved: false,
  };
}

function transformPoint(
  point: Point<ImageSpace>,
  alignment: AlignmentResult,
): Point<ImageSpace> {
  const [a, b, c, d, e, f] = alignment.transformMatrix.values;
  return Object.freeze({
    x: a * point.x + b * point.y + c,
    y: d * point.x + e * point.y + f,
    coordinateSpace: alignment.targetSpace,
  });
}

function transformPolygon(
  polygon: Polygon<ImageSpace>,
  alignment: AlignmentResult,
): Polygon<ImageSpace> {
  return Object.freeze({
    points: Object.freeze(
      polygon.points.map((point) => transformPoint(point, alignment)),
    ),
    coordinateSpace: alignment.targetSpace,
  });
}

function transformBounds(
  bounds: Bounds<ImageSpace>,
  alignment: AlignmentResult,
): Bounds<ImageSpace> {
  const points = [
    { x: bounds.x, y: bounds.y, coordinateSpace: bounds.coordinateSpace },
    {
      x: bounds.x + bounds.width,
      y: bounds.y,
      coordinateSpace: bounds.coordinateSpace,
    },
    {
      x: bounds.x + bounds.width,
      y: bounds.y + bounds.height,
      coordinateSpace: bounds.coordinateSpace,
    },
    {
      x: bounds.x,
      y: bounds.y + bounds.height,
      coordinateSpace: bounds.coordinateSpace,
    },
  ].map((point) => transformPoint(point, alignment));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return Object.freeze({
    x: left,
    y: top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
    coordinateSpace: alignment.targetSpace,
  });
}

function pointInPolygon(
  x: number,
  y: number,
  points: readonly Point<ImageSpace>[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const current = points[i]!;
    const previous = points[j]!;
    const crosses =
      current.y > y !== previous.y > y &&
      x <
        ((previous.x - current.x) * (y - current.y)) /
          (previous.y - current.y) +
          current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

async function renderVisualization(
  pageImage: Uint8Array,
  region: CaptionSafeRegion,
  maskSpace: MaskSpace,
  tail: Polygon<ImageSpace> | null,
): Promise<Buffer> {
  const scaleX =
    region.coordinateSpace.dimensions.width / maskSpace.dimensions.width;
  const scaleY =
    region.coordinateSpace.dimensions.height / maskSpace.dimensions.height;
  const safePath = region.mask.runs
    .map((run) => {
      const x = (region.mask.origin.x + run.x) * scaleX;
      const y = (region.mask.origin.y + run.y) * scaleY;
      return `M${x.toFixed(2)},${y.toFixed(2)}h${(run.length * scaleX).toFixed(2)}v${scaleY.toFixed(2)}h-${(run.length * scaleX).toFixed(2)}Z`;
    })
    .join('');
  const tailPath = tail?.points.length
    ? `<path d="${tail.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${(point.x + 0.5).toFixed(2)},${(point.y + 0.5).toFixed(2)}`).join(' ')}Z" fill="#ff5a36" fill-opacity=".35" stroke="#e63926" stroke-width="2"/>`
    : '';
  const textBounds = region.originalTextBounds;
  const textOverlay = `<rect x="${(textBounds.x + 0.5).toFixed(2)}" y="${(textBounds.y + 0.5).toFixed(2)}" width="${textBounds.width.toFixed(2)}" height="${textBounds.height.toFixed(2)}" fill="none" stroke="#2680eb" stroke-width="2" stroke-dasharray="6 4"/>`;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${region.coordinateSpace.dimensions.width}" height="${region.coordinateSpace.dimensions.height}" viewBox="0 0 ${region.coordinateSpace.dimensions.width} ${region.coordinateSpace.dimensions.height}"><path d="${safePath}" fill="#16a34a" fill-opacity=".38"/>${tailPath}${textOverlay}</svg>`,
  );
  return sharp(pageImage)
    .rotate()
    .composite([{ input: svg }])
    .png()
    .toBuffer();
}
