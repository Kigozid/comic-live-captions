import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createImageSpace,
  createMaskSpace,
  type BinaryMask,
  type OriginalTextRegion,
} from '@comic-captioner/shared';
import type { CaptionSafeRegion } from '@comic-captioner/bubble-engine';
import {
  ReferencePlacementEngine,
  ReferencePlacementError,
  type ReferencePlacementInput,
} from '@comic-captioner/caption-engine';
import type { CaptionFontMetrics } from '@comic-captioner/caption-engine';

const pageSpace = createImageSpace('reference-placement-page', 120, 100);
const font: CaptionFontMetrics = {
  family: 'Test Comic Sans',
  unitsPerEm: 1000,
  ascent: 760,
  descent: 240,
  fallbackAdvance: 520,
  glyphAdvances: {
    ' ': 270,
    i: 250,
    l: 250,
    m: 780,
    w: 760,
    '.': 280,
    ',': 280,
    '!': 300,
    W: 820,
  },
};

function safeRegion(): CaptionSafeRegion {
  const maskSpace = createMaskSpace('reference-safe-mask', pageSpace, 120, 100);
  const runs = Array.from({ length: 82 }, (_, y) => ({
    x: 0,
    y,
    length: 120,
  }));
  return {
    id: 'safe-reference-bubble',
    bubbleId: 'bubble-reference',
    mask: {
      width: 120,
      height: 82,
      runs,
      origin: { x: 0, y: 9, coordinateSpace: maskSpace },
      coordinateSpace: maskSpace,
    },
    coordinateSpace: pageSpace,
    boundingBox: {
      x: -0.5,
      y: 8.5,
      width: 120,
      height: 82,
      coordinateSpace: pageSpace,
    },
    originalTextBounds: {
      x: 24,
      y: 30,
      width: 72,
      height: 40,
      coordinateSpace: pageSpace,
    },
    preferredAnchor: { x: 60, y: 50, coordinateSpace: pageSpace },
    placementPreserved: true,
    internalPaddingPx: 2,
    tailExcluded: true,
    croppedBubble: false,
    status: 'ready',
    confidence: 1,
  };
}

function originalTextRegion(): OriginalTextRegion {
  const maskSpace = createMaskSpace('original-text-mask', pageSpace, 120, 100);
  const maskHeight = 8;
  const maskWidth = 20;
  const mask: BinaryMask = {
    width: maskWidth,
    height: maskHeight,
    runs: Array.from({ length: maskHeight }, (_, y) => ({
      x: 0,
      y,
      length: maskWidth,
    })),
    origin: { x: 39, y: 40, coordinateSpace: maskSpace },
    coordinateSpace: maskSpace,
  };
  const boundingBox = {
    x: 24,
    y: 30,
    width: 72,
    height: 40,
    coordinateSpace: pageSpace,
  };
  const polygon = {
    points: [
      { x: 24, y: 30, coordinateSpace: pageSpace },
      { x: 96, y: 30, coordinateSpace: pageSpace },
      { x: 96, y: 70, coordinateSpace: pageSpace },
      { x: 24, y: 70, coordinateSpace: pageSpace },
    ],
    coordinateSpace: pageSpace,
  };
  return {
    id: 'original-dialogue-text',
    mask,
    polygon,
    boundingBox,
    confidence: 0.97,
    coordinateSpace: pageSpace,
  };
}

function input(mode: ReferencePlacementInput['mode']): ReferencePlacementInput {
  return {
    caption: 'We go now please',
    font,
    fontSizeRange: { minPx: 10, maxPx: 34 },
    originalTextRegion: originalTextRegion(),
    originalLineCount: 2,
    originalAlignment: 'right',
    safeRegion: safeRegion(),
    paddingPx: 2,
    lineSpacingPx: 2,
    mode,
  };
}

describe('ReferencePlacementEngine', () => {
  const engine = new ReferencePlacementEngine();

  it('preserves reference center, footprint, two-line structure, and right alignment when possible', () => {
    const result = engine.place(input('reference'));
    expect(result.mode).toBe('reference');
    expect(result.requestedMode).toBe('reference');
    expect(result.layout.lines).toHaveLength(2);
    expect(result.layout.alignment).toBe('right');
    expect(result.preserved).toMatchObject({
      lineStructure: true,
      alignment: true,
    });
    expect(result.preserved.footprintWidthRatio).toBeLessThanOrEqual(1);
    expect(result.preserved.footprintHeightRatio).toBeLessThanOrEqual(1);
    expect(result.preserved.centerDistancePx).toBeLessThan(20);
    expect(result.warnings).toEqual([]);
    expect(result.layout.position.coordinateSpace.id).toBe(pageSpace.id);
  });

  it('uses OCR ink-mask centroid to place reference lettering within the original footprint', () => {
    const result = engine.place(input('reference'));
    const inkCenterX = 49;
    const layoutCenterX = result.layout.position.x + result.layout.widthPx / 2;
    expect(Math.abs(layoutCenterX - inkCenterX)).toBeLessThan(18);
  });

  it('auto-fit uses the full safe mask and optimizes size while retaining alignment', () => {
    const result = engine.place(input('auto-fit'));
    expect(result.mode).toBe('auto-fit');
    expect(result.layout.alignment).toBe('right');
    expect(result.layout.fontSizePx).toBeGreaterThan(10);
    expect(result.layout.safetyScore).toBeGreaterThan(0);
  });

  it('falls back explicitly when reference line structure cannot fit the original footprint', () => {
    const source = input('reference');
    const result = engine.place({
      ...source,
      caption:
        'This replacement dialogue is much longer than the lettering that was here before.',
      originalLineCount: 2,
    });
    expect(result.requestedMode).toBe('reference');
    expect(result.mode).toBe('auto-fit');
    expect(result.preserved.lineStructure).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it('can reject reference fallback when a caller requires the exact composition', () => {
    const source = input('reference');
    expect(() =>
      engine.place(
        {
          ...source,
          caption:
            'An impossible amount of dialogue for this tiny original lettering footprint.',
          originalLineCount: 2,
        },
        { onReferenceFailure: 'error' },
      ),
    ).toThrow(ReferencePlacementError);
  });

  it('validates OCR mask, page coordinate space, alignment, and line count', () => {
    const source = input('reference');
    expect(() => engine.place({ ...source, originalLineCount: 0 })).toThrow(
      ReferencePlacementError,
    );
    expect(() =>
      engine.place({ ...source, originalAlignment: 'diagonal' as never }),
    ).toThrow(ReferencePlacementError);
    const mismatched = {
      ...source.originalTextRegion,
      coordinateSpace: createImageSpace('other-reference-page', 120, 100),
    };
    expect(() =>
      engine.place({ ...source, originalTextRegion: mismatched }),
    ).toThrow(ReferencePlacementError);
  });

  it('renders a stable pixel-level visual regression for reference placement', async () => {
    const result = engine.place(input('reference'));
    const region = result.layout;
    const mask = safeRegion().mask;
    const maskSvg = mask.runs
      .map(
        (run) =>
          `<rect x="${mask.origin.x + run.x}" y="${mask.origin.y + run.y}" width="${run.length}" height="1" fill="#ffffff"/>`,
      )
      .join('');
    const textSvg = region.linePlacements
      .map(
        (line) =>
          `<rect x="${line.position.x.toFixed(3)}" y="${line.position.y.toFixed(3)}" width="${line.widthPx.toFixed(3)}" height="${line.heightPx.toFixed(3)}" fill="#00d084"/>`,
      )
      .join('');
    const original = originalTextRegion().boundingBox;
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100" viewBox="0 0 120 100"><rect width="120" height="100" fill="#20242a"/>${maskSvg}<rect x="${original.x}" y="${original.y}" width="${original.width}" height="${original.height}" fill="none" stroke="#ff8a00" stroke-width="1"/>${textSvg}</svg>`,
    );
    const { data, info } = await sharp(svg)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const digest = createHash('sha256')
      .update(data)
      .update(`${info.width}x${info.height}x${info.channels}`)
      .digest('hex');
    expect(digest).toBe(
      '545849bf0e260c720b3f362b0f7e85ae00bc290a15f354ebedeb1487838a36df',
    );
  });
});
