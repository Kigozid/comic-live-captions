import type { CaptionLayout } from '@comic-captioner/core';
import type { BubbleId, ImageSpace, Polygon } from '@comic-captioner/shared';

export type ExportIssueCode =
  | 'overflow'
  | 'low-readability'
  | 'missing-mapping'
  | 'missing-timing'
  | 'low-confidence'
  | 'missing-layout';
export interface ExportCaption {
  readonly id: string;
  readonly bubbleId: BubbleId;
  readonly caption: string;
  readonly layout: CaptionLayout | null;
  readonly start: number | null;
  readonly end: number | null;
  readonly mappingConfidence: number | null;
  readonly mapped: boolean;
  readonly confidence: number | null;
  /** Acoustic word timings when available (from forced alignment). */
  readonly words?:
    | readonly { readonly text: string; readonly start: number; readonly end: number }[]
    | undefined;
}
export interface ExportBubble {
  readonly id: BubbleId;
  readonly polygon: Polygon<ImageSpace>;
}
export interface ExportIssue {
  readonly code: ExportIssueCode;
  readonly captionId: string;
  readonly message: string;
}
export interface ExportValidationReport {
  readonly valid: boolean;
  readonly issues: readonly ExportIssue[];
}
export interface FrameExportInput {
  readonly sourceImage: Uint8Array;
  readonly captions: readonly ExportCaption[];
  readonly bubbles: readonly ExportBubble[];
  readonly time: number;
  readonly format: 'png' | 'jpeg';
  readonly quality?: number;
  readonly minimumReadability?: number;
  readonly minimumConfidence?: number;
}

export class ExportValidationError extends Error {
  constructor(readonly report: ExportValidationReport) {
    super(`Export validation failed with ${report.issues.length} issue(s).`);
    this.name = 'ExportValidationError';
  }
}

/** Validation only: uses saved fit diagnostics and never recalculates a layout. */
export function validateFrameExport(
  captions: readonly ExportCaption[],
  bubbles: readonly ExportBubble[],
  options: {
    readonly minimumReadability?: number;
    readonly minimumConfidence?: number;
  } = {},
): ExportValidationReport {
  const minimumReadability = options.minimumReadability ?? 0.45;
  const minimumConfidence = options.minimumConfidence ?? 0.6;
  const bubbleById = new Map(bubbles.map((bubble) => [bubble.id, bubble]));
  const issues: ExportIssue[] = [];
  const add = (
    code: ExportIssueCode,
    caption: ExportCaption,
    message: string,
  ) => issues.push({ code, captionId: caption.id, message });
  for (const caption of captions) {
    if (!caption.mapped || !bubbleById.has(caption.bubbleId))
      add('missing-mapping', caption, 'Caption has no valid bubble mapping.');
    if (
      caption.start === null ||
      caption.end === null ||
      !Number.isFinite(caption.start) ||
      !Number.isFinite(caption.end) ||
      caption.start < 0 ||
      caption.end <= caption.start
    )
      add('missing-timing', caption, 'Caption has no valid time interval.');
    if (!caption.layout) {
      add('missing-layout', caption, 'Caption has no saved fitted layout.');
      continue;
    }
    if (caption.layout.bubbleId !== caption.bubbleId)
      add(
        'missing-mapping',
        caption,
        'Fitted layout targets a different bubble.',
      );
    if (caption.layout.readabilityScore < minimumReadability)
      add(
        'low-readability',
        caption,
        'Caption readability is below threshold.',
      );
    if (
      caption.confidence === null ||
      !Number.isFinite(caption.confidence) ||
      caption.confidence < minimumConfidence ||
      caption.mappingConfidence === null ||
      !Number.isFinite(caption.mappingConfidence) ||
      caption.mappingConfidence < minimumConfidence
    )
      add(
        'low-confidence',
        caption,
        'Caption or mapping confidence is below threshold.',
      );
    const bubble = bubbleById.get(caption.bubbleId);
    if (bubble && layoutOverflowsBubble(caption.layout, bubble.polygon))
      add(
        'overflow',
        caption,
        'Caption layout extends outside its bubble geometry.',
      );
  }
  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function layoutOverflowsBubble(
  layout: CaptionLayout,
  polygon: Polygon<ImageSpace>,
): boolean {
  if (layout.position.coordinateSpace.id !== polygon.coordinateSpace.id)
    return true;
  const corners = layout.linePlacements.flatMap((line) => [
    { x: line.position.x, y: line.baselineY - line.heightPx },
    { x: line.position.x + line.widthPx, y: line.baselineY - line.heightPx },
    { x: line.position.x, y: line.baselineY },
    { x: line.position.x + line.widthPx, y: line.baselineY },
  ]);
  return corners.some(({ x, y }) => !pointInPolygon(x, y, polygon.points));
}
function pointInPolygon(
  x: number,
  y: number,
  points: readonly Readonly<{ x: number; y: number }>[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
