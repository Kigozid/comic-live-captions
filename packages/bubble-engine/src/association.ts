import type {
  BubbleDialogueReference,
  DialogueTextAlignment,
} from '@comic-captioner/core';
import type { Bubble } from './index.js';
import type {
  AlignmentResult,
  Bounds,
  ImageSpace,
  OCRDocument,
  OCRLine,
  OriginalTextRegion,
  Point,
  Polygon,
} from '@comic-captioner/shared';

export interface BubbleSemanticCandidate {
  readonly bubbleId: string;
  readonly kind: Bubble['kind'];
  readonly shape: Bubble['shape'];
  readonly spatialConfidence: number;
}

export interface BubbleSemanticResolutionInput {
  readonly originalText: string;
  readonly candidates: readonly BubbleSemanticCandidate[];
}

/** Optional AI semantic port; invoked only when geometry yields competing candidates. */
export interface BubbleSemanticResolver {
  resolveAmbiguousBubble(
    input: BubbleSemanticResolutionInput,
  ): Promise<{ readonly bubbleId: string; readonly confidence: number } | null>;
}

export interface BubbleDialogueAssociationInput {
  readonly bubbles: readonly Bubble[];
  readonly originalTextRegions: readonly OriginalTextRegion[];
  readonly ocrDocument: OCRDocument;
  readonly coordinateSpace: ImageSpace;
  /** Maps cleaned-page bubble geometry into the original-page ImageSpace. */
  readonly alignment?: AlignmentResult;
}

export interface BubbleDialogueAssociationResult {
  readonly references: readonly BubbleDialogueReference[];
  readonly unassignedTextRegionIds: readonly string[];
  readonly ambiguousTextRegionIds: readonly string[];
}

export interface BubbleDialogueAssociationOptions {
  readonly minimumSpatialScore?: number;
  readonly ambiguityMargin?: number;
  readonly semanticResolver?: BubbleSemanticResolver;
}

export class BubbleDialogueAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BubbleDialogueAssociationError';
  }
}

interface SpatialBubble {
  readonly source: Bubble;
  readonly polygon: Polygon<ImageSpace>;
  readonly bounds: Bounds<ImageSpace>;
}

interface AssignedRegion {
  readonly bubble: SpatialBubble;
  readonly region: OriginalTextRegion;
  readonly score: number;
  readonly method: 'spatial' | 'semantic';
  readonly semanticConfidence?: number;
}

/** Geometry-first OCR/text-region to bubble association. It emits review proposals only. */
export class BubbleDialogueAssociationEngine {
  async associate(
    input: BubbleDialogueAssociationInput,
    options: BubbleDialogueAssociationOptions = {},
  ): Promise<BubbleDialogueAssociationResult> {
    validateInput(input);
    validateOptions(options);
    const bubbles = input.bubbles.map((bubble) => toPageBubble(bubble, input));
    const lines = extractOCRLines(input.ocrDocument, input);
    const lineMatches = input.originalTextRegions.map((region) =>
      lines.filter(
        (line) =>
          textBoxesOverlap(region.boundingBox, line.boundingBox) >= 0.12,
      ),
    );

    const assigned: AssignedRegion[] = [];
    const unassignedTextRegionIds: string[] = [];
    const ambiguousTextRegionIds: string[] = [];
    for (const [index, region] of input.originalTextRegions.entries()) {
      const candidates = bubbles
        .map((bubble) => ({ bubble, score: spatialScore(bubble, region) }))
        .filter(({ score }) => score >= (options.minimumSpatialScore ?? 0.42))
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.bubble.source.id.localeCompare(b.bubble.source.id),
        );
      if (candidates.length === 0) {
        unassignedTextRegionIds.push(region.id);
        continue;
      }
      const first = candidates[0]!;
      const second = candidates[1];
      const ambiguous = Boolean(
        first.score < 0.72 ||
        (second &&
          first.score - second.score <= (options.ambiguityMargin ?? 0.12)),
      );
      let winner = first;
      let method: AssignedRegion['method'] = 'spatial';
      let semanticConfidence: number | undefined;
      if (ambiguous) {
        if (options.semanticResolver) {
          const matchedLines = lineMatches[index] ?? [];
          const originalText = matchedLines.map((line) => line.text).join(' ');
          const resolution =
            await options.semanticResolver.resolveAmbiguousBubble({
              originalText,
              candidates: candidates.map(({ bubble, score }) => ({
                bubbleId: bubble.source.id,
                kind: bubble.source.kind,
                shape: bubble.source.shape,
                spatialConfidence: score,
              })),
            });
          if (resolution) {
            validateSemanticResolution(resolution, candidates);
            winner = candidates.find(
              (candidate) => candidate.bubble.source.id === resolution.bubbleId,
            )!;
            method = 'semantic';
            semanticConfidence = resolution.confidence;
          }
        }
        if (method !== 'semantic') ambiguousTextRegionIds.push(region.id);
      }
      assigned.push({
        bubble: winner.bubble,
        region,
        score: winner.score,
        method,
        ...(semanticConfidence !== undefined ? { semanticConfidence } : {}),
      });
    }

    const referenceGroups = new Map<string, AssignedRegion[]>();
    for (const entry of assigned) {
      const id = entry.bubble.source.id;
      const group = referenceGroups.get(id) ?? [];
      group.push(entry);
      referenceGroups.set(id, group);
    }
    const references = [...referenceGroups.values()].map((group) =>
      makeReference(group, input, lines),
    );
    return Object.freeze({
      references: Object.freeze(references),
      unassignedTextRegionIds: Object.freeze(unassignedTextRegionIds),
      ambiguousTextRegionIds: Object.freeze(ambiguousTextRegionIds),
    });
  }
}

function validateInput(input: BubbleDialogueAssociationInput): void {
  const spaceId = input.coordinateSpace.id;
  const regionIds = new Set<string>();
  for (const region of input.originalTextRegions) {
    if (regionIds.has(region.id))
      throw new BubbleDialogueAssociationError(
        `Duplicate text region ID ${region.id}.`,
      );
    regionIds.add(region.id);
    if (
      region.coordinateSpace.id !== spaceId ||
      region.boundingBox.coordinateSpace.id !== spaceId ||
      region.polygon.coordinateSpace.id !== spaceId
    ) {
      throw new BubbleDialogueAssociationError(
        `Text region ${region.id} is not in the target page ImageSpace.`,
      );
    }
  }
  if (
    input.ocrDocument.coordinateSpace.id !== spaceId &&
    !(
      input.alignment &&
      input.ocrDocument.coordinateSpace.id === input.alignment.sourceSpace.id &&
      input.alignment.targetSpace.id === spaceId
    )
  ) {
    throw new BubbleDialogueAssociationError(
      'OCR geometry must use the target page space or the alignment source space.',
    );
  }
  if (
    input.ocrDocument.boundingBox.coordinateSpace.id !==
    input.ocrDocument.coordinateSpace.id
  ) {
    throw new BubbleDialogueAssociationError(
      'OCR document bounds do not match its declared coordinate space.',
    );
  }
  for (const block of input.ocrDocument.blocks) {
    if (
      block.coordinateSpace.id !== input.ocrDocument.coordinateSpace.id ||
      block.boundingBox.coordinateSpace.id !==
        input.ocrDocument.coordinateSpace.id
    ) {
      throw new BubbleDialogueAssociationError(
        `OCR block ${block.id} has inconsistent coordinate space.`,
      );
    }
  }
  for (const bubble of input.bubbles) {
    if (
      bubble.polygon.coordinateSpace.id !== bubble.coordinateSpace.id ||
      bubble.boundingBox.coordinateSpace.id !== bubble.coordinateSpace.id ||
      (bubble.coordinateSpace.id !== input.coordinateSpace.id &&
        !(
          input.alignment &&
          bubble.coordinateSpace.id === input.alignment.sourceSpace.id &&
          input.alignment.targetSpace.id === spaceId
        ))
    ) {
      throw new BubbleDialogueAssociationError(
        `Bubble ${bubble.id} cannot be mapped into the target page ImageSpace.`,
      );
    }
  }
  if (input.alignment && input.alignment.targetSpace.id !== spaceId) {
    throw new BubbleDialogueAssociationError(
      'Alignment target does not match the requested page ImageSpace.',
    );
  }
}

function validateOptions(options: BubbleDialogueAssociationOptions): void {
  if (
    options.minimumSpatialScore !== undefined &&
    (!Number.isFinite(options.minimumSpatialScore) ||
      options.minimumSpatialScore < 0 ||
      options.minimumSpatialScore > 1)
  ) {
    throw new BubbleDialogueAssociationError(
      'Minimum spatial score must be between 0 and 1.',
    );
  }
  if (
    options.ambiguityMargin !== undefined &&
    (!Number.isFinite(options.ambiguityMargin) ||
      options.ambiguityMargin < 0 ||
      options.ambiguityMargin > 1)
  ) {
    throw new BubbleDialogueAssociationError(
      'Ambiguity margin must be between 0 and 1.',
    );
  }
}

function toPageBubble(
  bubble: Bubble,
  input: BubbleDialogueAssociationInput,
): SpatialBubble {
  if (bubble.coordinateSpace.id === input.coordinateSpace.id) {
    if (
      bubble.coordinateSpace.dimensions.width !==
        input.coordinateSpace.dimensions.width ||
      bubble.coordinateSpace.dimensions.height !==
        input.coordinateSpace.dimensions.height
    ) {
      throw new BubbleDialogueAssociationError(
        `Bubble ${bubble.id} conflicts with the target ImageSpace dimensions.`,
      );
    }
    return {
      source: bubble,
      polygon: bubble.polygon,
      bounds: bubble.boundingBox,
    };
  }
  const alignment = input.alignment;
  if (!alignment || alignment.sourceSpace.id !== bubble.coordinateSpace.id) {
    throw new BubbleDialogueAssociationError(
      `Bubble ${bubble.id} has no transform to the original page.`,
    );
  }
  return {
    source: bubble,
    polygon: transformPolygon(bubble.polygon, alignment),
    bounds: transformBounds(bubble.boundingBox, alignment),
  };
}

function extractOCRLines(
  document: OCRDocument,
  input: BubbleDialogueAssociationInput,
): readonly OCRLine[] {
  const lines = document.blocks.flatMap((block) => block.lines);
  for (const line of lines) {
    if (
      line.coordinateSpace.id !== document.coordinateSpace.id ||
      line.boundingBox.coordinateSpace.id !== document.coordinateSpace.id
    ) {
      throw new BubbleDialogueAssociationError(
        `OCR line ${line.id} has inconsistent coordinate space.`,
      );
    }
  }
  if (document.coordinateSpace.id === input.coordinateSpace.id) return lines;
  if (
    !input.alignment ||
    input.alignment.sourceSpace.id !== document.coordinateSpace.id
  ) {
    throw new BubbleDialogueAssociationError(
      'OCR lines have no transform to the original page.',
    );
  }
  return lines.map((line) => ({
    ...line,
    boundingBox: transformBounds(line.boundingBox, input.alignment!),
    coordinateSpace: input.coordinateSpace,
  }));
}

function spatialScore(
  bubble: SpatialBubble,
  region: OriginalTextRegion,
): number {
  const box = region.boundingBox;
  const centerInside = pointInPolygon(
    box.x + box.width / 2,
    box.y + box.height / 2,
    bubble.polygon.points,
  );
  const regionPointsInside = region.polygon.points.filter((point) =>
    pointInPolygon(point.x, point.y, bubble.polygon.points),
  ).length;
  const polygonCoverage = region.polygon.points.length
    ? regionPointsInside / region.polygon.points.length
    : 0;
  const boxCoverage = textBoxesOverlap(bubble.bounds, box);
  if (!centerInside && boxCoverage < 0.5 && polygonCoverage < 0.5) return 0;
  return clamp(
    0.6 * Number(centerInside) + 0.22 * polygonCoverage + 0.18 * boxCoverage,
    0,
    1,
  );
}

function makeReference(
  group: readonly AssignedRegion[],
  input: BubbleDialogueAssociationInput,
  lines: readonly OCRLine[],
): BubbleDialogueReference {
  const regionIds = [...new Set(group.map((entry) => entry.region.id))].sort();
  const matchedLines = group
    .flatMap((entry) =>
      lines.filter(
        (line) =>
          textBoxesOverlap(entry.region.boundingBox, line.boundingBox) >= 0.12,
      ),
    )
    .filter(
      (line, index, all) =>
        all.findIndex((candidate) => candidate.id === line.id) === index,
    )
    .sort(
      (a, b) =>
        a.boundingBox.y - b.boundingBox.y || a.boundingBox.x - b.boundingBox.x,
    );
  const textBounds = matchedLines.length
    ? unionBounds(
        matchedLines.map((line) => line.boundingBox),
        input.coordinateSpace,
      )
    : unionBounds(
        group.map((entry) => entry.region.boundingBox),
        input.coordinateSpace,
      );
  const bubbleBounds = group[0]!.bubble.bounds;
  const alignment = inferTextAlignment(textBounds, bubbleBounds);
  const semantic = group.filter((entry) => entry.method === 'semantic');
  const meanSpatial =
    group.reduce((sum, entry) => sum + entry.score, 0) / group.length;
  const meanSemantic = semantic.length
    ? semantic.reduce(
        (sum, entry) => sum + (entry.semanticConfidence ?? 0),
        0,
      ) / semantic.length
    : 1;
  return Object.freeze({
    id: `bubble-dialogue:${group[0]!.bubble.source.id}:${regionIds.join(',')}`,
    bubbleId: group[0]!.bubble.source.id as BubbleDialogueReference['bubbleId'],
    textRegionIds: Object.freeze(regionIds),
    originalText: matchedLines
      .map((line) => line.text)
      .filter(Boolean)
      .join('\n'),
    originalTextBounds: textBounds,
    lineCount: matchedLines.length,
    alignment,
    confidence: clamp(meanSpatial * meanSemantic, 0, 1),
    status: 'pending-review',
    method: semantic.length ? 'semantic' : 'spatial',
    revision: 1,
  });
}

function validateSemanticResolution(
  resolution: { readonly bubbleId: string; readonly confidence: number },
  candidates: readonly {
    readonly bubble: SpatialBubble;
    readonly score: number;
  }[],
): void {
  if (
    !resolution.bubbleId ||
    !Number.isFinite(resolution.confidence) ||
    resolution.confidence < 0 ||
    resolution.confidence > 1
  ) {
    throw new BubbleDialogueAssociationError(
      'Semantic resolver returned invalid confidence or bubble ID.',
    );
  }
  if (
    !candidates.some(
      (candidate) => candidate.bubble.source.id === resolution.bubbleId,
    )
  ) {
    throw new BubbleDialogueAssociationError(
      'Semantic resolver selected a bubble outside the spatial candidate set.',
    );
  }
}

function transformPolygon(
  polygon: Polygon<ImageSpace>,
  alignment: AlignmentResult,
): Polygon<ImageSpace> {
  const points = polygon.points.map((point) =>
    transformPoint(point, alignment),
  );
  return Object.freeze({
    points: Object.freeze(points),
    coordinateSpace: alignment.targetSpace,
  });
}

function transformBounds(
  bounds: Bounds<ImageSpace>,
  alignment: AlignmentResult,
): Bounds<ImageSpace> {
  const corners: readonly Point<ImageSpace>[] = [
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
  ];
  const transformed = corners.map((point) => transformPoint(point, alignment));
  const xs = transformed.map((point) => point.x);
  const ys = transformed.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: alignment.targetSpace,
  });
}

function transformPoint(
  point: Point<ImageSpace>,
  alignment: AlignmentResult,
): Point<ImageSpace> {
  const [m0, m1, m2, m3, m4, m5] = alignment.transformMatrix.values;
  return Object.freeze({
    x: m0 * point.x + m1 * point.y + m2,
    y: m3 * point.x + m4 * point.y + m5,
    coordinateSpace: alignment.targetSpace,
  });
}

function textBoxesOverlap(
  a: Bounds<ImageSpace>,
  b: Bounds<ImageSpace>,
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
  const minimumArea = Math.min(a.width * a.height, b.width * b.height);
  return minimumArea > 0 ? intersection / minimumArea : 0;
}

function unionBounds(
  bounds: readonly Bounds<ImageSpace>[],
  space: ImageSpace,
): Bounds<ImageSpace> {
  if (bounds.length === 0)
    throw new BubbleDialogueAssociationError(
      'Cannot create a reference without text geometry.',
    );
  const left = Math.min(...bounds.map((box) => box.x));
  const top = Math.min(...bounds.map((box) => box.y));
  const right = Math.max(...bounds.map((box) => box.x + box.width));
  const bottom = Math.max(...bounds.map((box) => box.y + box.height));
  return Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: space,
  });
}

function inferTextAlignment(
  text: Bounds<ImageSpace>,
  bubble: Bounds<ImageSpace>,
): DialogueTextAlignment {
  const delta = text.x + text.width / 2 - (bubble.x + bubble.width / 2);
  const tolerance = bubble.width * 0.12;
  if (Math.abs(delta) <= tolerance) return 'center';
  return delta < 0 ? 'left' : 'right';
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
