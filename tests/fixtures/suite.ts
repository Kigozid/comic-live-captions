export const COMIC_FIXTURE_NAMES = [
  'simple',
  'ellipse',
  'irregular',
  'multiple-bubbles',
  'overlapping',
  'cropped',
  'narration',
  'thought-bubble',
  'long-dialogue',
  'difficult-lettering',
] as const;

export interface FixturePoint {
  readonly x: number;
  readonly y: number;
}
export interface FixtureBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface ComicFixtureGroundTruth {
  readonly schemaVersion: 1;
  readonly id: (typeof COMIC_FIXTURE_NAMES)[number];
  readonly description: string;
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly coordinateSpace: {
    readonly id: string;
    readonly kind: 'image';
    readonly pixelCenters: 'integer';
    readonly origin: 'top-left';
    readonly xAxis: 'right';
    readonly yAxis: 'down';
  };
  readonly sourceFiles: {
    readonly original: 'original.png';
    readonly cleaned: 'cleaned.png';
  };
  readonly expected: {
    readonly bubbles: readonly {
      readonly id: string;
      readonly kind: 'speech' | 'thought' | 'narration';
      readonly polygon: readonly FixturePoint[];
      readonly boundingBox: FixtureBounds;
      readonly tail: readonly FixturePoint[] | null;
      readonly maskFile: string;
    }[];
    readonly textRegions: readonly {
      readonly id: string;
      readonly bubbleId: string;
      readonly boundingBox: FixtureBounds;
      readonly polygon: readonly FixturePoint[];
      readonly maskFile: string;
    }[];
    readonly ocr: readonly {
      readonly id: string;
      readonly bubbleId: string;
      readonly text: string;
      readonly confidence: number;
      readonly boundingBox: FixtureBounds;
      readonly coordinateSpaceId: string;
    }[];
    readonly dialogueMappings: readonly {
      readonly id: string;
      readonly transcriptSegmentId: string;
      readonly bubbleId: string;
      readonly confidence: number;
      readonly expectedIntervalSeconds: {
        readonly start: number;
        readonly end: number;
      };
    }[];
  };
}
