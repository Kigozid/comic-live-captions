import type { EditableBubble } from './editor-model.js';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface XY {
  readonly x: number;
  readonly y: number;
}

export type OCRClassification = 'dialogue' | 'non-dialogue' | 'ambiguous';

export interface OCRBubbleMatch {
  readonly classification: OCRClassification;
  readonly bubbleId: string | null;
  readonly confidence: number;
  readonly alternatives: readonly {
    readonly bubbleId: string;
    readonly score: number;
  }[];
}

/** Geometry-only line assignment. Ambiguous or off-bubble text remains reviewable. */
export function associateOCRLine(
  bounds: Box,
  bubbles: readonly EditableBubble[],
): OCRBubbleMatch {
  const alternatives = bubbles
    .filter((bubble) => bubble.reviewStatus !== 'rejected')
    .map((bubble) => ({
      bubbleId: bubble.id,
      score: scoreLine(bounds, bubble),
    }))
    .filter((candidate) => candidate.score >= 0.2)
    .sort(
      (left, right) =>
        right.score - left.score || left.bubbleId.localeCompare(right.bubbleId),
    );
  const best = alternatives[0];
  const second = alternatives[1];
  if (!best || best.score < 0.38)
    return {
      classification: 'non-dialogue',
      bubbleId: null,
      confidence: best?.score ?? 0,
      alternatives,
    };
  if (second && best.score - second.score < 0.12)
    return {
      classification: 'ambiguous',
      bubbleId: null,
      confidence: best.score,
      alternatives,
    };
  return {
    classification: 'dialogue',
    bubbleId: best.bubbleId,
    confidence: best.score,
    alternatives,
  };
}

/** Suppress duplicate model boxes without changing source OCR text or geometry. */
export function deduplicateOCRLines<
  T extends {
    readonly id: string;
    readonly text: string;
    readonly confidence: number;
    readonly boundingBox: Box;
  },
>(lines: readonly T[]): readonly T[] {
  const ordered = [...lines].sort(
    (left, right) =>
      left.boundingBox.y - right.boundingBox.y ||
      left.boundingBox.x - right.boundingBox.x ||
      left.id.localeCompare(right.id),
  );
  const kept: T[] = [];
  for (const line of ordered) {
    const normalized = normalizeOCRText(line.text);
    if (!normalized) continue;
    const duplicate = kept.some(
      (candidate) =>
        normalizeOCRText(candidate.text) === normalized &&
        boxIoU(candidate.boundingBox, line.boundingBox) >= 0.65,
    );
    if (!duplicate) kept.push(line);
  }
  return Object.freeze(kept);
}

export function groupOCRLines<T extends { readonly boundingBox: Box }>(
  lines: readonly T[],
): readonly (readonly T[])[] {
  const ordered = [...lines].sort(
    (left, right) =>
      left.boundingBox.y - right.boundingBox.y ||
      left.boundingBox.x - right.boundingBox.x,
  );
  const rows: T[][] = [];
  for (const line of ordered) {
    const centerY = line.boundingBox.y + line.boundingBox.height / 2;
    const row = rows.find((candidate) => {
      const rowCenter =
        candidate.reduce(
          (sum, item) => sum + item.boundingBox.y + item.boundingBox.height / 2,
          0,
        ) / candidate.length;
      const rowHeight =
        candidate.reduce((sum, item) => sum + item.boundingBox.height, 0) /
        candidate.length;
      return Math.abs(centerY - rowCenter) <= Math.max(2, rowHeight * 0.42);
    });
    if (row) row.push(line);
    else rows.push([line]);
  }
  return Object.freeze(
    rows.map((row) =>
      Object.freeze(
        row.sort((left, right) => left.boundingBox.x - right.boundingBox.x),
      ),
    ),
  );
}

function scoreLine(bounds: Box, bubble: EditableBubble): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 0;
  const points = samplePoints(bounds);
  const coverage =
    points.filter((point) =>
      pointInPolygon(point.x, point.y, bubble.polygon.points),
    ).length / points.length;
  const center = points[4]!;
  const centerInside = pointInPolygon(
    center.x,
    center.y,
    bubble.polygon.points,
  );
  const box = bubble.boundingBox;
  const intersectionWidth = Math.max(
    0,
    Math.min(bounds.x + bounds.width, box.x + box.width) -
      Math.max(bounds.x, box.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(bounds.y + bounds.height, box.y + box.height) -
      Math.max(bounds.y, box.y),
  );
  const boxCoverage =
    (intersectionWidth * intersectionHeight) / (bounds.width * bounds.height);
  const gapX = Math.max(
    box.x - (bounds.x + bounds.width),
    bounds.x - (box.x + box.width),
    0,
  );
  const gapY = Math.max(
    box.y - (bounds.y + bounds.height),
    bounds.y - (box.y + box.height),
    0,
  );
  const nearBorder =
    Math.hypot(gapX, gapY) <= Math.max(2, bounds.height * 0.28);
  return Math.min(
    1,
    0.58 * coverage +
      0.24 * Number(centerInside) +
      0.18 * boxCoverage +
      (nearBorder ? 0.06 : 0),
  );
}

function samplePoints(bounds: Box): readonly XY[] {
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

function boxIoU(left: Box, right: Box): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  const intersection = width * height;
  const union =
    left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizeOCRText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\s+/gu, ' ')
    .trim();
}
