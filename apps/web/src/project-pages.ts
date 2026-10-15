/**
 * Multi-page project workspace helpers.
 *
 * The editor keeps one *active* page in the existing single-page state (pair,
 * blobs, editor document). Inactive pages live in a registry so a project can
 * hold 10–15 comic pages without rewriting the single-page workspace.
 */

import type { EditorDocument } from './editor-model.js';
import type { SourceImageMetadata } from '@comic-captioner/shared';

export interface PagePanelBounds {
  readonly id: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly label?: string;
}

export interface PageWorkspace {
  readonly id: string;
  readonly label: string;
  readonly original: SourceImageMetadata | null;
  readonly cleaned: SourceImageMetadata | null;
  readonly originalBlob: Blob | null;
  readonly cleanedBlob: Blob | null;
  readonly editor: EditorDocument | null;
  readonly panels: readonly PagePanelBounds[];
  /** Optional manual pacing override in audio seconds. */
  readonly pacingOverride?: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  };
}

export function createPageWorkspace(
  label: string,
  id: string = crypto.randomUUID(),
): PageWorkspace {
  return {
    id,
    label,
    original: null,
    cleaned: null,
    originalBlob: null,
    cleanedBlob: null,
    editor: null,
    panels: [],
  };
}

export function replacePage(
  pages: readonly PageWorkspace[],
  page: PageWorkspace,
): PageWorkspace[] {
  const index = pages.findIndex((candidate) => candidate.id === page.id);
  if (index < 0) return [...pages, page];
  const next = [...pages];
  next[index] = page;
  return next;
}

export function movePage(
  pages: readonly PageWorkspace[],
  pageId: string,
  delta: number,
): PageWorkspace[] {
  const index = pages.findIndex((page) => page.id === pageId);
  if (index < 0) return [...pages];
  const target = Math.min(Math.max(0, index + delta), pages.length - 1);
  if (target === index) return [...pages];
  const next = [...pages];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

export function pageExportImage(
  page: PageWorkspace,
): { blob: Blob; width: number; height: number } | null {
  const blob = page.cleanedBlob ?? page.originalBlob;
  const metadata = page.cleaned ?? page.original;
  if (!blob || !metadata) return null;
  return {
    blob,
    width: metadata.dimensions.width,
    height: metadata.dimensions.height,
  };
}

/** Dialogues as export cues, tagged with the page that owns the bubble. */
export function dialoguesToExportCues(
  dialogues: readonly {
    id: string;
    bubbleId: string;
    caption: string;
    start: number;
    end: number;
    fontFamily?: string;
    fontSizePx?: number;
  }[],
  pageId: string,
): {
  id: string;
  bubbleId: string;
  caption: string;
  start: number;
  end: number;
  pageId: string;
  mapped: boolean;
}[] {
  return dialogues.map((dialogue) => ({
    id: dialogue.id,
    bubbleId: dialogue.bubbleId,
    caption: dialogue.caption,
    start: dialogue.start,
    end: dialogue.end,
    pageId,
    mapped: Boolean(dialogue.bubbleId),
  }));
}

export interface MultiPageExportPlan {
  readonly sourcePages: {
    readonly id: string;
    readonly blob: Blob;
    readonly width: number;
    readonly height: number;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly label: string;
    readonly bubbles: readonly {
      readonly id: string;
      readonly polygon: {
        readonly points: readonly { x: number; y: number }[];
      };
    }[];
  }[];
  readonly captions: {
    readonly id: string;
    readonly bubbleId: string;
    readonly caption: string;
    readonly start: number;
    readonly end: number;
    readonly mapped: boolean;
    readonly needsReview?: boolean;
    readonly pageId: string;
  }[];
  readonly pacing: PagePacingSlice[];
  readonly warnings: readonly string[];
}

/**
 * Build a multi-page export plan: pace pages across the narration, then emit
 * one source image + bubbles per page and global cues tagged by page.
 */
export function buildMultiPageExportPlan(options: {
  readonly pages: readonly PageWorkspace[];
  readonly durationSeconds: number;
  readonly dialoguesByPageId: Readonly<
    Record<
      string,
      readonly {
        id: string;
        bubbleId: string;
        caption: string;
        start: number;
        end: number;
      }[]
    >
  >;
}): MultiPageExportPlan {
  const warnings: string[] = [];
  const exportable = options.pages
    .map((page) => {
      const image = pageExportImage(page);
      return image ? { page, image } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        page: PageWorkspace;
        image: NonNullable<ReturnType<typeof pageExportImage>>;
      } => Boolean(entry),
    );

  if (exportable.length === 0) {
    return {
      sourcePages: [],
      captions: [],
      pacing: [],
      warnings: ['No pages have image data yet. Import comic pages first.'],
    };
  }
  if (!(options.durationSeconds > 0)) {
    return {
      sourcePages: [],
      captions: [],
      pacing: [],
      warnings: [
        'Narration duration is unknown; load audio before multi-page export.',
      ],
    };
  }

  const pacing = proposePagePacingSlices({
    pages: exportable.map(({ page }) => ({
      id: page.id,
      ...(page.pacingOverride ? { pacingOverride: page.pacingOverride } : {}),
      dialogues: (options.dialoguesByPageId[page.id] ?? []).map((dialogue) => ({
        startSeconds: dialogue.start,
        endSeconds: dialogue.end,
      })),
    })),
    durationSeconds: options.durationSeconds,
  });

  const pacingByPage = new Map(pacing.map((slice) => [slice.pageId, slice]));
  const sourcePages = exportable.map(({ page, image }, index) => {
    const slice = pacingByPage.get(page.id);
    const fallbackSlice = {
      startSeconds: (index / exportable.length) * options.durationSeconds,
      endSeconds:
        index === exportable.length - 1
          ? options.durationSeconds
          : ((index + 1) / exportable.length) * options.durationSeconds,
    };
    return {
      id: page.id,
      blob: image.blob,
      width: image.width,
      height: image.height,
      startSeconds: slice?.startSeconds ?? fallbackSlice.startSeconds,
      endSeconds: slice?.endSeconds ?? fallbackSlice.endSeconds,
      label: page.label,
      bubbles: (page.editor ? Object.values(page.editor.bubbles) : []).map(
        (bubble) => ({
          id: bubble.id,
          polygon: bubble.polygon,
        }),
      ),
    };
  });

  const captions = exportable.flatMap(({ page }) =>
    dialoguesToExportCues(options.dialoguesByPageId[page.id] ?? [], page.id),
  );

  if (exportable.length >= 2) {
    warnings.push(
      `Multi-page export: ${exportable.length} pages across ${options.durationSeconds.toFixed(1)}s.`,
    );
  }
  if (exportable.length > 1 && exportable.length < 10) {
    warnings.push(
      `Tip: import more pages (target 10–15) for a full issue-length export.`,
    );
  }

  return { sourcePages, captions, pacing, warnings };
}

export interface PagePacingInput {
  readonly pages: readonly {
    readonly id: string;
    readonly pacingOverride?: {
      readonly startSeconds: number;
      readonly endSeconds: number;
    };
    /** Dialogue intervals already assigned to this page, in audio seconds. */
    readonly dialogues: readonly { startSeconds: number; endSeconds: number }[];
  }[];
  readonly durationSeconds: number;
}

export interface PagePacingSlice {
  readonly pageId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly source: 'dialogue' | 'even-split' | 'override';
}

/**
 * Tile the narration across pages in reading order. Pages with dialogues
 * expand to cover them; overrides win; unmapped gaps fill proportionally.
 * Always covers [0, durationSeconds] without overlaps.
 */
export function proposePagePacingSlices(
  input: PagePacingInput,
): PagePacingSlice[] {
  const { pages, durationSeconds } = input;
  if (pages.length === 0) return [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError('durationSeconds must be finite and positive.');
  }

  const firstDialogue = pages.map((page) => {
    if (page.pacingOverride) return page.pacingOverride.startSeconds;
    if (page.dialogues.length === 0) return Number.NaN;
    return Math.min(...page.dialogues.map((dialogue) => dialogue.startSeconds));
  });
  const lastDialogue = pages.map((page) => {
    if (page.pacingOverride) return page.pacingOverride.endSeconds;
    if (page.dialogues.length === 0) return Number.NaN;
    return Math.max(...page.dialogues.map((dialogue) => dialogue.endSeconds));
  });

  const hasAny = firstDialogue.some((value) => Number.isFinite(value));
  if (!hasAny) {
    const slice = durationSeconds / pages.length;
    return pages.map((page, index) => ({
      pageId: page.id,
      startSeconds: index * slice,
      endSeconds:
        index === pages.length - 1 ? durationSeconds : (index + 1) * slice,
      source: 'even-split' as const,
    }));
  }

  const starts = pages.map((_, index) => (index === 0 ? 0 : Number.NaN));
  const ends = pages.map((_, index) =>
    index === pages.length - 1 ? durationSeconds : Number.NaN,
  );

  // Anchor each page to its dialogue (or override) span, then fill gaps.
  for (const [index, page] of pages.entries()) {
    if (page.pacingOverride) {
      starts[index] = page.pacingOverride.startSeconds;
      ends[index] = page.pacingOverride.endSeconds;
      continue;
    }
    if (Number.isFinite(firstDialogue[index]!)) {
      starts[index] = firstDialogue[index]!;
      ends[index] = Math.max(lastDialogue[index]!, firstDialogue[index]!);
    }
  }

  // Fill unknown starts/ends so the sequence is monotonic and contiguous.
  let cursor = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const override = pages[index]!.pacingOverride;
    if (override) {
      starts[index] = override.startSeconds;
      ends[index] = override.endSeconds;
      cursor = override.endSeconds;
      continue;
    }
    const dialogueStart = Number.isFinite(starts[index]!)
      ? starts[index]!
      : Number.NaN;
    const dialogueEnd = Number.isFinite(ends[index]!)
      ? ends[index]!
      : Number.NaN;

    // Walk forward to the next page with a known anchor (or the end).
    let runEnd = index;
    while (
      runEnd + 1 < pages.length &&
      !pages[runEnd + 1]!.pacingOverride &&
      !Number.isFinite(firstDialogue[runEnd + 1]!)
    ) {
      runEnd += 1;
    }
    const nextAnchored =
      runEnd + 1 < pages.length
        ? {
            start: pages[runEnd + 1]!.pacingOverride
              ? pages[runEnd + 1]!.pacingOverride!.startSeconds
              : firstDialogue[runEnd + 1]!,
          }
        : { start: durationSeconds };

    const gapStart = cursor;
    const gapEnd = Math.min(
      Math.max(nextAnchored.start, gapStart),
      durationSeconds,
    );
    const runCount = runEnd - index + 1;
    const slice = Math.max(0, gapEnd - gapStart) / Math.max(1, runCount);

    for (let offset = 0; offset < runCount; offset += 1) {
      const shot = index + offset;
      const ownStart =
        offset === 0 && Number.isFinite(dialogueStart)
          ? Math.min(Math.max(dialogueStart, gapStart), gapEnd)
          : gapStart + offset * slice;
      const ownEnd =
        offset === runCount - 1
          ? gapEnd
          : Math.max(ownStart + 1e-3, gapStart + (offset + 1) * slice);
      starts[shot] = ownStart;
      ends[shot] = Math.max(ownStart + 1e-3, Math.min(ownEnd, durationSeconds));
      if (Number.isFinite(dialogueEnd) && offset === 0 && runCount === 1) {
        ends[shot] = Math.min(
          Math.max(dialogueEnd, ownStart + 1e-3),
          Math.max(gapEnd, dialogueEnd),
        );
      }
    }
    cursor = ends[runEnd]!;
    index = runEnd;
  }

  // Force contiguous coverage in reading order.
  let head = 0;
  const slices: PagePacingSlice[] = pages.map((page, index) => {
    const start = Math.min(Math.max(starts[index]!, head), durationSeconds);
    const end =
      index === pages.length - 1
        ? durationSeconds
        : Math.min(Math.max(ends[index]!, start + 1e-3), durationSeconds);
    head = end;
    return {
      pageId: page.id,
      startSeconds: start,
      endSeconds: end,
      source: page.pacingOverride
        ? 'override'
        : Number.isFinite(firstDialogue[index]!)
          ? 'dialogue'
          : 'even-split',
    };
  });
  if (slices.length > 0) {
    const last = slices[slices.length - 1]!;
    slices[slices.length - 1] = { ...last, endSeconds: durationSeconds };
  }
  return slices;
}
