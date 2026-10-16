import { describe, expect, it } from 'vitest';
import {
  activeWordAt,
  cueProgress,
  durationInFrames,
  frameToSeconds,
  isCueVisibleAt,
  isCueVisibleAtFrame,
  mapWordsToLines,
  secondsToFrame,
  visibleWordsAt,
} from '../../packages/video-composer/src/timing.js';
import {
  assertValidVideoComposition,
  validateVideoComposition,
} from '../../packages/video-composer/src/validate.js';
import { VideoCompositionError } from '../../packages/video-composer/src/types.js';
import type {
  CaptionCue,
  MotionComicVideoProps,
  PageInput,
} from '../../packages/video-composer/src/types.js';
import {
  DEFAULT_CAMERA,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FALLBACK_PLACEMENT,
  DEFAULT_TRANSITIONS,
} from '../../packages/video-composer/src/defaults.js';
import {
  bubbleSafeRect,
  insetRect,
  pageAtTime,
  pagePlacement,
  pointInPolygon,
} from '../../packages/video-composer/src/geometry.js';
import {
  compositionPropsFromExportPayload,
  cuesFromExportCaptions,
} from '../../packages/video-composer/src/converters.js';

function baseProps(
  overrides: Partial<MotionComicVideoProps> = {},
): MotionComicVideoProps {
  return {
    pages: [
      {
        id: 'page-1',
        imageUrl: 'data:image/png;base64,AA==',
        width: 200,
        height: 200,
        startSeconds: 0,
        endSeconds: 10,
        bubbles: [
          {
            id: 'bubble-1',
            polygon: [
              { x: 10, y: 10 },
              { x: 100, y: 10 },
              { x: 100, y: 100 },
              { x: 10, y: 100 },
            ],
          },
        ],
      },
    ],
    audioUrl:
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
    cues: [],
    width: 640,
    height: 360,
    fps: 24,
    durationSeconds: 10,
    captionStyle: DEFAULT_CAPTION_STYLE,
    camera: DEFAULT_CAMERA,
    transitions: DEFAULT_TRANSITIONS,
    fallbackPlacement: DEFAULT_FALLBACK_PLACEMENT,
    backgroundColor: '#000000',
    ...overrides,
  };
}

function baseCue(overrides: Partial<CaptionCue> = {}): CaptionCue {
  return {
    id: 'cue-1',
    bubbleId: 'bubble-1',
    text: 'Hello world',
    startSeconds: 1,
    endSeconds: 3,
    words: [
      { text: 'Hello', startSeconds: 1, endSeconds: 1.5 },
      { text: 'world', startSeconds: 1.5, endSeconds: 3 },
    ],
    ...overrides,
  };
}

describe('timestamp-to-frame conversion', () => {
  it('converts duration and timestamps deterministically', () => {
    expect(durationInFrames(1, 24)).toBe(24);
    expect(durationInFrames(0.5, 24)).toBe(12);
    expect(frameToSeconds(24, 24)).toBe(1);
    expect(secondsToFrame(1, 24)).toBe(24);
    expect(() => durationInFrames(0, 24)).toThrow(RangeError);
    expect(() => durationInFrames(1, 0)).toThrow(RangeError);
  });

  it('uses half-open cue intervals for visibility', () => {
    const cue = { startSeconds: 1, endSeconds: 2 };
    expect(isCueVisibleAt(cue, 1)).toBe(true);
    expect(isCueVisibleAt(cue, 1.999)).toBe(true);
    expect(isCueVisibleAt(cue, 2)).toBe(false);
    expect(isCueVisibleAtFrame(cue, 24, 24)).toBe(true);
    expect(isCueVisibleAtFrame(cue, 48, 24)).toBe(false);
    expect(cueProgress(cue, 1.5)).toBeCloseTo(0.5);
    expect(cueProgress(cue, 0)).toBe(0);
  });

  it('reveals words progressively and picks the active karaoke word', () => {
    const words = [
      { text: 'one', startSeconds: 0, endSeconds: 0.5 },
      { text: 'two', startSeconds: 0.5, endSeconds: 1 },
    ];
    expect(visibleWordsAt(words, 0.2).map((w) => w.text)).toEqual(['one']);
    expect(visibleWordsAt(words, 0.6).map((w) => w.text)).toEqual([
      'one',
      'two',
    ]);
    expect(activeWordAt(words, 0.7)?.text).toBe('two');
    expect(activeWordAt(words, 2)).toBeNull();
  });

  it('maps timed words onto fitted caption lines', () => {
    const spans = mapWordsToLines(
      ['Hello world', 'again'],
      [
        { text: 'Hello', startSeconds: 0, endSeconds: 0.2 },
        { text: 'world', startSeconds: 0.2, endSeconds: 0.4 },
        { text: 'again', startSeconds: 0.4, endSeconds: 0.6 },
      ],
    );
    expect(spans.map((span) => [span.lineIndex, span.text])).toEqual([
      [0, 'Hello'],
      [0, 'world'],
      [1, 'again'],
    ]);
  });
});

describe('composition input validation', () => {
  it('accepts a well-formed composition', () => {
    const report = validateVideoComposition(baseProps({ cues: [baseCue()] }));
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('reports missing assets and malformed timestamps', () => {
    const report = validateVideoComposition(
      baseProps({
        audioUrl: '',
        pages: [
          {
            id: 'p',
            imageUrl: '',
            width: 10,
            height: -1,
            startSeconds: 5,
            endSeconds: 2,
            bubbles: [],
          } as PageInput,
        ],
        cues: [
          baseCue({
            startSeconds: -1,
            endSeconds: -2,
            words: [{ text: 'x', startSeconds: 9, endSeconds: 10 }],
          }),
        ],
      }),
    );
    expect(report.valid).toBe(false);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('missing-asset');
    expect(codes).toContain('invalid-dimensions');
    expect(codes).toContain('malformed-timestamp');
  });

  it('rejects invalid bubble coordinates and unknown bubbles', () => {
    const report = validateVideoComposition(
      baseProps({
        pages: [
          {
            id: 'page-1',
            imageUrl: 'data:image/png;base64,AA==',
            width: 200,
            height: 200,
            startSeconds: 0,
            endSeconds: 10,
            bubbles: [
              {
                id: 'bubble-1',
                polygon: [
                  { x: Number.NaN, y: 10 },
                  { x: 100, y: 10 },
                  { x: 100, y: 100 },
                ],
              },
            ],
          },
        ],
        cues: [baseCue({ bubbleId: 'missing-bubble' })],
      }),
    );
    expect(report.valid).toBe(false);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain('invalid-coordinates');
    expect(codes).toContain('unknown-bubble');
  });

  it('flags cues that end after the composition duration', () => {
    const report = validateVideoComposition(
      baseProps({
        durationSeconds: 2,
        cues: [baseCue({ startSeconds: 1, endSeconds: 5 })],
      }),
    );
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(
      'cue-out-of-range',
    );
  });

  it('throws a typed error from assertValidVideoComposition', () => {
    expect(() => assertValidVideoComposition(baseProps({ width: 15 }))).toThrow(
      VideoCompositionError,
    );
    try {
      assertValidVideoComposition(baseProps({ fps: 0 }));
    } catch (error) {
      expect(error).toBeInstanceOf(VideoCompositionError);
      expect((error as VideoCompositionError).issues[0]?.code).toBe(
        'invalid-fps',
      );
    }
  });
});

describe('bubble geometry and fallback placement', () => {
  it('insets bubble interiors and keeps polygons usable', () => {
    const page = baseProps().pages[0]!;
    const bubble = page.bubbles[0]!;
    const safe = bubbleSafeRect(bubble, 5);
    expect(safe.width).toBeLessThan(90);
    expect(pointInPolygon(50, 50, bubble.polygon)).toBe(true);
    expect(pointInPolygon(500, 50, bubble.polygon)).toBe(false);
    const inset = insetRect({ x: 0, y: 0, width: 10, height: 10 }, 8);
    expect(inset.width).toBeGreaterThan(0);
  });

  it('letterboxes the page and does not crop', () => {
    const placement = pagePlacement(200, 400, 100, 100);
    expect(placement.width).toBe(50);
    expect(placement.height).toBe(100);
    expect(placement.offsetX).toBe(25);
    expect(placement.offsetY).toBe(0);
  });

  it('selects the active page by half-open interval', () => {
    const pages = [
      {
        id: 'a',
        imageUrl: 'a',
        width: 1,
        height: 1,
        startSeconds: 0,
        endSeconds: 2,
        bubbles: [],
      },
      {
        id: 'b',
        imageUrl: 'b',
        width: 1,
        height: 1,
        startSeconds: 2,
        endSeconds: 4,
        bubbles: [],
      },
    ] satisfies PageInput[];
    expect(pageAtTime(pages, 1)?.id).toBe('a');
    expect(pageAtTime(pages, 2)?.id).toBe('b');
    expect(pageAtTime(pages, 9)?.id).toBe('b');
  });
});

describe('export payload converters', () => {
  it('maps export captions into timed cues with fitted layouts', () => {
    const cues = cuesFromExportCaptions([
      {
        id: 'c1',
        bubbleId: 'bubble-1',
        caption: 'Hi there',
        start: 0.5,
        end: 2,
        words: [
          { text: 'Hi', start: 0.5, end: 1 },
          { text: 'there', start: 1, end: 2 },
        ],
        layout: {
          fontFamily: 'Arial',
          fontSizePx: 20,
          lineSpacingPx: 4,
          alignment: 'center',
          lines: [
            {
              text: 'Hi there',
              position: { x: 10, y: 20 },
              baselineY: 36,
              widthPx: 80,
              heightPx: 20,
            },
          ],
        },
      },
    ]);
    expect(cues[0]?.words).toHaveLength(2);
    expect(cues[0]?.layout?.lines[0]?.x).toBe(10);
    expect(cues[0]?.startSeconds).toBe(0.5);
  });

  it('builds full composition props from an export payload', () => {
    const props = compositionPropsFromExportPayload({
      pageImage: { url: 'data:image/png;base64,AA==', width: 100, height: 100 },
      audioUrl:
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
      captions: [],
      bubbles: [
        {
          id: 'bubble-1',
          polygon: {
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 1 },
              { x: 2, y: 2 },
            ],
          },
        },
      ],
      width: 640,
      height: 360,
      fps: 24,
      durationSeconds: 3,
    });
    expect(props.pages[0]?.bubbles[0]?.id).toBe('bubble-1');
    expect(props.cues).toEqual([]);
    expect(props.captionStyle.revealMode).toBe('phrase');
    expect(props.camera.enabled).toBe(false);
  });
});
