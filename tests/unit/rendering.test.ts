import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { CaptionLayout } from '@comic-captioner/core';
import type { BubbleId, CoordinateSpaceId } from '@comic-captioner/shared';
import {
  ExportValidationError,
  renderCaptionLayerSvg,
  renderDebugLayerSvg,
  RenderingEngine,
  validateFrameExport,
  captionMotionAtTime,
} from '@comic-captioner/rendering';

const space = {
  id: 'image:test-render' as CoordinateSpaceId,
  kind: 'image' as const,
  dimensions: { width: 16, height: 16 },
};
function layout(text: string): CaptionLayout {
  return {
    id: 'layout-1',
    bubbleId: 'bubble-1' as BubbleId,
    text,
    lines: [text],
    placement: { points: [], coordinateSpace: space },
    position: { x: 2, y: 2, coordinateSpace: space },
    widthPx: 12,
    heightPx: 8,
    fontFamily: 'DejaVu Sans',
    fontSizePx: 6,
    alignment: 'left',
    lineSpacingPx: 0,
    linePlacements: [
      {
        text,
        position: { x: 2, y: 2, coordinateSpace: space },
        baselineY: 8,
        widthPx: 12,
        heightPx: 6,
        availableSpanPx: 12,
      },
    ],
    fitScore: 1,
    readabilityScore: 1,
    safetyScore: 1,
  };
}

describe('layered rendering primitives', () => {
  it('creates a deterministic audio-paced entrance and exit transform', () => {
    expect(captionMotionAtTime(2, 4, 2)).toEqual({ opacity: 0, scale: 0.96 });
    expect(captionMotionAtTime(2, 4, 2.22)).toEqual({ opacity: 1, scale: 1 });
    expect(captionMotionAtTime(2, 4, 4)).toEqual({ opacity: 0, scale: 1 });
    expect(captionMotionAtTime(2, 4, 2.22)).toEqual(
      captionMotionAtTime(2, 4, 2.22),
    );
    expect(() => captionMotionAtTime(3, 2, 2)).toThrow(RangeError);
  });

  it('produces stable SVG layers from the fitted CaptionLayout and escapes user text', () => {
    expect(renderCaptionLayerSvg(16, 16, [layout('<Hi>')])).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g data-bubble-id="bubble-1" fill="#111111"><text x="2" y="8" text-anchor="start" font-family="DejaVu Sans" font-size="6">&lt;Hi&gt;</text></g></svg>',
    );
    expect(renderCaptionLayerSvg(16, 16, [layout('Edited')])).not.toBe(
      renderCaptionLayerSvg(16, 16, [layout('Original')]),
    );
  });

  it('applies motion to the caption group while preserving the fitted line geometry', () => {
    const svg = renderCaptionLayerSvg(16, 16, [layout('Hello')], {
      opacity: 0.5,
      scale: 0.98,
    });
    expect(svg).toContain(
      'opacity="0.5" transform="translate(8 6) scale(0.98) translate(-8 -6)"',
    );
    expect(svg).toContain('y="8"');
  });

  it('renderFrame reveals words progressively instead of dumping the full line', async () => {
    const source = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
    const bubble = {
      id: 'bubble-1' as BubbleId,
      polygon: {
        points: [
          { x: 0, y: 0 },
          { x: 16, y: 0 },
          { x: 16, y: 16 },
          { x: 0, y: 16 },
        ],
        coordinateSpace: space,
      },
    };
    const multiWord = layout('One two three four');
    const engine = new RenderingEngine();
    const early = await engine.renderFrame({
      sourceImage: source,
      captions: [
        {
          id: 'cue-1',
          bubbleId: bubble.id,
          caption: 'One two three four',
          layout: multiWord,
          start: 1,
          end: 2,
          mappingConfidence: 0.9,
          mapped: true,
          confidence: 0.9,
          words: [
            { text: 'One', start: 1, end: 1.2 },
            { text: 'two', start: 1.2, end: 1.4 },
            { text: 'three', start: 1.4, end: 1.7 },
            { text: 'four', start: 1.7, end: 2 },
          ],
        },
      ],
      bubbles: [bubble],
      time: 1.1,
      format: 'png',
    });
    const late = await engine.renderFrame({
      sourceImage: source,
      captions: [
        {
          id: 'cue-1',
          bubbleId: bubble.id,
          caption: 'One two three four',
          layout: multiWord,
          start: 1,
          end: 2,
          mappingConfidence: 0.9,
          mapped: true,
          confidence: 0.9,
          words: [
            { text: 'One', start: 1, end: 1.2 },
            { text: 'two', start: 1.2, end: 1.4 },
            { text: 'three', start: 1.4, end: 1.7 },
            { text: 'four', start: 1.7, end: 2 },
          ],
        },
      ],
      bubbles: [bubble],
      time: 1.9,
      format: 'png',
    });
    // Different reveal states must produce different frames.
    expect(Buffer.compare(early, late)).not.toBe(0);
    const earlyMeta = await sharp(early).metadata();
    expect(earlyMeta.width).toBe(16);
  });

  it('keeps debug geometry in its own SVG layer', () => {
    expect(
      renderDebugLayerSvg(16, 16, [
        {
          id: 'region',
          points: [
            { x: 1, y: 2 },
            { x: 5, y: 6 },
          ],
        },
      ]),
    ).toContain('data-overlay-id="region"');
  });

  it('composites export using the shared caption primitive and preserves page dimensions', async () => {
    const source = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const output = await new RenderingEngine().renderPng(source, [
      layout('Caption'),
    ]);
    const decoded = await sharp(output)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 16, height: 16, channels: 4 });
    expect(decoded.data.some((channel) => channel < 240)).toBe(true);
    const blankOutput = await new RenderingEngine().renderPng(source, []);
    const blank = await sharp(blankOutput).removeAlpha().raw().toBuffer();
    expect(blank).toEqual(await sharp(source).removeAlpha().raw().toBuffer());
  });

  it('validates every caption and renders only the timeline-active saved layout', async () => {
    const source = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const bubble = {
      id: 'bubble-1' as BubbleId,
      polygon: {
        coordinateSpace: space,
        points: [
          { x: 0, y: 0, coordinateSpace: space },
          { x: 15, y: 0, coordinateSpace: space },
          { x: 15, y: 15, coordinateSpace: space },
          { x: 0, y: 15, coordinateSpace: space },
        ],
      },
    };
    const validCaption = {
      id: 'cue-1',
      bubbleId: bubble.id,
      caption: 'First',
      layout: layout('First'),
      start: 0,
      end: 1,
      mappingConfidence: 0.9,
      mapped: true,
      confidence: 0.9,
    } as const;
    const inactiveCaption = {
      ...validCaption,
      id: 'cue-2',
      caption: 'Later',
      layout: layout('Later'),
      start: 2,
      end: 3,
    } as const;
    const engine = new RenderingEngine();
    const frame = await engine.renderFrame({
      sourceImage: source,
      captions: [validCaption, inactiveCaption],
      bubbles: [bubble],
      time: 0.5,
      format: 'jpeg',
    });
    expect((await sharp(frame).metadata()).format).toBe('jpeg');
    expect((await sharp(frame).metadata()).width).toBe(16);

    const invalid = {
      ...validCaption,
      id: 'bad',
      mapped: false,
      start: null,
      end: null,
      mappingConfidence: 0.1,
      confidence: 0.2,
      layout: {
        ...layout('Bad'),
        readabilityScore: 0.1,
        linePlacements: [
          {
            ...layout('Bad').linePlacements[0]!,
            position: { ...layout('Bad').linePlacements[0]!.position, x: 14 },
          },
        ],
      },
    };
    const report = validateFrameExport([validCaption, invalid], [bubble]);
    expect(report.valid).toBe(false);
    expect(
      new Set(
        report.issues
          .filter((issue) => issue.captionId === 'bad')
          .map((issue) => issue.code),
      ),
    ).toEqual(
      new Set([
        'missing-mapping',
        'missing-timing',
        'low-readability',
        'low-confidence',
        'overflow',
      ]),
    );
    await expect(
      engine.renderFrame({
        sourceImage: source,
        captions: [validCaption, invalid],
        bubbles: [bubble],
        time: 0.5,
        format: 'png',
      }),
    ).rejects.toBeInstanceOf(ExportValidationError);
  });
});
