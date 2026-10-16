import type { ExportBubble, ExportCaption } from './export-types.js';
import {
  assignBubblesToPanels,
  buildPanelPageSequence,
  proposePanelSequenceTimings,
  type PanelSequenceStep,
} from '@comic-captioner/video-composer';

export interface PanelBounds {
  readonly id: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly label?: string;
}

export interface PanelSequenceBuildInput {
  readonly panels: readonly PanelBounds[];
  readonly captions: readonly ExportCaption[];
  readonly bubbles: readonly ExportBubble[];
  readonly durationSeconds: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly focusMarginPx?: number;
}

export interface PanelSequenceBuildResult {
  readonly steps: PanelSequenceStep[];
  readonly pages: ReturnType<typeof buildPanelPageSequence>['pages'];
  readonly cues: ReturnType<typeof buildPanelPageSequence>['cues'];
  readonly bubbleIdsByPanel: Readonly<Record<string, readonly string[]>>;
  readonly warnings: readonly string[];
}

function polygonBounds(points: readonly { x: number; y: number }[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function nearestPanelId(
  cx: number,
  cy: number,
  panels: readonly PanelBounds[],
): string | null {
  if (panels.length === 0) return null;
  let owner = panels[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const panel of panels) {
    const b = panel.bounds;
    const inside =
      cx >= b.x && cy >= b.y && cx <= b.x + b.width && cy <= b.y + b.height;
    const dx = cx - (b.x + b.width / 2);
    const dy = cy - (b.y + b.height / 2);
    const score = inside ? 0 : 1_000_000 + dx * dx + dy * dy;
    if (score < best) {
      best = score;
      owner = panel;
    }
  }
  return owner.id;
}

/**
 * Build a timed panel sequence for Remotion export from detected panels and
 * caption cues. Each shot's window covers the dialogues mapped to that panel;
 * unmapped gaps fill proportionally so the sequence spans the narration.
 */
export function buildEditorPanelSequence(
  input: PanelSequenceBuildInput,
): PanelSequenceBuildResult {
  const warnings: string[] = [];
  if (input.panels.length === 0) {
    return {
      steps: [],
      pages: [],
      cues: [],
      bubbleIdsByPanel: {},
      warnings: [
        'No panels detected on the page. Run “Detect bubbles” first, or export the full page.',
      ],
    };
  }
  if (!(input.durationSeconds > 0)) {
    return {
      steps: [],
      pages: [],
      cues: [],
      bubbleIdsByPanel: {},
      warnings: [
        'Narration duration is unknown; cannot pace the panel sequence.',
      ],
    };
  }

  const bubbleBoundsById = new Map(
    input.bubbles.map((bubble) => [
      String(bubble.id),
      polygonBounds(bubble.polygon.points),
    ]),
  );

  const bubbleIdsByPanel = assignBubblesToPanels(
    input.bubbles.map((bubble) => ({
      id: String(bubble.id),
      bounds: bubbleBoundsById.get(String(bubble.id))!,
    })),
    input.panels.map((panel) => ({
      id: panel.id,
      bounds: panel.bounds,
      ...(panel.label ? { label: panel.label } : {}),
    })),
  );

  const cuesByPanel: Record<
    string,
    { startSeconds: number; endSeconds: number }[]
  > = {};
  for (const panel of input.panels) cuesByPanel[panel.id] = [];

  for (const caption of input.captions) {
    if (caption.start == null || caption.end == null) continue;
    const bubbleBounds = caption.bubbleId
      ? bubbleBoundsById.get(String(caption.bubbleId))
      : undefined;
    const cx = bubbleBounds
      ? bubbleBounds.x + bubbleBounds.width / 2
      : input.pageWidth / 2;
    const cy = bubbleBounds
      ? bubbleBounds.y + bubbleBounds.height / 2
      : input.pageHeight / 2;
    const owner = nearestPanelId(cx, cy, input.panels);
    if (!owner) continue;
    cuesByPanel[owner]!.push({
      startSeconds: caption.start,
      endSeconds: caption.end,
    });
  }

  const steps = proposePanelSequenceTimings({
    panels: input.panels.map((panel) => ({
      id: panel.id,
      bounds: panel.bounds,
      ...(panel.label ? { label: panel.label } : {}),
    })),
    cuesByPanel,
    durationSeconds: input.durationSeconds,
  });

  // Keep shots strictly sequential.
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    if (current.startSeconds < previous.endSeconds) {
      steps[index] = { ...current, startSeconds: previous.endSeconds };
    }
  }

  const sequence = buildPanelPageSequence({
    imageUrl: '',
    pageWidth: input.pageWidth,
    pageHeight: input.pageHeight,
    durationSeconds: input.durationSeconds,
    steps,
    bubbles: input.bubbles.map((bubble) => ({
      id: String(bubble.id),
      polygon: bubble.polygon.points.map((point) => ({
        x: point.x,
        y: point.y,
      })),
    })),
    cues: input.captions
      .filter(
        (caption): caption is ExportCaption & { start: number; end: number } =>
          caption.start != null && caption.end != null,
      )
      .map((caption) => ({
        id: caption.id,
        bubbleId: caption.bubbleId || null,
        text: caption.caption,
        startSeconds: caption.start,
        endSeconds: caption.end,
        words: (
          (
            caption as {
              words?: readonly { text: string; start: number; end: number }[];
            }
          ).words ?? []
        ).map((word) => ({
          text: word.text,
          startSeconds: word.start,
          endSeconds: word.end,
        })),
        needsReview:
          (caption as { needsReview?: boolean }).needsReview ??
          caption.mapped === false,
      })),
    ...(input.focusMarginPx != null
      ? { focusMarginPx: input.focusMarginPx }
      : {}),
  });

  const pages = sequence.pages.map((page) => ({ ...page, imageUrl: '' }));

  if (pages.length > 1) {
    warnings.push(
      `Panel sequence: ${pages.length} shots across ${input.durationSeconds.toFixed(1)}s.`,
    );
  }
  return {
    steps,
    pages,
    cues: sequence.cues,
    bubbleIdsByPanel,
    warnings,
  };
}
