import type { CaptionLayout } from '@comic-captioner/core';
import { createImageSpace } from '@comic-captioner/shared';
import type { ComicFixtureGroundTruth } from './suite.js';

export interface CaptionVisualCase {
  readonly id: string;
  readonly fixture: string;
  readonly captions: readonly Readonly<{
    bubbleId: string;
    lines: readonly string[];
    fontFamily?: string;
  }>[];
}

export const CAPTION_VISUAL_CASES: readonly CaptionVisualCase[] = [
  {
    id: 'simple-rounded',
    fixture: 'simple',
    captions: [{ bubbleId: 'bubble-1', lines: ['HELLO'] }],
  },
  {
    id: 'ellipse-centered',
    fixture: 'ellipse',
    captions: [{ bubbleId: 'bubble-1', lines: ['STAY CLOSE'] }],
  },
  {
    id: 'irregular-tail',
    fixture: 'irregular',
    captions: [{ bubbleId: 'bubble-1', lines: ['LOOK OUT!'] }],
  },
  {
    id: 'multiple-bubbles',
    fixture: 'multiple-bubbles',
    captions: [
      { bubbleId: 'bubble-1', lines: ['READY?'] },
      { bubbleId: 'bubble-2', lines: ['YES!'] },
    ],
  },
  {
    id: 'long-dialogue-lines',
    fixture: 'long-dialogue',
    captions: [
      {
        bubbleId: 'bubble-1',
        lines: [
          'WE SHOULD TAKE THE NORTH ROAD',
          'BEFORE THE STORM REACHES',
          'THE VALLEY',
        ],
      },
    ],
  },
  {
    id: 'difficult-lettering',
    fixture: 'difficult-lettering',
    captions: [
      { bubbleId: 'bubble-1', lines: ['KRAK!!'], fontFamily: 'DejaVu Serif' },
    ],
  },
];

export function createVisualLayouts(
  truth: ComicFixtureGroundTruth,
  testCase: CaptionVisualCase,
): readonly CaptionLayout[] {
  const space = createImageSpace(
    truth.coordinateSpace.id,
    truth.dimensions.width,
    truth.dimensions.height,
  );
  return testCase.captions.map((caption, captionIndex) => {
    const region = truth.expected.textRegions.find(
      (item) => item.bubbleId === caption.bubbleId,
    );
    if (!region)
      throw new Error(
        `Visual case ${testCase.id} refers to unknown bubble ${caption.bubbleId}.`,
      );
    const box = region.boundingBox;
    const longestLine = Math.max(...caption.lines.map((line) => line.length));
    const fontSizePx = Math.max(
      10,
      Math.min(
        (box.height * 0.66) / caption.lines.length,
        box.width / (longestLine * 0.62),
      ),
    );
    const lineHeight = fontSizePx * 1.2;
    const blockHeight = caption.lines.length * lineHeight;
    const top = box.y + (box.height - blockHeight) / 2;
    const horizontalInset = box.width * 0.04;
    const linePlacements = caption.lines.map((text, index) => {
      const y = top + index * lineHeight;
      return {
        text,
        position: { x: box.x + horizontalInset, y, coordinateSpace: space },
        baselineY: y + fontSizePx,
        widthPx: box.width - horizontalInset * 2,
        heightPx: fontSizePx,
        availableSpanPx: box.width - horizontalInset * 2,
      };
    });
    return {
      id: `visual:${testCase.id}:${captionIndex}`,
      bubbleId: caption.bubbleId as CaptionLayout['bubbleId'],
      text: caption.lines.join(' '),
      lines: caption.lines,
      placement: {
        coordinateSpace: space,
        points: [
          { x: box.x, y: box.y, coordinateSpace: space },
          { x: box.x + box.width, y: box.y, coordinateSpace: space },
          {
            x: box.x + box.width,
            y: box.y + box.height,
            coordinateSpace: space,
          },
          { x: box.x, y: box.y + box.height, coordinateSpace: space },
        ],
      },
      position: { x: box.x, y: top, coordinateSpace: space },
      widthPx: box.width,
      heightPx: blockHeight,
      fontFamily: caption.fontFamily ?? 'DejaVu Sans',
      fontSizePx,
      alignment: 'center',
      lineSpacingPx: lineHeight - fontSizePx,
      linePlacements,
      fitScore: 1,
      readabilityScore: 1,
      safetyScore: 1,
    };
  });
}
