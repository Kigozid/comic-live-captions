/**
 * Deterministic caption fitting into user-drawn caption containers.
 *
 * The draft-first workflow cleans the page, lets the user draw empty caption
 * boxes, then inserts live typewriter text. Drawn boxes are intentional layout
 * targets — no OCR↔bubble mapping — so fitting is a simple wrap + scale into
 * the container's inner rect. Same geometry rules as the engine fitter:
 * layout is computed from the full sentence; reveal paints a prefix at time t.
 */

import type { CaptionLayout, CaptionLinePlacement, ImageSpace, Point, Polygon } from '@comic-captioner/core';

export interface CaptionBox {
  readonly id: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface FitCaptionBoxOptions {
  readonly fontFamily?: string;
  readonly alignment?: CaptionLayout['alignment'];
  readonly paddingPx?: number;
  readonly minimumFontSizePx?: number;
  readonly maximumFontSizePx?: number;
  readonly lineSpacingRatio?: number;
}

const DEFAULT_FONT = 'DejaVu Sans';
const MIN_FONT = 10;
const MAX_FONT = 64;
/** Average glyph width as a fraction of font size (Helvetica-ish). */
const CHAR_WIDTH_RATIO = 0.52;

function boundsOf(points: readonly { x: number; y: number }[]): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { left, top, right, bottom };
}

function wrapLines(
  text: string,
  fontSizePx: number,
  maxWidthPx: number,
): string[] {
  const words = text.split(/\s+/).filter((part) => part.length > 0);
  if (words.length === 0) return [];
  const charWidth = Math.max(1, fontSizePx * CHAR_WIDTH_RATIO);
  const maxChars = Math.max(1, Math.floor(maxWidthPx / charWidth));
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Fit `caption` into a drawn container. Returns a `CaptionLayout` ready for
 * `timedCaptionLayoutsFromExport` / typewriter reveal.
 */
export function fitCaptionIntoBox(
  captionBox: CaptionBox,
  caption: string,
  imageSpace: ImageSpace,
  options: FitCaptionBoxOptions = {},
): CaptionLayout {
  const text = caption.trim();
  const fontFamily = options.fontFamily ?? DEFAULT_FONT;
  const alignment = options.alignment ?? 'center';
  const padding = options.paddingPx ?? 8;
  const minFont = options.minimumFontSizePx ?? MIN_FONT;
  const maxFont = options.maximumFontSizePx ?? MAX_FONT;
  const spacingRatio = options.lineSpacingRatio ?? 0.18;

  const box = boundsOf(captionBox.points);
  const innerWidth = Math.max(8, box.right - box.left - padding * 2);
  const innerHeight = Math.max(8, box.bottom - box.top - padding * 2);

  // Largest font size whose wrapped block fits the inner rect.
  let bestSize = minFont;
  let bestLines: string[] = wrapLines(text, minFont, innerWidth);
  for (let size = maxFont; size >= minFont; size -= 1) {
    const lines = wrapLines(text, size, innerWidth);
    const lineHeight = size * (1 + spacingRatio);
    const blockHeight = lines.length * lineHeight;
    const widest = lines.reduce(
      (max, line) => Math.max(max, line.length * size * CHAR_WIDTH_RATIO),
      0,
    );
    if (blockHeight <= innerHeight && widest <= innerWidth) {
      bestSize = size;
      bestLines = lines;
      break;
    }
    if (size === minFont) {
      bestSize = size;
      bestLines = lines;
    }
  }

  const fontSizePx = bestSize;
  const lineHeightPx = fontSizePx * (1 + spacingRatio);
  const lineSpacingPx = fontSizePx * spacingRatio;
  const blockHeight = bestLines.length * lineHeightPx;
  const startY = box.top + padding + Math.max(0, (innerHeight - blockHeight) / 2);

  const linePlacements: CaptionLinePlacement[] = bestLines.map((line, index) => {
    const widthPx = line.length * fontSizePx * CHAR_WIDTH_RATIO;
    const y = startY + index * lineHeightPx;
    const x =
      alignment === 'left'
        ? box.left + padding
        : alignment === 'right'
          ? box.right - padding - widthPx
          : box.left + (box.right - box.left - widthPx) / 2;
    return {
      text: line,
      position: { x, y, coordinateSpace: imageSpace },
      baselineY: y + fontSizePx * 0.85,
      widthPx,
      heightPx: lineHeightPx,
      availableSpanPx: innerWidth,
    };
  });

  const blockWidth = linePlacements.reduce(
    (max, line) => Math.max(max, line.widthPx),
    0,
  );
  const position: Point<ImageSpace> = {
    x: box.left + padding,
    y: startY,
    coordinateSpace: imageSpace,
  };
  const placement: Polygon<ImageSpace> = {
    coordinateSpace: imageSpace,
    points: captionBox.points.map((point) => ({
      ...point,
      coordinateSpace: imageSpace,
    })),
  };

  return {
    id: `caption-box:${captionBox.id}`,
    bubbleId: captionBox.id as CaptionLayout['bubbleId'],
    text,
    lines: bestLines,
    placement,
    position,
    widthPx: blockWidth,
    heightPx: blockHeight,
    fontFamily,
    fontSizePx,
    alignment,
    lineSpacingPx,
    linePlacements,
    // Drawn containers are intentional: treat fit as complete.
    fitScore: 1,
    readabilityScore: 1,
    safetyScore: 1,
  };
}

/**
 * Reading order for drawn caption boxes: top-to-bottom rows, then LTR (or RTL).
 */
export function orderCaptionBoxes(
  boxes: readonly CaptionBox[],
  direction: 'ltr' | 'rtl' = 'ltr',
): CaptionBox[] {
  const decorated = boxes.map((box) => {
    const b = boundsOf(box.points);
    return {
      box,
      cx: (b.left + b.right) / 2,
      cy: (b.top + b.bottom) / 2,
      height: b.bottom - b.top,
    };
  });
  decorated.sort((a, b) => {
    const tolerance = Math.min(a.height, b.height) * 0.5;
    if (Math.abs(a.cy - b.cy) > tolerance) return a.cy - b.cy;
    return direction === 'ltr' ? a.cx - b.cx : b.cx - a.cx;
  });
  return decorated.map((entry) => entry.box);
}
