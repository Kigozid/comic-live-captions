import type { CaptionLayout } from '@comic-captioner/core';
import type { ComicFixtureGroundTruth } from './suite.js';
import { compareRgbaImages, type ImageDifference } from './visual-diff.js';

/**
 * Font-portable caption visual comparison.
 *
 * Caption text is rasterized by the host font stack (librsvg + system fonts),
 * so glyph pixels are NOT byte-reproducible across machines even when the
 * renderer behaves correctly. Reference PNGs therefore cannot be compared
 * pixel-exactly outside one machine.
 *
 * Tolerance policy:
 * 1. STRUCTURE is exact and font-independent. The approved-structure manifest
 *    pins caption ids, bubble ids, line count, line text, layout bounds, font
 *    size, and family. Each caption block and line box must also lie inside
 *    its bubble's ground-truth text-region bounds. This catches wrong bubble,
 *    layout overflow, and text drift without looking at glyphs.
 * 2. CAPTION PRESENCE uses the ink delta against the cleaned page (pixels
 *    differing by more than INK_CHANNEL_THRESHOLD per channel). Every approved
 *    line box must keep at least MIN_LINE_INK_RATIO of the reference ink (and
 *    at least MIN_LINE_INK_PIXELS) so a missing caption fails even though
 *    caption pixels are a tiny fraction of the page.
 * 3. PLACEMENT is checked as ink outside every caption's safe region (ground
 *    truth text region inflated by SAFE_REGION_INSET for antialiasing bleed).
 *    Outside ink beyond MAX_OUTSIDE_INK_RATIO of the render's ink means
 *    overflow past the safe region, a caption in the wrong bubble, or damaged
 *    page compositing. The allowance also doubles whatever hairline bleed the
 *    reference itself shows.
 * 4. GLOBAL pixel similarity allows up to MAX_CHANGED_PIXEL_RATIO of pixels to
 *    differ (25%) to absorb glyph shape, hinting, and antialiasing variance
 *    between font stacks. Real renderer regressions (geometry, colors, page
 *    damage) move far more than glyph pixels and fail this gate.
 */
export const MAX_CHANGED_PIXEL_RATIO = 0.25;
export const INK_CHANNEL_THRESHOLD = 24;
export const MIN_LINE_INK_RATIO = 0.35;
export const MIN_LINE_INK_PIXELS = 8;
export const MAX_OUTSIDE_INK_RATIO = 0.08;
export const MIN_OUTSIDE_INK_PIXELS = 24;
export const SAFE_REGION_INSET = 2;
export const LINE_INK_MARGIN_RATIO = 0.35;
export const LINE_INK_MARGIN_MIN = 4;
export const STRUCTURE_EPSILON_PX = 0.01;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ApprovedCaptionStructure {
  readonly id: string;
  readonly bubbleId: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly blockBounds: Box;
  readonly lineBoxes: readonly Box[];
  readonly fontFamily: string;
  readonly fontSizePx: number;
}

export interface ApprovedCaptionCaseStructure {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly captions: readonly ApprovedCaptionStructure[];
}

export interface ApprovedStructureManifest {
  readonly schemaVersion: 1;
  readonly cases: readonly ApprovedCaptionCaseStructure[];
}

export interface CaptionInkLayout {
  readonly label: string;
  readonly fontSizePx: number;
  /** Tight glyph box per rendered line, in image pixels. */
  readonly lineBoxes: readonly Box[];
  /** Ground-truth safe region the caption must stay inside. */
  readonly safeRegion: Box;
}

export interface CaptionInkComparison {
  readonly referenceInk: number;
  readonly actualInk: number;
  readonly outsideInk: number;
  readonly issues: readonly string[];
}

export interface CaptionRenderComparison {
  readonly difference: ImageDifference;
  readonly ink: CaptionInkComparison;
  readonly issues: readonly string[];
}

/** Font-independent structural facts of the layouts that produced a reference. */
export function summarizeCaptionLayouts(
  layouts: readonly CaptionLayout[],
): ApprovedCaptionStructure[] {
  return layouts.map((layout) => ({
    id: layout.id,
    bubbleId: layout.bubbleId,
    text: layout.text,
    lines: [...layout.lines],
    blockBounds: {
      x: layout.position.x,
      y: layout.position.y,
      width: layout.widthPx,
      height: layout.heightPx,
    },
    lineBoxes: layout.linePlacements.map((line) => ({
      x: line.position.x,
      y: line.position.y,
      width: line.widthPx,
      height: line.heightPx,
    })),
    fontFamily: layout.fontFamily,
    fontSizePx: layout.fontSizePx,
  }));
}

/**
 * Compare a live layout structure against the approved manifest and verify
 * every caption sits inside its bubble's ground-truth text region.
 * Returns human-readable issues; an empty list means the structure matches.
 */
export function checkCaptionStructure(options: {
  readonly layouts: readonly CaptionLayout[];
  readonly truth: ComicFixtureGroundTruth;
  readonly approved: ApprovedCaptionCaseStructure;
}): string[] {
  const { layouts, truth, approved } = options;
  const issues: string[] = [];
  if (layouts.length !== approved.captions.length)
    issues.push(
      `caption count ${layouts.length} does not match approved ${approved.captions.length}`,
    );
  const summarized = summarizeCaptionLayouts(layouts);
  for (let index = 0; index < summarized.length; index += 1) {
    const caption = summarized[index]!;
    const expected = approved.captions[index];
    if (!expected) continue;
    const label = `caption ${caption.id}`;
    if (caption.id !== expected.id)
      issues.push(`${label} id changed (approved ${expected.id})`);
    if (caption.bubbleId !== expected.bubbleId)
      issues.push(
        `${label} bubble ${caption.bubbleId} does not match approved ${expected.bubbleId} (wrong bubble)`,
      );
    if (!sameStrings(caption.lines, expected.lines))
      issues.push(
        `${label} lines ${JSON.stringify(caption.lines)} do not match approved ${JSON.stringify(expected.lines)}`,
      );
    if (caption.text !== expected.text)
      issues.push(
        `${label} text ${JSON.stringify(caption.text)} does not match approved ${JSON.stringify(expected.text)}`,
      );
    if (caption.fontFamily !== expected.fontFamily)
      issues.push(
        `${label} font family ${caption.fontFamily} does not match approved ${expected.fontFamily}`,
      );
    if (Math.abs(caption.fontSizePx - expected.fontSizePx) > STRUCTURE_EPSILON_PX)
      issues.push(
        `${label} font size ${caption.fontSizePx} does not match approved ${expected.fontSizePx}`,
      );
    if (!boxNear(caption.blockBounds, expected.blockBounds))
      issues.push(
        `${label} block bounds ${formatBox(caption.blockBounds)} do not match approved ${formatBox(expected.blockBounds)}`,
      );
    if (caption.lineBoxes.length !== expected.lineBoxes.length)
      issues.push(
        `${label} line box count ${caption.lineBoxes.length} does not match approved ${expected.lineBoxes.length}`,
      );
    for (
      let line = 0;
      line < Math.min(caption.lineBoxes.length, expected.lineBoxes.length);
      line += 1
    ) {
      if (!boxNear(caption.lineBoxes[line]!, expected.lineBoxes[line]!))
        issues.push(
          `${label} line ${line} bounds ${formatBox(caption.lineBoxes[line]!)} do not match approved ${formatBox(expected.lineBoxes[line]!)}`,
        );
    }

    const bubble = truth.expected.bubbles.find(
      (candidate) => candidate.id === caption.bubbleId,
    );
    const region = truth.expected.textRegions.find(
      (candidate) => candidate.bubbleId === caption.bubbleId,
    );
    if (!bubble || !region) {
      issues.push(
        `${label} references unknown bubble ${caption.bubbleId} (wrong bubble)`,
      );
      continue;
    }
    if (!boxInside(caption.blockBounds, region.boundingBox))
      issues.push(
        `${label} block ${formatBox(caption.blockBounds)} overflows safe region ${formatBox(region.boundingBox)}`,
      );
    for (let line = 0; line < caption.lineBoxes.length; line += 1) {
      if (!boxInside(caption.lineBoxes[line]!, region.boundingBox))
        issues.push(
          `${label} line ${line} ${formatBox(caption.lineBoxes[line]!)} overflows safe region ${formatBox(region.boundingBox)}`,
        );
    }
  }
  return issues;
}

/**
 * Font-tolerant pixel comparison: global difference ratio plus caption ink
 * analysis against the cleaned page. See the tolerance policy above.
 */
export function compareCaptionRenders(options: {
  readonly reference: Uint8Array;
  readonly actual: Uint8Array;
  readonly cleaned: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly captions: readonly CaptionInkLayout[];
}): CaptionRenderComparison {
  const { width, height, captions } = options;
  const difference = compareRgbaImages(
    options.reference,
    options.actual,
    width,
    height,
  );
  const ink = compareCaptionInk({
    reference: options.reference,
    actual: options.actual,
    cleaned: options.cleaned,
    width,
    height,
    captions,
  });
  const issues = [...ink.issues];
  if (difference.changedPixelRatio > MAX_CHANGED_PIXEL_RATIO)
    issues.push(
      `changed pixel ratio ${(difference.changedPixelRatio * 100).toFixed(2)}% exceeds the ${(MAX_CHANGED_PIXEL_RATIO * 100).toFixed(0)}% glyph-rasterization tolerance`,
    );
  return { difference, ink, issues };
}

/** Ink-delta comparison; synthetic tests can drive it with plain boxes. */
export function compareCaptionInk(options: {
  readonly reference: Uint8Array;
  readonly actual: Uint8Array;
  readonly cleaned: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly captions: readonly CaptionInkLayout[];
}): CaptionInkComparison {
  const { width, height, captions } = options;
  const pixelCount = width * height;
  const referenceInk = computeInkMask(
    options.reference,
    options.cleaned,
    pixelCount,
  );
  const actualInk = computeInkMask(options.actual, options.cleaned, pixelCount);
  const issues: string[] = [];

  for (const caption of captions) {
    const margin = Math.max(
      LINE_INK_MARGIN_MIN,
      caption.fontSizePx * LINE_INK_MARGIN_RATIO,
    );
    for (let index = 0; index < caption.lineBoxes.length; index += 1) {
      const lineBounds = inflate(caption.lineBoxes[index]!, margin);
      const referenceCount = countMaskInBox(
        referenceInk.mask,
        width,
        height,
        lineBounds,
      );
      const actualCount = countMaskInBox(
        actualInk.mask,
        width,
        height,
        lineBounds,
      );
      if (referenceCount < MIN_LINE_INK_PIXELS) continue;
      const required = Math.max(
        MIN_LINE_INK_PIXELS,
        Math.floor(referenceCount * MIN_LINE_INK_RATIO),
      );
      if (actualCount < required)
        issues.push(
          `${caption.label} line ${index} lost caption ink: ${actualCount}/${referenceCount} reference pixels inside ${formatBox(lineBounds)} (missing caption?)`,
        );
    }
  }

  const safeRegions = captions.map((caption) =>
    inflate(caption.safeRegion, SAFE_REGION_INSET),
  );
  let outsideInk = 0;
  let referenceOutsideInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const inside = safeRegions.some((region) => boxContains(region, x, y));
      if (!inside) {
        if (actualInk.mask[index]) outsideInk += 1;
        if (referenceInk.mask[index]) referenceOutsideInk += 1;
      }
    }
  }
  const allowedOutside = Math.max(
    MIN_OUTSIDE_INK_PIXELS,
    Math.ceil(MAX_OUTSIDE_INK_RATIO * actualInk.count),
    referenceOutsideInk * 2,
  );
  if (outsideInk > allowedOutside)
    issues.push(
      `caption ink outside the safe regions: ${outsideInk} pixels (allowed ${allowedOutside}) — overflow past the bubble or damaged page compositing`,
    );

  return {
    referenceInk: referenceInk.count,
    actualInk: actualInk.count,
    outsideInk,
    issues,
  };
}

export function computeInkMask(
  foreground: Uint8Array,
  background: Uint8Array,
  pixelCount: number,
): { mask: Uint8Array; count: number } {
  if (foreground.length !== pixelCount * 4 || background.length !== pixelCount * 4)
    throw new RangeError('Ink comparison requires matching RGBA buffers.');
  const mask = new Uint8Array(pixelCount);
  let count = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      if (
        Math.abs(
          foreground[pixel * 4 + channel]! - background[pixel * 4 + channel]!,
        ) > INK_CHANNEL_THRESHOLD
      ) {
        mask[pixel] = 1;
        count += 1;
        break;
      }
    }
  }
  return { mask, count };
}

export function countMaskInBox(
  mask: Uint8Array,
  width: number,
  height: number,
  box: Box,
): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.width) - 1);
  const y1 = Math.min(height - 1, Math.ceil(box.y + box.height) - 1);
  let count = 0;
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) if (mask[y * width + x]) count += 1;
  return count;
}

export function inflate(box: Box, margin: number): Box {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };
}

function boxContains(box: Box, x: number, y: number): boolean {
  return (
    x >= box.x &&
    x < box.x + box.width &&
    y >= box.y &&
    y < box.y + box.height
  );
}

function boxInside(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x - STRUCTURE_EPSILON_PX &&
    inner.y >= outer.y - STRUCTURE_EPSILON_PX &&
    inner.x + inner.width <= outer.x + outer.width + STRUCTURE_EPSILON_PX &&
    inner.y + inner.height <= outer.y + outer.height + STRUCTURE_EPSILON_PX
  );
}

function boxNear(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) <= STRUCTURE_EPSILON_PX &&
    Math.abs(a.y - b.y) <= STRUCTURE_EPSILON_PX &&
    Math.abs(a.width - b.width) <= STRUCTURE_EPSILON_PX &&
    Math.abs(a.height - b.height) <= STRUCTURE_EPSILON_PX
  );
}

function formatBox(box: Box): string {
  return `(${box.x}, ${box.y}, ${box.width} x ${box.height})`;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
