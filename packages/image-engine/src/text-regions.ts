import sharp from 'sharp';
import {
  createMaskSpace,
  type BinaryMask,
  type Bounds,
  type ImageDimensions,
  type ImageSpace,
  type MaskRun,
  type Point,
  type Polygon,
} from '@comic-captioner/shared';

/**
 * Comic text-region detection.
 *
 * Detects lettering regions (dialogue, narration, signs, sound effects)
 * independently of speech-bubble geometry. The deterministic path uses
 * page-ink components and line grouping so it runs in Node without model
 * weights. An optional proposal provider can raise recall when a compatible
 * model is available.
 *
 * Geometry provenance is always explicit:
 * - `model`     — polygon/mask comes from a detector model
 * - `derived`   — geometry is computed from page pixels (contours/boxes)
 * - `hybrid`    — model proposal refined by deterministic geometry
 *
 * Confidence values here are text-region detection confidence only. OCR
 * recognition and bubble-association confidence are separate fields
 * elsewhere and must never be substituted for these values.
 */

export type TextRegionGeometryProvenance = 'model' | 'derived' | 'hybrid';

export type TextRegionDetectionSource = 'deterministic' | 'model' | 'heuristic';

export type TextRegionKindHint =
  | 'unknown'
  | 'dialogue-candidate'
  | 'narration-candidate'
  | 'sfx-candidate';

export interface DetectedTextRegion {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
  /**
   * Region outline in original-image pixel coordinates. Derived from ink
   * components when no model polygon is supplied; never fabricated from a
   * bare bounding box without recording `geometryProvenance: 'derived'`.
   */
  readonly polygon: Polygon<ImageSpace>;
  /** Segmentation mask when the detector produced one; otherwise null. */
  readonly mask: BinaryMask | null;
  /** Text-region detection confidence in [0, 1]. Not OCR or association. */
  readonly confidence: number;
  readonly coordinateSpace: ImageSpace;
  readonly geometryProvenance: TextRegionGeometryProvenance;
  readonly detectionSource: TextRegionDetectionSource;
  /** Optional soft label; never a hard dialogue classification. */
  readonly kindHint: TextRegionKindHint;
  /** Stable order index within one analysis result (0-based). */
  readonly order: number;
  /** True when confidence is low or geometry is uncertain. */
  readonly needsReview: boolean;
  readonly algorithmVersion: string;
}

export interface TextRegionDetectionResult {
  readonly regions: readonly DetectedTextRegion[];
  readonly coordinateSpace: ImageSpace;
  readonly imageDimensions: ImageDimensions;
  readonly provider: string;
  readonly algorithmVersion: string;
  readonly analysisWidth: number;
  readonly analysisHeight: number;
}

/** A recall-oriented candidate from an optional model or heuristic. */
export interface TextRegionProposal {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
  /** Model-native polygon when available. Do not invent one from a box. */
  readonly polygon?: Polygon<ImageSpace>;
  /** Model-native mask when available. */
  readonly mask?: BinaryMask | null;
  /** Detector confidence in [0, 1]. */
  readonly confidence: number;
  readonly provenance: 'model' | 'heuristic';
}

export interface TextRegionProposalProvider {
  readonly name: string;
  propose(
    image: Uint8Array,
    space: ImageSpace,
  ): Promise<readonly TextRegionProposal[]> | readonly TextRegionProposal[];
}

export interface TextRegionDetectionOptions {
  /** Cap analysis side before ink extraction (default 2400). */
  readonly maximumAnalysisSide?: number;
  /** Luminance below which a pixel counts as ink (default 140). */
  readonly inkLuminanceThreshold?: number;
  /** Minimum connected ink component area in analysis pixels (default 4). */
  readonly minimumComponentArea?: number;
  /** Maximum component area as a fraction of the page (default 0.12). */
  readonly maximumAreaRatio?: number;
  /** Vertical gap factor for line grouping (default 0.7 × median height). */
  readonly lineGapFactor?: number;
  /** Regions below this confidence are flagged `needsReview` (default 0.55). */
  readonly reviewConfidenceThreshold?: number;
  /** Drop regions whose text-likeness score is below this (default 0.18). */
  readonly minimumRegionScore?: number;
  /**
   * Maximum final region area as a fraction of the page (default 0.12).
   * Prevents line-merging from swallowing whole panels or the full page.
   */
  readonly maximumRegionAreaRatio?: number;
}

export interface TextRegionDetectorOptions {
  readonly provider?: TextRegionProposalProvider;
  readonly defaults?: TextRegionDetectionOptions;
}

export class TextRegionDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextRegionDetectionError';
  }
}

const ALGORITHM_VERSION = 'text-regions-1';
const MAX_DECODED_PIXELS = 40_000_000;
const DEFAULT_MAXIMUM_ANALYSIS_SIDE = 2400;
const DEFAULT_INK_LUMINANCE_THRESHOLD = 140;
const DEFAULT_MINIMUM_COMPONENT_AREA = 4;
const DEFAULT_MAXIMUM_AREA_RATIO = 0.12;
const DEFAULT_LINE_GAP_FACTOR = 0.7;
const DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_MINIMUM_REGION_SCORE = 0.18;
const DEFAULT_MAXIMUM_REGION_AREA_RATIO = 0.12;

interface InkComponent {
  readonly id: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly pixelCount: number;
}

/**
 * Detects lettering regions on a comic page. Heavy decode and component
 * analysis stay in this Node package; callers must not load this in browsers
 * that cannot run `sharp`.
 */
export class TextRegionDetector {
  readonly #provider: TextRegionProposalProvider | null;
  readonly #defaults: TextRegionDetectionOptions;

  constructor(options: TextRegionDetectorOptions = {}) {
    this.#provider = options.provider ?? null;
    this.#defaults = options.defaults ?? {};
    Object.freeze(this);
  }

  async detect(
    image: Uint8Array,
    coordinateSpace: ImageSpace,
    options: TextRegionDetectionOptions = {},
  ): Promise<TextRegionDetectionResult> {
    const settings = resolveOptions(this.#defaults, options);
    let metadata: {
      width?: number | undefined;
      height?: number | undefined;
      orientation?: number | undefined;
    };
    try {
      metadata = await sharp(image).metadata();
    } catch (cause) {
      throw new TextRegionDetectionError(
        `The comic image is not decodable: ${cause instanceof Error ? cause.message : 'unknown error'}`,
      );
    }
    if (!metadata.width || !metadata.height) {
      throw new TextRegionDetectionError('The comic image is not decodable.');
    }
    if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
      throw new TextRegionDetectionError(
        'The comic image exceeds 40 megapixels.',
      );
    }
    const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
    const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
    if (
      orientedWidth !== coordinateSpace.dimensions.width ||
      orientedHeight !== coordinateSpace.dimensions.height
    ) {
      throw new TextRegionDetectionError(
        'The image dimensions do not match the declared ImageSpace.',
      );
    }

    const maxSide = settings.maximumAnalysisSide!;
    const scale = Math.min(
      1,
      maxSide / Math.max(orientedWidth, orientedHeight),
    );
    const analysisWidth = Math.max(1, Math.round(orientedWidth * scale));
    const analysisHeight = Math.max(1, Math.round(orientedHeight * scale));
    const scaleX = orientedWidth / analysisWidth;
    const scaleY = orientedHeight / analysisHeight;

    const { data } = await sharp(image)
      .rotate()
      .resize(analysisWidth, analysisHeight, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const components = findInkComponents(
      gray,
      analysisWidth,
      analysisHeight,
      settings,
    );
    const grouped = groupComponentsIntoRegions(
      components,
      analysisWidth,
      analysisHeight,
      settings,
    );
    const deterministic = grouped.map((group, index) =>
      groupToRegion(
        `text-${coordinateSpace.id}-${index + 1}`,
        group,
        index,
        coordinateSpace,
        analysisWidth,
        analysisHeight,
        scaleX,
        scaleY,
        settings,
      ),
    );

    let proposals: readonly TextRegionProposal[] = [];
    if (this.#provider) {
      proposals = await this.#provider.propose(image, coordinateSpace);
      for (const proposal of proposals) {
        validateProposal(proposal, coordinateSpace);
      }
    }

    const merged = mergeProposals(
      deterministic,
      proposals,
      coordinateSpace,
      scaleX,
      scaleY,
      settings,
    );

    return Object.freeze({
      regions: Object.freeze(merged),
      coordinateSpace,
      imageDimensions: Object.freeze({
        width: orientedWidth,
        height: orientedHeight,
      }),
      provider: this.#provider
        ? `deterministic+${this.#provider.name}`
        : 'deterministic',
      algorithmVersion: ALGORITHM_VERSION,
      analysisWidth,
      analysisHeight,
    });
  }
}

// ---------------------------------------------------------------------------
// Deterministic ink analysis
// ---------------------------------------------------------------------------

function findInkComponents(
  gray: Uint8Array,
  width: number,
  height: number,
  options: Required<TextRegionDetectionOptions>,
): InkComponent[] {
  const threshold = options.inkLuminanceThreshold;
  const visited = new Uint8Array(width * height);
  const components: InkComponent[] = [];
  const stack: number[] = [];
  const pageArea = width * height;
  const maximumArea = Math.floor(pageArea * options.maximumAreaRatio);

  for (let start = 0; start < pageArea; start += 1) {
    if (visited[start] || gray[start]! >= threshold) continue;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let pixelCount = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index / width) | 0;
      pixelCount += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      // 4-connected neighborhood keeps glyph strokes from bridging across
      // anti-aliased diagonal gaps into neighbouring letters.
      if (x > 0) {
        const n = index - 1;
        if (!visited[n] && gray[n]! < threshold) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (x + 1 < width) {
        const n = index + 1;
        if (!visited[n] && gray[n]! < threshold) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = index - width;
        if (!visited[n] && gray[n]! < threshold) {
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (y + 1 < height) {
        const n = index + width;
        if (!visited[n] && gray[n]! < threshold) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (pixelCount < options.minimumComponentArea) continue;
    if (pixelCount > maximumArea) continue;
    components.push({
      id: components.length,
      minX,
      minY,
      maxX,
      maxY,
      pixelCount,
    });
  }
  return components;
}

function groupComponentsIntoRegions(
  components: readonly InkComponent[],
  _width: number,
  _height: number,
  options: Required<TextRegionDetectionOptions>,
): InkComponent[][] {
  if (components.length === 0) return [];
  const heights = components
    .map((c) => c.maxY - c.minY + 1)
    .sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)]!;
  const maxGap = Math.max(2, medianHeight * options.lineGapFactor);

  const ordered = [...components].sort(
    (a, b) => a.minY - b.minY || a.minX - b.minX,
  );
  const groups: InkComponent[][] = [];
  for (const component of ordered) {
    let target: InkComponent[] | null = null;
    for (const group of groups) {
      const box = groupBounds(group);
      const verticalGap = Math.max(
        box.minY - (component.maxY + 1),
        component.minY - (box.maxY + 1),
        0,
      );
      const height = component.maxY - component.minY + 1;
      const groupHeight = box.maxY - box.minY + 1;
      const heightCompatible =
        Math.abs(height - groupHeight) <= Math.max(2, groupHeight * 0.85);
      // Same visual line: nearly the same row band and a small horizontal gap.
      if (verticalGap <= maxGap && heightCompatible) {
        const horizontalGap = Math.max(
          box.minX - (component.maxX + 1),
          component.minX - (box.maxX + 1),
          0,
        );
        if (horizontalGap <= maxGap * 2.5) {
          target = group;
          break;
        }
      }
    }
    if (target) target.push(component);
    else groups.push([component]);
  }

  // Merge groups that share a horizontal band and sit close together so a
  // single text line is not split mid-word. Skip merges that would swallow
  // a large fraction of the page.
  const maxRegionArea = Math.floor(
    _width * _height * (options.maximumRegionAreaRatio ?? DEFAULT_MAXIMUM_REGION_AREA_RATIO),
  );
  const merged: InkComponent[][] = [];
  for (const group of groups) {
    const box = groupBounds(group);
    const companion = merged.find((candidate) => {
      const other = groupBounds(candidate);
      const combinedArea =
        (Math.max(box.maxX, other.maxX) - Math.min(box.minX, other.minX) + 1) *
        (Math.max(box.maxY, other.maxY) - Math.min(box.minY, other.minY) + 1);
      if (combinedArea > maxRegionArea) return false;
      const verticalOverlap = Math.min(box.maxY, other.maxY) - Math.max(box.minY, other.minY);
      const horizontalGap = Math.max(
        box.minX - (other.maxX + 1),
        other.minX - (box.maxX + 1),
        0,
      );
      return verticalOverlap > 0 && horizontalGap <= maxGap * 1.25;
    });
    if (companion) companion.push(...group);
    else merged.push([...group]);
  }
  // Drop leftover page-sized blobs that still slipped through.
  return merged.filter((group) => {
    const box = groupBounds(group);
    const area =
      (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1);
    return area <= maxRegionArea;
  });
}

function groupBounds(group: readonly InkComponent[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  let area = 0;
  for (const component of group) {
    minX = Math.min(minX, component.minX);
    minY = Math.min(minY, component.minY);
    maxX = Math.max(maxX, component.maxX);
    maxY = Math.max(maxY, component.maxY);
    area += component.pixelCount;
  }
  return { minX, minY, maxX, maxY, area };
}

function groupToRegion(
  id: string,
  group: readonly InkComponent[],
  order: number,
  coordinateSpace: ImageSpace,
  analysisWidth: number,
  analysisHeight: number,
  scaleX: number,
  scaleY: number,
  options: Required<TextRegionDetectionOptions>,
): DetectedTextRegion {
  const box = groupBounds(group);
  const analysisBounds = {
    x: box.minX,
    y: box.minY,
    width: box.maxX - box.minX + 1,
    height: box.maxY - box.minY + 1,
  };
  // Map analysis pixel edges back to original image pixel edges.
  const boundingBox = freezeBounds(
    analysisBounds.x * scaleX,
    analysisBounds.y * scaleY,
    analysisBounds.width * scaleX,
    analysisBounds.height * scaleY,
    coordinateSpace,
  );
  const polygon = rectPolygon(boundingBox, coordinateSpace);
  const mask = componentMask(group, coordinateSpace, scaleX, scaleY);
  const score = textLikenessScore(
    analysisBounds,
    box.area,
    group.length,
    analysisWidth,
    analysisHeight,
  );
  const confidence = clamp01(score);
  const needsReview = confidence < options.reviewConfidenceThreshold!;
  return Object.freeze({
    id,
    boundingBox,
    polygon,
    mask,
    confidence,
    coordinateSpace,
    geometryProvenance: 'derived' as const,
    detectionSource: 'deterministic' as const,
    kindHint: kindHintFor(boundingBox, coordinateSpace),
    order,
    needsReview,
    algorithmVersion: ALGORITHM_VERSION,
  });
}

function componentMask(
  group: readonly InkComponent[],
  coordinateSpace: ImageSpace,
  scaleX: number,
  scaleY: number,
): BinaryMask | null {
  if (group.length === 0) return null;
  const box = groupBounds(group);
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  if (width * height > 2_000_000) return null;
  const runs: MaskRun[] = [];
  // Approximate the component bounding boxes as filled runs. This is derived
  // geometry (component extents), not a model segmentation mask.
  for (const component of group) {
    const localX = component.minX - box.minX;
    const localY = component.minY - box.minY;
    const runWidth = component.maxX - component.minX + 1;
    for (let y = localY; y <= component.maxY - box.minY; y += 1) {
      runs.push({ y, x: localX, length: runWidth });
    }
  }
  const maskSpace = createMaskSpace(
    `text-mask:${coordinateSpace.id}:${box.minX},${box.minY}`,
    coordinateSpace,
    Math.max(1, Math.round(coordinateSpace.dimensions.width / scaleX)),
    Math.max(1, Math.round(coordinateSpace.dimensions.height / scaleY)),
  );
  return Object.freeze({
    width,
    height,
    runs: Object.freeze(runs),
    origin: Object.freeze({
      x: box.minX * scaleX,
      y: box.minY * scaleY,
      coordinateSpace: maskSpace,
    }) as Point<ReturnType<typeof createMaskSpace>>,
    coordinateSpace: maskSpace,
  });
}

function textLikenessScore(
  bounds: { width: number; height: number },
  inkArea: number,
  componentCount: number,
  pageWidth: number,
  pageHeight: number,
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 0;
  const boxArea = bounds.width * bounds.height;
  const fill = inkArea / boxArea;
  // Text lines are wider than tall or roughly square; huge aspect ratios
  // usually mean panel borders or artwork strokes.
  const aspect = bounds.width / bounds.height;
  const aspectScore =
    aspect >= 0.6 && aspect <= 18
      ? 1
      : aspect < 0.6
        ? Math.max(0, aspect / 0.6)
        : Math.max(0, 1 - (aspect - 18) / 30);
  // Typical lettering occupies a small fraction of the page.
  const areaRatio = boxArea / (pageWidth * pageHeight);
  const areaScore =
    areaRatio <= 0.04 ? 1 : Math.max(0, 1 - (areaRatio - 0.04) / 0.12);
  // Multiple small components on one line look like words.
  const clusterScore = Math.min(1, componentCount / 3);
  const fillScore = fill >= 0.08 && fill <= 0.75 ? 1 : 0.35;
  return clamp01(
    0.28 * aspectScore +
      0.22 * areaScore +
      0.28 * clusterScore +
      0.22 * fillScore,
  );
}

function kindHintFor(
  bounds: Bounds<ImageSpace>,
  space: ImageSpace,
): TextRegionKindHint {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const nx = cx / space.dimensions.width;
  const ny = cy / space.dimensions.height;
  // Soft layout priors only. Classification is completed by bubble
  // association and user review, never by this hint alone.
  if (ny < 0.12 || ny > 0.9) return 'narration-candidate';
  if (bounds.width > space.dimensions.width * 0.45) return 'narration-candidate';
  if (bounds.height < space.dimensions.height * 0.03 && nx > 0.55)
    return 'sfx-candidate';
  return 'dialogue-candidate';
}

// ---------------------------------------------------------------------------
// Proposal merge
// ---------------------------------------------------------------------------

function mergeProposals(
  deterministic: readonly DetectedTextRegion[],
  proposals: readonly TextRegionProposal[],
  coordinateSpace: ImageSpace,
  scaleX: number,
  scaleY: number,
  options: Required<TextRegionDetectionOptions>,
): DetectedTextRegion[] {
  const merged: DetectedTextRegion[] = [...deterministic];
  const used = new Set<number>();

  for (const proposal of [...proposals].sort(
    (a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id),
  )) {
    let bestIndex = -1;
    let bestIou = 0;
    for (const [index, region] of merged.entries()) {
      if (used.has(index)) continue;
      const iou = boxIou(proposal.boundingBox, region.boundingBox);
      if (iou > bestIou) {
        bestIou = iou;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestIou >= 0.35) {
      const region = merged[bestIndex]!;
      used.add(bestIndex);
      // Keep the richer of the two geometries without inventing a model mask.
      const useModelPolygon = Boolean(proposal.polygon);
      merged[bestIndex] = Object.freeze({
        ...region,
        boundingBox: envelopeBounds(
          region.boundingBox,
          proposal.boundingBox,
          coordinateSpace,
        ),
        polygon:
          useModelPolygon && proposal.polygon
            ? proposal.polygon
            : region.polygon,
        mask: proposal.mask ?? region.mask,
        confidence: clamp01(
          Math.max(region.confidence, proposal.confidence) * 0.7 +
            ((region.confidence + proposal.confidence) / 2) * 0.3,
        ),
        geometryProvenance: useModelPolygon
          ? ('hybrid' as const)
          : region.geometryProvenance,
        detectionSource: 'model' as const,
        needsReview: false,
      });
    } else if (proposal.confidence >= options.minimumRegionScore!) {
      const polygon =
        proposal.polygon ??
        rectPolygon(proposal.boundingBox, coordinateSpace);
      merged.push(
        Object.freeze({
          id: proposal.id,
          boundingBox: proposal.boundingBox,
          polygon,
          mask: proposal.mask ?? null,
          confidence: clamp01(proposal.confidence),
          coordinateSpace,
          geometryProvenance: proposal.polygon
            ? ('model' as const)
            : ('derived' as const),
          detectionSource: 'model' as const,
          kindHint: kindHintFor(proposal.boundingBox, coordinateSpace),
          order: merged.length,
          needsReview: proposal.confidence < options.reviewConfidenceThreshold!,
          algorithmVersion: ALGORITHM_VERSION,
        }),
      );
    }
  }

  // Re-index order after merge so callers get a dense stable sequence.
  return merged.map((region, index) =>
    Object.freeze({ ...region, order: index }),
  );
}

function validateProposal(
  proposal: TextRegionProposal,
  space: ImageSpace,
): void {
  if (!proposal.id.trim()) {
    throw new TextRegionDetectionError('Text-region proposal ID is required.');
  }
  const box = proposal.boundingBox;
  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    throw new TextRegionDetectionError(
      `Text-region proposal ${proposal.id} has an invalid bounding box.`,
    );
  }
  if (
    box.x + box.width < 0 ||
    box.y + box.height < 0 ||
    box.x > space.dimensions.width ||
    box.y > space.dimensions.height
  ) {
    throw new TextRegionDetectionError(
      `Text-region proposal ${proposal.id} lies outside the image space.`,
    );
  }
  if (
    !Number.isFinite(proposal.confidence) ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    throw new TextRegionDetectionError(
      `Text-region proposal ${proposal.id} confidence must be in [0, 1].`,
    );
  }
  if (proposal.polygon && proposal.polygon.points.length < 3) {
    throw new TextRegionDetectionError(
      `Text-region proposal ${proposal.id} polygon needs at least 3 points.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function freezeBounds(
  x: number,
  y: number,
  width: number,
  height: number,
  space: ImageSpace,
): Bounds<ImageSpace> {
  return Object.freeze({
    x,
    y,
    width,
    height,
    coordinateSpace: space,
  });
}

function rectPolygon(
  bounds: Bounds<ImageSpace>,
  space: ImageSpace,
): Polygon<ImageSpace> {
  const points = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => Object.freeze({ ...point, coordinateSpace: space }));
  return Object.freeze({
    points: Object.freeze(points),
    coordinateSpace: space,
  });
}

function envelopeBounds(
  a: Bounds<ImageSpace>,
  b: Bounds<ImageSpace>,
  space: ImageSpace,
): Bounds<ImageSpace> {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return freezeBounds(x, y, right - x, bottom - y, space);
}

function boxIou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  const height = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function resolveOptions(
  defaults: TextRegionDetectionOptions,
  overrides: TextRegionDetectionOptions,
): Required<TextRegionDetectionOptions> {
  const merged = { ...defaults, ...overrides };
  const maximumAnalysisSide =
    merged.maximumAnalysisSide ?? DEFAULT_MAXIMUM_ANALYSIS_SIDE;
  const inkLuminanceThreshold =
    merged.inkLuminanceThreshold ?? DEFAULT_INK_LUMINANCE_THRESHOLD;
  const minimumComponentArea =
    merged.minimumComponentArea ?? DEFAULT_MINIMUM_COMPONENT_AREA;
  const maximumAreaRatio = merged.maximumAreaRatio ?? DEFAULT_MAXIMUM_AREA_RATIO;
  const lineGapFactor = merged.lineGapFactor ?? DEFAULT_LINE_GAP_FACTOR;
  const reviewConfidenceThreshold =
    merged.reviewConfidenceThreshold ?? DEFAULT_REVIEW_CONFIDENCE_THRESHOLD;
  const minimumRegionScore =
    merged.minimumRegionScore ?? DEFAULT_MINIMUM_REGION_SCORE;
  const maximumRegionAreaRatio =
    merged.maximumRegionAreaRatio ?? DEFAULT_MAXIMUM_REGION_AREA_RATIO;

  if (!Number.isFinite(maximumAnalysisSide) || maximumAnalysisSide < 32) {
    throw new TextRegionDetectionError(
      'maximumAnalysisSide must be at least 32.',
    );
  }
  if (
    !Number.isFinite(inkLuminanceThreshold) ||
    inkLuminanceThreshold < 0 ||
    inkLuminanceThreshold > 255
  ) {
    throw new TextRegionDetectionError(
      'inkLuminanceThreshold must be in [0, 255].',
    );
  }
  if (!Number.isFinite(minimumComponentArea) || minimumComponentArea < 1) {
    throw new TextRegionDetectionError(
      'minimumComponentArea must be at least 1.',
    );
  }
  if (
    !Number.isFinite(maximumAreaRatio) ||
    maximumAreaRatio <= 0 ||
    maximumAreaRatio > 1
  ) {
    throw new TextRegionDetectionError(
      'maximumAreaRatio must be in (0, 1].',
    );
  }
  if (!Number.isFinite(lineGapFactor) || lineGapFactor < 0) {
    throw new TextRegionDetectionError('lineGapFactor must be non-negative.');
  }
  if (
    !Number.isFinite(reviewConfidenceThreshold) ||
    reviewConfidenceThreshold < 0 ||
    reviewConfidenceThreshold > 1
  ) {
    throw new TextRegionDetectionError(
      'reviewConfidenceThreshold must be in [0, 1].',
    );
  }
  if (
    !Number.isFinite(minimumRegionScore) ||
    minimumRegionScore < 0 ||
    minimumRegionScore > 1
  ) {
    throw new TextRegionDetectionError(
      'minimumRegionScore must be in [0, 1].',
    );
  }
  if (
    !Number.isFinite(maximumRegionAreaRatio) ||
    maximumRegionAreaRatio <= 0 ||
    maximumRegionAreaRatio > 1
  ) {
    throw new TextRegionDetectionError(
      'maximumRegionAreaRatio must be in (0, 1].',
    );
  }

  return {
    maximumAnalysisSide,
    inkLuminanceThreshold,
    minimumComponentArea,
    maximumAreaRatio,
    lineGapFactor,
    reviewConfidenceThreshold,
    minimumRegionScore,
    maximumRegionAreaRatio,
  };
}
