import type {
  BubbleGeometryInput,
  ImagePoint,
  ImageRect,
  PageInput,
} from './types.js';

/** Axis-aligned bounds of a polygon in image coordinates. */
export function polygonBounds(points: readonly ImagePoint[]): ImageRect {
  if (points.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
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

/** Shrink a rect by a uniform margin, clamped to stay non-empty. */
export function insetRect(rect: ImageRect, margin: number): ImageRect {
  const marginX = Math.max(0, margin);
  const marginY = Math.max(0, margin);
  const width = rect.width - marginX * 2;
  const height = rect.height - marginY * 2;
  if (width <= 2 || height <= 2) {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: 2,
      height: 2,
    };
  }
  return {
    x: rect.x + marginX,
    y: rect.y + marginY,
    width,
    height,
  };
}

export function pointInPolygon(
  x: number,
  y: number,
  points: readonly ImagePoint[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Safe interior for lettering: prefer the explicit safe region, otherwise
 * inset the bubble contour bounds. Never invents hard-coded sample coords.
 */
export function bubbleSafeRect(
  bubble: BubbleGeometryInput,
  safeMarginPx: number,
): ImageRect {
  const base =
    bubble.safeRegion && bubble.safeRegion.length >= 3
      ? polygonBounds(bubble.safeRegion)
      : polygonBounds(bubble.polygon);
  return insetRect(base, safeMarginPx);
}

/** Map a normalized fallback rect (0..1 of the page) into image pixels. */
export function resolveFallbackRect(
  page: PageInput,
  rect: ImageRect,
  safeMarginPx: number,
): ImageRect {
  const normalized =
    rect.width <= 1.5 && rect.height <= 1.5 && rect.x <= 1.5 && rect.y <= 1.5;
  const imageRect: ImageRect = normalized
    ? {
        x: rect.x * page.width,
        y: rect.y * page.height,
        width: Math.max(8, rect.width * page.width),
        height: Math.max(8, rect.height * page.height),
      }
    : rect;
  return insetRect(imageRect, safeMarginPx);
}

export function pageAtTime(
  pages: readonly PageInput[],
  timeSeconds: number,
): PageInput | null {
  // Half-open [start, end), matching cue visibility. On exact boundaries the
  // later page wins so transitions never show two full-strength pages.
  let match: PageInput | null = null;
  for (const page of pages) {
    if (page.startSeconds <= timeSeconds && timeSeconds < page.endSeconds) {
      match = page;
    }
  }
  return match ?? pages[pages.length - 1] ?? null;
}

/**
 * Letterbox the page inside the output frame — never crops comic art. Camera
 * motion scales around the fitted page only.
 */
export function pagePlacement(
  pageWidth: number,
  pageHeight: number,
  frameWidth: number,
  frameHeight: number,
): {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
} {
  const scale = Math.min(frameWidth / pageWidth, frameHeight / pageHeight);
  const width = Math.max(1, Math.round(pageWidth * scale));
  const height = Math.max(1, Math.round(pageHeight * scale));
  return {
    width,
    height,
    offsetX: Math.round((frameWidth - width) / 2),
    offsetY: Math.round((frameHeight - height) / 2),
    scale,
  };
}

/**
 * Frame a panel `focus` rect inside the output frame (contain). The full page
 * is still drawn — only the camera window changes — so captions in page
 * coordinates stay aligned with the artwork.
 */
export function focusPlacement(
  pageWidth: number,
  pageHeight: number,
  focus: ImageRect,
  frameWidth: number,
  frameHeight: number,
): {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
} {
  const focusWidth = Math.max(1, focus.width);
  const focusHeight = Math.max(1, focus.height);
  const scale = Math.min(frameWidth / focusWidth, frameHeight / focusHeight);
  const width = Math.max(1, pageWidth * scale);
  const height = Math.max(1, pageHeight * scale);
  const focusDrawX = focus.x * scale;
  const focusDrawY = focus.y * scale;
  const focusDrawWidth = focusWidth * scale;
  const focusDrawHeight = focusHeight * scale;
  return {
    width,
    height,
    offsetX: (frameWidth - focusDrawWidth) / 2 - focusDrawX,
    offsetY: (frameHeight - focusDrawHeight) / 2 - focusDrawY,
    scale,
  };
}

/** Choose full-page letterbox or panel focus framing for a sequence step. */
export function resolvePageCameraPlacement(
  page: { width: number; height: number; cameraFocus?: ImageRect },
  frameWidth: number,
  frameHeight: number,
): {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
} {
  if (page.cameraFocus) {
    return focusPlacement(
      page.width,
      page.height,
      page.cameraFocus,
      frameWidth,
      frameHeight,
    );
  }
  return pagePlacement(page.width, page.height, frameWidth, frameHeight);
}
