import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  associateTextRegionsToBubbles,
  matchOcrBoxToTextRegion,
  TextBubbleAssociationError,
} from '../../packages/bubble-engine/src/text-region-association.js';

const space = createImageSpace('assoc-test', 400, 300);

function box(
  x: number,
  y: number,
  width: number,
  height: number,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: typeof space;
} {
  return { x, y, width, height, coordinateSpace: space };
}

function rectPolygon(
  x: number,
  y: number,
  width: number,
  height: number,
): {
  coordinateSpace: typeof space;
  points: readonly { x: number; y: number; coordinateSpace: typeof space }[];
} {
  return {
    coordinateSpace: space,
    points: [
      { x, y, coordinateSpace: space },
      { x: x + width, y, coordinateSpace: space },
      { x: x + width, y: y + height, coordinateSpace: space },
      { x, y: y + height, coordinateSpace: space },
    ],
  };
}

const speechBubble = {
  id: 'bubble-speech',
  boundingBox: box(40, 40, 120, 80),
  polygon: rectPolygon(40, 40, 120, 80),
  detectionConfidence: 0.91,
};

const secondBubble = {
  id: 'bubble-second',
  boundingBox: box(220, 40, 120, 80),
  polygon: rectPolygon(220, 40, 120, 80),
  detectionConfidence: 0.88,
};

describe('associateTextRegionsToBubbles', () => {
  it('assigns text inside a bubble with association confidence only', () => {
    const result = associateTextRegionsToBubbles(
      [{ id: 'text-1', boundingBox: box(55, 55, 60, 20) }],
      [speechBubble, secondBubble],
    );
    expect(result.associations).toHaveLength(1);
    const match = result.associations[0]!;
    expect(match.bubbleId).toBe('bubble-speech');
    expect(match.classification).toBe('dialogue');
    expect(match.confidence).toBeGreaterThan(0.5);
    // Association confidence is independent of detection confidence.
    expect(match.confidence).not.toBe(speechBubble.detectionConfidence);
    expect(result.bubblesWithoutTextIds).toEqual(['bubble-second']);
    expect(result.meanAssociationConfidence).toBeGreaterThan(0);
  });

  it('keeps multiple text lines assignable to one bubble', () => {
    const result = associateTextRegionsToBubbles(
      [
        { id: 'line-a', boundingBox: box(55, 55, 50, 14) },
        { id: 'line-b', boundingBox: box(55, 80, 55, 14) },
      ],
      [speechBubble],
    );
    expect(result.associations).toHaveLength(2);
    expect(result.associations.every((item) => item.bubbleId === 'bubble-speech')).toBe(
      true,
    );
  });

  it('supports multiple bubbles without cross-assigning far text', () => {
    const result = associateTextRegionsToBubbles(
      [
        { id: 'left', boundingBox: box(55, 55, 40, 14) },
        { id: 'right', boundingBox: box(240, 55, 40, 14) },
      ],
      [speechBubble, secondBubble],
    );
    const left = result.associations.find((item) => item.textRegionId === 'left');
    const right = result.associations.find((item) => item.textRegionId === 'right');
    expect(left?.bubbleId).toBe('bubble-speech');
    expect(right?.bubbleId).toBe('bubble-second');
  });

  it('preserves outside text as non-dialogue rather than forcing a bubble', () => {
    const result = associateTextRegionsToBubbles(
      [{ id: 'caption', boundingBox: box(20, 270, 200, 16) }],
      [speechBubble],
    );
    expect(result.unassociatedTextRegionIds).toContain('caption');
    const match = result.associations[0]!;
    expect(match.bubbleId).toBeNull();
    expect(match.classification).toBe('non-dialogue');
    expect(match.needsReview).toBe(true);
  });

  it('marks competing bubble matches as ambiguous', () => {
    // Two identical overlapping bubble polygons produce a close score race.
    const twinA = {
      id: 'twin-a',
      boundingBox: box(40, 40, 100, 60),
      polygon: rectPolygon(40, 40, 100, 60),
    };
    const twinB = {
      id: 'twin-b',
      boundingBox: box(45, 45, 100, 60),
      polygon: rectPolygon(45, 45, 100, 60),
    };
    const result = associateTextRegionsToBubbles(
      [{ id: 'overlapping', boundingBox: box(60, 60, 30, 12) }],
      [twinA, twinB],
    );
    const match = result.associations[0]!;
    expect(match.classification).toBe('ambiguous');
    expect(match.needsReview).toBe(true);
    expect(match.alternatives.length).toBeGreaterThanOrEqual(2);
  });

  it('handles irregular balloon shapes via polygon containment', () => {
    const diamond = {
      id: 'diamond',
      boundingBox: box(50, 50, 100, 100),
      polygon: {
        coordinateSpace: space,
        points: [
          { x: 100, y: 50, coordinateSpace: space },
          { x: 150, y: 100, coordinateSpace: space },
          { x: 100, y: 150, coordinateSpace: space },
          { x: 50, y: 100, coordinateSpace: space },
        ],
      },
    };
    const inside = associateTextRegionsToBubbles(
      [{ id: 'center', boundingBox: box(90, 90, 20, 12) }],
      [diamond],
    );
    expect(inside.associations[0]!.bubbleId).toBe('diamond');

    const outsideCorner = associateTextRegionsToBubbles(
      [{ id: 'corner', boundingBox: box(52, 52, 12, 8) }],
      [diamond],
    );
    // Corner of the bbox is outside the diamond polygon.
    expect(outsideCorner.associations[0]!.bubbleId).toBeNull();
  });

  it('returns empty structure when there are no bubbles or regions', () => {
    const empty = associateTextRegionsToBubbles([], []);
    expect(empty.associations).toEqual([]);
    expect(empty.meanAssociationConfidence).toBe(0);
    expect(empty.bubblesWithoutTextIds).toEqual([]);
  });

  it('rejects malformed geometry and options', () => {
    expect(() =>
      associateTextRegionsToBubbles(
        [{ id: '', boundingBox: box(0, 0, 10, 10) }],
        [speechBubble],
      ),
    ).toThrow(TextBubbleAssociationError);
    expect(() =>
      associateTextRegionsToBubbles(
        [{ id: 'ok', boundingBox: box(0, 0, 0, 10) }],
        [speechBubble],
      ),
    ).toThrow(TextBubbleAssociationError);
    expect(() =>
      associateTextRegionsToBubbles(
        [{ id: 'ok', boundingBox: box(0, 0, 10, 10) }],
        [{ ...speechBubble, polygon: { coordinateSpace: space, points: [] } }],
      ),
    ).toThrow(TextBubbleAssociationError);
    expect(() =>
      associateTextRegionsToBubbles(
        [{ id: 'ok', boundingBox: box(0, 0, 10, 10) }],
        [speechBubble],
        { minimumScore: 2 },
      ),
    ).toThrow(TextBubbleAssociationError);
  });

  it('scores OCR overlap with geometric coverage only', () => {
    const region = { id: 'r', boundingBox: box(50, 50, 40, 20) };
    const inside = matchOcrBoxToTextRegion(box(55, 55, 20, 10), region);
    const partial = matchOcrBoxToTextRegion(box(80, 50, 20, 20), region);
    const outside = matchOcrBoxToTextRegion(box(200, 200, 10, 10), region);
    expect(inside).toBeGreaterThan(0.8);
    expect(partial).toBeLessThan(0.6);
    expect(partial).toBeGreaterThan(0);
    expect(outside).toBe(0);
  });
});
