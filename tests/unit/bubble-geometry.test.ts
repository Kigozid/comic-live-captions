import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  splitBubblePolygon,
  unionBubblePolygons,
} from '../../apps/web/src/bubble-geometry.js';

const space = createImageSpace('bubble-geometry-test', 100, 100);

function polygon(
  points: readonly { readonly x: number; readonly y: number }[],
) {
  return {
    coordinateSpace: space,
    points: points.map((point) => ({ ...point, coordinateSpace: space })),
  };
}

function area(points: readonly { readonly x: number; readonly y: number }[]) {
  return Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]!;
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

describe('bubble region editing geometry', () => {
  it('merges overlapping regions by polygon union', () => {
    const merged = unionBubblePolygons([
      polygon([
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 30 },
        { x: 10, y: 30 },
      ]),
      polygon([
        { x: 20, y: 10 },
        { x: 40, y: 10 },
        { x: 40, y: 30 },
        { x: 20, y: 30 },
      ]),
    ]);
    expect(area(merged.points)).toBeCloseTo(600, 2);
    expect(Math.min(...merged.points.map((point) => point.x))).toBe(10);
    expect(Math.max(...merged.points.map((point) => point.x))).toBe(40);
  });

  it('refuses to merge disconnected regions into a misleading envelope', () => {
    expect(() =>
      unionBubblePolygons([
        polygon([
          { x: 5, y: 5 },
          { x: 15, y: 5 },
          { x: 15, y: 15 },
          { x: 5, y: 15 },
        ]),
        polygon([
          { x: 30, y: 30 },
          { x: 40, y: 30 },
          { x: 40, y: 40 },
          { x: 30, y: 40 },
        ]),
      ]),
    ).toThrow(
      'Only touching or overlapping regions can merge into one bubble.',
    );
  });

  it('splits an editable region into two source-space polygons', () => {
    const [left, right] = splitBubblePolygon(
      polygon([
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 30 },
        { x: 10, y: 30 },
      ]),
    );
    expect(area(left.points)).toBeCloseTo(200, 2);
    expect(area(right.points)).toBeCloseTo(200, 2);
    expect(left.points.every((point) => point.coordinateSpace === space)).toBe(
      true,
    );
    expect(right.points.every((point) => point.coordinateSpace === space)).toBe(
      true,
    );
  });
});
