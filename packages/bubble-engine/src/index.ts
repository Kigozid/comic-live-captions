import sharp from 'sharp';
import {
  createMaskSpace,
  type BinaryMask,
  type Bounds,
  type ImageSpace,
  type MaskRun,
  type Point,
  type Polygon,
} from '@comic-captioner/shared';

export type BubbleKind = 'speech' | 'thought' | 'narration' | 'unknown';
export type BubbleShape =
  'ellipse' | 'rounded-rectangle' | 'rectangle' | 'irregular' | 'partial';
export type BubbleReviewStatus = 'pending-review' | 'edited';

export interface Bubble {
  readonly id: string;
  readonly kind: BubbleKind;
  readonly shape: BubbleShape;
  readonly mask: BinaryMask;
  /** Detailed boundary estimated from the detected or user-drawn mask. */
  readonly contour: Polygon<ImageSpace>;
  /** Stable simplified page polygon used for selection and editing. */
  readonly polygon: Polygon<ImageSpace>;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly tail: Polygon<ImageSpace> | null;
  /** Confidence in the speech/thought/narration label, separate from geometry. */
  readonly classificationConfidence: number;
  readonly confidence: number;
  readonly coordinateSpace: ImageSpace;
  readonly reviewStatus: BubbleReviewStatus;
  readonly source: 'detected' | 'manual';
  readonly algorithmVersion: string;
}

export interface BubbleDetectionOptions {
  readonly maximumAnalysisSide?: number;
  /** Override the adaptive near-white cutoffs (205 and 220) with one cutoff. */
  readonly whiteThreshold?: number;
  readonly minimumAreaRatio?: number;
  readonly maximumAreaRatio?: number;
  readonly minimumConfidence?: number;
}

export interface BubbleDetectionResult {
  readonly bubbles: readonly Bubble[];
  readonly coordinateSpace: ImageSpace;
  readonly analysisSpace: ReturnType<typeof createMaskSpace>;
  readonly debugPng: Buffer;
}

export interface ManualBubbleInput {
  readonly id: string;
  readonly polygon: Polygon<ImageSpace>;
  readonly coordinateSpace: ImageSpace;
  readonly kind?: BubbleKind;
  readonly shape?: BubbleShape;
  readonly tail?: Polygon<ImageSpace> | null;
}

export interface BubbleEdit {
  readonly kind?: BubbleKind;
  readonly shape?: BubbleShape;
  readonly polygon?: Polygon<ImageSpace>;
  readonly tail?: Polygon<ImageSpace> | null;
}

export class BubbleDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BubbleDetectionError';
  }
}

export {
  BubbleDialogueAssociationEngine,
  BubbleDialogueAssociationError,
} from './association.js';
export type {
  BubbleDialogueAssociationInput,
  BubbleDialogueAssociationOptions,
  BubbleDialogueAssociationResult,
  BubbleSemanticCandidate,
  BubbleSemanticResolutionInput,
  BubbleSemanticResolver,
} from './association.js';
export {
  HeuristicProposalProvider,
  HybridBubbleDetectionError,
  HybridBubbleDetector,
} from './hybrid-detection.js';
export type {
  BubbleProposal,
  BubbleProposalProvenance,
  BubbleProposalProvider,
  GeometryQuality,
  HeuristicProposalProviderOptions,
  HybridBubble,
  HybridBubbleDetectionResult,
  HybridBubbleDetectorOptions,
  HybridBubbleSource,
  HybridDetectionOptions,
  ProposalSupport,
} from './hybrid-detection.js';
export {
  BUBBLE_DETECTOR_CLASSES,
  COMIC_BUBBLE_CLASSES,
  MlBubbleDetectorError,
  SyntheticYoloSession,
  YoloBubbleProposalProvider,
  boundsToPolygon,
  createOnnxYoloSession,
  decodeYoloV5,
  decodeYoloV8,
  letterboxToTensor,
  nonMaxSuppression,
} from './ml-bubble-detector.js';
export type {
  ComicBubbleClass,
  LetterboxResult,
  OnnxYoloSessionOptions,
  YoloBubbleProposalProviderOptions,
  YoloDetection,
  YoloInferenceSession,
} from './ml-bubble-detector.js';
export {
  CaptionSafeRegionEngine,
  CaptionSafeRegionError,
} from './safe-region.js';
export type {
  CaptionSafeRegion,
  CaptionSafeRegionInput,
  CaptionSafeRegionResult,
} from './safe-region.js';
export {
  deriveReadingOrder,
  detectPanels,
  PanelOrderError,
} from './panel-order.js';
export type {
  Panel,
  PanelDetectionOptions,
  PanelDetectionResult,
  ReadingDirection,
  ReadingOrderBubbleInput,
} from './panel-order.js';

interface Component {
  readonly id: number;
  readonly pixels: number[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly touchesEdge: boolean;
  readonly edgeContact: number;
  readonly inkBoundaryRatio: number;
  readonly perimeterLength: number;
}

interface Candidate {
  readonly component: Component;
  readonly confidence: number;
  readonly classificationConfidence: number;
  readonly shape: BubbleShape;
  readonly kind: BubbleKind;
}

const ALGORITHM_VERSION = 'bubble-cv-2';
const MAX_DECODED_PIXELS = 40_000_000;
// Preserve subtle white-on-pale bubble boundaries on typical scanned pages.
// Analysis still caps at 3200px to keep memory bounded on oversized pages.
const DEFAULT_MAX_ANALYSIS_SIDE = 3200;
const DEFAULT_WHITE_THRESHOLDS = [205, 220] as const;

/** Deterministic page-ink and enclosure based bubble proposal engine. */
export class BubbleDetectionEngine {
  async detect(
    cleanedImage: Uint8Array,
    coordinateSpace: ImageSpace,
    options: BubbleDetectionOptions = {},
  ): Promise<BubbleDetectionResult> {
    const metadata = await sharp(cleanedImage).metadata();
    if (!metadata.width || !metadata.height) {
      throw new BubbleDetectionError(
        'The cleaned comic image is not decodable.',
      );
    }
    if (metadata.width * metadata.height > MAX_DECODED_PIXELS) {
      throw new BubbleDetectionError(
        'The cleaned comic image exceeds 40 megapixels.',
      );
    }
    const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
    const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
    if (
      orientedWidth !== coordinateSpace.dimensions.width ||
      orientedHeight !== coordinateSpace.dimensions.height
    ) {
      throw new BubbleDetectionError(
        'The image dimensions do not match the declared ImageSpace.',
      );
    }
    validateOptions(options);
    const maxSide = options.maximumAnalysisSide ?? DEFAULT_MAX_ANALYSIS_SIDE;
    const scale = Math.min(
      1,
      maxSide / Math.max(orientedWidth, orientedHeight),
    );
    const width = Math.max(1, Math.round(orientedWidth * scale));
    const height = Math.max(1, Math.round(orientedHeight * scale));
    const scaleX = orientedWidth / width;
    const scaleY = orientedHeight / height;
    const { data } = await sharp(cleanedImage)
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const thresholds =
      options.whiteThreshold === undefined
        ? DEFAULT_WHITE_THRESHOLDS
        : [options.whiteThreshold];
    const candidates = suppressDuplicateCandidates(
      thresholds.flatMap((threshold) => {
        const light = closeSmallGaps(gray, width, height, threshold);
        return findBrightComponents(light, gray, width, height)
          .map((component) =>
            scoreCandidate(component, light, width, height, options),
          )
          .filter((candidate): candidate is Candidate => candidate !== null);
      }),
    ).sort(
      (a, b) =>
        a.component.minY - b.component.minY ||
        a.component.minX - b.component.minX,
    );
    const analysisSpace = createMaskSpace(
      `bubble-analysis:${coordinateSpace.id}:${width}x${height}`,
      coordinateSpace,
      width,
      height,
    );
    const detectedBubbles = candidates.map((candidate, index) =>
      componentToBubble(
        `bubble-${coordinateSpace.id}-${index + 1}`,
        candidate,
        width,
        scaleX,
        scaleY,
        coordinateSpace,
        analysisSpace,
      ),
    );
    const bubbles = mergeDetachedTailCandidates(detectedBubbles);
    const debugPng = await renderDebug(cleanedImage, bubbles, coordinateSpace);
    return Object.freeze({
      bubbles: Object.freeze(bubbles),
      coordinateSpace,
      analysisSpace,
      debugPng,
    });
  }
}

/** Construct an editable bubble from user-drawn page geometry. */
export function createManualBubble(input: ManualBubbleInput): Bubble {
  if (!input.id.trim())
    throw new BubbleDetectionError('Bubble ID is required.');
  assertKind(input.kind ?? 'speech');
  assertShape(input.shape ?? 'irregular');
  assertPolygon(input.polygon, input.coordinateSpace);
  if (input.tail) assertPolygon(input.tail, input.coordinateSpace);
  const bounds = polygonBounds(input.polygon);
  const integerBounds = {
    left: Math.max(0, Math.ceil(bounds.x)),
    top: Math.max(0, Math.ceil(bounds.y)),
    right: Math.min(
      input.coordinateSpace.dimensions.width - 1,
      Math.floor(bounds.x + bounds.width),
    ),
    bottom: Math.min(
      input.coordinateSpace.dimensions.height - 1,
      Math.floor(bounds.y + bounds.height),
    ),
  };
  if (
    integerBounds.right < integerBounds.left ||
    integerBounds.bottom < integerBounds.top
  ) {
    throw new BubbleDetectionError(
      'The manual bubble polygon must cover at least one image pixel.',
    );
  }
  const maskSpace = createMaskSpace(
    `bubble-mask:${input.coordinateSpace.id}:${input.id}`,
    input.coordinateSpace,
    input.coordinateSpace.dimensions.width,
    input.coordinateSpace.dimensions.height,
  );
  const runs: MaskRun[] = [];
  for (let y = integerBounds.top; y <= integerBounds.bottom; y += 1) {
    let runStart = -1;
    for (let x = integerBounds.left; x <= integerBounds.right; x += 1) {
      const inside = pointInPolygon(x, y, input.polygon.points);
      if (inside && runStart < 0) runStart = x - integerBounds.left;
      if ((!inside || x === integerBounds.right) && runStart >= 0) {
        const runEnd =
          inside && x === integerBounds.right
            ? x - integerBounds.left + 1
            : x - integerBounds.left;
        runs.push(
          Object.freeze({
            y: y - integerBounds.top,
            x: runStart,
            length: runEnd - runStart,
          }),
        );
        runStart = -1;
      }
    }
  }
  if (runs.length === 0)
    throw new BubbleDetectionError(
      'The manual polygon contains no image pixels.',
    );
  const mask: BinaryMask = Object.freeze({
    width: integerBounds.right - integerBounds.left + 1,
    height: integerBounds.bottom - integerBounds.top + 1,
    runs: Object.freeze(runs),
    origin: Object.freeze({
      x: integerBounds.left,
      y: integerBounds.top,
      coordinateSpace: maskSpace,
    }),
    coordinateSpace: maskSpace,
  });
  const polygon = freezePolygon(input.polygon);
  const box = Object.freeze({
    ...bounds,
    coordinateSpace: input.coordinateSpace,
  });
  return Object.freeze({
    id: input.id,
    kind: input.kind ?? 'speech',
    shape: input.shape ?? 'irregular',
    mask,
    contour: polygon,
    polygon,
    boundingBox: box,
    tail: input.tail ? freezePolygon(input.tail) : null,
    classificationConfidence: 1,
    confidence: 1,
    coordinateSpace: input.coordinateSpace,
    reviewStatus: 'edited',
    source: 'manual',
    algorithmVersion: ALGORITHM_VERSION,
  });
}

/** Immutable manual replacement of editable bubble fields. */
export function editBubble(bubble: Bubble, edit: BubbleEdit): Bubble {
  const polygon = edit.polygon ?? bubble.polygon;
  assertPolygon(polygon, bubble.coordinateSpace);
  const replacement = createManualBubble({
    id: bubble.id,
    polygon,
    coordinateSpace: bubble.coordinateSpace,
    kind: edit.kind ?? bubble.kind,
    shape: edit.shape ?? bubble.shape,
    tail: edit.tail === undefined ? bubble.tail : edit.tail,
  });
  return Object.freeze({
    ...replacement,
    confidence: bubble.confidence,
    source: bubble.source,
  });
}

/** Remove a bubble by ID without mutating the caller's collection. */
export function deleteBubble(
  bubbles: readonly Bubble[],
  id: string,
): readonly Bubble[] {
  if (!bubbles.some((bubble) => bubble.id === id)) {
    throw new BubbleDetectionError(`Bubble ${id} was not found.`);
  }
  return Object.freeze(bubbles.filter((bubble) => bubble.id !== id));
}

function validateOptions(options: BubbleDetectionOptions): void {
  const values = [
    options.maximumAnalysisSide,
    options.whiteThreshold,
    options.minimumAreaRatio,
    options.maximumAreaRatio,
    options.minimumConfidence,
  ];
  if (values.some((value) => value !== undefined && !Number.isFinite(value))) {
    throw new BubbleDetectionError(
      'Bubble detection options must be finite numbers.',
    );
  }
  if (
    options.maximumAnalysisSide !== undefined &&
    options.maximumAnalysisSide < 128
  ) {
    throw new BubbleDetectionError(
      'Maximum analysis side must be at least 128 pixels.',
    );
  }
  if (
    options.whiteThreshold !== undefined &&
    (options.whiteThreshold < 160 || options.whiteThreshold > 250)
  ) {
    throw new BubbleDetectionError(
      'White threshold must be between 160 and 250.',
    );
  }
  if (
    options.minimumAreaRatio !== undefined &&
    (options.minimumAreaRatio <= 0 || options.minimumAreaRatio >= 1)
  ) {
    throw new BubbleDetectionError(
      'Minimum area ratio must be between 0 and 1.',
    );
  }
  if (
    options.maximumAreaRatio !== undefined &&
    (options.maximumAreaRatio <= 0 || options.maximumAreaRatio > 0.6)
  ) {
    throw new BubbleDetectionError(
      'Maximum area ratio must be greater than 0 and no more than 0.6.',
    );
  }
  if (
    options.minimumAreaRatio !== undefined &&
    options.maximumAreaRatio !== undefined &&
    options.minimumAreaRatio >= options.maximumAreaRatio
  ) {
    throw new BubbleDetectionError(
      'Minimum area ratio must be smaller than maximum area ratio.',
    );
  }
  if (
    options.minimumConfidence !== undefined &&
    (options.minimumConfidence < 0 || options.minimumConfidence > 1)
  ) {
    throw new BubbleDetectionError(
      'Minimum confidence must be between 0 and 1.',
    );
  }
}

/** Merge duplicate proposals from adaptive threshold passes without dropping adjacent balloons. */
function suppressDuplicateCandidates(
  candidates: readonly Candidate[],
): Candidate[] {
  const ranked = [...candidates].sort(
    (left, right) => right.confidence - left.confidence,
  );
  const kept: Candidate[] = [];
  for (const candidate of ranked) {
    const duplicate = kept.some(
      (existing) =>
        componentIoU(candidate.component, existing.component) >= 0.78,
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

function componentIoU(left: Component, right: Component): number {
  const leftWidth = left.maxX - left.minX + 1;
  const leftHeight = left.maxY - left.minY + 1;
  const rightWidth = right.maxX - right.minX + 1;
  const rightHeight = right.maxY - right.minY + 1;
  const width = Math.max(
    0,
    Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX) + 1,
  );
  const height = Math.max(
    0,
    Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY) + 1,
  );
  const intersection = width * height;
  const union =
    leftWidth * leftHeight + rightWidth * rightHeight - intersection;
  return union > 0 ? intersection / union : 0;
}

function closeSmallGaps(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): Uint8Array {
  const source = new Uint8Array(gray.length);
  for (let index = 0; index < gray.length; index += 1)
    source[index] = gray[index]! >= threshold ? 1 : 0;
  const dilated = new Uint8Array(gray.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let value = 0;
      for (let dy = -1; dy <= 1 && !value; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1)
          if (source[(y + dy) * width + x + dx]) value = 1;
      }
      dilated[y * width + x] = value;
    }
  }
  const closed = new Uint8Array(gray.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let value = 1;
      for (let dy = -1; dy <= 1 && value; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1)
          if (!dilated[(y + dy) * width + x + dx]) value = 0;
      }
      closed[y * width + x] = value;
    }
  }
  return closed;
}

function findBrightComponents(
  mask: Uint8Array,
  gray: Uint8Array,
  width: number,
  height: number,
): Component[] {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];
  let label = 0;
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || seen[seed]) continue;
    label += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    seen[seed] = 1;
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let perimeter = 0;
    let inkEdges = 0;
    let edgeContact = 0;
    while (head < tail) {
      const index = queue[head++]!;
      pixels.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1)
        edgeContact += 1;
      for (const [nx, ny] of [
        [x, y - 1],
        [x, y + 1],
        [x - 1, y],
        [x + 1, y],
      ] as const) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (mask[neighbor] && !seen[neighbor]) {
          seen[neighbor] = 1;
          queue[tail++] = neighbor;
        } else if (!mask[neighbor]) {
          perimeter += 1;
          if (gray[neighbor]! < 150) inkEdges += 1;
        }
      }
    }
    components.push({
      id: label,
      pixels,
      minX,
      minY,
      maxX,
      maxY,
      // The morphology pass leaves a one-pixel analysis border empty; count a
      // component adjacent to that border as page-cropped as well.
      touchesEdge:
        edgeContact > 0 ||
        minX <= 1 ||
        minY <= 1 ||
        maxX >= width - 4 ||
        maxY >= height - 2,
      edgeContact,
      inkBoundaryRatio: perimeter ? inkEdges / perimeter : 0,
      perimeterLength: perimeter,
    });
  }
  return components;
}

function scoreCandidate(
  component: Component,
  mask: Uint8Array,
  width: number,
  height: number,
  options: BubbleDetectionOptions,
): Candidate | null {
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const boxArea = boxWidth * boxHeight;
  const imageArea = width * height;
  const areaRatio = boxArea / imageArea;
  const minArea = options.minimumAreaRatio ?? 0.002;
  // Large speech balloons can occupy a substantial fraction of a page.
  const maxArea = options.maximumAreaRatio ?? 0.4;
  const aspect = boxWidth / boxHeight;
  const fillRatio = component.pixels.length / boxArea;
  const cornerFill = cornerFillRatio(component, mask, width);
  const edgeRatio = component.edgeContact / (2 * (boxWidth + boxHeight));

  // A candidate needs a plausible size and shape, a near-white interior, and
  // dark boundary evidence. This avoids treating page gutters and blank panels
  // as bubbles based on whiteness alone.
  if (areaRatio < minArea || areaRatio > maxArea) return null;
  if (aspect < 0.3 || aspect > 3.4 || fillRatio < 0.3) return null;
  // A large, near-square, fully filled frame is characteristic of a panel.
  // Long balloons remain eligible at larger page-area ratios.
  if (areaRatio > 0.25 && aspect < 1.2 && fillRatio > 0.91 && cornerFill > 0.76)
    return null;
  if (component.inkBoundaryRatio < 0.24 || edgeRatio > 0.48) return null;
  if (component.touchesEdge && edgeRatio > 0.35) return null;

  const sizeScore = clamp(1 - Math.max(0, areaRatio - 0.16) / 0.36, 0, 1);
  const aspectScore = clamp(
    1 - Math.max(0, 0.5 - aspect, aspect - 2.4) / 2.4,
    0,
    1,
  );
  const fillScore = clamp((fillRatio - 0.3) / 0.62, 0, 1);
  const borderScore = clamp((component.inkBoundaryRatio - 0.16) / 0.58, 0, 1);
  const confidence =
    0.27 * sizeScore +
    0.19 * aspectScore +
    0.24 * fillScore +
    0.3 * borderScore;
  if (confidence < (options.minimumConfidence ?? 0.45)) return null;

  let shape: BubbleShape;
  if (component.touchesEdge) shape = 'partial';
  else if (fillRatio >= 0.91 && cornerFill < 0.76) shape = 'rounded-rectangle';
  else if (fillRatio >= 0.91) shape = 'rectangle';
  else if (fillRatio >= 0.8) shape = 'rounded-rectangle';
  else if (fillRatio >= 0.67) shape = 'ellipse';
  else shape = 'irregular';
  // A scalloped, strongly non-rectangular interior is consistent with thought
  // balloons. It remains a proposal and is editable by the user.
  const thoughtScallops = countRadialPeaks(component, width);
  const hasThoughtOutline =
    thoughtScallops >= 5 &&
    thoughtScallops <= 24 &&
    shape !== 'rectangle' &&
    shape !== 'rounded-rectangle';
  let kind: BubbleKind = 'unknown';
  let classificationConfidence = 0.35;
  if (hasThoughtOutline) {
    kind = 'thought';
    classificationConfidence = clamp(
      0.58 + (thoughtScallops - 5) * 0.035,
      0.58,
      0.9,
    );
  } else if (shape === 'rectangle') {
    kind = 'narration';
    classificationConfidence = 0.72;
  } else if (shape === 'rounded-rectangle') {
    // Rectangular narration boxes and tailless rectangular speech balloons
    // share the same contour. Leave the type explicitly reviewable.
    kind = 'unknown';
    classificationConfidence = 0.48;
  }
  return { component, confidence, classificationConfidence, shape, kind };
}

function componentToBubble(
  id: string,
  candidate: Candidate,
  width: number,
  scaleX: number,
  scaleY: number,
  imageSpace: ImageSpace,
  maskSpace: ReturnType<typeof createMaskSpace>,
): Bubble {
  const { component } = candidate;
  const contour = radialContour(component, width, scaleX, scaleY, imageSpace);
  const polygon = simplifyPolygon(contour, 0.75);
  const tail = detectTail(contour);
  // Scalloped cloud contours can produce a false tail-like protrusion. Keep
  // the independently supported thought classification in that case; a real
  // tail boosts speech confidence for the remaining candidate shapes.
  const kind = tail && candidate.kind !== 'thought' ? 'speech' : candidate.kind;
  const maskRuns = componentToRuns(component, width);
  const originX = component.minX;
  const originY = component.minY;
  const mask: BinaryMask = Object.freeze({
    width: component.maxX - component.minX + 1,
    height: component.maxY - component.minY + 1,
    runs: Object.freeze(maskRuns),
    origin: Object.freeze({
      x: originX,
      y: originY,
      coordinateSpace: maskSpace,
    }),
    coordinateSpace: maskSpace,
  });
  const left = component.minX * scaleX - 0.5;
  const top = component.minY * scaleY - 0.5;
  const right = (component.maxX + 1) * scaleX - 0.5;
  const bottom = (component.maxY + 1) * scaleY - 0.5;
  const bounds: Bounds<ImageSpace> = Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: imageSpace,
  });
  return Object.freeze({
    id,
    kind,
    shape: candidate.shape,
    mask,
    contour,
    polygon,
    boundingBox: bounds,
    tail,
    classificationConfidence:
      tail && kind === 'speech'
        ? Math.max(candidate.classificationConfidence, 0.82)
        : candidate.classificationConfidence,
    confidence: candidate.confidence,
    coordinateSpace: imageSpace,
    reviewStatus: 'pending-review',
    source: 'detected',
    algorithmVersion: ALGORITHM_VERSION,
  });
}

/**
 * Bright-component segmentation can split a balloon's tapered tail from its
 * body. Reattach only a small, independently tail-shaped candidate that lies
 * near a larger candidate's boundary; this preserves page-derived geometry
 * and avoids treating the tail as a separate caption container.
 */
function mergeDetachedTailCandidates(bubbles: readonly Bubble[]): Bubble[] {
  const removed = new Set<string>();
  const merged = bubbles.map((body) => {
    if (body.tail || body.kind === 'thought') return body;
    const bodyArea = body.boundingBox.width * body.boundingBox.height;
    const candidates = bubbles
      .filter((tail) => {
        if (tail.id === body.id || removed.has(tail.id) || !tail.tail)
          return false;
        const tailArea = tail.boundingBox.width * tail.boundingBox.height;
        if (tailArea > bodyArea * 0.1) return false;
        const margin =
          Math.min(body.boundingBox.width, body.boundingBox.height) * 0.14;
        const nearBody =
          tail.boundingBox.x + tail.boundingBox.width >=
            body.boundingBox.x - margin &&
          tail.boundingBox.x <=
            body.boundingBox.x + body.boundingBox.width + margin &&
          tail.boundingBox.y + tail.boundingBox.height >=
            body.boundingBox.y - margin &&
          tail.boundingBox.y <=
            body.boundingBox.y + body.boundingBox.height + margin;
        const centerX = tail.boundingBox.x + tail.boundingBox.width / 2;
        const centerY = tail.boundingBox.y + tail.boundingBox.height / 2;
        const outsideDistance = Math.min(
          Math.abs(centerX - body.boundingBox.x),
          Math.abs(centerX - (body.boundingBox.x + body.boundingBox.width)),
          Math.abs(centerY - body.boundingBox.y),
          Math.abs(centerY - (body.boundingBox.y + body.boundingBox.height)),
        );
        return (
          nearBody &&
          outsideDistance <=
            margin + Math.max(tail.boundingBox.width, tail.boundingBox.height)
        );
      })
      .sort(
        (a, b) =>
          a.boundingBox.width * a.boundingBox.height -
          b.boundingBox.width * b.boundingBox.height,
      );
    const detachedTail = candidates[0];
    if (!detachedTail) return body;
    removed.add(detachedTail.id);
    return Object.freeze({
      ...body,
      kind: 'speech' as const,
      tail: detachedTail.tail,
      classificationConfidence: Math.max(body.classificationConfidence, 0.82),
      confidence: Math.min(body.confidence, detachedTail.confidence),
    });
  });
  return merged.filter((bubble) => !removed.has(bubble.id));
}

function componentToRuns(component: Component, width: number): MaskRun[] {
  const sorted = [...component.pixels].sort((a, b) => a - b);
  const runs: MaskRun[] = [];
  let startX = -1;
  let row = -1;
  let previousX = -2;
  for (const index of sorted) {
    const x = (index % width) - component.minX;
    const y = Math.floor(index / width) - component.minY;
    if (y !== row || x !== previousX + 1) {
      if (startX >= 0)
        runs.push(
          Object.freeze({ y: row, x: startX, length: previousX - startX + 1 }),
        );
      row = y;
      startX = x;
    }
    previousX = x;
  }
  if (startX >= 0)
    runs.push(
      Object.freeze({ y: row, x: startX, length: previousX - startX + 1 }),
    );
  return runs;
}

function radialContour(
  component: Component,
  width: number,
  scaleX: number,
  scaleY: number,
  space: ImageSpace,
): Polygon<ImageSpace> {
  const centerX =
    component.pixels.reduce((sum, index) => sum + (index % width), 0) /
    component.pixels.length;
  const centerY =
    component.pixels.reduce(
      (sum, index) => sum + Math.floor(index / width),
      0,
    ) / component.pixels.length;
  const bins = 96;
  const radii = new Float64Array(bins);
  const points = new Array<{ x: number; y: number } | undefined>(bins);
  for (const index of component.pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    let angle = Math.atan2(y - centerY, x - centerX);
    if (angle < 0) angle += Math.PI * 2;
    const bin = Math.floor((angle / (Math.PI * 2)) * bins) % bins;
    const radius = Math.hypot(x - centerX, y - centerY);
    if (radius > radii[bin]!) {
      radii[bin] = radius;
      points[bin] = {
        x: (x + 0.5) * scaleX - 0.5,
        y: (y + 0.5) * scaleY - 0.5,
      };
    }
  }
  const contour = points.filter(
    (point): point is { x: number; y: number } => point !== undefined,
  );
  const mapped = contour.map((point) =>
    Object.freeze({ x: point.x, y: point.y, coordinateSpace: space }),
  );
  return Object.freeze({
    points: Object.freeze(mapped),
    coordinateSpace: space,
  });
}

function simplifyPolygon(
  polygon: Polygon<ImageSpace>,
  tolerance: number,
): Polygon<ImageSpace> {
  const points = polygon.points;
  if (points.length < 8) return polygon;
  const selected = points.filter(
    (_, index) => index % Math.max(1, Math.ceil(tolerance)) === 0,
  );
  return Object.freeze({
    points: Object.freeze(selected),
    coordinateSpace: polygon.coordinateSpace,
  });
}

function detectTail(contour: Polygon<ImageSpace>): Polygon<ImageSpace> | null {
  const points = contour.points;
  if (points.length < 20) return null;
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const radii = points.map((point) =>
    Math.hypot(point.x - center.x, point.y - center.y),
  );
  const protrusions: boolean[] = radii.map((radius, index) => {
    const nearby: number[] = [];
    for (let delta = -7; delta <= 7; delta += 1) {
      if (Math.abs(delta) <= 2) continue;
      nearby.push(radii[(index + delta + radii.length) % radii.length]!);
    }
    nearby.sort((a, b) => a - b);
    const baseline = nearby[Math.floor(nearby.length / 2)]!;
    return radius > baseline * 1.2 && radius - baseline > 4;
  });
  let start = -1;
  let longest: { start: number; end: number; length: number } | null = null;
  for (let i = 0; i <= protrusions.length * 2; i += 1) {
    const index = i % protrusions.length;
    if (protrusions[index] && start < 0) start = i;
    if ((!protrusions[index] || i === protrusions.length * 2) && start >= 0) {
      const length = i - start;
      if (length <= 12 && (!longest || length > longest.length))
        longest = { start, end: i - 1, length };
      start = -1;
    }
    if (i >= protrusions.length && !longest) break;
  }
  if (!longest || longest.length < 2) return null;
  const first = (longest.start - 1 + points.length) % points.length;
  const last = (longest.end + 1) % points.length;
  let tip = (longest.start + Math.floor(longest.length / 2)) % points.length;
  for (let i = longest.start; i <= longest.end; i += 1) {
    const candidate = i % points.length;
    if (radii[candidate]! > radii[tip]!) tip = candidate;
  }
  return Object.freeze({
    points: Object.freeze([points[first]!, points[tip]!, points[last]!]),
    coordinateSpace: contour.coordinateSpace,
  });
}

function countRadialPeaks(component: Component, width: number): number {
  const bins = 48;
  const centerX =
    component.pixels.reduce((sum, index) => sum + (index % width), 0) /
    component.pixels.length;
  const centerY =
    component.pixels.reduce(
      (sum, index) => sum + Math.floor(index / width),
      0,
    ) / component.pixels.length;
  const radii = new Float64Array(bins);
  for (const index of component.pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    let angle = Math.atan2(y - centerY, x - centerX);
    if (angle < 0) angle += Math.PI * 2;
    const bin = Math.floor((angle / (Math.PI * 2)) * bins) % bins;
    radii[bin] = Math.max(radii[bin]!, Math.hypot(x - centerX, y - centerY));
  }
  let peaks = 0;
  for (let i = 0; i < bins; i += 1) {
    const current = radii[i]!;
    const before = radii[(i - 1 + bins) % bins]!;
    const after = radii[(i + 1) % bins]!;
    if (current > before + 1.5 && current > after + 1.5) peaks += 1;
  }
  return peaks;
}

function cornerFillRatio(
  component: Component,
  mask: Uint8Array,
  width: number,
): number {
  const boxWidth = component.maxX - component.minX + 1;
  const boxHeight = component.maxY - component.minY + 1;
  const patchWidth = Math.max(2, Math.round(boxWidth * 0.075));
  const patchHeight = Math.max(2, Math.round(boxHeight * 0.075));
  const corners = [
    [component.minX, component.minY],
    [component.maxX - patchWidth + 1, component.minY],
    [component.minX, component.maxY - patchHeight + 1],
    [component.maxX - patchWidth + 1, component.maxY - patchHeight + 1],
  ] as const;
  let filled = 0;
  let total = 0;
  for (const [left, top] of corners) {
    for (let y = top; y < top + patchHeight; y += 1) {
      for (let x = left; x < left + patchWidth; x += 1) {
        total += 1;
        if (mask[y * width + x]) filled += 1;
      }
    }
  }
  return total ? filled / total : 0;
}

function renderDebug(
  bytes: Uint8Array,
  bubbles: readonly Bubble[],
  space: ImageSpace,
): Promise<Buffer> {
  const paths = bubbles
    .map((bubble, index) => {
      const points = bubble.polygon.points;
      if (points.length < 3) return '';
      const path =
        points
          .map(
            (point, pointIndex) =>
              `${pointIndex === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
          )
          .join(' ') + ' Z';
      const tail = bubble.tail?.points.length
        ? `<path d="${bubble.tail.points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} Z" fill="#ffb00044" stroke="#ff8a00" stroke-width="2"/>`
        : '';
      return `<path d="${path}" fill="none" stroke="#00d084" stroke-width="3"/>${tail}<text x="${bubble.boundingBox.x + 4}" y="${bubble.boundingBox.y + 18}" fill="#ff3b30" font-size="16">${index + 1}</text>`;
    })
    .join('');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${space.dimensions.width}" height="${space.dimensions.height}" viewBox="0 0 ${space.dimensions.width} ${space.dimensions.height}">${paths}</svg>`,
  );
  return sharp(bytes)
    .rotate()
    .composite([{ input: svg }])
    .png()
    .toBuffer();
}

function assertPolygon(polygon: Polygon<ImageSpace>, space: ImageSpace): void {
  if (
    polygon.coordinateSpace.id !== space.id ||
    polygon.coordinateSpace.kind !== 'image'
  ) {
    throw new BubbleDetectionError(
      'Bubble polygon must use the declared ImageSpace.',
    );
  }
  if (polygon.points.length < 3)
    throw new BubbleDetectionError(
      'Bubble polygon must have at least three points.',
    );
  for (const point of polygon.points) {
    if (
      point.coordinateSpace.id !== space.id ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      throw new BubbleDetectionError(
        'Bubble polygon points must be finite and use the declared ImageSpace.',
      );
    }
    if (
      point.x < -0.5 ||
      point.y < -0.5 ||
      point.x > space.dimensions.width - 0.5 ||
      point.y > space.dimensions.height - 0.5
    ) {
      throw new BubbleDetectionError(
        'Bubble polygon must stay within its image bounds.',
      );
    }
  }
  if (Math.abs(signedArea(polygon.points)) < 1)
    throw new BubbleDetectionError('Bubble polygon must have non-zero area.');
}

function assertKind(kind: string): asserts kind is BubbleKind {
  if (!['speech', 'thought', 'narration', 'unknown'].includes(kind)) {
    throw new BubbleDetectionError('Bubble kind is not supported.');
  }
}

function assertShape(shape: string): asserts shape is BubbleShape {
  if (
    ![
      'ellipse',
      'rounded-rectangle',
      'rectangle',
      'irregular',
      'partial',
    ].includes(shape)
  ) {
    throw new BubbleDetectionError('Bubble shape is not supported.');
  }
}

function polygonBounds(
  polygon: Polygon<ImageSpace>,
): Omit<Bounds<ImageSpace>, 'coordinateSpace'> {
  const xs = polygon.points.map((point) => point.x);
  const ys = polygon.points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function pointInPolygon(
  x: number,
  y: number,
  points: readonly Point<ImageSpace>[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const first = points[i]!;
    const second = points[j]!;
    const crosses =
      first.y > y !== second.y > y &&
      x <
        ((second.x - first.x) * (y - first.y)) / (second.y - first.y) + first.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function signedArea(points: readonly Point<ImageSpace>[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function freezePolygon(polygon: Polygon<ImageSpace>): Polygon<ImageSpace> {
  return Object.freeze({
    points: Object.freeze(
      polygon.points.map((point) => Object.freeze({ ...point })),
    ),
    coordinateSpace: polygon.coordinateSpace,
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
