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

function pointInPolygon(
  x: number,
  y: number,
  points: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i]!.x;
    const yi = points[i]!.y;
    const xj = points[j]!.x;
    const yj = points[j]!.y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Same corner rule as export validation (`layoutOverflowsBubble`). */
function lineCornersOverflow(
  line: CaptionLinePlacement,
  points: readonly { x: number; y: number }[],
): boolean {
  const corners = [
    { x: line.position.x, y: line.baselineY - line.heightPx },
    { x: line.position.x + line.widthPx, y: line.baselineY - line.heightPx },
    { x: line.position.x, y: line.baselineY },
    { x: line.position.x + line.widthPx, y: line.baselineY },
  ];
  return corners.some((corner) => !pointInPolygon(corner.x, corner.y, points));
}

function placementsOverflow(
  placements: readonly CaptionLinePlacement[],
  points: readonly { x: number; y: number }[],
): boolean {
  return placements.some((line) => lineCornersOverflow(line, points));
}

/**
 * Largest axis-aligned rect centered in the polygon whose corners and edge
 * midpoints stay inside. Speech balloons are roughly convex, so a centroid-
 * scaled rect is a safe inner frame for wrap/align (not the raw bounding box).
 */
function innerRectFromPolygon(
  points: readonly { x: number; y: number }[],
  paddingPx: number,
): { left: number; top: number; right: number; bottom: number } {
  const box = boundsOf(points);
  const width = Math.max(1, box.right - box.left);
  const height = Math.max(1, box.bottom - box.top);
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const rectFits = (halfW: number, halfH: number) => {
    const left = cx - halfW;
    const right = cx + halfW;
    const top = cy - halfH;
    const bottom = cy + halfH;
    const samples = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
      { x: cx, y: top },
      { x: cx, y: bottom },
      { x: left, y: cy },
      { x: right, y: cy },
    ];
    return samples.every((p) => pointInPolygon(p.x, p.y, points));
  };

  let bestHalfW = Math.max(4, width / 2 - paddingPx);
  let bestHalfH = Math.max(4, height / 2 - paddingPx);
  if (!rectFits(bestHalfW, bestHalfH)) {
    // Binary-search a uniform scale of the padded bbox rect.
    let lo = 0.05;
    let hi = 1;
    bestHalfW = Math.max(4, (width / 2 - paddingPx) * lo);
    bestHalfH = Math.max(4, (height / 2 - paddingPx) * lo);
    for (let step = 0; step < 12; step += 1) {
      const mid = (lo + hi) / 2;
      const halfW = Math.max(2, (width / 2 - paddingPx) * mid);
      const halfH = Math.max(2, (height / 2 - paddingPx) * mid);
      if (rectFits(halfW, halfH)) {
        bestHalfW = halfW;
        bestHalfH = halfH;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    // One more shrink so sampled corners stay strictly inside after rounding.
    bestHalfW = Math.max(2, bestHalfW * 0.92);
    bestHalfH = Math.max(2, bestHalfH * 0.92);
    if (!rectFits(bestHalfW, bestHalfH)) {
      bestHalfW = Math.max(2, bestHalfW * 0.8);
      bestHalfH = Math.max(2, bestHalfH * 0.8);
    }
  }

  return {
    left: cx - bestHalfW,
    top: cy - bestHalfH,
    right: cx + bestHalfW,
    bottom: cy + bestHalfH,
  };
}

/**
 * Fit `caption` into a drawn container. Returns a `CaptionLayout` ready for
 * `timedCaptionLayoutsFromExport` / typewriter reveal. Line corners stay
 * inside the container polygon (not just its bounding box).
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
  const basePadding = options.paddingPx ?? 8;
  const minFont = options.minimumFontSizePx ?? MIN_FONT;
  const maxFont = options.maximumFontSizePx ?? MAX_FONT;
  const spacingRatio = options.lineSpacingRatio ?? 0.18;

  const points = captionBox.points;
  // Fit into the polygon's inner rect so irregular balloons cannot overflow.
  const box = innerRectFromPolygon(points, basePadding);
  const innerWidthMax = Math.max(8, box.right - box.left);
  const innerHeightMax = Math.max(8, box.bottom - box.top);

  let bestSize = minFont;
  let bestLines: string[] = wrapLines(text, minFont, innerWidthMax);
  let bestPlacements: CaptionLinePlacement[] = [];
  let bestPadding = 0;

  for (let padding = 0; padding <= 16; padding += 2) {
    const innerWidth = Math.max(8, innerWidthMax - padding * 2);
    const innerHeight = Math.max(8, innerHeightMax - padding * 2);
    for (let size = maxFont; size >= minFont; size -= 1) {
      const lines = wrapLines(text, size, innerWidth);
      const lineHeight = size * (1 + spacingRatio);
      const blockHeight = lines.length * lineHeight;
      const widest = lines.reduce(
        (max, line) => Math.max(max, line.length * size * CHAR_WIDTH_RATIO),
        0,
      );
      if (blockHeight > innerHeight || widest > innerWidth) continue;
      const startY =
        box.top + padding + Math.max(0, (innerHeight - blockHeight) / 2);
      const placements: CaptionLinePlacement[] = lines.map((line, index) => {
        const widthPx = line.length * size * CHAR_WIDTH_RATIO;
        const y = startY + index * lineHeight;
        const x =
          alignment === 'left'
            ? box.left + padding
            : alignment === 'right'
              ? box.right - padding - widthPx
              : box.left + (box.right - box.left - widthPx) / 2;
        return {
          text: line,
          position: { x, y, coordinateSpace: imageSpace },
          baselineY: y + size * 0.85,
          widthPx,
          heightPx: lineHeight,
          availableSpanPx: innerWidth,
        };
      });
      if (placementsOverflow(placements, points)) continue;
      bestSize = size;
      bestLines = lines;
      bestPlacements = placements;
      bestPadding = padding;
      break;
    }
    if (bestPlacements.length > 0) break;
  }

  if (bestPlacements.length === 0) {
    const size = minFont;
    const lines = wrapLines(text, size, innerWidthMax);
    const lineHeight = size * (1 + spacingRatio);
    const startY = box.top;
    bestSize = size;
    bestLines = lines;
    bestPadding = 0;
    bestPlacements = lines.map((line, index) => {
      const widthPx = line.length * size * CHAR_WIDTH_RATIO;
      const y = startY + index * lineHeight;
      const x = box.left + (box.right - box.left - widthPx) / 2;
      return {
        text: line,
        position: { x, y, coordinateSpace: imageSpace },
        baselineY: y + size * 0.85,
        widthPx,
        heightPx: lineHeight,
        availableSpanPx: innerWidthMax,
      };
    });
  }

  const fontSizePx = bestSize;
  const lineSpacingPx = fontSizePx * spacingRatio;
  const blockHeight = bestPlacements.length * fontSizePx * (1 + spacingRatio);
  const linePlacements = bestPlacements;

  const blockWidth = linePlacements.reduce(
    (max, line) => Math.max(max, line.widthPx),
    0,
  );
  const position: Point<ImageSpace> = {
    x: box.left + bestPadding,
    y: linePlacements[0]?.position.y ?? box.top + bestPadding,
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
