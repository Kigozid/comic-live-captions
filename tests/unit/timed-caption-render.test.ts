import { describe, expect, it } from 'vitest';
import type { CaptionLayout, ImageSpace, Point } from '@comic-captioner/core';
import {
  renderTimedCaptionLayerSvg,
  timedCaptionLayoutsFromExport,
  type TimedCaptionLayout,
} from '@comic-captioner/rendering';

const space: ImageSpace = {
  id: 'image:reveal-render' as ImageSpace['id'],
  kind: 'image',
  dimensions: { width: 200, height: 200 },
};
const pt = (x: number, y: number): Point<ImageSpace> => ({ x, y, coordinateSpace: space });

function layout(
  id: string,
  bubbleId: string,
  lineTexts: readonly string[],
): CaptionLayout {
  return {
    id,
    bubbleId: bubbleId as CaptionLayout['bubbleId'],
    text: lineTexts.join(' '),
    lines: [...lineTexts],
    placement: { points: [], coordinateSpace: space },
    position: pt(10, 10),
    widthPx: 120,
    heightPx: 40,
    fontFamily: 'DejaVu Sans',
    fontSizePx: 12,
    alignment: 'center',
    lineSpacingPx: 4,
    linePlacements: lineTexts.map((text, index) => ({
      text,
      position: pt(10, 10 + index * 16),
      baselineY: 20 + index * 16,
      widthPx: 120,
      heightPx: 12,
      availableSpanPx: 120,
    })),
    fitScore: 1,
    readabilityScore: 1,
    safetyScore: 1,
  };
}

/** "The city is under attack!" across two lines → 5 words. */
function caption(
  id: string,
  bubbleId: string,
  startSeconds: number,
  endSeconds: number,
): TimedCaptionLayout {
  return {
    layout: layout(id, bubbleId, ['The city is under', 'attack!']),
    startSeconds,
    endSeconds,
  };
}

/** Count word tspans that are visible (fill-opacity > 0). */
function revealedCount(svg: string): number {
  const matches = svg.match(/fill-opacity="([^"]+)"/g) ?? [];
  return matches.filter((entry) => {
    const value = Number(entry.match(/fill-opacity="([^"]+)"/)?.[1] ?? 0);
    return value > 0;
  }).length;
}

describe('renderTimedCaptionLayerSvg — progressive word reveal', () => {
  it('10. reveals words progressively instead of the full sentence at once', () => {
    const item = caption('c1', 'b1', 1, 2); // 5 words over [1, 2]
    const opts = { revealMode: 'word-by-word' as const };
    const before = renderTimedCaptionLayerSvg(200, 200, [item], 1.1, opts);
    const mid = renderTimedCaptionLayerSvg(200, 200, [item], 1.5, opts);
    const end = renderTimedCaptionLayerSvg(200, 200, [item], 2.0, opts);

    // Before the caption starts: bubble stays empty (no words rendered).
    expect(renderTimedCaptionLayerSvg(200, 200, [item], 0.5, opts)).not.toContain(
      '<tspan',
    );
    // Progressive: more words revealed as time advances, never all at once early.
    expect(revealedCount(before)).toBe(1);
    expect(revealedCount(mid)).toBe(3);
    expect(revealedCount(end)).toBe(5);
  });

  it('smooth-phrase reveals 2–3 word chunks instead of a single word', () => {
    const item = caption('c1', 'b1', 1, 2);
    const early = renderTimedCaptionLayerSvg(200, 200, [item], 1.05, {
      revealMode: 'smooth-phrase',
      fadeInSeconds: 0,
    });
    // First chunk is a readable phrase, not the whole sentence.
    const count = revealedCount(early);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThan(5);
  });

  it('keeps the next bubble empty until its own dialogue begins', () => {
    const first = caption('c1', 'b1', 1, 2);
    const second = caption('c2', 'b2', 3, 4);
    const svg = renderTimedCaptionLayerSvg(200, 200, [first, second], 1.5);
    // First bubble has revealed words, second bubble contributes none yet.
    expect(svg).toContain('data-caption-id="c1"');
    expect(svg).not.toContain('data-caption-id="c2"');
  });

  it('keeps completed dialogue visible (persistence) after it is spoken', () => {
    const item = caption('c1', 'b1', 1, 2);
    const after = renderTimedCaptionLayerSvg(200, 200, [item], 3.5);
    expect(revealedCount(after)).toBe(5); // still fully visible past end
  });

  it('clears the bubble under the clear reuse policy once it finishes', () => {
    const item = caption('c1', 'b1', 1, 2);
    const after = renderTimedCaptionLayerSvg(200, 200, [item], 3.5, {
      reusePolicy: 'clear',
    });
    expect(after).not.toContain('<tspan');
  });

  it('is a pure function of time (seeking reproduces the same SVG)', () => {
    const item = caption('c1', 'b1', 1, 2);
    const a = renderTimedCaptionLayerSvg(200, 200, [item], 1.5);
    const b = renderTimedCaptionLayerSvg(200, 200, [item], 1.5);
    expect(a).toBe(b);
  });
});

describe('timedCaptionLayoutsFromExport — shared export → reveal bridge', () => {
  const fitted = layout('c1', 'b1', ['The city is under', 'attack!']);

  it('maps acoustic word timings onto the fitted layout tokens', () => {
    const [timed] = timedCaptionLayoutsFromExport([
      {
        layout: fitted,
        start: 1,
        end: 2,
        words: [
          { text: 'The', start: 1, end: 1.1 },
          { text: 'city', start: 1.1, end: 1.2 },
          { text: 'is', start: 1.2, end: 1.3 },
          { text: 'under', start: 1.3, end: 1.5 },
          { text: 'attack!', start: 1.5, end: 2 },
        ],
      },
    ]);
    expect(timed?.words).toHaveLength(5);
    expect(timed?.words?.[0]?.startSeconds).toBe(1);
    expect(timed?.words?.[4]?.endSeconds).toBe(2);
  });

  it('synthesizes even slices when acoustic words are missing or mismatched', () => {
    const missing = timedCaptionLayoutsFromExport([
      { layout: fitted, start: 1, end: 2 },
    ])[0]!;
    expect(missing.words).toHaveLength(5);
    expect(missing.words?.every((word) => word.estimated)).toBe(true);

    const mismatched = timedCaptionLayoutsFromExport([
      {
        layout: fitted,
        start: 1,
        end: 2,
        words: [{ text: 'The', start: 1, end: 2 }],
      },
    ])[0]!;
    expect(mismatched.words).toHaveLength(5);
    expect(mismatched.words?.every((word) => word.estimated)).toBe(true);
  });

  it('skips captions without layout or timing', () => {
    expect(
      timedCaptionLayoutsFromExport([
        { layout: null, start: 1, end: 2 },
        { layout: fitted, start: null, end: 2 },
        { layout: fitted, start: 1, end: null },
      ]),
    ).toHaveLength(0);
  });

  it('drives progressive reveal through the export bridge (not full-line dumps)', () => {
    const timed = timedCaptionLayoutsFromExport([
      {
        layout: fitted,
        start: 1,
        end: 2,
        words: [
          { text: 'The', start: 1, end: 1.2 },
          { text: 'city', start: 1.2, end: 1.4 },
          { text: 'is', start: 1.4, end: 1.55 },
          { text: 'under', start: 1.55, end: 1.75 },
          { text: 'attack!', start: 1.75, end: 2 },
        ],
      },
    ]);
    const before = renderTimedCaptionLayerSvg(200, 200, timed, 1.1, {
      revealMode: 'word-by-word',
    });
    const mid = renderTimedCaptionLayerSvg(200, 200, timed, 1.5, {
      revealMode: 'word-by-word',
    });
    expect(revealedCount(before)).toBe(1);
    expect(revealedCount(mid)).toBeLessThan(5);
  });
});
