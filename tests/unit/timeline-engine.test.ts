import { describe, expect, it } from 'vitest';
import type { CaptionLayout, DialogueEvent } from '@comic-captioner/core';
import { TimelineEngine, TimelineError } from '@comic-captioner/caption-engine';
import type {
  AudioTime,
  AudioTimebaseId,
  BubbleId,
  CoordinateSpaceId,
} from '@comic-captioner/shared';

const timebase = 'audio:timeline-test' as AudioTimebaseId;
const imageSpace = {
  id: 'image:timeline-test' as CoordinateSpaceId,
  kind: 'image' as const,
  dimensions: { width: 100, height: 100 },
};

function at(value: number): AudioTime {
  return { value, timebase, unit: 'seconds' };
}

function event(
  id: string,
  start: number,
  end: number,
  bubble = `bubble-${id}`,
): DialogueEvent {
  const bubbleId = bubble as BubbleId;
  const layout: CaptionLayout = {
    id: `layout-${id}`,
    bubbleId,
    text: `Caption ${id}`,
    lines: [`Caption ${id}`],
    placement: { points: [], coordinateSpace: imageSpace },
    position: { x: 0, y: 0, coordinateSpace: imageSpace },
    widthPx: 10,
    heightPx: 10,
    fontFamily: 'Test',
    fontSizePx: 10,
    alignment: 'center',
    lineSpacingPx: 0,
    linePlacements: [],
    fitScore: 1,
    readabilityScore: 1,
    safetyScore: 1,
  };
  return {
    id,
    bubbleId,
    caption: `Caption ${id}`,
    start: at(start),
    end: at(end),
    layout,
    confidence: 0.9,
  };
}

describe('TimelineEngine', () => {
  const engine = new TimelineEngine([
    event('first', 1, 3),
    event('second', 4, 5),
  ]);

  it('includes the segment start and excludes its end', () => {
    expect(engine.getActiveDialogue(at(1))?.id).toBe('first');
    expect(engine.getActiveDialogue(at(2.999))?.id).toBe('first');
    expect(engine.getActiveDialogue(at(3))).toBeNull();
  });

  it('returns null in gaps and at time before the first event', () => {
    expect(engine.getActiveDialogue(at(0))).toBeNull();
    expect(engine.getActiveDialogue(at(3.5))).toBeNull();
  });

  it('uses deterministic precedence for overlap, independent of input order', () => {
    const events = [
      event('early', 1, 5),
      event('latest', 2, 6),
      event('shortest', 2, 4),
    ];
    expect(new TimelineEngine(events).getActiveDialogue(at(2.5))?.id).toBe(
      'shortest',
    );
    expect(
      new TimelineEngine([...events].reverse()).getActiveDialogue(at(2.5))?.id,
    ).toBe('shortest');
    expect(
      new TimelineEngine([
        event('z', 1, 4),
        event('a', 1, 4),
      ]).getActiveDialogue(at(2))?.id,
    ).toBe('a');
  });

  it('remains deterministic for seeks, reverse playback, and rate changes', () => {
    const positions = [1, 2, 4.5, 3.5, 2, 1, 4, 5];
    expect(
      positions.map(
        (position) => engine.getActiveDialogue(at(position))?.id ?? null,
      ),
    ).toEqual([
      'first',
      'first',
      'second',
      null,
      'first',
      'first',
      'second',
      null,
    ]);
    // Different playback rates affect how quickly callers supply times, not lookup results.
    expect(
      [0.5, 1, 2, 4].map(() => engine.getActiveDialogue(at(4.5))?.id),
    ).toEqual(['second', 'second', 'second', 'second']);
  });

  it('rejects invalid intervals and incompatible timebases', () => {
    expect(() => new TimelineEngine([event('bad', 2, 2)])).toThrow(
      TimelineError,
    );
    expect(
      () =>
        new TimelineEngine([
          event('a', 1, 2),
          {
            ...event('b', 3, 4),
            start: { ...at(3), timebase: 'other' as AudioTimebaseId },
          },
        ]),
    ).toThrow(TimelineError);
    expect(() =>
      engine.getActiveDialogue({ ...at(1), unit: 'samples' }),
    ).toThrow(TimelineError);
  });
});
