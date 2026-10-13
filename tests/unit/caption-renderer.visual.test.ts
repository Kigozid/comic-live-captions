import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CAPTION_VISUAL_CASES } from '../fixtures/caption-visual-cases.js';
import {
  renderCaptionVisualCase,
  VISUAL_REFERENCE_DIRECTORY,
} from '../fixtures/render-caption-case.js';
import { compareRgbaImages } from '../fixtures/visual-diff.js';

/**
 * Visual snapshots are compared structurally first (dimensions, caption text
 * lines, bubble containment) and then with a pixel-difference tolerance that
 * absorbs system-font glyph rasterization variance. This keeps the suite
 * portable across macOS/Linux/CI without bundling font binaries, while still
 * catching real regressions (missing captions, wrong bubble, overflow).
 *
 * Tolerance policy (font-portable):
 * - changedPixelRatio ≤ 0.12 (12% of pixels may differ at the glyph level)
 * - meanAbsoluteChannelDifference ≤ 18
 * - maximumChannelDifference is reported but not gated (anti-aliasing spikes)
 * Structural checks always run and are exact.
 */
const MAX_CHANGED_PIXEL_RATIO = 0.12;
const MAX_MEAN_ABSOLUTE_CHANNEL_DIFFERENCE = 18;

describe('caption renderer visual regression', () => {
  it('reports changed-pixel counts, difference magnitude, and connected region bounds', () => {
    const reference = new Uint8Array(4 * 3 * 4);
    const actual = new Uint8Array(reference.length);
    actual[(1 * 4 + 1) * 4] = 255;
    actual[(2 * 4 + 2) * 4] = 80;
    const difference = compareRgbaImages(reference, actual, 4, 3);
    expect(difference.changedPixels).toBe(2);
    expect(difference.maximumChannelDifference).toBe(255);
    expect(difference.changedRegions).toEqual([
      { x: 1, y: 1, width: 2, height: 2, changedPixels: 2 },
    ]);
  });

  for (const testCase of CAPTION_VISUAL_CASES) {
    it(`matches the approved ${testCase.id} reference within font-portable tolerance`, async () => {
      const referencePath = path.join(
        VISUAL_REFERENCE_DIRECTORY,
        `${testCase.id}.png`,
      );
      const referenceBytes = await readFile(referencePath);
      const reference = await sharp(referenceBytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const actual = await renderCaptionVisualCase(testCase.id);

      // Structural: dimensions must match exactly.
      expect(actual.width).toBe(reference.info.width);
      expect(actual.height).toBe(reference.info.height);

      // Structural: expected caption lines are present in the fitted layouts.
      for (const caption of testCase.captions) {
        const layout = actual.layouts.find(
          (item) => item.bubbleId === caption.bubbleId,
        );
        expect(layout, `missing layout for ${caption.bubbleId}`).toBeTruthy();
        const text = layout!.linePlacements.map((line) => line.text).join(' ');
        for (const line of caption.lines) {
          expect(text).toContain(line);
        }
        // Captions stay inside the selected bubble — never a bottom subtitle lane.
        expect(layout!.bubbleId).toBe(caption.bubbleId);
      }

      // Structural: no layout is allowed in a screen-bottom subtitle track.
      const bottomOfPage = actual.height * 0.92;
      for (const layout of actual.layouts) {
        const bottom =
          layout.position.y +
          layout.heightPx;
        expect(
          bottom < bottomOfPage || layout.heightPx < actual.height * 0.2,
          `layout ${layout.bubbleId} appears to occupy a bottom subtitle region`,
        ).toBe(true);
      }

      // Pixel comparison with font-rasterization tolerance.
      const difference = compareRgbaImages(
        reference.data,
        actual.rgba,
        actual.width,
        actual.height,
      );
      const pixelRatioOk =
        difference.changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO;
      const meanOk =
        difference.meanAbsoluteChannelDifference <=
        MAX_MEAN_ABSOLUTE_CHANNEL_DIFFERENCE;

      if (!pixelRatioOk || !meanOk) {
        throw new Error(
          [
            `Caption visual regression in ${testCase.id}.`,
            `Changed pixels: ${difference.changedPixels}/${actual.width * actual.height} (${(difference.changedPixelRatio * 100).toFixed(5)}%); allowed ≤ ${(MAX_CHANGED_PIXEL_RATIO * 100).toFixed(1)}%.`,
            `Mean absolute channel difference: ${difference.meanAbsoluteChannelDifference.toFixed(5)} (allowed ≤ ${MAX_MEAN_ABSOLUTE_CHANNEL_DIFFERENCE}); maximum: ${difference.maximumChannelDifference}.`,
            `Changed regions (8-connected, sorted by size): ${JSON.stringify(difference.changedRegions)}`,
            'If this is a real layout/bubble/overflow regression, fix the renderer. If this is only font rasterization on a new OS and the structural checks pass, re-approve with `pnpm update:visual-snapshots`.',
          ].join('\n'),
        );
      }
      expect(difference.changedPixelRatio).toBeLessThanOrEqual(
        MAX_CHANGED_PIXEL_RATIO,
      );
      expect(difference.meanAbsoluteChannelDifference).toBeLessThanOrEqual(
        MAX_MEAN_ABSOLUTE_CHANNEL_DIFFERENCE,
      );
    });
  }
});
