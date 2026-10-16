import { describe, expect, it } from 'vitest';
import type { CaptionLayout, ImageSpace, Point } from '@comic-captioner/core';
import {
  renderTimedCaptionLayerSvg,
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

/** Count fully-revealed word tspans (fill-opacity="1"). */
function revealedCount(svg: string): number {
  return svg.split('fill-opacity="1"').length - 1;
}

describe('renderTimedCaptionLayerSvg — progressive word reveal', () => {
  it('10. reveals words progressively instead of the full sentence at once', () => {
    const item = caption('c1', 'b1', 1, 2); // 5 words over [1, 2]
    const before = renderTimedCaptionLayerSvg(200, 200, [item], 1.1);
    const mid = renderTimedCaptionLayerSvg(200, 200, [item], 1.5);
    const end = renderTimedCaptionLayerSvg(200, 200, [item], 2.0);

    // Before the caption starts: bubble stays empty (no words rendered).
    expect(renderTimedCaptionLayerSvg(200, 200, [item], 0.5)).not.toContain(
      '<tspan',
    );
    // Progressive: more words revealed as time advances, never all at once early.
    expect(revealedCount(before)).toBe(1);
    expect(revealedCount(mid)).toBe(3);
    expect(revealedCount(end)).toBe(5);
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
