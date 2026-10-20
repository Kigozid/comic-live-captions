/**
 * Draft-first mapping: assign transcript segments to user-drawn caption
 * containers in reading order. No OCR↔bubble matching — the boxes *are* the
 * layout targets. Word timings travel with each assignment for typewriter reveal.
 */

import type { CaptionLayout, ImageSpace } from '@comic-captioner/core';
import {
  fitCaptionIntoBox,
  orderCaptionBoxes,
  type CaptionBox,
} from './caption-box-fit.js';

export interface DraftTranscriptSegment {
  readonly id: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly words?: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
  }[];
}

export interface DraftAssignment {
  readonly bubbleId: string;
  readonly segmentId: string;
  readonly caption: string;
  readonly start: number;
  readonly end: number;
  readonly words?: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly layout: CaptionLayout;
}

export interface DraftFromBoxesResult {
  readonly assignments: readonly DraftAssignment[];
  readonly layouts: readonly CaptionLayout[];
  /** Boxes with no segment (extra containers stay empty until reassigned). */
  readonly unusedBoxIds: readonly string[];
  /** Segments with no box (user can draw more containers). */
  readonly unassignedSegmentIds: readonly string[];
}

/**
 * Pair segments with drawn boxes in order. Segments fill boxes top-to-bottom
 * (or RTL); extras are reported so the UI can prompt for more boxes or skips.
 */
export function draftFromBoxes(
  boxes: readonly CaptionBox[],
  segments: readonly DraftTranscriptSegment[],
  imageSpace: ImageSpace,
  options: {
    readonly direction?: 'ltr' | 'rtl';
    readonly fontFamily?: string;
  } = {},
): DraftFromBoxesResult {
  const ordered = orderCaptionBoxes(boxes, options.direction ?? 'ltr');
  const spoken = segments
    .filter((segment) => segment.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.start - b.start);

  const assignments: DraftAssignment[] = [];
  const usedBoxIds = new Set<string>();
  const assignedSegmentIds = new Set<string>();

  const count = Math.min(ordered.length, spoken.length);
  for (let index = 0; index < count; index += 1) {
    const box = ordered[index]!;
    const segment = spoken[index]!;
    const layout = fitCaptionIntoBox(box, segment.text, imageSpace, {
      ...(options.fontFamily ? { fontFamily: options.fontFamily } : {}),
    });
    assignments.push({
      bubbleId: box.id,
      segmentId: segment.id,
      caption: segment.text,
      start: segment.start,
      end: segment.end,
      ...(segment.words && segment.words.length > 0
        ? {
            words: segment.words.map((word) => ({
              text: word.text,
              start: word.start,
              end: word.end,
            })),
          }
        : {}),
      layout,
    });
    usedBoxIds.add(box.id);
    assignedSegmentIds.add(segment.id);
  }

  return {
    assignments,
    layouts: assignments.map((assignment) => assignment.layout),
    unusedBoxIds: ordered
      .filter((box) => !usedBoxIds.has(box.id))
      .map((box) => box.id),
    unassignedSegmentIds: spoken
      .filter((segment) => !assignedSegmentIds.has(segment.id))
      .map((segment) => segment.id),
  };
}
