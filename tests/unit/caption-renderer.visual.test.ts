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
    it(`matches the approved ${testCase.id} reference exactly`, async () => {
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
      expect(actual.width).toBe(reference.info.width);
      expect(actual.height).toBe(reference.info.height);
      const difference = compareRgbaImages(
        reference.data,
        actual.rgba,
        actual.width,
        actual.height,
      );
      if (difference.changedPixels !== 0) {
        throw new Error(
          [
            `Caption visual regression in ${testCase.id}.`,
            `Changed pixels: ${difference.changedPixels}/${actual.width * actual.height} (${(difference.changedPixelRatio * 100).toFixed(5)}%).`,
            `Mean absolute channel difference: ${difference.meanAbsoluteChannelDifference.toFixed(5)}; maximum: ${difference.maximumChannelDifference}.`,
            `Changed regions (8-connected, sorted by size): ${JSON.stringify(difference.changedRegions)}`,
            'Review the rendering change, then intentionally update references with `pnpm update:visual-snapshots` if approved.',
          ].join('\n'),
        );
      }
      expect(difference.changedPixelRatio).toBe(0);
    });
  }
});
