import type {
  Bounds,
  ImageSpace,
  Polygon,
} from '@comic-captioner/shared';

/**
 * Bubble ↔ text-region association.
 *
 * Uses containment, overlap, and geometric consistency to attach detected
 * text regions to speech bubbles. Multiple text lines may map to one bubble;
 * text outside every bubble is preserved as a non-dialogue region
 * (narration, sound effects, signs) rather than being forced into dialogue.
 *
 * Association confidence is strictly separate from:
 * - bubble-detection confidence
 * - text-region-detection confidence
 * - OCR-recognition confidence
 */

export type TextAssociationClassification =
  | 'dialogue'
  | 'non-dialogue'
  | 'ambiguous';

export interface TextRegionForAssociation {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly polygon?: Polygon<ImageSpace>;
  /** Text-region detection confidence; not reused as association confidence. */
  readonly detectionConfidence?: number;
}

export interface BubbleForAssociation {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly polygon: Polygon<ImageSpace>;
  /** Bubble-detection confidence; not reused as association confidence. */
  readonly detectionConfidence?: number;
}

export interface TextBubbleAssociation {
  readonly textRegionId: string;
  /** Null when the region is not confidently inside any bubble. */
  readonly bubbleId: string | null;
  /** Association confidence in [0, 1]. Not a detection or OCR score. */
  readonly confidence: number;
  readonly classification: TextAssociationClassification;
  readonly alternatives: readonly {
    readonly bubbleId: string;
    readonly score: number;
  }[];
  readonly needsReview: boolean;
}

export interface TextBubbleAssociationResult {
  readonly associations: readonly TextBubbleAssociation[];
  readonly unassociatedTextRegionIds: readonly string[];
  readonly ambiguousTextRegionIds: readonly string[];
  readonly bubblesWithoutTextIds: readonly string[];
  /** Mean association confidence over associated regions; 0 when none. */
  readonly meanAssociationConfidence: number;
}

export interface TextBubbleAssociationOptions {
  /** Minimum score for any candidate bubble (default 0.38). */
  readonly minimumScore?: number;
  /** Score gap below which the match is ambiguous (default 0.12). */
  readonly ambiguityMargin?: number;
  /** Score at or above which classification is `dialogue` (default 0.55). */
  readonly dialogueScore?: number;
  /** Score below which the region is marked for review (default 0.55). */
  readonly reviewScore?: number;
}

export class TextBubbleAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextBubbleAssociationError';
  }
}

const DEFAULT_MINIMUM_SCORE = 0.38;
const DEFAULT_AMBIGUITY_MARGIN = 0.12;
const DEFAULT_DIALOGUE_SCORE = 0.55;
const DEFAULT_REVIEW_SCORE = 0.55;

/**
 * Assign text regions to bubbles using containment, overlap, and geometric
 * consistency. Regions without a confident bubble stay available as
 * non-dialogue / ambiguous candidates for manual review.
 */
export function associateTextRegionsToBubbles(
  regions: readonly TextRegionForAssociation[],
  bubbles: readonly BubbleForAssociation[],
  options: TextBubbleAssociationOptions = {},
): TextBubbleAssociationResult {
  validateOptions(options);
  for (const region of regions) validateRegion(region);
  for (const bubble of bubbles) validateBubble(bubble);

  const minimumScore = options.minimumScore ?? DEFAULT_MINIMUM_SCORE;
  const ambiguityMargin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
  const dialogueScore = options.dialogueScore ?? DEFAULT_DIALOGUE_SCORE;
  const reviewScore = options.reviewScore ?? DEFAULT_REVIEW_SCORE;

  const associations: TextBubbleAssociation[] = [];
  const unassociatedTextRegionIds: string[] = [];
  const ambiguousTextRegionIds: string[] = [];
  const claimedBubbles = new Set<string>();

  for (const region of regions) {
    const candidates = bubbles
      .map((bubble) => ({
        bubbleId: bubble.id,
        score: scoreRegion(region, bubble),
      }))
      .filter((candidate) => candidate.score >= 0.2)
      .sort(
        (left, right) =>
          right.score - left.score || left.bubbleId.localeCompare(right.bubbleId),
      );
    const best = candidates[0];
    const second = candidates[1];
    if (!best || best.score < minimumScore) {
      unassociatedTextRegionIds.push(region.id);
      associations.push({
        textRegionId: region.id,
        bubbleId: null,
        confidence: best?.score ?? 0,
        classification: 'non-dialogue',
        alternatives: candidates,
        needsReview: true,
      });
      continue;
    }
    const ambiguous =
      best.score < dialogueScore ||
      (second && best.score - second.score < ambiguityMargin);
    if (ambiguous) ambiguousTextRegionIds.push(region.id);
    claimedBubbles.add(best.bubbleId);
    associations.push({
      textRegionId: region.id,
      bubbleId: best.bubbleId,
      confidence: best.score,
      classification: ambiguous ? 'ambiguous' : 'dialogue',
      alternatives: candidates,
      needsReview: ambiguous || best.score < reviewScore,
    });
  }

  const associated = associations.filter((item) => item.bubbleId !== null);
  const meanAssociationConfidence =
    associated.length === 0
      ? 0
      : associated.reduce((sum, item) => sum + item.confidence, 0) /
        associated.length;

  return Object.freeze({
    associations: Object.freeze(associations),
    unassociatedTextRegionIds: Object.freeze([...unassociatedTextRegionIds]),
    ambiguousTextRegionIds: Object.freeze([...ambiguousTextRegionIds]),
    bubblesWithoutTextIds: Object.freeze(
      bubbles
        .map((bubble) => bubble.id)
        .filter((id) => !claimedBubbles.has(id))
        .sort(),
    ),
    meanAssociationConfidence,
  });
}

/**
 * Geometric overlap between an OCR line and a detected text region.
 * The returned confidence is match confidence only — never OCR recognition
 * confidence and never bubble-association confidence.
 */
export function matchOcrBoxToTextRegion(
  ocrBox: Bounds<ImageSpace>,
  region: TextRegionForAssociation,
): number {
  return boxCoverage(ocrBox, region.boundingBox);
}

function scoreRegion(
  region: TextRegionForAssociation,
  bubble: BubbleForAssociation,
): number {
  const box = region.boundingBox;
  if (box.width <= 0 || box.height <= 0) return 0;

  const points = samplePoints(box);
  const polygon = region.polygon?.points ?? rectPoints(box, region.boundingBox.coordinateSpace);
  const regionCoverage =
    points.filter((point) =>
      pointInPolygon(point.x, point.y, bubble.polygon.points),
    ).length / points.length;

  const center = points[4]!;
  const centerInside = pointInPolygon(
    center.x,
    center.y,
    bubble.polygon.points,
  );

  const boxCoverageRatio = boxCoverage(box, bubble.boundingBox);
  const gapX = Math.max(
    bubble.boundingBox.x - (box.x + box.width),
    box.x - (bubble.boundingBox.x + bubble.boundingBox.width),
    0,
  );
  const gapY = Math.max(
    bubble.boundingBox.y - (box.y + box.height),
    box.y - (bubble.boundingBox.y + bubble.boundingBox.height),
    0,
  );
  const nearBorder =
    Math.hypot(gapX, gapY) <= Math.max(2, box.height * 0.28);

  // Consistency: if the region has a polygon, also measure polygon coverage.
  const polygonCoverage = region.polygon
    ? polygon.filter((point) =>
        pointInPolygon(point.x, point.y, bubble.polygon.points),
      ).length / Math.max(1, polygon.length)
    : regionCoverage;

  return Math.min(
    1,
    0.42 * regionCoverage +
      0.22 * Number(centerInside) +
      0.2 * boxCoverageRatio +
      0.1 * polygonCoverage +
      (nearBorder ? 0.06 : 0),
  );
}

function samplePoints(bounds: Bounds<ImageSpace>): readonly {
  x: number;
  y: number;
}[] {
  const x0 = bounds.x;
  const x1 = bounds.x + bounds.width / 2;
  const x2 = bounds.x + bounds.width;
  const y0 = bounds.y;
  const y1 = bounds.y + bounds.height / 2;
  const y2 = bounds.y + bounds.height;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x2, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x0, y: y2 },
    { x: x1, y: y2 },
    { x: x2, y: y2 },
  ];
}

function rectPoints(
  bounds: Bounds<ImageSpace>,
  space: ImageSpace,
): readonly { x: number; y: number }[] {
  void space;
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
}

function pointInPolygon(
  x: number,
  y: number,
  points: readonly { readonly x: number; readonly y: number }[],
): boolean {
  let inside = false;
  for (
    let index = 0, previous = points.length - 1;
    index < points.length;
    previous = index, index += 1
  ) {
    const current = points[index]!;
    const prior = points[previous]!;
    if (
      current.y > y !== prior.y > y &&
      x <
        ((prior.x - current.x) * (y - current.y)) / (prior.y - current.y) +
          current.x
    )
      inside = !inside;
  }
  return inside;
}

function boxCoverage(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(
    0,
    Math.min(inner.x + inner.width, outer.x + outer.width) -
      Math.max(inner.x, outer.x),
  );
  const height = Math.max(
    0,
    Math.min(inner.y + inner.height, outer.y + outer.height) -
      Math.max(inner.y, outer.y),
  );
  const intersection = width * height;
  const area = inner.width * inner.height;
  return area > 0 ? intersection / area : 0;
}

function validateRegion(region: TextRegionForAssociation): void {
  if (!region.id.trim()) {
    throw new TextBubbleAssociationError('Text-region ID is required.');
  }
  const box = region.boundingBox;
  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    throw new TextBubbleAssociationError(
      `Text region ${region.id} has an invalid bounding box.`,
    );
  }
  if (
    region.detectionConfidence !== undefined &&
    (!Number.isFinite(region.detectionConfidence) ||
      region.detectionConfidence < 0 ||
      region.detectionConfidence > 1)
  ) {
    throw new TextBubbleAssociationError(
      `Text region ${region.id} detectionConfidence must be in [0, 1].`,
    );
  }
}

function validateBubble(bubble: BubbleForAssociation): void {
  if (!bubble.id.trim()) {
    throw new TextBubbleAssociationError('Bubble ID is required.');
  }
  if (!bubble.polygon || bubble.polygon.points.length < 3) {
    throw new TextBubbleAssociationError(
      `Bubble ${bubble.id} polygon needs at least 3 points.`,
    );
  }
  const box = bubble.boundingBox;
  if (
    !Number.isFinite(box.x) ||
    !Number.isFinite(box.y) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    throw new TextBubbleAssociationError(
      `Bubble ${bubble.id} has an invalid bounding box.`,
    );
  }
}

function validateOptions(options: TextBubbleAssociationOptions): void {
  for (const [name, value] of [
    ['minimumScore', options.minimumScore],
    ['ambiguityMargin', options.ambiguityMargin],
    ['dialogueScore', options.dialogueScore],
    ['reviewScore', options.reviewScore],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new TextBubbleAssociationError(`${name} must be in [0, 1].`);
    }
  }
}
