import type { CaptionLayout } from '@comic-captioner/core';
import type { BinaryMask } from '@comic-captioner/shared';

/** Numerical acceptance thresholds for synthetic fixture comparisons. */
export const FIXTURE_TOLERANCES = Object.freeze({
  bubbleMaskIoU: 0.9,
  difficultBubbleMaskIoU: 0.82,
  textRegionMaskIoU: 0.85,
  coordinateRmsPixels: 3,
  coordinateMaximumPixels: 6,
  captionOverflowFraction: 0.01,
  timingBoundarySeconds: 0.08,
});

export function binaryMaskIoU(
  expected: Uint8Array,
  actual: Uint8Array,
): number {
  if (expected.length !== actual.length || expected.length === 0)
    throw new RangeError('Masks must have equal, non-zero pixel counts.');
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const a = expected[index]! > 0;
    const b = actual[index]! > 0;
    if (a && b) intersection += 1;
    if (a || b) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

export function boundsIoU(
  a: Readonly<{ x: number; y: number; width: number; height: number }>,
  b: Readonly<{ x: number; y: number; width: number; height: number }>,
): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function coordinateError(
  expected: readonly Readonly<{ x: number; y: number }>[],
  actual: readonly Readonly<{ x: number; y: number }>[],
) {
  if (expected.length !== actual.length || expected.length === 0)
    throw new RangeError('Coordinate lists must have equal, non-zero lengths.');
  let squared = 0;
  let maximum = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const first = expected[index]!;
    const second = actual[index]!;
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    squared += distance * distance;
    maximum = Math.max(maximum, distance);
  }
  return {
    rmsPixels: Math.sqrt(squared / expected.length),
    maximumPixels: maximum,
  };
}

/** Fraction of each laid-out line's tested pixel span outside a safe-mask run. */
export function captionOverflowFraction(
  layout: CaptionLayout,
  mask: BinaryMask,
): number {
  let total = 0;
  let overflow = 0;
  const originX = mask.origin.x;
  const originY = mask.origin.y;
  const rows = new Map<
    number,
    readonly Readonly<{ x: number; length: number }>[]
  >();
  for (const run of mask.runs)
    rows.set(run.y, [...(rows.get(run.y) ?? []), run]);
  for (const line of layout.linePlacements) {
    const xStart = Math.floor(line.position.x);
    const xEnd = Math.ceil(line.position.x + line.widthPx);
    const yStart = Math.floor(line.baselineY - line.heightPx);
    const yEnd = Math.ceil(line.baselineY);
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        total += 1;
        const localY = y - originY;
        const localX = x - originX;
        const safe = (rows.get(localY) ?? []).some(
          (run) => localX >= run.x && localX < run.x + run.length,
        );
        if (!safe) overflow += 1;
      }
    }
  }
  return total === 0 ? 1 : overflow / total;
}

export function timingBoundaryError(
  expected: Readonly<{ start: number; end: number }>,
  actual: Readonly<{ start: number; end: number }>,
): number {
  return Math.max(
    Math.abs(expected.start - actual.start),
    Math.abs(expected.end - actual.end),
  );
}
