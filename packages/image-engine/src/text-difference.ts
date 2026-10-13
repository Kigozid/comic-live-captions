import sharp from 'sharp';
import {
  createMaskSpace,
  type ImageSpace,
  type MaskRun,
  type TextRegion,
} from '@comic-captioner/shared';

const MAX_ANALYSIS_SIDE = 1600;
const MAX_DECODED_PIXELS = 40_000_000;

export interface TextDifferenceOptions {
  readonly differenceThreshold?: number;
  readonly inkThreshold?: number;
  readonly minimumConfidence?: number;
}

export interface TextDifferenceResult {
  readonly regions: readonly TextRegion[];
  readonly maskSpace: ReturnType<typeof createMaskSpace>;
  readonly debugPng: Buffer;
  readonly differencePng: Buffer;
}

interface Component {
  readonly label: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

interface CandidateGroup {
  readonly components: readonly Component[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly area: number;
  readonly confidence: number;
}

/** Finds likely dark dialogue ink present in the original but absent from the aligned clean page. */
export class TextDifferenceEngine {
  async detect(
    originalBytes: Uint8Array,
    alignedCleanedBytes: Uint8Array,
    coordinateSpace: ImageSpace,
    options: TextDifferenceOptions = {},
  ): Promise<TextDifferenceResult> {
    const [originalMetadata, cleanedMetadata] = await Promise.all([
      sharp(originalBytes).metadata(),
      sharp(alignedCleanedBytes).metadata(),
    ]);
    if (
      !originalMetadata.width ||
      !originalMetadata.height ||
      !cleanedMetadata.width ||
      !cleanedMetadata.height
    ) {
      throw new TextDifferenceError(
        'The original and aligned images must be decodable.',
      );
    }
    if (
      originalMetadata.width * originalMetadata.height > MAX_DECODED_PIXELS ||
      cleanedMetadata.width * cleanedMetadata.height > MAX_DECODED_PIXELS
    ) {
      throw new TextDifferenceError(
        'Aligned images exceed the supported 40 megapixel processing limit.',
      );
    }
    validateOptions(options);
    const sourceWidth = originalMetadata.width;
    const sourceHeight = originalMetadata.height;
    const width = Math.max(
      1,
      Math.round(
        sourceWidth *
          Math.min(
            1,
            MAX_ANALYSIS_SIDE / sourceWidth,
            MAX_ANALYSIS_SIDE / sourceHeight,
          ),
      ),
    );
    const height = Math.max(
      1,
      Math.round(
        sourceHeight *
          Math.min(
            1,
            MAX_ANALYSIS_SIDE / sourceWidth,
            MAX_ANALYSIS_SIDE / sourceHeight,
          ),
      ),
    );
    const originalAspect = sourceWidth / sourceHeight;
    const cleanedAspect = cleanedMetadata.width / cleanedMetadata.height;
    const declaredAspect =
      coordinateSpace.dimensions.width / coordinateSpace.dimensions.height;
    if (
      Math.abs(originalAspect - cleanedAspect) > 0.002 ||
      Math.abs(cleanedAspect - declaredAspect) > 0.002
    ) {
      throw new TextDifferenceError(
        'The original and aligned raster aspect ratios must match their declared ImageSpace.',
      );
    }
    const [original, cleaned] = await Promise.all([
      decodeGray(originalBytes, width, height),
      decodeGray(alignedCleanedBytes, width, height),
    ]);
    const pixelCount = width * height;
    const rawDifferences = new Uint8Array(pixelCount);
    const directionalMask = new Uint8Array(pixelCount);
    const differenceThreshold = options.differenceThreshold ?? 32;
    const inkThreshold = options.inkThreshold ?? 190;
    for (let index = 0; index < pixelCount; index += 1) {
      const delta = Math.abs(original[index]! - cleaned[index]!);
      if (delta >= differenceThreshold) rawDifferences[index] = 1;
      if (
        original[index]! <= inkThreshold &&
        cleaned[index]! - original[index]! >= differenceThreshold
      ) {
        directionalMask[index] = 1;
      }
    }

    const cleanedMask = closeMask(directionalMask, width, height);
    const labels = new Int32Array(pixelCount);
    const components = connectedComponents(cleanedMask, labels, width, height);
    const substantial = components.filter((component) => component.area >= 2);
    const groups = groupComponents(substantial)
      .map((group) => scoreGroup(group, width, height))
      .filter((group): group is CandidateGroup => group !== null)
      .filter(
        (group) => group.confidence >= (options.minimumConfidence ?? 0.48),
      );
    const acceptedLabels = new Set(
      groups.flatMap((group) =>
        group.components.map((component) => component.label),
      ),
    );
    const acceptedMask = new Uint8Array(pixelCount);
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]!;
      if (label > 0 && acceptedLabels.has(label)) acceptedMask[index] = 1;
    }
    const maskSpace = createMaskSpace(
      `mask:${coordinateSpace.id}:${width}x${height}`,
      coordinateSpace,
      width,
      height,
    );
    const xScale = coordinateSpace.dimensions.width / width;
    const yScale = coordinateSpace.dimensions.height / height;
    const regions = groups.map((group) =>
      createTextRegion(
        group,
        labels,
        width,
        maskSpace,
        coordinateSpace,
        xScale,
        yScale,
      ),
    );
    const [debugPng, differencePng] = await Promise.all([
      createDebugPng(original, rawDifferences, acceptedMask, width, height),
      createDifferencePng(rawDifferences, width, height),
    ]);
    return Object.freeze({
      regions: Object.freeze(regions),
      maskSpace,
      debugPng,
      differencePng,
    });
  }
}

export class TextDifferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextDifferenceError';
  }
}

function validateOptions(options: TextDifferenceOptions): void {
  const differenceThreshold = options.differenceThreshold ?? 32;
  const inkThreshold = options.inkThreshold ?? 190;
  const minimumConfidence = options.minimumConfidence ?? 0.48;
  if (
    !Number.isFinite(differenceThreshold) ||
    differenceThreshold < 0 ||
    differenceThreshold > 255 ||
    !Number.isFinite(inkThreshold) ||
    inkThreshold < 0 ||
    inkThreshold > 255 ||
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1
  ) {
    throw new TextDifferenceError(
      'Difference thresholds must be within 0–255 and confidence within 0–1.',
    );
  }
}

async function decodeGray(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(bytes)
    .rotate()
    .greyscale()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer();
}

function closeMask(
  source: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const dilated = new Uint8Array(source.length);
  const closed = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (
            xx >= 0 &&
            yy >= 0 &&
            xx < width &&
            yy < height &&
            source[yy * width + xx]
          ) {
            found = true;
            break;
          }
        }
      }
      if (found) dilated[y * width + x] = 1;
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let filled = true;
      for (let dy = -1; dy <= 1 && filled; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dilated[(y + dy) * width + x + dx]) {
            filled = false;
            break;
          }
        }
      }
      if (filled) closed[y * width + x] = 1;
    }
  }
  return closed;
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
    const component: Component = {
      label: nextLabel,
      minX: x0,
      maxX: x0,
      minY: y0,
      maxY: y0,
      area: 0,
    };
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width;
      const y = Math.floor(index / width);
      component.minX = Math.min(component.minX, x);
      component.maxX = Math.max(component.maxX, x);
      component.minY = Math.min(component.minY, y);
      component.maxY = Math.max(component.maxY, y);
      component.area += 1;
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

function groupComponents(components: readonly Component[]): Component[][] {
  const parent = components.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (first: number, second: number) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot;
  };
  const sorted = components
    .map((component, index) => ({ component, index }))
    .sort((a, b) => a.component.minX - b.component.minX);
  for (let cursor = 0; cursor < sorted.length; cursor += 1) {
    const current = sorted[cursor]!;
    for (let next = cursor + 1; next < sorted.length; next += 1) {
      const candidate = sorted[next]!;
      const maxHeight = Math.max(
        current.component.maxY - current.component.minY + 1,
        candidate.component.maxY - candidate.component.minY + 1,
      );
      if (
        candidate.component.minX - current.component.maxX >
        Math.max(3, maxHeight * 0.9)
      )
        break;
      const overlapY =
        Math.min(current.component.maxY, candidate.component.maxY) -
        Math.max(current.component.minY, candidate.component.minY) +
        1;
      const centerDistance = Math.abs(
        (current.component.minY +
          current.component.maxY -
          candidate.component.minY -
          candidate.component.maxY) /
          2,
      );
      if (overlapY >= maxHeight * 0.15 || centerDistance <= maxHeight * 0.55)
        union(current.index, candidate.index);
    }
  }
  const grouped = new Map<number, Component[]>();
  for (let index = 0; index < components.length; index += 1) {
    const root = find(index);
    const group = grouped.get(root) ?? [];
    group.push(components[index]!);
    grouped.set(root, group);
  }
  return [...grouped.values()];
}

function scoreGroup(
  components: readonly Component[],
  width: number,
  height: number,
): CandidateGroup | null {
  const minX = Math.min(...components.map((component) => component.minX));
  const minY = Math.min(...components.map((component) => component.minY));
  const maxX = Math.max(...components.map((component) => component.maxX));
  const maxY = Math.max(...components.map((component) => component.maxY));
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const area = components.reduce((sum, component) => sum + component.area, 0);
  const aspect = boxWidth / boxHeight;
  const density = area / (boxWidth * boxHeight);
  const relativeHeight = boxHeight / Math.min(width, height);
  const aspectScore =
    clamp01((aspect - 1.05) / 3.5) * clamp01((24 - aspect) / 12);
  const heightScore = clamp01((0.13 - relativeHeight) / 0.1);
  const densityScore = clamp01(1 - Math.abs(density - 0.22) / 0.32);
  const repetitionScore = clamp01((components.length - 1) / 5);
  const confidence =
    aspectScore * 0.3 +
    heightScore * 0.25 +
    densityScore * 0.3 +
    repetitionScore * 0.15;
  if (aspect < 1.05 || relativeHeight > 0.13 || density > 0.72) return null;
  return { components, minX, minY, maxX, maxY, area, confidence };
}

function createTextRegion(
  group: CandidateGroup,
  labels: Int32Array,
  rasterWidth: number,
  maskSpace: ReturnType<typeof createMaskSpace>,
  imageSpace: ImageSpace,
  xScale: number,
  yScale: number,
): TextRegion {
  const cropWidth = group.maxX - group.minX + 1;
  const cropHeight = group.maxY - group.minY + 1;
  const componentLabels = new Set(
    group.components.map((component) => component.label),
  );
  const runs: MaskRun[] = [];
  for (let y = group.minY; y <= group.maxY; y += 1) {
    let x = group.minX;
    while (x <= group.maxX) {
      while (
        x <= group.maxX &&
        !componentLabels.has(labels[y * rasterWidth + x]!)
      )
        x += 1;
      if (x > group.maxX) break;
      const start = x;
      while (
        x <= group.maxX &&
        componentLabels.has(labels[y * rasterWidth + x]!)
      )
        x += 1;
      runs.push(
        Object.freeze({
          y: y - group.minY,
          x: start - group.minX,
          length: x - start,
        }),
      );
    }
  }
  const left = group.minX * xScale - 0.5;
  const top = group.minY * yScale - 0.5;
  const right = (group.maxX + 1) * xScale - 0.5;
  const bottom = (group.maxY + 1) * yScale - 0.5;
  const polygon = Object.freeze({
    points: Object.freeze([
      Object.freeze({ x: left, y: top, coordinateSpace: imageSpace }),
      Object.freeze({ x: right, y: top, coordinateSpace: imageSpace }),
      Object.freeze({ x: right, y: bottom, coordinateSpace: imageSpace }),
      Object.freeze({ x: left, y: bottom, coordinateSpace: imageSpace }),
    ]),
    coordinateSpace: imageSpace,
  });
  const boundingBox = Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: imageSpace,
  });
  const mask = Object.freeze({
    width: cropWidth,
    height: cropHeight,
    runs: Object.freeze(runs),
    origin: Object.freeze({
      x: group.minX,
      y: group.minY,
      coordinateSpace: maskSpace,
    }),
    coordinateSpace: maskSpace,
  });
  return Object.freeze({
    id: `text-region:${imageSpace.id}:${group.minX}:${group.minY}:${cropWidth}:${cropHeight}`,
    mask,
    polygon,
    boundingBox,
    confidence: group.confidence,
    coordinateSpace: imageSpace,
  });
}

async function createDebugPng(
  original: Buffer,
  differences: Uint8Array,
  textMask: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const gray = original[pixel]!;
    const offset = pixel * 3;
    rgb[offset] = textMask[pixel] ? 255 : differences[pixel] ? 30 : gray;
    rgb[offset + 1] = textMask[pixel] ? 45 : differences[pixel] ? 190 : gray;
    rgb[offset + 2] = textMask[pixel] ? 35 : differences[pixel] ? 255 : gray;
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

async function createDifferencePng(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  const pixels = Buffer.from(Uint8Array.from(mask, (value) => value * 255));
  return sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
