import ClipperLib from 'clipper-lib';
import type { ImageSpace, Polygon } from '@comic-captioner/shared';

const INTEGER_SCALE = 1000;

export class BubbleGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BubbleGeometryError';
  }
}

/** Boolean-union overlapping bubble regions without replacing them by a box. */
export function unionBubblePolygons(
  polygons: readonly Polygon<ImageSpace>[],
): Polygon<ImageSpace> {
  if (polygons.length < 2)
    throw new BubbleGeometryError('Select at least two bubbles to merge.');
  const space = polygons[0]!.coordinateSpace;
  if (
    polygons.some(
      (polygon) =>
        polygon.coordinateSpace.id !== space.id || polygon.points.length < 3,
    )
  )
    throw new BubbleGeometryError(
      'Selected bubbles must use the same page coordinate space.',
    );
  const clipper = new ClipperLib.Clipper();
  if (
    !clipper.AddPaths(
      polygons.map((polygon) => toClipperPath(polygon.points)),
      ClipperLib.PolyType.ptSubject,
      true,
    )
  )
    throw new BubbleGeometryError('The selected bubble outlines are invalid.');
  const solution: { X: number; Y: number }[][] = [];
  if (
    !clipper.Execute(
      ClipperLib.ClipType.ctUnion,
      solution,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero,
    )
  )
    throw new BubbleGeometryError(
      'The selected bubble outlines could not merge.',
    );
  const outerPaths = solution.filter((path) => signedArea(path) > 0);
  if (outerPaths.length !== 1)
    throw new BubbleGeometryError(
      'Only touching or overlapping regions can merge into one bubble.',
    );
  return fromClipperPath(outerPaths[0]!, space);
}

/** Split a region down its image-space vertical midpoint using polygon clipping. */
export function splitBubblePolygon(
  polygon: Polygon<ImageSpace>,
): readonly [Polygon<ImageSpace>, Polygon<ImageSpace>] {
  if (polygon.points.length < 3)
    throw new BubbleGeometryError('The bubble outline cannot be split.');
  const left = Math.min(...polygon.points.map((point) => point.x));
  const right = Math.max(...polygon.points.map((point) => point.x));
  const top = Math.min(...polygon.points.map((point) => point.y));
  const bottom = Math.max(...polygon.points.map((point) => point.y));
  const splitX = (left + right) / 2;
  const margin = Math.max(right - left, bottom - top, 1) + 1;
  const subject = toClipperPath(polygon.points);
  const halves = [
    [
      { x: left - margin, y: top - margin },
      { x: splitX, y: top - margin },
      { x: splitX, y: bottom + margin },
      { x: left - margin, y: bottom + margin },
    ],
    [
      { x: splitX, y: top - margin },
      { x: right + margin, y: top - margin },
      { x: right + margin, y: bottom + margin },
      { x: splitX, y: bottom + margin },
    ],
  ];
  const result = halves.map((half) => {
    const clipper = new ClipperLib.Clipper();
    clipper.AddPath(subject, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(toClipperPath(half), ClipperLib.PolyType.ptClip, true);
    const solution: { X: number; Y: number }[][] = [];
    if (
      !clipper.Execute(
        ClipperLib.ClipType.ctIntersection,
        solution,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero,
      )
    )
      throw new BubbleGeometryError('The bubble could not be divided.');
    const components = solution.filter((path) => signedArea(path) > 0);
    if (components.length !== 1 || Math.abs(signedArea(components[0]!)) < 1)
      throw new BubbleGeometryError(
        'The midpoint split does not produce two single connected regions.',
      );
    return fromClipperPath(components[0]!, polygon.coordinateSpace);
  });
  return [result[0]!, result[1]!];
}

function toClipperPath(points: readonly { x: number; y: number }[]) {
  return points.map((point) => ({
    X: Math.round(point.x * INTEGER_SCALE),
    Y: Math.round(point.y * INTEGER_SCALE),
  }));
}

function fromClipperPath(
  path: { X: number; Y: number }[],
  coordinateSpace: ImageSpace,
): Polygon<ImageSpace> {
  const points = path.map((point) => ({
    x: point.X / INTEGER_SCALE,
    y: point.Y / INTEGER_SCALE,
    coordinateSpace,
  }));
  return Object.freeze({
    coordinateSpace,
    points: Object.freeze(points.map((point) => Object.freeze(point))),
  });
}

function signedArea(path: { X: number; Y: number }[]): number {
  let area = 0;
  for (let index = 0; index < path.length; index += 1) {
    const current = path[index]!;
    const next = path[(index + 1) % path.length]!;
    area += current.X * next.Y - next.X * current.Y;
  }
  return area / 2;
}
