import type { Bounds, ImageSpace, Polygon } from '@comic-captioner/shared';

/**
 * Raw RGBA raster in DOM ImageData layout (row-major, 4 bytes per pixel).
 * Inpainting is implemented in pure TypeScript over this buffer so the
 * package does not need native image libraries for text erasure.
 */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA (DOM ImageData layout), 4 bytes per pixel. */
  readonly data: Uint8ClampedArray;
}

/**
 * `solid-fill` replaces text pixels with the bubble interior background color
 * estimated from non-text pixels (plain bubbles). `diffusion` iteratively
 * diffuses surrounding colors into the erased region (textured bubbles).
 */
export type InpaintMode = 'solid-fill' | 'diffusion';

export type InpaintMaskMethod =
  | 'text-observation'
  | 'ink-detection'
  | 'combined';

/** Minimal bubble geometry needed to localize text. `BubbleGeometry` conforms. */
export interface InpaintBubbleInput {
  readonly id: string;
  readonly contour: Polygon<ImageSpace>;
}

/** Semantic text hint. Core `TextObservation` conforms. */
export interface InpaintTextObservationInput {
  readonly id: string;
  readonly polygon: Polygon<ImageSpace>;
  readonly associatedBubbleId?: string | null;
}

/**
 * Dense text-erasure mask for one bubble. `pixels` covers the whole page
 * raster (1 = erase) so `inpaintTextRegions` can consume masks without
 * re-deriving bubble geometry.
 */
export interface InpaintTextMask {
  readonly id: string;
  readonly bubbleId: string;
  /** Dense page-sized mask; 1 marks ink to erase. Length = width * height. */
  readonly pixels: Uint8Array;
  /** Bounds of the erased pixels in page coordinates. */
  readonly boundingBox: Bounds<ImageSpace>;
  /** Bubble interior sampling box used for solid-fill background estimation. */
  readonly backgroundBounds: Bounds<ImageSpace>;
  readonly suggestedMode: InpaintMode;
  readonly confidence: number;
  readonly method: InpaintMaskMethod;
}

export interface DetectTextRegionsOptions {
  /** Luminance below which interior pixels count as ink (default 150). */
  readonly inkLuminanceThreshold?: number;
  /** Minimum connected ink-component area in pixels (default 3). */
  readonly minimumComponentArea?: number;
  /**
   * Maximum ink-component area as a fraction of the eroded bubble interior
   * (default 0.18). Larger dark regions are treated as artwork, not text.
   */
  readonly maximumComponentAreaRatio?: number;
  /** Mask dilation in pixels covering anti-aliased glyph edges (default 1). */
  readonly dilationPx?: number;
  /** Erosion in pixels excluding the bubble outline from the interior (default 1). */
  readonly outlineErosionPx?: number;
  /**
   * Interior luminance standard deviation (non-text pixels) at or below which
   * a bubble counts as plain and gets `solid-fill` (default 5).
   */
  readonly plainTextureDeviation?: number;
}

export interface InpaintOptions {
  /** Force one fill strategy for every mask; defaults to each mask's suggestion. */
  readonly mode?: InpaintMode;
  /** Maximum diffusion sweeps (default 256). */
  readonly diffusionIterations?: number;
  /** Stop diffusion when the largest per-sweep change falls below this (default 0.75). */
  readonly diffusionEpsilon?: number;
}

export class InpaintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InpaintError';
  }
}

const DEFAULT_INK_LUMINANCE_THRESHOLD = 150;
const DEFAULT_MINIMUM_COMPONENT_AREA = 3;
const DEFAULT_MAXIMUM_COMPONENT_AREA_RATIO = 0.18;
const DEFAULT_DILATION_PX = 1;
const DEFAULT_OUTLINE_EROSION_PX = 1;
const DEFAULT_PLAIN_TEXTURE_DEVIATION = 5;
const DEFAULT_DIFFUSION_ITERATIONS = 256;
const DEFAULT_DIFFUSION_EPSILON = 0.75;
const MAX_RASTER_PIXELS = 40_000_000;

/**
 * Detects text ink inside the given bubble contours and returns one erasure
 * mask per bubble that contains text. When `textObservations` are supplied
 * they define the text geometry; bubbles without a covering observation fall
 * back to deterministic dark-ink detection so recall does not depend on OCR.
 */
export function detectTextRegionsForInpaint(
  image: RasterImage,
  bubbles: readonly InpaintBubbleInput[],
  textObservations?: readonly InpaintTextObservationInput[],
  options: DetectTextRegionsOptions = {},
): readonly InpaintTextMask[] {
  validateRaster(image);
  validateDetectOptions(options);
  const space = resolveImageSpace(image, bubbles, textObservations);
  const inkLuminanceThreshold =
    options.inkLuminanceThreshold ?? DEFAULT_INK_LUMINANCE_THRESHOLD;
  const minimumComponentArea =
    options.minimumComponentArea ?? DEFAULT_MINIMUM_COMPONENT_AREA;
  const maximumComponentAreaRatio =
    options.maximumComponentAreaRatio ?? DEFAULT_MAXIMUM_COMPONENT_AREA_RATIO;
  const dilationPx = options.dilationPx ?? DEFAULT_DILATION_PX;
  const outlineErosionPx =
    options.outlineErosionPx ?? DEFAULT_OUTLINE_EROSION_PX;
  const plainTextureDeviation =
    options.plainTextureDeviation ?? DEFAULT_PLAIN_TEXTURE_DEVIATION;
  const width = image.width;
  const height = image.height;
  const luminance = computeLuminance(image);

  const masks: InpaintTextMask[] = [];
  for (const bubble of bubbles) {
    validateBubbleContour(bubble, space);
    const interior = rasterizePolygon(bubble.contour, width, height);
    const erodedInterior = erodeMask(interior, width, height, outlineErosionPx);
    const interiorArea = countMask(erodedInterior);
    if (interiorArea === 0) continue;

    const observations = (textObservations ?? []).filter((observation) =>
      observationBelongsToBubble(observation, bubble, interior, width, height),
    );
    const observationMask =
      observations.length > 0
        ? rasterizeObservationMasks(observations, erodedInterior, width, height)
        : null;
    const detectedInk = detectInkMask(
      luminance,
      erodedInterior,
      width,
      height,
      inkLuminanceThreshold,
      minimumComponentArea,
      Math.max(1, Math.floor(interiorArea * maximumComponentAreaRatio)),
    );

    const textPixels = new Uint8Array(width * height);
    let method: InpaintMaskMethod;
    if (observationMask && countMask(observationMask) > 0) {
      mergeMask(textPixels, observationMask);
      method = 'text-observation';
      // Keep ink the OCR hint missed so erasure covers the full text.
      if (countMaskOutside(detectedInk, observationMask) > 0) {
        mergeMask(textPixels, detectedInk);
        method = 'combined';
      }
    } else if (countMask(detectedInk) > 0) {
      mergeMask(textPixels, detectedInk);
      method = 'ink-detection';
    } else {
      continue;
    }
    dilateMaskInPlace(textPixels, erodedInterior, width, height, dilationPx);
    if (countMask(textPixels) === 0) continue;

    const backgroundBounds = maskBounds(erodedInterior, width, height, space);
    const suggestedMode = classifyTexture(
      luminance,
      erodedInterior,
      textPixels,
      width,
      height,
      plainTextureDeviation,
    );
    const textArea = countMask(textPixels);
    masks.push(
      Object.freeze({
        id: `inpaint-text:${bubble.id}`,
        bubbleId: bubble.id,
        pixels: textPixels,
        boundingBox: maskBounds(textPixels, width, height, space),
        backgroundBounds,
        suggestedMode,
        confidence: textMaskConfidence(method, textArea, interiorArea),
        method,
      }),
    );
  }
  return Object.freeze(masks);
}

/**
 * Erases the masked text from `image` and returns a cleaned copy. The input
 * raster is never mutated. `solid-fill` paints the estimated bubble interior
 * background; `diffusion` runs an iterative neighbor-average fill.
 */
export function inpaintTextRegions(
  image: RasterImage,
  masks: readonly InpaintTextMask[],
  options: InpaintOptions = {},
): RasterImage {
  validateRaster(image);
  validateInpaintOptions(options);
  const width = image.width;
  const height = image.height;
  const pixelCount = width * height;
  const output = new Uint8ClampedArray(image.data);
  if (masks.length === 0) return freezeRaster(output, width, height);

  const holes = new Uint8Array(pixelCount);
  for (const mask of masks) {
    if (mask.pixels.length !== pixelCount) {
      throw new InpaintError(
        'Inpaint mask dimensions must match the source raster.',
      );
    }
    for (let index = 0; index < pixelCount; index += 1) {
      if (mask.pixels[index]) holes[index] = 1;
    }
  }
  if (countMask(holes) === 0) return freezeRaster(output, width, height);

  const diffusionIterations =
    options.diffusionIterations ?? DEFAULT_DIFFUSION_ITERATIONS;
  const diffusionEpsilon =
    options.diffusionEpsilon ?? DEFAULT_DIFFUSION_EPSILON;

  for (const group of groupMasksByBubble(masks)) {
    const regionHoles = new Uint8Array(pixelCount);
    for (const mask of group.masks) {
      for (let index = 0; index < pixelCount; index += 1) {
        if (mask.pixels[index]) regionHoles[index] = 1;
      }
    }
    const mode = options.mode ?? group.masks[0]!.suggestedMode;
    const background = estimateBackgroundColor(
      output,
      holes,
      group.masks[0]!.backgroundBounds,
      width,
      height,
    );
    if (mode === 'solid-fill') {
      for (let index = 0; index < pixelCount; index += 1) {
        if (!regionHoles[index]) continue;
        writePixel(output, index, background);
      }
    } else {
      diffuseIntoHoles(
        output,
        regionHoles,
        background,
        width,
        height,
        diffusionIterations,
        diffusionEpsilon,
      );
    }
  }
  return freezeRaster(output, width, height);
}

interface MaskGroup {
  readonly bubbleId: string;
  readonly masks: readonly InpaintTextMask[];
}

function groupMasksByBubble(
  masks: readonly InpaintTextMask[],
): readonly MaskGroup[] {
  const groups = new Map<string, InpaintTextMask[]>();
  for (const mask of masks) {
    const group = groups.get(mask.bubbleId) ?? [];
    group.push(mask);
    groups.set(mask.bubbleId, group);
  }
  return [...groups.entries()].map(([bubbleId, groupMasks]) =>
    Object.freeze({ bubbleId, masks: Object.freeze(groupMasks) }),
  );
}

function diffuseIntoHoles(
  pixels: Uint8ClampedArray,
  holes: Uint8Array,
  background: readonly [number, number, number],
  width: number,
  height: number,
  iterations: number,
  epsilon: number,
): void {
  const holeIndices: number[] = [];
  for (let index = 0; index < holes.length; index += 1) {
    if (holes[index]) {
      writePixel(pixels, index, background);
      holeIndices.push(index);
    }
  }
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let maxDelta = 0;
    for (const index of holeIndices) {
      const x = index % width;
      const y = Math.floor(index / width);
      const leftX = Math.max(0, x - 1);
      const rightX = Math.min(width - 1, x + 1);
      const upY = Math.max(0, y - 1);
      const downY = Math.min(height - 1, y + 1);
      const offset = index * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const neighborSum =
          pixels[(y * width + leftX) * 4 + channel]! +
          pixels[(y * width + rightX) * 4 + channel]! +
          pixels[(upY * width + x) * 4 + channel]! +
          pixels[(downY * width + x) * 4 + channel]!;
        const next = neighborSum / 4;
        const delta = Math.abs(next - pixels[offset + channel]!);
        if (delta > maxDelta) maxDelta = delta;
        pixels[offset + channel] = next;
      }
      pixels[offset + 3] = 255;
    }
    if (maxDelta < epsilon) break;
  }
}

function estimateBackgroundColor(
  pixels: Uint8ClampedArray,
  holes: Uint8Array,
  backgroundBounds: Bounds<ImageSpace>,
  width: number,
  height: number,
): readonly [number, number, number] {
  const left = Math.max(0, Math.floor(backgroundBounds.x + 0.5));
  const top = Math.max(0, Math.floor(backgroundBounds.y + 0.5));
  const right = Math.min(
    width - 1,
    Math.ceil(backgroundBounds.x + backgroundBounds.width - 0.5),
  );
  const bottom = Math.min(
    height - 1,
    Math.ceil(backgroundBounds.y + backgroundBounds.height - 0.5),
  );
  const samples: number[][] = [[], [], []];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = y * width + x;
      if (holes[index]) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        samples[channel]!.push(pixels[index * 4 + channel]!);
      }
    }
  }
  if (samples[0]!.length === 0) {
    for (let index = 0; index < holes.length; index += 1) {
      if (holes[index]) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        samples[channel]!.push(pixels[index * 4 + channel]!);
      }
    }
  }
  if (samples[0]!.length === 0) return [255, 255, 255];
  return [
    median(samples[0]!),
    median(samples[1]!),
    median(samples[2]!),
  ] as const;
}

function writePixel(
  pixels: Uint8ClampedArray,
  index: number,
  color: readonly [number, number, number],
): void {
  pixels[index * 4] = color[0];
  pixels[index * 4 + 1] = color[1];
  pixels[index * 4 + 2] = color[2];
  pixels[index * 4 + 3] = 255;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function freezeRaster(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): RasterImage {
  return Object.freeze({ width, height, data });
}

function validateRaster(image: RasterImage): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new InpaintError('Raster dimensions must be positive integers.');
  }
  if (image.width * image.height > MAX_RASTER_PIXELS) {
    throw new InpaintError('Raster exceeds the supported 40 megapixel limit.');
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new InpaintError(
      'Raster data must contain exactly width × height RGBA pixels.',
    );
  }
}

function validateDetectOptions(options: DetectTextRegionsOptions): void {
  const numeric = [
    options.inkLuminanceThreshold,
    options.minimumComponentArea,
    options.maximumComponentAreaRatio,
    options.dilationPx,
    options.outlineErosionPx,
    options.plainTextureDeviation,
  ];
  if (numeric.some((value) => value !== undefined && !Number.isFinite(value))) {
    throw new InpaintError('Text detection options must be finite numbers.');
  }
  if (
    options.inkLuminanceThreshold !== undefined &&
    (options.inkLuminanceThreshold < 0 || options.inkLuminanceThreshold > 255)
  ) {
    throw new InpaintError('Ink luminance threshold must be within 0–255.');
  }
  if (
    options.minimumComponentArea !== undefined &&
    options.minimumComponentArea < 1
  ) {
    throw new InpaintError('Minimum component area must be at least 1 pixel.');
  }
  if (
    options.maximumComponentAreaRatio !== undefined &&
    (options.maximumComponentAreaRatio <= 0 ||
      options.maximumComponentAreaRatio > 1)
  ) {
    throw new InpaintError('Maximum component area ratio must be within (0, 1].');
  }
  if (
    (options.dilationPx !== undefined && options.dilationPx < 0) ||
    (options.outlineErosionPx !== undefined && options.outlineErosionPx < 0)
  ) {
    throw new InpaintError('Dilation and erosion radii must be non-negative.');
  }
  if (
    options.plainTextureDeviation !== undefined &&
    options.plainTextureDeviation < 0
  ) {
    throw new InpaintError('Plain texture deviation must be non-negative.');
  }
}

function validateInpaintOptions(options: InpaintOptions): void {
  if (
    options.mode !== undefined &&
    options.mode !== 'solid-fill' &&
    options.mode !== 'diffusion'
  ) {
    throw new InpaintError('Inpaint mode must be solid-fill or diffusion.');
  }
  if (
    options.diffusionIterations !== undefined &&
    (!Number.isInteger(options.diffusionIterations) ||
      options.diffusionIterations < 1)
  ) {
    throw new InpaintError('Diffusion iterations must be a positive integer.');
  }
  if (
    options.diffusionEpsilon !== undefined &&
    (!Number.isFinite(options.diffusionEpsilon) ||
      options.diffusionEpsilon < 0)
  ) {
    throw new InpaintError('Diffusion epsilon must be a non-negative number.');
  }
}

function resolveImageSpace(
  image: RasterImage,
  bubbles: readonly InpaintBubbleInput[],
  textObservations: readonly InpaintTextObservationInput[] | undefined,
): ImageSpace {
  const geometries: Polygon<ImageSpace>[] = [
    ...bubbles.map((bubble) => bubble.contour),
    ...(textObservations ?? []).map((observation) => observation.polygon),
  ];
  if (geometries.length === 0) {
    throw new InpaintError(
      'At least one bubble contour or text observation is required.',
    );
  }
  const space = geometries[0]!.coordinateSpace;
  if (space.kind !== 'image') {
    throw new InpaintError('Inpaint geometry must use an ImageSpace.');
  }
  if (
    space.dimensions.width !== image.width ||
    space.dimensions.height !== image.height
  ) {
    throw new InpaintError(
      'The raster dimensions must match the declared ImageSpace.',
    );
  }
  for (const polygon of geometries) {
    if (
      polygon.coordinateSpace.id !== space.id ||
      polygon.coordinateSpace.kind !== 'image'
    ) {
      throw new InpaintError(
        'All inpaint geometry must share one ImageSpace.',
      );
    }
  }
  return space;
}

function validateBubbleContour(
  bubble: InpaintBubbleInput,
  space: ImageSpace,
): void {
  if (!bubble.id.trim()) {
    throw new InpaintError('Bubble ID is required.');
  }
  if (bubble.contour.points.length < 3) {
    throw new InpaintError(
      'Bubble contours must contain at least three points.',
    );
  }
  for (const point of bubble.contour.points) {
    if (
      point.coordinateSpace.id !== space.id ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      throw new InpaintError(
        'Bubble contour points must be finite and use the declared ImageSpace.',
      );
    }
  }
}

function computeLuminance(image: RasterImage): Float64Array {
  const luminance = new Float64Array(image.width * image.height);
  for (let index = 0; index < luminance.length; index += 1) {
    luminance[index] =
      0.2126 * image.data[index * 4]! +
      0.7152 * image.data[index * 4 + 1]! +
      0.0722 * image.data[index * 4 + 2]!;
  }
  return luminance;
}

/**
 * Even-odd scanline fill of a page-space polygon into a dense mask. A pixel
 * is inside when its integer center (x, y) satisfies the same even-odd rule
 * as `pointInPolygon`, keeping rasterization and point tests consistent.
 */
function rasterizePolygon(
  polygon: Polygon<ImageSpace>,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const points = polygon.points;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const yStart = Math.max(0, Math.ceil(minY - 1e-9));
  const yEnd = Math.min(height - 1, Math.ceil(maxY - 1e-9) - 1);
  for (let y = yStart; y <= yEnd; y += 1) {
    const crossings: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const first = points[i]!;
      const second = points[j]!;
      if (first.y > y === second.y > y) continue;
      const t = (y - first.y) / (second.y - first.y);
      crossings.push(first.x + t * (second.x - first.x));
    }
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const start = Math.max(0, Math.ceil(crossings[pair]! - 1e-9));
      const end = Math.min(width - 1, Math.ceil(crossings[pair + 1]! - 1e-9) - 1);
      for (let x = start; x <= end; x += 1) {
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

function pointInPolygon(
  x: number,
  y: number,
  points: readonly { readonly x: number; readonly y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const first = points[i]!;
    const second = points[j]!;
    const crosses =
      first.y > y !== second.y > y &&
      x < ((second.x - first.x) * (y - first.y)) / (second.y - first.y) + first.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function observationBelongsToBubble(
  observation: InpaintTextObservationInput,
  bubble: InpaintBubbleInput,
  interior: Uint8Array,
  width: number,
  height: number,
): boolean {
  if (observation.associatedBubbleId != null) {
    return observation.associatedBubbleId === bubble.id;
  }
  const bounds = polygonBounds(observation.polygon);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const pixelX = Math.min(width - 1, Math.max(0, Math.round(centerX + 0.5) - 1));
  const pixelY = Math.min(
    height - 1,
    Math.max(0, Math.round(centerY + 0.5) - 1),
  );
  if (interior[pixelY * width + pixelX]) return true;
  return pointInPolygon(centerX, centerY, bubble.contour.points);
}

function rasterizeObservationMasks(
  observations: readonly InpaintTextObservationInput[],
  erodedInterior: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const observation of observations) {
    const rasterized = rasterizePolygon(observation.polygon, width, height);
    for (let index = 0; index < mask.length; index += 1) {
      if (rasterized[index] && erodedInterior[index]) mask[index] = 1;
    }
  }
  return mask;
}

function detectInkMask(
  luminance: Float64Array,
  erodedInterior: Uint8Array,
  width: number,
  height: number,
  inkLuminanceThreshold: number,
  minimumComponentArea: number,
  maximumComponentArea: number,
): Uint8Array {
  const interiorLuminances: number[] = [];
  for (let index = 0; index < luminance.length; index += 1) {
    if (erodedInterior[index]) interiorLuminances.push(luminance[index]!);
  }
  if (interiorLuminances.length === 0) return new Uint8Array(luminance.length);
  const backgroundLuminance = median(interiorLuminances);
  const inkCutoff = Math.min(
    inkLuminanceThreshold,
    backgroundLuminance - 36,
  );
  const ink = new Uint8Array(luminance.length);
  for (let index = 0; index < luminance.length; index += 1) {
    if (erodedInterior[index] && luminance[index]! <= inkCutoff) ink[index] = 1;
  }
  const labels = new Int32Array(luminance.length);
  const components = connectedComponents(ink, labels, width, height);
  const interiorHeight = countMaskRows(erodedInterior, width, height);
  const accepted = new Set<number>();
  for (const component of components) {
    if (component.area < minimumComponentArea) continue;
    if (component.area > maximumComponentArea) continue;
    const boxHeight = component.maxY - component.minY + 1;
    // Reject full-height outline rings, but keep short lettering on small
    // balloons ("UH…") whose glyphs can span most of a tiny interior.
    if (boxHeight > interiorHeight * 0.95 && component.area > interiorHeight * 3) {
      continue;
    }
    accepted.add(component.label);
  }
  const mask = new Uint8Array(luminance.length);
  for (let index = 0; index < mask.length; index += 1) {
    const label = labels[index]!;
    if (label > 0 && accepted.has(label)) mask[index] = 1;
  }
  return mask;
}

function classifyTexture(
  luminance: Float64Array,
  erodedInterior: Uint8Array,
  textPixels: Uint8Array,
  width: number,
  height: number,
  plainTextureDeviation: number,
): InpaintMode {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < luminance.length; index += 1) {
    if (!erodedInterior[index] || textPixels[index]) continue;
    const value = luminance[index]!;
    count += 1;
    sum += value;
    sumSquares += value * value;
  }
  if (count === 0) return 'diffusion';
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  return deviation <= plainTextureDeviation ? 'solid-fill' : 'diffusion';
}

function textMaskConfidence(
  method: InpaintMaskMethod,
  textArea: number,
  interiorArea: number,
): number {
  const coverage = interiorArea > 0 ? textArea / interiorArea : 0;
  // Typical dialogue ink covers roughly 2–20% of a bubble interior.
  const coverageScore = Math.min(1, coverage / 0.08);
  const base =
    method === 'text-observation'
      ? 0.86
      : method === 'combined'
        ? 0.82
        : 0.62;
  return Math.min(0.98, base + 0.12 * coverageScore);
}

interface Component {
  readonly label: number;
  readonly area: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function connectedComponents(
  mask: Uint8Array,
  labels: Int32Array,
  width: number,
  height: number,
): Component[] {
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];
  let nextLabel = 1;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = nextLabel;
    const x0 = start % width;
    const y0 = Math.floor(start / width);
    const component = {
      label: nextLabel,
      area: 0,
      minX: x0,
      minY: y0,
      maxX: x0,
      maxY: y0,
    };
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width;
      const y = Math.floor(index / width);
      component.area += 1;
      component.minX = Math.min(component.minX, x);
      component.maxX = Math.max(component.maxX, x);
      component.minY = Math.min(component.minY, y);
      component.maxY = Math.max(component.maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const neighbor = yy * width + xx;
          if (mask[neighbor] && !labels[neighbor]) {
            labels[neighbor] = nextLabel;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    components.push(component);
    nextLabel += 1;
  }
  return components;
}

function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  let current = mask;
  for (let step = 0; step < radius; step += 1) {
    const next = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!current[index]) continue;
        let keep = 1;
        for (let dy = -1; dy <= 1 && keep; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            if (!current[yy * width + xx]) keep = 0;
          }
        }
        next[index] = keep;
      }
    }
    current = next;
  }
  return current === mask ? new Uint8Array(mask) : current;
}

function dilateMaskInPlace(
  mask: Uint8Array,
  allowed: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  for (let step = 0; step < radius; step += 1) {
    const additions: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (mask[index] || !allowed[index]) continue;
        let near = 0;
        for (let dy = -1; dy <= 1 && !near; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            if (mask[yy * width + xx]) near = 1;
          }
        }
        if (near) additions.push(index);
      }
    }
    for (const index of additions) mask[index] = 1;
  }
}

function mergeMask(target: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) {
    if (source[index]) target[index] = 1;
  }
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) if (mask[index]) count += 1;
  return count;
}

function countMaskOutside(mask: Uint8Array, coverage: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && !coverage[index]) count += 1;
  }
  return count;
}

function countMaskRows(
  mask: Uint8Array,
  width: number,
  height: number,
): number {
  let rows = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        rows += 1;
        break;
      }
    }
  }
  return rows;
}

function polygonBounds(
  polygon: Polygon<ImageSpace>,
): Omit<Bounds<ImageSpace>, 'coordinateSpace'> {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of polygon.points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function maskBounds(
  mask: Uint8Array,
  width: number,
  height: number,
  space: ImageSpace,
): Bounds<ImageSpace> {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) {
    throw new InpaintError('Cannot compute bounds of an empty mask.');
  }
  const left = minX - 0.5;
  const top = minY - 0.5;
  const right = maxX + 0.5;
  const bottom = maxY + 0.5;
  return Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: space,
  });
}
