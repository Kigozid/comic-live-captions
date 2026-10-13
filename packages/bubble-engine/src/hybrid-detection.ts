import sharp from 'sharp';
import {
  createMaskSpace,
  type Bounds,
  type ImageSpace,
  type MaskRun,
  type Point,
  type Polygon,
} from '@comic-captioner/shared';
import {
  BubbleDetectionEngine,
  type Bubble,
  type BubbleDetectionOptions,
  type BubbleKind,
  type BubbleShape,
} from './index.js';

/** Where a bubble candidate came from before deterministic refinement. */
export type BubbleProposalProvenance = 'heuristic' | 'ml';

/**
 * A recall-oriented bubble candidate from an ML model or a heuristic CV
 * provider. Proposals never carry final geometry: deterministic refinement
 * and validation always produce the emitted bubble.
 */
export interface BubbleProposal {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly polygon?: Polygon<ImageSpace>;
  /** Provider confidence in [0, 1]. */
  readonly confidence: number;
  readonly provenance: BubbleProposalProvenance;
}

/**
 * Injectable proposal source. The ML side is out of scope here (no network);
 * any implementation — model wrapper or heuristic — plugs in through this
 * port and is validated on the way in.
 */
export interface BubbleProposalProvider {
  readonly name: string;
  readonly provenance: BubbleProposalProvenance;
  propose(
    image: Uint8Array,
    space: ImageSpace,
  ): Promise<readonly BubbleProposal[]> | readonly BubbleProposal[];
}

/** Deterministic geometry metrics; always computed from page pixels. */
export interface GeometryQuality {
  readonly areaRatio: number;
  readonly fillRatio: number;
  readonly interiorLuminance: number;
  readonly boundaryContrast: number;
  readonly edgeContactRatio: number;
  readonly score: number;
}

export interface ProposalSupport {
  readonly proposalId: string;
  readonly provider: string;
  readonly provenance: BubbleProposalProvenance;
  readonly confidence: number;
  /** Intersection-over-union of the proposal box with the final bubble box. */
  readonly iou: number;
}

export type HybridBubbleSource = 'detected' | 'heuristic' | 'ml';

export interface HybridBubble {
  readonly bubble: Bubble;
  /** Which pipelines found this bubble (deterministic and/or providers). */
  readonly sources: readonly HybridBubbleSource[];
  readonly support: readonly ProposalSupport[];
  readonly quality: GeometryQuality;
}

export interface HybridBubbleDetectionResult {
  readonly bubbles: readonly HybridBubble[];
  readonly coordinateSpace: ImageSpace;
  readonly deterministicCount: number;
  readonly proposalCount: number;
  /** Proposals matched to a deterministic bubble by IoU. */
  readonly mergedCount: number;
  /** Unmatched proposals promoted through deterministic refinement. */
  readonly refinedCount: number;
  /** Unmatched proposals rejected by deterministic validation. */
  readonly rejectedCount: number;
  readonly providerName: string | null;
}

export interface HybridBubbleDetectorOptions {
  /** Deterministic geometry engine; defaults to `BubbleDetectionEngine`. */
  readonly deterministic?: BubbleDetectionEngine;
  /** Optional recall-boosting proposal source (ML or heuristic). */
  readonly provider?: BubbleProposalProvider;
  readonly hybrid?: HybridDetectionOptions;
}

export interface HybridDetectionOptions {
  /** IoU at which a proposal is considered the same bubble (default 0.3). */
  readonly mergeIouThreshold?: number;
  /** Minimum deterministic quality score for an unmatched proposal (default 0.42). */
  readonly minimumRefinedQuality?: number;
  readonly maximumAnalysisSide?: number;
}

export class HybridBubbleDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HybridBubbleDetectionError';
  }
}

const ALGORITHM_VERSION = 'hybrid-bubble-1';
const DEFAULT_MERGE_IOU = 0.3;
const DEFAULT_MINIMUM_REFINED_QUALITY = 0.42;
const DEFAULT_ANALYSIS_SIDE = 1600;
const MAX_DECODED_PIXELS = 40_000_000;

/**
 * Merges proposal-provider candidates with deterministic detection: the
 * provider boosts recall, deterministic geometry refines contours, validates
 * every candidate, and always computes the quality metrics.
 */
export class HybridBubbleDetector {
  readonly #deterministic: BubbleDetectionEngine;
  readonly #provider: BubbleProposalProvider | null;
  readonly #hybrid: HybridDetectionOptions;

  constructor(options: HybridBubbleDetectorOptions = {}) {
    this.#deterministic =
      options.deterministic ?? new BubbleDetectionEngine();
    this.#provider = options.provider ?? null;
    this.#hybrid = options.hybrid ?? {};
    Object.freeze(this);
  }

  async detect(
    image: Uint8Array,
    coordinateSpace: ImageSpace,
    detectionOptions: BubbleDetectionOptions = {},
  ): Promise<HybridBubbleDetectionResult> {
    validateHybridOptions(this.#hybrid);
    const mergeIou = this.#hybrid.mergeIouThreshold ?? DEFAULT_MERGE_IOU;
    const minimumQuality =
      this.#hybrid.minimumRefinedQuality ?? DEFAULT_MINIMUM_REFINED_QUALITY;
    const deterministicResult = await this.#deterministic.detect(
      image,
      coordinateSpace,
      detectionOptions,
    );
    const proposals = this.#provider
      ? await this.#provider.propose(image, coordinateSpace)
      : [];
    for (const proposal of proposals) {
      validateProposal(proposal, coordinateSpace);
    }
    const gray = await decodeGray(
      image,
      this.#hybrid.maximumAnalysisSide ?? DEFAULT_ANALYSIS_SIDE,
    );

    const entries: {
      bubble: Bubble;
      support: ProposalSupport[];
      refined: boolean;
    }[] = deterministicResult.bubbles.map((bubble) => ({
      bubble,
      support: [],
      refined: false,
    }));

    const sortedProposals = [...proposals].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.boundingBox.x - b.boundingBox.x ||
        a.boundingBox.y - b.boundingBox.y ||
        a.id.localeCompare(b.id),
    );
    let mergedCount = 0;
    let refinedCount = 0;
    let rejectedCount = 0;
    for (const proposal of sortedProposals) {
      let bestIndex = -1;
      let bestIou = 0;
      for (const [index, entry] of entries.entries()) {
        const iou = boundsIoU(proposal.boundingBox, entry.bubble.boundingBox);
        if (iou > bestIou) {
          bestIou = iou;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0 && bestIou >= mergeIou) {
        entries[bestIndex]!.support.push(
          Object.freeze({
            proposalId: proposal.id,
            provider: this.#provider!.name,
            provenance: proposal.provenance,
            confidence: proposal.confidence,
            iou: bestIou,
          }),
        );
        mergedCount += 1;
        continue;
      }
      const refined = refineProposal(
        proposal,
        gray,
        coordinateSpace,
        minimumQuality,
      );
      if (!refined) {
        rejectedCount += 1;
        continue;
      }
      // A refined contour can overlap a known bubble even when the raw
      // proposal box did not; merge in that case as well.
      let refinedIndex = -1;
      let refinedIou = 0;
      for (const [index, entry] of entries.entries()) {
        const iou = boundsIoU(refined.bubble.boundingBox, entry.bubble.boundingBox);
        if (iou > refinedIou) {
          refinedIou = iou;
          refinedIndex = index;
        }
      }
      if (refinedIndex >= 0 && refinedIou >= mergeIou) {
        entries[refinedIndex]!.support.push(
          Object.freeze({
            proposalId: proposal.id,
            provider: this.#provider!.name,
            provenance: proposal.provenance,
            confidence: proposal.confidence,
            iou: refinedIou,
          }),
        );
        mergedCount += 1;
        continue;
      }
      entries.push({
        bubble: refined.bubble,
        support: [
          Object.freeze({
            proposalId: proposal.id,
            provider: this.#provider!.name,
            provenance: proposal.provenance,
            confidence: proposal.confidence,
            iou: 1,
          }),
        ],
        refined: true,
      });
      refinedCount += 1;
    }

    const bubbles = entries
      .map((entry) => {
        const confidence =
          entry.refined && entry.support.length > 0
            ? Math.min(
                1,
                0.45 * entry.support[0]!.confidence +
                  0.55 * entry.bubble.confidence,
              )
            : entry.support.length > 0
              ? Math.min(1, entry.bubble.confidence + 0.03 * entry.support.length)
              : entry.bubble.confidence;
        const bubble: Bubble = Object.freeze({
          ...entry.bubble,
          confidence,
        });
        return Object.freeze({
          bubble,
          sources: sourcesFor(entry),
          support: Object.freeze(entry.support),
          quality: computeGeometryQuality(
            gray,
            entry.bubble.boundingBox,
            coordinateSpace,
          ),
        });
      })
      .sort(
        (a, b) =>
          a.bubble.boundingBox.y - b.bubble.boundingBox.y ||
          a.bubble.boundingBox.x - b.bubble.boundingBox.x,
      );

    return Object.freeze({
      bubbles: Object.freeze(bubbles),
      coordinateSpace,
      deterministicCount: deterministicResult.bubbles.length,
      proposalCount: proposals.length,
      mergedCount,
      refinedCount,
      rejectedCount,
      providerName: this.#provider?.name ?? null,
    });
  }
}

function sourcesFor(entry: {
  support: readonly ProposalSupport[];
}): readonly HybridBubbleSource[] {
  // Deterministic geometry always produces the final contour, so `detected`
  // is present even for provider-only recall candidates.
  const sources: HybridBubbleSource[] = ['detected'];
  for (const support of entry.support) {
    const source: HybridBubbleSource =
      support.provenance === 'heuristic' ? 'heuristic' : 'ml';
    if (!sources.includes(source)) sources.push(source);
  }
  return Object.freeze(sources);
}

function validateHybridOptions(options: HybridDetectionOptions): void {
  const values = [
    options.mergeIouThreshold,
    options.minimumRefinedQuality,
    options.maximumAnalysisSide,
  ];
  if (values.some((value) => value !== undefined && !Number.isFinite(value))) {
    throw new HybridBubbleDetectionError(
      'Hybrid detection options must be finite numbers.',
    );
  }
  if (
    options.mergeIouThreshold !== undefined &&
    (options.mergeIouThreshold <= 0 || options.mergeIouThreshold > 1)
  ) {
    throw new HybridBubbleDetectionError(
      'Merge IoU threshold must be within (0, 1].',
    );
  }
  if (
    options.minimumRefinedQuality !== undefined &&
    (options.minimumRefinedQuality < 0 || options.minimumRefinedQuality > 1)
  ) {
    throw new HybridBubbleDetectionError(
      'Minimum refined quality must be within [0, 1].',
    );
  }
  if (
    options.maximumAnalysisSide !== undefined &&
    options.maximumAnalysisSide < 128
  ) {
    throw new HybridBubbleDetectionError(
      'Maximum analysis side must be at least 128 pixels.',
    );
  }
}

function validateProposal(
  proposal: BubbleProposal,
  space: ImageSpace,
): void {
  if (!proposal.id.trim()) {
    throw new HybridBubbleDetectionError('Proposal ID is required.');
  }
  if (proposal.provenance !== 'heuristic' && proposal.provenance !== 'ml') {
    throw new HybridBubbleDetectionError(
      'Proposal provenance must be heuristic or ml.',
    );
  }
  if (
    !Number.isFinite(proposal.confidence) ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    throw new HybridBubbleDetectionError(
      'Proposal confidence must be within [0, 1].',
    );
  }
  const box = proposal.boundingBox;
  if (
    box.coordinateSpace.id !== space.id ||
    box.coordinateSpace.kind !== 'image' ||
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width < -0.5 ||
    box.y + box.height < -0.5 ||
    box.x > space.dimensions.width - 0.5 ||
    box.y > space.dimensions.height - 0.5
  ) {
    throw new HybridBubbleDetectionError(
      'Proposal bounds must be finite, positive, and overlap the page ImageSpace.',
    );
  }
  if (proposal.polygon) {
    if (
      proposal.polygon.coordinateSpace.id !== space.id ||
      proposal.polygon.points.length < 3
    ) {
      throw new HybridBubbleDetectionError(
        'Proposal polygons must use the declared ImageSpace with at least three points.',
      );
    }
  }
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
): Promise<GrayRaster> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) {
    throw new HybridBubbleDetectionError('The comic image is not decodable.');
  }
  if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
    throw new HybridBubbleDetectionError(
      'The comic image exceeds 40 megapixels.',
    );
  }
  const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
  const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
  const scale = Math.min(
    1,
    maxSide / Math.max(orientedWidth, orientedHeight),
  );
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

function computeGeometryQuality(
  gray: GrayRaster,
  boundingBox: Bounds<ImageSpace>,
  space: ImageSpace,
): GeometryQuality {
  const minX = clampInt(
    Math.floor((boundingBox.x + 0.5) / gray.scaleX),
    0,
    gray.width - 1,
  );
  const minY = clampInt(
    Math.floor((boundingBox.y + 0.5) / gray.scaleY),
    0,
    gray.height - 1,
  );
  const maxX = clampInt(
    Math.ceil((boundingBox.x + boundingBox.width + 0.5) / gray.scaleX) - 1,
    0,
    gray.width - 1,
  );
  const maxY = clampInt(
    Math.ceil((boundingBox.y + boundingBox.height + 0.5) / gray.scaleY) - 1,
    0,
    gray.height - 1,
  );
  const boxWidth = Math.max(1, maxX - minX + 1);
  const boxHeight = Math.max(1, maxY - minY + 1);
  const insetX = Math.max(1, Math.floor(boxWidth * 0.1));
  const insetY = Math.max(1, Math.floor(boxHeight * 0.1));
  const interior: number[] = [];
  for (let y = minY + insetY; y <= maxY - insetY; y += 1) {
    for (let x = minX + insetX; x <= maxX - insetX; x += 1) {
      interior.push(gray.data[y * gray.width + x]!);
    }
  }
  if (interior.length === 0) {
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        interior.push(gray.data[y * gray.width + x]!);
      }
    }
  }
  const interiorLuminance =
    interior.reduce((sum, value) => sum + value, 0) / Math.max(1, interior.length);
  const brightCutoff = Math.max(140, interiorLuminance * 0.85);
  let bright = 0;
  for (const value of interior) if (value >= brightCutoff) bright += 1;
  const fillRatio = interior.length > 0 ? bright / interior.length : 0;

  const ring: number[] = [];
  const ringDepth = 2;
  for (let y = minY - ringDepth; y <= maxY + ringDepth; y += 1) {
    for (let x = minX - ringDepth; x <= maxX + ringDepth; x += 1) {
      if (x < 0 || y < 0 || x >= gray.width || y >= gray.height) continue;
      const inside =
        x >= minX - 1 &&
        x <= maxX + 1 &&
        y >= minY - 1 &&
        y <= maxY + 1;
      if (inside) continue;
      ring.push(gray.data[y * gray.width + x]!);
    }
  }
  const ringLuminance =
    ring.length > 0
      ? ring.reduce((sum, value) => sum + value, 0) / ring.length
      : interiorLuminance;
  const boundaryContrast = Math.max(0, interiorLuminance - ringLuminance);

  const perimeter = 2 * (boxWidth + boxHeight);
  const edgeContact =
    (minX <= 0 ? boxHeight : 0) +
    (maxX >= gray.width - 1 ? boxHeight : 0) +
    (minY <= 0 ? boxWidth : 0) +
    (maxY >= gray.height - 1 ? boxWidth : 0);
  const edgeContactRatio = perimeter > 0 ? Math.min(1, edgeContact / perimeter) : 0;

  const areaRatio = (boxWidth * boxHeight) / (gray.width * gray.height);
  const sizeScore = clamp01(1 - Math.max(0, areaRatio - 0.18) / 0.34);
  const fillScore = clamp01((fillRatio - 0.3) / 0.6);
  const contrastScore = clamp01(boundaryContrast / 40);
  const opennessScore = clamp01(1 - edgeContactRatio / 0.5);
  const score = clamp01(
    0.22 * sizeScore +
      0.28 * fillScore +
      0.3 * contrastScore +
      0.2 * opennessScore,
  );
  return Object.freeze({
    areaRatio,
    fillRatio,
    interiorLuminance,
    boundaryContrast,
    edgeContactRatio,
    score,
  });
}

interface RefinedBubble {
  readonly bubble: Bubble;
}

/**
 * Deterministic refinement of an unmatched proposal: snap the candidate to
 * the bright enclosed component around its center, rebuild contour and mask
 * geometry from pixels, and score it. Returns null when quality fails.
 */
function refineProposal(
  proposal: BubbleProposal,
  gray: GrayRaster,
  space: ImageSpace,
  minimumQuality: number,
): RefinedBubble | null {
  const rawLeft = (proposal.boundingBox.x + 0.5) / gray.scaleX;
  const rawTop = (proposal.boundingBox.y + 0.5) / gray.scaleY;
  const rawRight =
    (proposal.boundingBox.x + proposal.boundingBox.width + 0.5) / gray.scaleX;
  const rawBottom =
    (proposal.boundingBox.y + proposal.boundingBox.height + 0.5) / gray.scaleY;
  const padX = Math.max(2, (rawRight - rawLeft) * 0.18);
  const padY = Math.max(2, (rawBottom - rawTop) * 0.18);
  const minX = clampInt(Math.floor(rawLeft - padX), 0, gray.width - 1);
  const minY = clampInt(Math.floor(rawTop - padY), 0, gray.height - 1);
  const maxX = clampInt(Math.ceil(rawRight + padX), 0, gray.width - 1);
  const maxY = clampInt(Math.ceil(rawBottom + padY), 0, gray.height - 1);
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  if (boxWidth < 3 || boxHeight < 3) return null;

  const centerSamples: number[] = [];
  const centerMinX = minX + Math.floor(boxWidth * 0.35);
  const centerMaxX = maxX - Math.floor(boxWidth * 0.35);
  const centerMinY = minY + Math.floor(boxHeight * 0.35);
  const centerMaxY = maxY - Math.floor(boxHeight * 0.35);
  for (let y = centerMinY; y <= centerMaxY; y += 1) {
    for (let x = centerMinX; x <= centerMaxX; x += 1) {
      centerSamples.push(gray.data[y * gray.width + x]!);
    }
  }
  if (centerSamples.length === 0) return null;
  const centerMedian = median(centerSamples);
  const brightCutoff = Math.max(140, centerMedian * 0.85);

  const localWidth = maxX - minX + 1;
  const localHeight = maxY - minY + 1;
  const bright = new Uint8Array(localWidth * localHeight);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (gray.data[y * gray.width + x]! >= brightCutoff) {
        bright[(y - minY) * localWidth + (x - minX)] = 1;
      }
    }
  }
  const seedX = clampInt(
    Math.round((rawLeft + rawRight) / 2) - minX,
    0,
    localWidth - 1,
  );
  const seedY = clampInt(
    Math.round((rawTop + rawBottom) / 2) - minY,
    0,
    localHeight - 1,
  );
  const component = floodFrom(bright, localWidth, localHeight, seedX, seedY);
  if (component.pixels.length < 6) return null;

  const compMinX = minX + component.minX;
  const compMinY = minY + component.minY;
  const compMaxX = minX + component.maxX;
  const compMaxY = minY + component.maxY;
  const pageLeft = compMinX * gray.scaleX - 0.5;
  const pageTop = compMinY * gray.scaleY - 0.5;
  const pageRight = (compMaxX + 1) * gray.scaleX - 0.5;
  const pageBottom = (compMaxY + 1) * gray.scaleY - 0.5;
  const boundingBox: Bounds<ImageSpace> = Object.freeze({
    x: pageLeft,
    y: pageTop,
    width: pageRight - pageLeft,
    height: pageBottom - pageTop,
    coordinateSpace: space,
  });
  const quality = computeGeometryQuality(gray, boundingBox, space);
  // A balloon interior is separated from its surroundings by ink or tone;
  // flat regions must not be promoted even if they are uniformly bright.
  if (quality.boundaryContrast < 6 || quality.score < minimumQuality) {
    return null;
  }

  const analysisSpace = createMaskSpace(
    `hybrid-mask:${space.id}:${gray.width}x${gray.height}`,
    space,
    gray.width,
    gray.height,
  );
  const runs = pixelsToRuns(
    component.pixels.map((index) => {
      const x = component.minX + (index % localWidth);
      const y = component.minY + Math.floor(index / localWidth);
      return (minY + y) * gray.width + (minX + x);
    }),
    gray.width,
    compMinX,
    compMinY,
  );
  const contour = radialContour(
    component.pixels.map((index) => {
      const x = component.minX + (index % localWidth);
      const y = component.minY + Math.floor(index / localWidth);
      return { x: minX + x, y: minY + y };
    }),
    gray.scaleX,
    gray.scaleY,
    space,
  );
  const polygon = simplifyPolygon(contour, 2);
  const shape = shapeFromQuality(quality);
  const mask: Bubble['mask'] = Object.freeze({
    width: compMaxX - compMinX + 1,
    height: compMaxY - compMinY + 1,
    runs: Object.freeze(runs),
    origin: Object.freeze({
      x: compMinX,
      y: compMinY,
      coordinateSpace: analysisSpace,
    }),
    coordinateSpace: analysisSpace,
  });
  const kind: BubbleKind = 'unknown';
  const bubble: Bubble = Object.freeze({
    id: proposal.id,
    kind,
    shape,
    mask,
    contour,
    polygon,
    boundingBox,
    tail: null,
    classificationConfidence: 0.4,
    confidence: clamp01(0.45 * proposal.confidence + 0.55 * quality.score),
    coordinateSpace: space,
    reviewStatus: 'pending-review' as const,
    source: 'detected' as const,
    algorithmVersion: ALGORITHM_VERSION,
  });
  return { bubble };
}

function shapeFromQuality(quality: GeometryQuality): BubbleShape {
  if (quality.fillRatio >= 0.9) return 'rounded-rectangle';
  if (quality.fillRatio >= 0.75) return 'ellipse';
  return 'irregular';
}

function floodFrom(
  mask: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): { pixels: number[]; minX: number; minY: number; maxX: number; maxY: number } {
  const start = seedY * width + seedX;
  if (!mask[start]) {
    // Fall back to the brightest connected pixel near the seed.
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!mask[y * width + x]) continue;
        const distance = (x - seedX) * (x - seedX) + (y - seedY) * (y - seedY);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = y * width + x;
        }
      }
    }
    if (best < 0) {
      return { pixels: [], minX: 0, minY: 0, maxX: -1, maxY: -1 };
    }
    return floodFrom(
      mask,
      width,
      height,
      best % width,
      Math.floor(best / width),
    );
  }
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  const pixels: number[] = [];
  let minX = seedX;
  let minY = seedY;
  let maxX = seedX;
  let maxY = seedY;
  while (head < tail) {
    const index = queue[head++]!;
    pixels.push(index);
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
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
  return { pixels, minX, minY, maxX, maxY };
}

function pixelsToRuns(
  pixels: readonly number[],
  rasterWidth: number,
  originX: number,
  originY: number,
): MaskRun[] {
  const sorted = [...pixels].sort((a, b) => a - b);
  const runs: MaskRun[] = [];
  let startX = -1;
  let row = -1;
  let previousX = -2;
  for (const index of sorted) {
    const x = (index % rasterWidth) - originX;
    const y = Math.floor(index / rasterWidth) - originY;
    if (y !== row || x !== previousX + 1) {
      if (startX >= 0) {
        runs.push(
          Object.freeze({ y: row, x: startX, length: previousX - startX + 1 }),
        );
      }
      row = y;
      startX = x;
    }
    previousX = x;
  }
  if (startX >= 0) {
    runs.push(
      Object.freeze({ y: row, x: startX, length: previousX - startX + 1 }),
    );
  }
  return runs;
}

function radialContour(
  pixels: readonly { x: number; y: number }[],
  scaleX: number,
  scaleY: number,
  space: ImageSpace,
): Polygon<ImageSpace> {
  const centerX = pixels.reduce((sum, pixel) => sum + pixel.x, 0) / pixels.length;
  const centerY = pixels.reduce((sum, pixel) => sum + pixel.y, 0) / pixels.length;
  const bins = 72;
  const radii = new Float64Array(bins);
  const points = new Array<{ x: number; y: number } | undefined>(bins);
  for (const pixel of pixels) {
    let angle = Math.atan2(pixel.y - centerY, pixel.x - centerX);
    if (angle < 0) angle += Math.PI * 2;
    const bin = Math.floor((angle / (Math.PI * 2)) * bins) % bins;
    const radius = Math.hypot(pixel.x - centerX, pixel.y - centerY);
    if (radius > radii[bin]!) {
      radii[bin] = radius;
      points[bin] = {
        x: (pixel.x + 0.5) * scaleX - 0.5,
        y: (pixel.y + 0.5) * scaleY - 0.5,
      };
    }
  }
  const contour = points.filter(
    (point): point is { x: number; y: number } => point !== undefined,
  );
  return Object.freeze({
    points: Object.freeze(
      contour.map((point) =>
        Object.freeze({ x: point.x, y: point.y, coordinateSpace: space }),
      ),
    ),
    coordinateSpace: space,
  });
}

function simplifyPolygon(
  polygon: Polygon<ImageSpace>,
  tolerance: number,
): Polygon<ImageSpace> {
  const points = polygon.points;
  if (points.length < 8) return polygon;
  const step = Math.max(1, Math.ceil(tolerance));
  const selected = points.filter((_, index) => index % step === 0);
  return Object.freeze({
    points: Object.freeze(selected),
    coordinateSpace: polygon.coordinateSpace,
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Heuristic proposal provider
// ---------------------------------------------------------------------------

export interface HeuristicProposalProviderOptions {
  /** Gradient L1 magnitude counted as outline ink (default 30). */
  readonly edgeThreshold?: number;
  /** Minimum mean luminance of the candidate interior (default 168). */
  readonly minimumInteriorLuminance?: number;
  /** Minimum interior-minus-surround luminance contrast (default 12). */
  readonly minimumContrast?: number;
  readonly minimumAreaRatio?: number;
  readonly maximumAreaRatio?: number;
  readonly minimumConfidence?: number;
  readonly maximumAnalysisSide?: number;
}

/**
 * Model-free proposal source: finds high-contrast closed regions with bright
 * interiors from gradient edges and border-flood closure tests. It shares the
 * proposal interface with ML providers so the hybrid pipeline runs without a
 * model; its candidates are labelled `heuristic`.
 */
export class HeuristicProposalProvider implements BubbleProposalProvider {
  readonly name = 'heuristic-proposal-provider';
  readonly provenance = 'heuristic' as const;
  readonly #options: HeuristicProposalProviderOptions;

  constructor(options: HeuristicProposalProviderOptions = {}) {
    this.#options = options;
    Object.freeze(this);
  }

  async propose(
    image: Uint8Array,
    space: ImageSpace,
  ): Promise<readonly BubbleProposal[]> {
    validateHeuristicOptions(this.#options);
    const gray = await decodeGray(
      image,
      this.#options.maximumAnalysisSide ?? DEFAULT_ANALYSIS_SIDE,
    );
    const edgeThreshold = this.#options.edgeThreshold ?? 30;
    const minimumInteriorLuminance =
      this.#options.minimumInteriorLuminance ?? 168;
    const minimumContrast = this.#options.minimumContrast ?? 12;
    const minimumAreaRatio = this.#options.minimumAreaRatio ?? 0.004;
    const maximumAreaRatio = this.#options.maximumAreaRatio ?? 0.45;
    const minimumConfidence = this.#options.minimumConfidence ?? 0.4;

    const edge = new Uint8Array(gray.width * gray.height);
    for (let y = 1; y < gray.height - 1; y += 1) {
      for (let x = 1; x < gray.width - 1; x += 1) {
        const index = y * gray.width + x;
        const gx =
          gray.data[index + 1]! - gray.data[index - 1]!;
        const gy =
          gray.data[index + gray.width]! - gray.data[index - gray.width]!;
        if (Math.abs(gx) + Math.abs(gy) >= edgeThreshold) edge[index] = 1;
      }
    }
    // Seal anti-aliasing gaps so closed outlines stay closed for the flood.
    const sealed = dilate(edge, gray.width, gray.height);

    const labels = new Int32Array(sealed.length);
    const components = edgeComponents(sealed, labels, gray.width, gray.height);
    const proposals: BubbleProposal[] = [];
    for (const component of components) {
      const boxWidth = component.maxX - component.minX + 1;
      const boxHeight = component.maxY - component.minY + 1;
      const areaRatio =
        (boxWidth * boxHeight) / (gray.width * gray.height);
      if (areaRatio < minimumAreaRatio || areaRatio > maximumAreaRatio) continue;
      const aspect = boxWidth / boxHeight;
      if (aspect < 0.25 || aspect > 4) continue;

      const margin = 3;
      const localMinX = Math.max(0, component.minX - margin);
      const localMinY = Math.max(0, component.minY - margin);
      const localMaxX = Math.min(gray.width - 1, component.maxX + margin);
      const localMaxY = Math.min(gray.height - 1, component.maxY + margin);
      const localWidth = localMaxX - localMinX + 1;
      const localHeight = localMaxY - localMinY + 1;
      const barrier = new Uint8Array(localWidth * localHeight);
      for (let y = localMinY; y <= localMaxY; y += 1) {
        for (let x = localMinX; x <= localMaxX; x += 1) {
          if (sealed[y * gray.width + x]) {
            barrier[(y - localMinY) * localWidth + (x - localMinX)] = 1;
          }
        }
      }
      const closure = closureScore(
        barrier,
        localWidth,
        localHeight,
        component.minX - localMinX,
        component.minY - localMinY,
        component.maxX - localMinX,
        component.maxY - localMinY,
      );
      if (closure < 0.55) continue;

      const insetX = Math.max(1, Math.floor(boxWidth * 0.12));
      const insetY = Math.max(1, Math.floor(boxHeight * 0.12));
      const interiorValues: number[] = [];
      for (
        let y = component.minY + insetY;
        y <= component.maxY - insetY;
        y += 1
      ) {
        for (
          let x = component.minX + insetX;
          x <= component.maxX - insetX;
          x += 1
        ) {
          if (sealed[y * gray.width + x]) continue;
          interiorValues.push(gray.data[y * gray.width + x]!);
        }
      }
      if (interiorValues.length === 0) continue;
      const interiorLuminance =
        interiorValues.reduce((sum, value) => sum + value, 0) /
        interiorValues.length;
      if (interiorLuminance < minimumInteriorLuminance) continue;

      const ringValues: number[] = [];
      const ringDepth = 3;
      for (
        let y = component.minY - ringDepth;
        y <= component.maxY + ringDepth;
        y += 1
      ) {
        for (
          let x = component.minX - ringDepth;
          x <= component.maxX + ringDepth;
          x += 1
        ) {
          if (x < 0 || y < 0 || x >= gray.width || y >= gray.height) continue;
          const inside =
            x >= component.minX - 1 &&
            x <= component.maxX + 1 &&
            y >= component.minY - 1 &&
            y <= component.maxY + 1;
          if (inside) continue;
          ringValues.push(gray.data[y * gray.width + x]!);
        }
      }
      const ringLuminance =
        ringValues.length > 0
          ? ringValues.reduce((sum, value) => sum + value, 0) / ringValues.length
          : interiorLuminance;
      const contrast = interiorLuminance - ringLuminance;
      if (contrast < minimumContrast) continue;

      const contrastScore = clamp01(contrast / 60);
      const interiorScore = clamp01((interiorLuminance - 120) / 100);
      const sizeScore = clamp01(1 - Math.abs(areaRatio - 0.08) / 0.2);
      const confidence = clamp01(
        0.3 * contrastScore +
          0.3 * interiorScore +
          0.25 * closure +
          0.15 * sizeScore,
      );
      if (confidence < minimumConfidence) continue;

      const left = component.minX * gray.scaleX - 0.5;
      const top = component.minY * gray.scaleY - 0.5;
      const right = (component.maxX + 1) * gray.scaleX - 0.5;
      const bottom = (component.maxY + 1) * gray.scaleY - 0.5;
      const boundingBox: Bounds<ImageSpace> = Object.freeze({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        coordinateSpace: space,
      });
      const polygon: Polygon<ImageSpace> = Object.freeze({
        points: Object.freeze([
          Object.freeze({ x: left, y: top, coordinateSpace: space }),
          Object.freeze({ x: right, y: top, coordinateSpace: space }),
          Object.freeze({ x: right, y: bottom, coordinateSpace: space }),
          Object.freeze({ x: left, y: bottom, coordinateSpace: space }),
        ]),
        coordinateSpace: space,
      });
      proposals.push(
        Object.freeze({
          id: `heuristic-${component.minX}-${component.minY}-${boxWidth}-${boxHeight}`,
          boundingBox,
          polygon,
          confidence,
          provenance: 'heuristic' as const,
        }),
      );
    }
    return Object.freeze(
      proposals.sort(
        (a, b) =>
          b.confidence - a.confidence ||
          a.boundingBox.y - b.boundingBox.y ||
          a.boundingBox.x - b.boundingBox.x,
      ),
    );
  }
}

function validateHeuristicOptions(
  options: HeuristicProposalProviderOptions,
): void {
  const values = [
    options.edgeThreshold,
    options.minimumInteriorLuminance,
    options.minimumContrast,
    options.minimumAreaRatio,
    options.maximumAreaRatio,
    options.minimumConfidence,
    options.maximumAnalysisSide,
  ];
  if (values.some((value) => value !== undefined && !Number.isFinite(value))) {
    throw new HybridBubbleDetectionError(
      'Heuristic proposal options must be finite numbers.',
    );
  }
  if (
    options.minimumAreaRatio !== undefined &&
    (options.minimumAreaRatio <= 0 || options.minimumAreaRatio >= 1)
  ) {
    throw new HybridBubbleDetectionError(
      'Minimum area ratio must be within (0, 1).',
    );
  }
  if (
    options.maximumAreaRatio !== undefined &&
    (options.maximumAreaRatio <= 0 || options.maximumAreaRatio > 1)
  ) {
    throw new HybridBubbleDetectionError(
      'Maximum area ratio must be within (0, 1].',
    );
  }
  if (
    options.minimumConfidence !== undefined &&
    (options.minimumConfidence < 0 || options.minimumConfidence > 1)
  ) {
    throw new HybridBubbleDetectionError(
      'Minimum confidence must be within [0, 1].',
    );
  }
}

function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
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

interface EdgeComponent {
  readonly id: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function edgeComponents(
  mask: Uint8Array,
  labels: Int32Array,
  width: number,
  height: number,
): EdgeComponent[] {
  const queue = new Int32Array(mask.length);
  const components: EdgeComponent[] = [];
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
      id: nextLabel,
      minX: x0,
      minY: y0,
      maxX: x0,
      maxY: y0,
    };
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width;
      const y = Math.floor(index / width);
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

/**
 * Fraction of the candidate interior that border flood fill cannot reach
 * without crossing an edge pixel — a deterministic closed-region cue.
 */
function closureScore(
  barrier: Uint8Array,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  const reachable = new Uint8Array(barrier.length);
  const queue = new Int32Array(barrier.length);
  let head = 0;
  let tail = 0;
  const push = (x: number, y: number) => {
    const index = y * width + x;
    if (barrier[index] || reachable[index]) return;
    reachable[index] = 1;
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
  const insetX = Math.max(1, Math.floor((maxX - minX + 1) * 0.15));
  const insetY = Math.max(1, Math.floor((maxY - minY + 1) * 0.15));
  let interior = 0;
  let sealed = 0;
  for (let y = minY + insetY; y <= maxY - insetY; y += 1) {
    for (let x = minX + insetX; x <= maxX - insetX; x += 1) {
      interior += 1;
      if (!reachable[y * width + x]) sealed += 1;
    }
  }
  return interior > 0 ? sealed / interior : 0;
}
