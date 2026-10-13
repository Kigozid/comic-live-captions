import { describe, expect, it } from 'vitest';
import {
  createImageSpace,
  createMaskSpace,
  type BinaryMask,
  type MaskRun,
} from '@comic-captioner/shared';
import {
  CaptionFitError,
  CaptionFittingEngine,
  type CaptionFittingInput,
  type CaptionFontMetrics,
} from '@comic-captioner/caption-engine';
import type { CaptionSafeRegion } from '@comic-captioner/bubble-engine';

const pageSpace = createImageSpace('caption-fit-page', 120, 100);
const font: CaptionFontMetrics = {
  family: 'Test Comic Sans',
  unitsPerEm: 1000,
  ascent: 760,
  descent: 240,
  fallbackAdvance: 560,
  glyphAdvances: {
    ' ': 270,
    i: 250,
    l: 250,
    m: 800,
    w: 780,
    '.': 280,
    ',': 280,
    '!': 300,
    '?': 540,
    W: 850,
  },
  kerningPairs: { 'A+V': -100 },
};
const engine = new CaptionFittingEngine();

function safeRegion(
  rows: readonly (readonly Readonly<{ x: number; width: number }>[])[],
  options: {
    anchor?: { x: number; y: number };
    status?: 'ready' | 'no-safe-area';
  } = {},
): CaptionSafeRegion {
  const maskSpace = createMaskSpace('caption-mask', pageSpace, 120, 100);
  const runs: MaskRun[] = [];
  let minX = 120;
  let maxX = -1;
  let minY = rows.length;
  let maxY = -1;
  rows.forEach((spans, y) => {
    for (const span of spans) {
      runs.push({ x: span.x, y, length: span.width });
      minX = Math.min(minX, span.x);
      maxX = Math.max(maxX, span.x + span.width - 1);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });
  const mask: BinaryMask = {
    width: maxX < 0 ? 0 : maxX - minX + 1,
    height: maxY < 0 ? 0 : maxY - minY + 1,
    runs: runs.map((run) => ({ ...run, x: run.x - minX, y: run.y - minY })),
    origin: {
      x: maxX < 0 ? 0 : minX,
      y: maxY < 0 ? 0 : minY,
      coordinateSpace: maskSpace,
    },
    coordinateSpace: maskSpace,
  };
  return {
    id: 'safe:caption-test',
    bubbleId: 'bubble-test',
    mask,
    coordinateSpace: pageSpace,
    boundingBox:
      maxX < 0
        ? null
        : {
            x: minX - 0.5,
            y: minY - 0.5,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
            coordinateSpace: pageSpace,
          },
    originalTextBounds: {
      x: 45,
      y: 38,
      width: 30,
      height: 12,
      coordinateSpace: pageSpace,
    },
    preferredAnchor: options.anchor
      ? { ...options.anchor, coordinateSpace: pageSpace }
      : { x: 60, y: 48, coordinateSpace: pageSpace },
    placementPreserved: true,
    internalPaddingPx: 2,
    tailExcluded: true,
    croppedBubble: false,
    status: options.status ?? (maxX < 0 ? 'no-safe-area' : 'ready'),
    confidence: 1,
  };
}

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): CaptionSafeRegion {
  return safeRegion(
    Array.from({ length: 100 }, (_, row) =>
      row >= y && row < y + height ? [{ x, width }] : [],
    ),
    { anchor: { x: x + width / 2, y: y + height / 2 } },
  );
}

function ellipse(): CaptionSafeRegion {
  const rows = Array.from({ length: 100 }, (_, y) => {
    const normalized = (y - 50) / 42;
    if (Math.abs(normalized) >= 1) return [];
    const half = Math.floor(48 * Math.sqrt(1 - normalized * normalized));
    return [{ x: 60 - half, width: half * 2 }];
  });
  return safeRegion(rows, { anchor: { x: 60, y: 48 } });
}

function input(
  caption: string,
  region: CaptionSafeRegion = rectangle(14, 12, 92, 76),
  overrides: Partial<CaptionFittingInput> = {},
): CaptionFittingInput {
  return {
    caption,
    font,
    fontSizeRange: { minPx: 12, maxPx: 34 },
    safeRegion: region,
    paddingPx: 3,
    lineSpacingPx: 3,
    ...overrides,
  };
}

function rowIntervals(region: CaptionSafeRegion, y: number) {
  const scaleY = region.mask.coordinateSpace.maskToImageScaleY;
  const localY = y - region.mask.origin.y;
  const imageTop = (region.mask.origin.y + localY) * scaleY - 0.5;
  const imageBottom = (region.mask.origin.y + localY + 1) * scaleY - 0.5;
  return region.mask.runs
    .filter((run) => {
      const top = (region.mask.origin.y + run.y) * scaleY - 0.5;
      const bottom = (region.mask.origin.y + run.y + 1) * scaleY - 0.5;
      return imageBottom > top && imageTop < bottom;
    })
    .map((run) => ({
      left:
        (region.mask.origin.x + run.x) *
          region.mask.coordinateSpace.maskToImageScaleX -
        0.5,
      right:
        (region.mask.origin.x + run.x + run.length) *
          region.mask.coordinateSpace.maskToImageScaleX -
        0.5,
    }));
}

describe('CaptionFittingEngine', () => {
  it('wraps text and returns deterministic page-space geometry and quality scores', () => {
    const request = input('The signal is coming from the old radio tower.');
    const first = engine.fit(request);
    const second = engine.fit(request);
    expect(first).toEqual(second);
    expect(first.lines.length).toBeGreaterThan(1);
    expect(first.linePlacements).toHaveLength(first.lines.length);
    expect(first.position.coordinateSpace.id).toBe(pageSpace.id);
    expect(first.placement.coordinateSpace.id).toBe(pageSpace.id);
    expect(first.widthPx).toBeGreaterThan(0);
    expect(first.heightPx).toBeGreaterThan(0);
    for (const score of [
      first.fitScore,
      first.readabilityScore,
      first.safetyScore,
    ]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('fits against an ellipse mask and uses narrower spans near the curved top', () => {
    const result = engine.fit(
      input('We should leave before the storm.', ellipse()),
    );
    expect(result.linePlacements.length).toBeGreaterThan(1);
    expect(
      new Set(
        result.linePlacements.map((line) => Math.round(line.availableSpanPx)),
      ).size,
    ).toBeGreaterThan(1);
    for (const line of result.linePlacements) {
      const rows = Array.from(
        { length: Math.ceil(line.heightPx) + 1 },
        (_, i) => rowIntervals(ellipse(), line.position.y + i),
      );
      const shared = rows.reduce(
        (spans, row) =>
          spans.flatMap((a) =>
            row.flatMap((b) => {
              const left = Math.max(a.left, b.left);
              const right = Math.min(a.right, b.right);
              return right > left ? [{ left, right }] : [];
            }),
          ),
        rows[0] ?? [],
      );
      expect(
        shared.some(
          (span) =>
            line.position.x >= span.left + 3 - 1e-6 &&
            line.position.x + line.widthPx <= span.right - 3 + 1e-6,
        ),
      ).toBe(true);
    }
  });

  it('avoids a tail-shaped exclusion and does not treat the safe-region bounding box as usable', () => {
    const rows = Array.from({ length: 100 }, (_, y) => {
      if (y < 15 || y > 76) return [];
      if (y >= 64) return [{ x: 57, width: 6 }]; // Narrow tail-free neck.
      return [{ x: 20, width: 80 }];
    });
    const region = safeRegion(rows, { anchor: { x: 60, y: 42 } });
    const result = engine.fit(input('A short line.', region));
    expect(
      result.linePlacements.every(
        (line) => line.position.y + line.heightPx <= 64,
      ),
    ).toBe(true);
    expect(result.safetyScore).toBeGreaterThan(0);
  });

  it('uses disjoint safe spans without placing text across the gap', () => {
    const rows = Array.from({ length: 100 }, (_, y) =>
      y >= 5 && y < 95
        ? [
            { x: 8, width: 48 },
            { x: 64, width: 48 },
          ]
        : [],
    );
    const result = engine.fit(
      input('Left side stays apart.', safeRegion(rows)),
    );
    for (const line of result.linePlacements) {
      const inLeft = line.position.x + line.widthPx <= 56;
      const inRight = line.position.x >= 63;
      expect(inLeft || inRight).toBe(true);
    }
  });

  it('converts downsampled mask runs into canonical page ImageSpace spans', () => {
    const base = rectangle(18, 16, 84, 68);
    const maskSpace = createMaskSpace(
      'caption-mask-half-resolution',
      pageSpace,
      60,
      50,
    );
    const mask: BinaryMask = {
      width: 42,
      height: 34,
      runs: Array.from({ length: 34 }, (_, y) => ({
        x: 0,
        y,
        length: 42,
      })),
      origin: { x: 9, y: 8, coordinateSpace: maskSpace },
      coordinateSpace: maskSpace,
    };
    const downsampled: CaptionSafeRegion = { ...base, mask };
    const result = engine.fit(input('Scale-aware fitting works.', downsampled));
    expect(result.position.coordinateSpace.id).toBe(pageSpace.id);
    expect(result.linePlacements.every((line) => line.position.x >= 17.5)).toBe(
      true,
    );
    expect(result.linePlacements.every((line) => line.position.y >= 15.5)).toBe(
      true,
    );
  });

  it('respects font size floor, padding, line spacing, and explicit line breaks', () => {
    const request = input('Go now\nStay here', rectangle(4, 18, 112, 64), {
      fontSizeRange: { minPx: 20, maxPx: 20 },
      paddingPx: 8,
      lineSpacingPx: 7,
    });
    const result = engine.fit(request);
    expect(result.fontSizePx).toBe(20);
    expect(result.lines).toEqual(['Go now', 'Stay here']);
    expect(
      result.linePlacements[1]!.position.y -
        result.linePlacements[0]!.position.y,
    ).toBeCloseTo(result.linePlacements[0]!.heightPx + 7);
    expect(result.linePlacements.every((line) => line.position.x >= 12)).toBe(
      true,
    );
  });

  it('rebalances avoidable one-word final lines', () => {
    const result = engine.fit(
      input('One two three four five six seven eight nine ten.'),
    );
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.lines.at(-1)?.trim().split(/\s+/u)).toHaveLength(2);
  });

  it('moves a dangling connector word forward when the next line has room', () => {
    const request = input('hello the spaceship', rectangle(14, 12, 92, 76), {
      fontSizeRange: { minPx: 12, maxPx: 12 },
      paddingPx: 3,
    });
    const result = engine.fit(request);
    expect(result.lines).toEqual(['hello', 'the spaceship']);
  });

  it('uses supplied font advances and kerning deterministically', () => {
    const av = engine.fit(
      input('AV', rectangle(20, 20, 80, 60), {
        fontSizeRange: { minPx: 30, maxPx: 30 },
        paddingPx: 0,
      }),
    );
    const withoutKerning = engine.fit(
      input('AV', rectangle(20, 20, 80, 60), {
        font: { ...font, kerningPairs: {} },
        fontSizeRange: { minPx: 30, maxPx: 30 },
        paddingPx: 0,
      }),
    );
    expect(av.linePlacements[0]!.widthPx).toBeLessThan(
      withoutKerning.linePlacements[0]!.widthPx,
    );
  });

  it.each([
    ['empty safe mask', safeRegion(Array.from({ length: 100 }, () => []))],
    [
      'no-safe-area status',
      safeRegion(
        Array.from({ length: 100 }, () => []),
        { status: 'no-safe-area' },
      ),
    ],
  ])('rejects a pathological %s safely', (_label, region) => {
    expect(() => engine.fit(input('Cannot fit this.', region))).toThrow(
      CaptionFitError,
    );
  });

  it('rejects a long unbreakable token instead of overflowing the mask', () => {
    expect(() =>
      engine.fit(
        input('SUPERCALIFRAGILISTICEXPIALIDOCIOUS', rectangle(55, 20, 10, 60), {
          fontSizeRange: { minPx: 16, maxPx: 24 },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'minimum-font-size' }));
  });

  it('rejects height overflow and does not shrink below the configured minimum', () => {
    expect(() =>
      engine.fit(
        input(
          'One two three four five six seven eight nine ten eleven twelve.',
          rectangle(40, 42, 40, 15),
          { fontSizeRange: { minPx: 18, maxPx: 24 } },
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: 'minimum-font-size' }));
  });

  it('handles minimum-readable-score and text-length pathological limits', () => {
    expect(() =>
      engine.fit(
        input('Small but technically fits.', rectangle(30, 20, 60, 58)),
        {
          minimumReadabilityScore: 0.99,
        },
      ),
    ).toThrow(CaptionFitError);
    expect(() =>
      engine.fit(input('Too long for the configured input policy.'), {
        maximumTextLength: 8,
      }),
    ).toThrowError(expect.objectContaining({ code: 'text-too-long' }));
  });

  it('validates malformed metrics, mask runs, dimensions, and spacing', () => {
    const base = input('Check the edge.');
    expect(() =>
      engine.fit({ ...base, fontSizeRange: { minPx: 0, maxPx: 12 } }),
    ).toThrow(CaptionFitError);
    expect(() => engine.fit({ ...base, paddingPx: Number.NaN })).toThrow(
      CaptionFitError,
    );
    expect(() =>
      engine.fit({ ...base, font: { ...font, fallbackAdvance: 0 } }),
    ).toThrow(CaptionFitError);
    const damaged = {
      ...base.safeRegion,
      mask: { ...base.safeRegion.mask, runs: [{ x: -1, y: 0, length: 2 }] },
    } as CaptionSafeRegion;
    expect(() => engine.fit({ ...base, safeRegion: damaged })).toThrow(
      CaptionFitError,
    );
  });
});
