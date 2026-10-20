import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { CaptionLayout } from '@comic-captioner/core';
import type { BubbleId, CoordinateSpaceId } from '@comic-captioner/shared';
import {
  RenderingEngine,
  timedCaptionLayoutsFromExport,
  renderTimedCaptionLayerSvg,
} from '@comic-captioner/rendering';

const space = {
  id: 'image:typewriter-audit' as CoordinateSpaceId,
  kind: 'image' as const,
  dimensions: { width: 200, height: 80 },
};

function multiWordLayout(): CaptionLayout {
  const text = 'The city is under attack!';
  return {
    id: 'layout-1',
    bubbleId: 'bubble-1' as BubbleId,
    text,
    lines: [text],
    placement: { points: [], coordinateSpace: space },
    position: { x: 10, y: 10, coordinateSpace: space },
    widthPx: 180,
    heightPx: 50,
    fontFamily: 'DejaVu Sans',
    fontSizePx: 16,
    alignment: 'left',
    lineSpacingPx: 2,
    linePlacements: [
      {
        text,
        position: { x: 10, y: 10, coordinateSpace: space },
        baselineY: 32,
        widthPx: 180,
        heightPx: 18,
        availableSpanPx: 180,
      },
    ],
    fitScore: 1,
    readabilityScore: 1,
    safetyScore: 1,
  };
}

const bubble = {
  id: 'bubble-1' as BubbleId,
  polygon: {
    coordinateSpace: space,
    points: [
      { x: 0, y: 0, coordinateSpace: space },
      { x: 200, y: 0, coordinateSpace: space },
      { x: 200, y: 80, coordinateSpace: space },
      { x: 0, y: 80, coordinateSpace: space },
    ],
  },
};

async function makePage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 80,
      channels: 3,
      background: '#ffffff',
    },
  })
    .png()
    .toBuffer();
}

/** Count ink pixels that differ from the white page (any glyph color). */
async function inkPixels(frame: Buffer): Promise<number> {
  const { data, info } = await sharp(frame)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r < 240 || g < 240 || b < 240) ink += 1;
  }
  return ink;
}

describe('exported frame typewriter audit (pixel-level)', () => {
  it('progressive ink across the cue (not a full dump at start)', async () => {
    const words = [
      { text: 'The', start: 1.0, end: 1.2 },
      { text: 'city', start: 1.2, end: 1.4 },
      { text: 'is', start: 1.4, end: 1.55 },
      { text: 'under', start: 1.55, end: 1.75 },
      { text: 'attack!', start: 1.75, end: 2.0 },
    ];
    const caption = {
      id: 'cue-1',
      bubbleId: 'bubble-1' as BubbleId,
      caption: 'The city is under attack!',
      layout: multiWordLayout(),
      start: 1,
      end: 2,
      mappingConfidence: 0.95,
      mapped: true,
      confidence: 0.95,
      words,
    };
    const sourceImage = await makePage();
    const engine = new RenderingEngine();
    const times = [0.5, 1.05, 1.35, 1.9, 2.5];
    const counts: number[] = [];
    for (const time of times) {
      const frame = await engine.renderFrame({
        sourceImage,
        captions: [caption],
        bubbles: [bubble],
        time,
        format: 'png',
      });
      counts.push(await inkPixels(frame));
    }
    console.log('ink pixels at t=', times, '=>', counts);
    const [before, first, mid, almost, after] = counts;
    expect(before).toBe(0);
    expect(first!).toBeGreaterThan(0);
    expect(mid!).toBeGreaterThan(first!);
    expect(almost!).toBeGreaterThan(mid!);
    // Completed text persists after the cue (allow tiny AA variance).
    expect(Math.abs(after! - almost!)).toBeLessThanOrEqual(
      Math.max(4, almost! * 0.05),
    );
    expect(first!).toBeLessThan(almost! * 0.85);
  });

  it('collapsed word timings still reveal progressively (no full dump)', async () => {
    const collapsed = [
      { text: 'The', start: 1.0, end: 2.0 },
      { text: 'city', start: 1.0, end: 2.0 },
      { text: 'is', start: 1.0, end: 2.0 },
      { text: 'under', start: 1.0, end: 2.0 },
      { text: 'attack!', start: 1.0, end: 2.0 },
    ];
    const caption = {
      id: 'cue-1',
      bubbleId: 'bubble-1' as BubbleId,
      caption: 'The city is under attack!',
      layout: multiWordLayout(),
      start: 1,
      end: 2,
      mappingConfidence: 0.95,
      mapped: true,
      confidence: 0.95,
      words: collapsed,
    };
    const sourceImage = await makePage();
    const engine = new RenderingEngine();
    const early = await engine.renderFrame({
      sourceImage,
      captions: [caption],
      bubbles: [bubble],
      time: 1.05,
      format: 'png',
    });
    const late = await engine.renderFrame({
      sourceImage,
      captions: [caption],
      bubbles: [bubble],
      time: 1.95,
      format: 'png',
    });
    const a = await inkPixels(early);
    const b = await inkPixels(late);
    console.log('collapsed-timing ink early/late', a, b);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeLessThan(b * 0.85);
  });

  it('other bubble stays empty until its own cue', () => {
    const other: CaptionLayout = {
      ...multiWordLayout(),
      id: 'layout-2',
      bubbleId: 'bubble-2' as BubbleId,
      text: 'Hold the line!',
      lines: ['Hold the line!'],
      linePlacements: [
        {
          text: 'Hold the line!',
          position: { x: 10, y: 50, coordinateSpace: space },
          baselineY: 68,
          widthPx: 180,
          heightPx: 18,
          availableSpanPx: 180,
        },
      ],
    };
    const captions = [
      {
        id: 'c1',
        bubbleId: 'bubble-1' as BubbleId,
        caption: 'The city is under attack!',
        layout: multiWordLayout(),
        start: 1,
        end: 2,
        mappingConfidence: 1,
        mapped: true,
        confidence: 1,
      },
      {
        id: 'c2',
        bubbleId: 'bubble-2' as BubbleId,
        caption: 'Hold the line!',
        layout: other,
        start: 3,
        end: 4,
        mappingConfidence: 1,
        mapped: true,
        confidence: 1,
      },
    ];
    const svgEarly = renderTimedCaptionLayerSvg(
      200,
      80,
      timedCaptionLayoutsFromExport(captions),
      1.5,
      { reusePolicy: 'replace', fadeInSeconds: 0 },
    );
    expect(svgEarly).toContain('data-caption-id="layout-1"');
    expect(svgEarly).not.toContain('data-caption-id="layout-2"');
    const svgLate = renderTimedCaptionLayerSvg(
      200,
      80,
      timedCaptionLayoutsFromExport(captions),
      3.2,
      { reusePolicy: 'replace', fadeInSeconds: 0 },
    );
    expect(svgLate).toContain('data-caption-id="layout-2"');
  });
});
