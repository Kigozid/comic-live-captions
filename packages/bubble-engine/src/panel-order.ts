import sharp from 'sharp';
import type { Bounds, ImageSpace } from '@comic-captioner/shared';

export type ReadingDirection = 'ltr' | 'rtl';

/** A detected panel rectangle in page coordinates (pixel-edge bounds). */
export interface Panel {
  readonly id: string;
  readonly bounds: Bounds<ImageSpace>;
  readonly coordinateSpace: ImageSpace;
  /** Panel area as a fraction of the page. */
  readonly areaRatio: number;
}

export interface PanelDetectionOptions {
  /** Luminance at or above which a pixel is gutter paper (default 242). */
  readonly gutterLuminanceThreshold?: number;
  /** Luminance below which a pixel seals panel borders (default 180). */
  readonly barrierLuminanceThreshold?: number;
  /** Minimum panel area as a fraction of the page (default 0.005). */
  readonly minimumPanelAreaRatio?: number;
  readonly maximumAnalysisSide?: number;
}

export interface PanelDetectionResult {
  readonly panels: readonly Panel[];
  readonly coordinateSpace: ImageSpace;
}

/** Minimal bubble geometry needed for reading-order derivation. */
export interface ReadingOrderBubbleInput {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
}

export class PanelOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelOrderError';
  }
}

const DEFAULT_GUTTER_LUMINANCE = 242;
const DEFAULT_BARRIER_LUMINANCE = 180;
const DEFAULT_MINIMUM_PANEL_AREA_RATIO = 0.005;
const DEFAULT_ANALYSIS_SIDE = 1600;
const MAX_DECODED_PIXELS = 40_000_000;
const MIN_PANEL_SIDE_PX = 6;

/**
 * Deterministic panel detection on the page grayscale: panel borders seal the
 * page into regions, gutter whitespace reachable from the page border is
 * removed, and connected components of the remainder are candidate panels.
 * Projection profiles then split any region that still contains a full-width
 * or full-height gutter band (borders with small gaps).
 */
export async function detectPanels(
  image: Uint8Array,
  coordinateSpace: ImageSpace,
  options: PanelDetectionOptions = {},
): Promise<PanelDetectionResult> {
  validatePanelOptions(options);
  const gutterLuminance =
    options.gutterLuminanceThreshold ?? DEFAULT_GUTTER_LUMINANCE;
  const barrierLuminance =
    options.barrierLuminanceThreshold ?? DEFAULT_BARRIER_LUMINANCE;
  const minimumPanelAreaRatio =
    options.minimumPanelAreaRatio ?? DEFAULT_MINIMUM_PANEL_AREA_RATIO;
  const gray = await decodeGray(
    image,
    options.maximumAnalysisSide ?? DEFAULT_ANALYSIS_SIDE,
    coordinateSpace,
  );
  const { data, width, height, scaleX, scaleY } = gray;
  const pixelCount = width * height;

  const whiteThrough = new Uint8Array(pixelCount);
  const barrier = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    if (data[index]! >= gutterLuminance) whiteThrough[index] = 1;
    if (data[index]! < barrierLuminance) barrier[index] = 1;
  }
  // Seal hairline gaps in panel borders so gutter flood fill cannot leak
  // into panel interiors.
  const sealedBarrier = dilate(barrier, width, height);
  const passable = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    if (whiteThrough[index] && !sealedBarrier[index]) passable[index] = 1;
  }

  const gutter = floodFromBorder(passable, width, height);
  const region = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    region[index] = gutter[index] ? 0 : 1;
  }

  const minimumArea = minimumPanelAreaRatio * pixelCount;
  const components = connectedComponents(region, width, height).filter(
    (component) =>
      component.area >= minimumArea &&
      component.maxX - component.minX + 1 >= MIN_PANEL_SIDE_PX &&
      component.maxY - component.minY + 1 >= MIN_PANEL_SIDE_PX,
  );

  const rects = components.flatMap((component) =>
    splitByProjectionProfiles(
      data,
      sealedBarrier,
      width,
      height,
      component.minX,
      component.minY,
      component.maxX,
      component.maxY,
      minimumArea,
    ),
  );

  const panels = rects
    .map((rect) =>
      toPanel(rect, scaleX, scaleY, coordinateSpace, pixelCount),
    )
    .sort(
      (a, b) =>
        a.bounds.y - b.bounds.y ||
        a.bounds.x - b.bounds.x ||
        a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height,
    )
    .map((panel, index) =>
      Object.freeze({
        id: `panel-${index + 1}`,
        bounds: panel.bounds,
        coordinateSpace: panel.coordinateSpace,
        areaRatio: panel.areaRatio,
      }),
    );

  return Object.freeze({
    panels: Object.freeze(panels),
    coordinateSpace,
  });
}

/**
 * Orders bubbles into a reading sequence: panel order first (row-major,
 * left-to-right or right-to-left within each row), then bubble position
 * within each panel using the same scheme. Bubbles outside every panel join
 * the nearest one; with no panels the page reads as a single region.
 */
export function deriveReadingOrder(
  bubbles: readonly ReadingOrderBubbleInput[],
  panels: readonly Panel[],
  direction: ReadingDirection,
): readonly string[] {
  if (direction !== 'ltr' && direction !== 'rtl') {
    throw new PanelOrderError('Reading direction must be ltr or rtl.');
  }
  if (bubbles.length === 0) return Object.freeze([]);
  resolveSpace(bubbles, panels);
  for (const bubble of bubbles) {
    validateBounds(bubble.boundingBox, 'Bubble bounds');
    if (!bubble.id.trim()) throw new PanelOrderError('Bubble ID is required.');
  }
  for (const panel of panels) {
    validateBounds(panel.bounds, 'Panel bounds');
    if (!panel.id.trim()) throw new PanelOrderError('Panel ID is required.');
  }

  const panelOrder = rowMajorOrder(
    panels.map((panel) => panel.bounds),
    direction,
  );
  const groupCount = panels.length > 0 ? panels.length : 1;
  const groups: number[][] = Array.from({ length: groupCount }, () => []);
  for (const [bubbleIndex, bubble] of bubbles.entries()) {
    if (panels.length === 0) {
      groups[0]!.push(bubbleIndex);
      continue;
    }
    let bestPanel = -1;
    let bestIou = 0;
    for (const [panelIndex, panel] of panels.entries()) {
      const iou = boundsIoU(bubble.boundingBox, panel.bounds);
      if (iou > bestIou) {
        bestIou = iou;
        bestPanel = panelIndex;
      }
    }
    if (bestIou <= 0) {
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [panelIndex, panel] of panels.entries()) {
        const distance = centerDistance(bubble.boundingBox, panel.bounds);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPanel = panelIndex;
        }
      }
    }
    groups[bestPanel]!.push(bubbleIndex);
  }

  const ordered: string[] = [];
  const panelSequence =
    panels.length > 0 ? panelOrder : [0];
  for (const panelIndex of panelSequence) {
    const members = groups[panelIndex] ?? [];
    const memberOrder = rowMajorOrder(
      members.map((index) => bubbles[index]!.boundingBox),
      direction,
    );
    for (const member of memberOrder) {
      ordered.push(bubbles[members[member]!]!.id);
    }
  }
  return Object.freeze(ordered);
}

interface AnalysisRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function toPanel(
  rect: AnalysisRect,
  scaleX: number,
  scaleY: number,
  coordinateSpace: ImageSpace,
  pixelCount: number,
): Omit<Panel, 'id'> {
  const left = rect.minX * scaleX - 0.5;
  const top = rect.minY * scaleY - 0.5;
  const right = (rect.maxX + 1) * scaleX - 0.5;
  const bottom = (rect.maxY + 1) * scaleY - 0.5;
  const bounds: Bounds<ImageSpace> = Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace,
  });
  const width = rect.maxX - rect.minX + 1;
  const height = rect.maxY - rect.minY + 1;
  return Object.freeze({
    bounds,
    coordinateSpace,
    areaRatio: (width * height) / pixelCount,
  });
}

/**
 * Splits a candidate region at projection-profile gutter bands: rows (then
 * columns) that contain no barrier ink and are light enough to be whitespace,
 * separating two substantial content bands.
 */
function splitByProjectionProfiles(
  gray: Uint8Array,
  barrier: Uint8Array,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  minimumArea: number,
): AnalysisRect[] {
  const rowBands = splitBands(
    gray,
    barrier,
    width,
    minX,
    maxX,
    minY,
    maxY,
    minimumArea,
    'row',
  );
  const rects: AnalysisRect[] = [];
  for (const band of rowBands) {
    const columnBands = splitBands(
      gray,
      barrier,
      width,
      band.minX,
      band.maxX,
      band.minY,
      band.maxY,
      minimumArea,
      'column',
    );
    for (const columnBand of columnBands) {
      if (
        (columnBand.maxX - columnBand.minX + 1) *
          (columnBand.maxY - columnBand.minY + 1) >=
        minimumArea
      ) {
        rects.push(columnBand);
      }
    }
  }
  return rects;
}

function splitBands(
  gray: Uint8Array,
  barrier: Uint8Array,
  width: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minimumArea: number,
  axis: 'row' | 'column',
): AnalysisRect[] {
  const spanStart = axis === 'row' ? minX : minY;
  const spanEnd = axis === 'row' ? maxX : maxY;
  const bandStart = axis === 'row' ? minY : minX;
  const bandEnd = axis === 'row' ? maxY : maxX;
  const spanLength = spanEnd - spanStart + 1;
  const isGutter: boolean[] = [];
  for (let band = bandStart; band <= bandEnd; band += 1) {
    let barrierCount = 0;
    let brightCount = 0;
    for (let span = spanStart; span <= spanEnd; span += 1) {
      const index = axis === 'row' ? band * width + span : span * width + band;
      if (barrier[index]) barrierCount += 1;
      if (gray[index]! >= 220) brightCount += 1;
    }
    // A gutter band has no border ink across the span and is almost entirely
    // paper. Panel interior rows keep at least their side borders, so they do
    // not register as gutters even when the panel is white inside.
    isGutter.push(barrierCount === 0 && brightCount / spanLength >= 0.92);
  }

  // Merge content runs across gutter runs that are too short or too close to
  // the region edge to separate two panels.
  const bands: { start: number; end: number }[] = [];
  let pending: { start: number; end: number } | null = null;
  let cursor = 0;
  while (cursor <= bandEnd - bandStart) {
    const runStart = cursor;
    const gutter = isGutter[cursor]!;
    while (
      cursor <= bandEnd - bandStart &&
      isGutter[cursor] === gutter
    ) {
      cursor += 1;
    }
    const runEnd = cursor - 1;
    if (!gutter) {
      if (pending) pending.end = bandStart + runEnd;
      else pending = { start: bandStart + runStart, end: bandStart + runEnd };
      continue;
    }
    const runLength = runEnd - runStart + 1;
    const hasContentBefore = pending !== null;
    const hasContentAfter = cursor <= bandEnd - bandStart && !isGutter[cursor];
    const splitsTwoBands =
      runLength >= 2 &&
      hasContentBefore &&
      hasContentAfter &&
      pending !== null &&
      pending.end - pending.start + 1 >= MIN_PANEL_SIDE_PX;
    if (splitsTwoBands) {
      bands.push(pending!);
      pending = null;
    }
  }
  if (pending) bands.push(pending);

  return bands
    .map((band) =>
      axis === 'row'
        ? { minX, maxX, minY: band.start, maxY: band.end }
        : { minY, maxY, minX: band.start, maxX: band.end },
    )
    .filter(
      (rect) =>
        (rect.maxX - rect.minX + 1) * (rect.maxY - rect.minY + 1) >=
        minimumArea,
    );
}

interface Component {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly area: number;
}

function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): Component[] {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const x0 = start % width;
    const y0 = Math.floor(start / width);
    const component = {
      minX: x0,
      minY: y0,
      maxX: x0,
      maxY: y0,
      area: 0,
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
      for (const [nx, ny] of [
        [x, y - 1],
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (mask[neighbor] && !seen[neighbor]) {
          seen[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    components.push(component);
  }
  return components;
}

function floodFromBorder(
  passable: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const reached = new Uint8Array(passable.length);
  const queue = new Int32Array(passable.length);
  let head = 0;
  let tail = 0;
  const push = (x: number, y: number) => {
    const index = y * width + x;
    if (!passable[index] || reached[index]) return;
    reached[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return reached;
}

function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index]) {
        result[index] = 1;
        continue;
      }
      let near = 0;
      for (let dy = -1; dy <= 1 && !near; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          if (mask[yy * width + xx]) near = 1;
        }
      }
      result[index] = near;
    }
  }
  return result;
}

/**
 * Row-major reading order for rectangles: top-to-bottom rows of vertically
 * overlapping items, left-to-right within a row for LTR and right-to-left for
 * RTL. Returns input indices in reading order.
 */
function rowMajorOrder(
  bounds: readonly Bounds<ImageSpace>[],
  direction: ReadingDirection,
): number[] {
  const indices = bounds.map((_, index) => index);
  indices.sort((a, b) => {
    const first = bounds[a]!;
    const second = bounds[b]!;
    const firstCenter = first.y + first.height / 2;
    const secondCenter = second.y + second.height / 2;
    return (
      firstCenter - secondCenter ||
      first.x - second.x ||
      a - b
    );
  });
  const rows: number[][] = [];
  const rowSpans: { top: number; bottom: number }[] = [];
  for (const index of indices) {
    const box = bounds[index]!;
    let placed = false;
    for (let row = 0; row < rows.length; row += 1) {
      const span = rowSpans[row]!;
      const overlap =
        Math.min(span.bottom, box.y + box.height) - Math.max(span.top, box.y);
      const shorterSide = Math.min(span.bottom - span.top, box.height);
      if (overlap >= shorterSide * 0.5) {
        rows[row]!.push(index);
        span.top = Math.min(span.top, box.y);
        span.bottom = Math.max(span.bottom, box.y + box.height);
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([index]);
      rowSpans.push({ top: box.y, bottom: box.y + box.height });
    }
  }
  const ordered: number[] = [];
  for (const row of rows) {
    row.sort((a, b) =>
      direction === 'ltr'
        ? bounds[a]!.x - bounds[b]!.x || a - b
        : bounds[b]!.x - bounds[a]!.x || a - b,
    );
    ordered.push(...row);
  }
  return ordered;
}

function boundsIoU(a: Bounds<ImageSpace>, b: Bounds<ImageSpace>): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection =
    right > left && bottom > top ? (right - left) * (bottom - top) : 0;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function centerDistance(a: Bounds<ImageSpace>, b: Bounds<ImageSpace>): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function resolveSpace(
  bubbles: readonly ReadingOrderBubbleInput[],
  panels: readonly Panel[],
): ImageSpace {
  const geometries: Bounds<ImageSpace>[] = [
    ...bubbles.map((bubble) => bubble.boundingBox),
    ...panels.map((panel) => panel.bounds),
  ];
  if (geometries.length === 0) {
    throw new PanelOrderError(
      'At least one bubble or panel is required to derive reading order.',
    );
  }
  const space = geometries[0]!.coordinateSpace;
  if (space.kind !== 'image') {
    throw new PanelOrderError('Reading-order geometry must use an ImageSpace.');
  }
  for (const bounds of geometries) {
    if (
      bounds.coordinateSpace.id !== space.id ||
      bounds.coordinateSpace.kind !== 'image'
    ) {
      throw new PanelOrderError(
        'All reading-order geometry must share one ImageSpace.',
      );
    }
  }
  return space;
}

function validateBounds(bounds: Bounds<ImageSpace>, label: string): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new PanelOrderError(
      `${label} must be finite with positive width and height.`,
    );
  }
}

function validatePanelOptions(options: PanelDetectionOptions): void {
  const values = [
    options.gutterLuminanceThreshold,
    options.barrierLuminanceThreshold,
    options.minimumPanelAreaRatio,
    options.maximumAnalysisSide,
  ];
  if (values.some((value) => value !== undefined && !Number.isFinite(value))) {
    throw new PanelOrderError('Panel detection options must be finite numbers.');
  }
  if (
    options.gutterLuminanceThreshold !== undefined &&
    (options.gutterLuminanceThreshold < 0 ||
      options.gutterLuminanceThreshold > 255)
  ) {
    throw new PanelOrderError('Gutter luminance threshold must be within 0–255.');
  }
  if (
    options.barrierLuminanceThreshold !== undefined &&
    (options.barrierLuminanceThreshold < 0 ||
      options.barrierLuminanceThreshold > 255)
  ) {
    throw new PanelOrderError(
      'Barrier luminance threshold must be within 0–255.',
    );
  }
  if (
    options.minimumPanelAreaRatio !== undefined &&
    (options.minimumPanelAreaRatio <= 0 || options.minimumPanelAreaRatio >= 1)
  ) {
    throw new PanelOrderError('Minimum panel area ratio must be within (0, 1).');
  }
  if (
    options.maximumAnalysisSide !== undefined &&
    options.maximumAnalysisSide < 128
  ) {
    throw new PanelOrderError(
      'Maximum analysis side must be at least 128 pixels.',
    );
  }
}

interface GrayRaster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

async function decodeGray(
  bytes: Uint8Array,
  maxSide: number,
  coordinateSpace: ImageSpace,
): Promise<GrayRaster> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) {
    throw new PanelOrderError('The comic image is not decodable.');
  }
  if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
    throw new PanelOrderError('The comic image exceeds 40 megapixels.');
  }
  const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
  const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
  if (
    orientedWidth !== coordinateSpace.dimensions.width ||
    orientedHeight !== coordinateSpace.dimensions.height
  ) {
    throw new PanelOrderError(
      'The image dimensions must match the declared ImageSpace.',
    );
  }
  const scale = Math.min(1, maxSide / Math.max(orientedWidth, orientedHeight));
  const width = Math.max(1, Math.round(orientedWidth * scale));
  const height = Math.max(1, Math.round(orientedHeight * scale));
  const { data } = await sharp(bytes)
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width,
    height,
    scaleX: orientedWidth / width,
    scaleY: orientedHeight / height,
  };
}
