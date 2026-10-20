import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  fitCaptionIntoBox,
  orderCaptionBoxes,
} from '../../apps/web/src/caption-box-fit.js';
import { draftFromBoxes } from '../../apps/web/src/draft-from-boxes.js';

const space = createImageSpace('image:box-fit', 400, 300);

function box(id: string, x: number, y: number, w = 160, h = 80) {
  return {
    id,
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

describe('fitCaptionIntoBox', () => {
  it('centers wrapped lines inside the drawn container', () => {
    const layout = fitCaptionIntoBox(
      box('b1', 20, 20),
      'The city is under attack!',
      space,
    );
    expect(layout.bubbleId).toBe('b1');
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.linePlacements).toHaveLength(layout.lines.length);
    for (const line of layout.linePlacements) {
      expect(line.position.x).toBeGreaterThanOrEqual(20);
      expect(line.position.x + line.widthPx).toBeLessThanOrEqual(181);
      expect(line.baselineY).toBeGreaterThan(20);
      expect(line.baselineY).toBeLessThan(101);
    }
    expect(layout.fontSizePx).toBeGreaterThanOrEqual(10);
  });

  it('grows the font until the block fills a large box', () => {
    const small = fitCaptionIntoBox(box('s', 0, 0, 80, 40), 'Hi there', space);
    const large = fitCaptionIntoBox(box('l', 0, 0, 360, 200), 'Hi there', space);
    expect(large.fontSizePx).toBeGreaterThan(small.fontSizePx);
  });

  it('computes reading order top-to-bottom then LTR', () => {
    const boxes = [
      box('right', 200, 20),
      box('left', 20, 20),
      box('below', 20, 160),
    ];
    expect(orderCaptionBoxes(boxes).map((b) => b.id)).toEqual([
      'left',
      'right',
      'below',
    ]);
    expect(orderCaptionBoxes(boxes, 'rtl').map((b) => b.id)).toEqual([
      'right',
      'left',
      'below',
    ]);
  });
});

describe('draftFromBoxes', () => {
  it('assigns segments to boxes in order with fitted layouts and words', () => {
    const result = draftFromBoxes(
      [box('b1', 20, 20), box('b2', 20, 140)],
      [
        {
          id: 'seg-1',
          text: 'The city is under attack!',
          start: 1,
          end: 2,
          words: [
            { text: 'The', start: 1, end: 1.2 },
            { text: 'city', start: 1.2, end: 2 },
          ],
        },
        {
          id: 'seg-2',
          text: 'Hold the line!',
          start: 3,
          end: 4,
        },
      ],
      space,
    );
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments[0]!.bubbleId).toBe('b1');
    expect(result.assignments[0]!.words).toHaveLength(2);
    expect(result.assignments[1]!.bubbleId).toBe('b2');
    expect(result.layouts).toHaveLength(2);
    expect(result.unusedBoxIds).toHaveLength(0);
    expect(result.unassignedSegmentIds).toHaveLength(0);
  });

  it('reports extra boxes and unassigned segments', () => {
    const result = draftFromBoxes(
      [box('b1', 20, 20), box('b2', 20, 140)],
      [{ id: 'seg-1', text: 'Only one line', start: 0, end: 1 }],
      space,
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.unusedBoxIds).toEqual(['b2']);
    expect(result.unassignedSegmentIds).toHaveLength(0);
  });
});
