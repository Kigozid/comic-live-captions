import type {
  BubbleGeometryInput,
  CaptionCue,
  ImageRect,
  PageInput,
  PanelSequenceStep,
} from './types.js';

export interface PanelAssignmentBubble {
  readonly id: string;
  /** Bubble bounds in page-image pixels (used for panel membership). */
  readonly bounds: ImageRect;
}

export interface PanelRef {
  readonly id: string;
  readonly bounds: ImageRect;
  readonly label?: string;
}

/**
 * Assign each bubble to the panel that contains its centroid. Bubbles outside
 * every panel join the nearest panel by center distance.
 */
export function assignBubblesToPanels(
  bubbles: readonly PanelAssignmentBubble[],
  panels: readonly PanelRef[],
): Readonly<Record<string, readonly string[]>> {
  const byPanel = new Map<string, string[]>();
  for (const panel of panels) byPanel.set(panel.id, []);
  if (panels.length === 0) return Object.freeze({});

  for (const bubble of bubbles) {
    const cx = bubble.bounds.x + bubble.bounds.width / 2;
    const cy = bubble.bounds.y + bubble.bounds.height / 2;
    let bestPanel = panels[0]!;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const panel of panels) {
      const { bounds } = panel;
      const inside =
        cx >= bounds.x &&
        cy >= bounds.y &&
        cx <= bounds.x + bounds.width &&
        cy <= bounds.y + bounds.height;
      const pcx = bounds.x + bounds.width / 2;
      const pcy = bounds.y + bounds.height / 2;
      const distance = (cx - pcx) ** 2 + (cy - pcy) ** 2;
      const score = inside ? 0 : 1_000_000 + distance;
      if (score < bestScore) {
        bestScore = score;
        bestPanel = panel;
      }
    }
    byPanel.get(bestPanel.id)!.push(bubble.id);
  }

  const frozen: Record<string, readonly string[]> = {};
  for (const [panelId, ids] of byPanel) {
    frozen[panelId] = Object.freeze([...ids]);
  }
  return Object.freeze(frozen);
}

export interface BuildPanelSequenceInput {
  readonly imageUrl: string;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly durationSeconds: number;
  readonly steps: readonly PanelSequenceStep[];
  readonly bubbles: readonly BubbleGeometryInput[];
  readonly cues?: readonly CaptionCue[];
  /** Extra inset around each panel focus (image px). */
  readonly focusMarginPx?: number;
}

/**
 * Expand timed panel shots into Remotion `PageInput[]`. Every step can share
 * one cleaned page image; `cameraFocus` frames the panel. Bubbles and cues are
 * filtered per step so captions only appear on the shot that owns them.
 */
export function buildPanelPageSequence(input: BuildPanelSequenceInput): {
  pages: PageInput[];
  cues: CaptionCue[];
} {
  const margin = Math.max(0, input.focusMarginPx ?? 8);
  const bubbleById = new Map(
    input.bubbles.map((bubble) => [bubble.id, bubble]),
  );
  const assignment = assignBubblesToPanels(
    input.bubbles.map((bubble) => ({
      id: bubble.id,
      bounds: polygonBoundsOf(bubble.polygon),
    })),
    input.steps.map((step) => ({
      id: step.id,
      bounds: step.bounds,
      ...(step.label ? { label: step.label } : {}),
    })),
  );

  const pages: PageInput[] = input.steps.map((step, index) => {
    const owned =
      step.bubbleIds && step.bubbleIds.length > 0
        ? step.bubbleIds
        : (assignment[step.id] ?? []);
    const bubbles = owned
      .map((id) => bubbleById.get(id))
      .filter((bubble): bubble is BubbleGeometryInput => Boolean(bubble));
    return {
      id: step.id || `panel-${index + 1}`,
      imageUrl: input.imageUrl,
      width: input.pageWidth,
      height: input.pageHeight,
      startSeconds: step.startSeconds,
      endSeconds: step.endSeconds,
      ...(step.label ? { label: step.label } : {}),
      cameraFocus: insetFocus(
        step.bounds,
        margin,
        input.pageWidth,
        input.pageHeight,
      ),
      bubbles,
    };
  });

  const cues: CaptionCue[] = [];
  for (const cue of input.cues ?? []) {
    const owner = input.steps.find(
      (step) =>
        step.startSeconds <= cue.startSeconds &&
        cue.startSeconds < step.endSeconds,
    );
    if (!owner) {
      cues.push(cue);
      continue;
    }
    const ownedIds = new Set(
      owner.bubbleIds && owner.bubbleIds.length > 0
        ? owner.bubbleIds
        : (assignment[owner.id] ?? []),
    );
    if (cue.bubbleId && ownedIds.has(cue.bubbleId)) {
      cues.push(cue);
    } else {
      cues.push({ ...cue, needsReview: true });
    }
  }

  return { pages, cues };
}

/**
 * Cover an audio span with sequential panel shots using dialogue switch
 * points: each shot runs until the next shot's first mapped dialogue (or an
 * even-split boundary). The sequence always tiles [0, durationSeconds].
 */
export function proposePanelSequenceTimings(options: {
  readonly panels: readonly PanelRef[];
  readonly cuesByPanel: Readonly<
    Record<
      string,
      readonly { readonly startSeconds: number; readonly endSeconds: number }[]
    >
  >;
  readonly durationSeconds: number;
}): PanelSequenceStep[] {
  const { panels, cuesByPanel, durationSeconds } = options;
  if (panels.length === 0) return [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError('durationSeconds must be finite and positive.');
  }

  const firstDialogueAt = panels.map((panel) => {
    const cues = cuesByPanel[panel.id] ?? [];
    if (cues.length === 0) return Number.NaN;
    return Math.min(...cues.map((cue) => cue.startSeconds));
  });

  const hasAnyDialogue = firstDialogueAt.some((value) =>
    Number.isFinite(value),
  );
  if (!hasAnyDialogue) {
    const slice = durationSeconds / panels.length;
    return panels.map((panel, index) => ({
      id: panel.id,
      bounds: panel.bounds,
      ...(panel.label ? { label: panel.label } : {}),
      startSeconds: index * slice,
      endSeconds:
        index === panels.length - 1 ? durationSeconds : (index + 1) * slice,
    }));
  }

  // Switch times: shot 0 starts at 0; later shots switch at their first
  // dialogue, or split the gap when a run has none.
  const starts = new Array<number>(panels.length).fill(0);
  const ends = new Array<number>(panels.length).fill(durationSeconds);
  let index = 1;
  while (index < panels.length) {
    if (Number.isFinite(firstDialogueAt[index]!)) {
      const start = Math.min(
        Math.max(firstDialogueAt[index]!, starts[index - 1]!),
        durationSeconds,
      );
      ends[index - 1] = start;
      starts[index] = start;
      index += 1;
      continue;
    }
    // Unmapped run: find the next dialogue shot (or the end).
    let runEnd = index;
    while (
      runEnd < panels.length &&
      !Number.isFinite(firstDialogueAt[runEnd]!)
    ) {
      runEnd += 1;
    }
    const gapStart = ends[index - 1]!;
    const gapEnd =
      runEnd < panels.length
        ? Math.min(
            Math.max(firstDialogueAt[runEnd]!, gapStart),
            durationSeconds,
          )
        : durationSeconds;
    // Shots index-1 .. runEnd-1 (the leading mapped shot already ends at
    // gapStart) — the unmapped ones are index .. runEnd-1, plus we need to
    // cover (gapStart, gapEnd). Include the previous shot's tail by splitting
    // across the unmapped count only.
    const unmappedCount = Math.max(1, runEnd - index);
    const slice = (gapEnd - gapStart) / unmappedCount;
    for (let offset = 0; offset < unmappedCount; offset += 1) {
      const shot = index + offset;
      starts[shot] = gapStart + offset * slice;
      ends[shot] =
        offset === unmappedCount - 1 ? gapEnd : gapStart + (offset + 1) * slice;
    }
    if (runEnd < panels.length) {
      ends[runEnd - 1] = gapEnd;
      starts[runEnd] = gapEnd;
    }
    index = runEnd < panels.length ? runEnd + 1 : panels.length;
  }

  let cursor = 0;
  const steps: PanelSequenceStep[] = panels.map((panel, shot) => {
    const start = Math.min(Math.max(starts[shot]!, cursor), durationSeconds);
    const end =
      shot === panels.length - 1
        ? durationSeconds
        : Math.min(Math.max(ends[shot]!, start + 1e-3), durationSeconds);
    cursor = end;
    return {
      id: panel.id,
      bounds: panel.bounds,
      ...(panel.label ? { label: panel.label } : {}),
      startSeconds: start,
      endSeconds: end,
    };
  });
  if (steps.length > 0) {
    const last = steps[steps.length - 1]!;
    steps[steps.length - 1] = { ...last, endSeconds: durationSeconds };
  }
  return steps;
}

function polygonBoundsOf(
  points: readonly { x: number; y: number }[],
): ImageRect {
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

function insetFocus(
  bounds: ImageRect,
  margin: number,
  pageWidth: number,
  pageHeight: number,
): ImageRect {
  const x = Math.max(0, bounds.x - margin);
  const y = Math.max(0, bounds.y - margin);
  const width = Math.min(pageWidth - x, bounds.width + margin * 2);
  const height = Math.min(pageHeight - y, bounds.height + margin * 2);
  return {
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}
