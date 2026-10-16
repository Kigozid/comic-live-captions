import { describe, expect, it } from 'vitest';
import type {
  BubbleId,
  CaptionLayout,
  WordTimestamp,
} from '@comic-captioner/core';
import {
  TimelineMappingError,
  buildTimelineFromAlignedWords,
  chunkAlignedWordsForTimeline,
  mapAlignedCaptionsToTimeline,
  timelineCuesFromDialogueEvents,
} from '../../packages/caption-engine/src/timeline-mapping.js';
import { TimelineEngine } from '../../packages/caption-engine/src/timeline.js';
import type {
  AudioTimebaseId,
  CoordinateSpaceId,
} from '@comic-captioner/shared';

const timebase = 'audio:timeline-map' as AudioTimebaseId;
const imageSpace = {
  id: 'image:timeline-map' as CoordinateSpaceId,
  kind: 'image' as const,
  dimensions: { width: 200, height: 200 },
};

function word(
  text: string,
  start: number,
  end: number,
  speakerId: string | null = 'spk_1',
  confidence = 0.9,
): WordTimestamp {
  return {
    id: `w-${text}-${start}`,
    text,
    start: { value: start, timebase, unit: 'seconds' },
    end: { value: end, timebase, unit: 'seconds' },
    speakerId,
    confidence,
  };
}

function layoutFor(bubbleId: string, text: string): CaptionLayout {
  const id = bubbleId as BubbleId;
  return {
    id: `layout-${bubbleId}`,
    bubbleId: id,
    text,
    lines: [text],
    placement: { points: [], coordinateSpace: imageSpace },
    position: { x: 0, y: 0, coordinateSpace: imageSpace },
    widthPx: 40,
    heightPx: 12,
    fontFamily: 'Test',
    fontSizePx: 12,
    alignment: 'center',
    lineSpacingPx: 0,
    linePlacements: [],
    fitScore: 1,
    readabilityScore: 1,
    safetyScore: 1,
  };
}

describe('chunkAlignedWordsForTimeline', () => {
  it('returns empty for no words', () => {
    expect(chunkAlignedWordsForTimeline([])).toEqual([]);
  });

  it('groups words and tiles start/end from word times', () => {
    const units = chunkAlignedWordsForTimeline(
      [word('hello', 0, 0.3), word('world', 0.35, 0.7)],
      { breakOnSentenceEnd: false },
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe('hello world');
    expect(units[0]!.start.value).toBe(0);
    expect(units[0]!.end.value).toBe(0.7);
  });

  it('breaks on sentence end and on long pauses', () => {
    const units = chunkAlignedWordsForTimeline([
      word('Done.', 0, 0.4),
      word('Next', 0.5, 0.8),
      word('line', 2.5, 2.8),
    ]);
    expect(units.map((u) => u.text)).toEqual(['Done.', 'Next', 'line']);
  });

  it('breaks on speaker change', () => {
    const units = chunkAlignedWordsForTimeline([
      word('hi', 0, 0.2, 'spk_1'),
      word('there', 0.25, 0.5, 'spk_2'),
    ]);
    expect(units).toHaveLength(2);
    expect(units[0]!.speakerId).toBe('spk_1');
    expect(units[1]!.speakerId).toBe('spk_2');
  });

  it('enforces character caps', () => {
    const units = chunkAlignedWordsForTimeline(
      [word('aaaa', 0, 0.2), word('bbbb', 0.2, 0.4)],
      { maxCharacters: 6, breakOnSentenceEnd: false },
    );
    expect(units.length).toBeGreaterThan(1);
  });

  it('rejects unordered or empty words', () => {
    expect(() =>
      chunkAlignedWordsForTimeline([word('b', 1, 2), word('a', 0, 0.5)]),
    ).toThrow(TimelineMappingError);
    expect(() =>
      chunkAlignedWordsForTimeline([
        {
          id: 'x',
          text: '  ',
          start: { value: 0, timebase, unit: 'seconds' },
          end: { value: 1, timebase, unit: 'seconds' },
          speakerId: null,
          confidence: 1,
        },
      ]),
    ).toThrow(TimelineMappingError);
  });
});

describe('mapAlignedCaptionsToTimeline', () => {
  it('maps units to DialogueEvents using assignments', () => {
    const units = chunkAlignedWordsForTimeline([
      word('hello', 0, 0.4),
      word('there', 0.5, 0.9),
    ]);
    const bubbleId = 'bubble-1' as BubbleId;
    const events = mapAlignedCaptionsToTimeline(units, [
      {
        unitId: units[0]!.id,
        bubbleId,
        layout: layoutFor('bubble-1', 'hello there'),
        confidence: 0.8,
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.bubbleId).toBe('bubble-1');
    expect(events[0]!.caption).toBe('hello there');
    expect(events[0]!.start.value).toBe(0);
    expect(events[0]!.end.value).toBe(0.9);
    expect(events[0]!.confidence).toBe(0.8);
  });

  it('skips unassigned units and supports caption override', () => {
    const units = chunkAlignedWordsForTimeline([
      word('one', 0, 0.3),
      word('two!', 2, 2.3),
    ]);
    expect(units.length).toBe(2);
    const events = mapAlignedCaptionsToTimeline(units, [
      {
        unitId: units[1]!.id,
        bubbleId: 'b2' as BubbleId,
        layout: layoutFor('b2', 'TWO'),
        caption: 'TWO!',
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.caption).toBe('TWO!');
    expect(events[0]!.start.value).toBe(2);
  });

  it('rejects layout/bubble mismatch', () => {
    const units = chunkAlignedWordsForTimeline([word('x', 0, 0.3)]);
    expect(() =>
      mapAlignedCaptionsToTimeline(units, [
        {
          unitId: units[0]!.id,
          bubbleId: 'a' as BubbleId,
          layout: layoutFor('b', 'x'),
        },
      ]),
    ).toThrow(TimelineMappingError);
  });
});

describe('buildTimelineFromAlignedWords → TimelineEngine', () => {
  it('produces events playable by TimelineEngine', () => {
    const words = [
      word('Hello', 0.1, 0.4),
      word('there', 0.45, 0.8),
      word('friend.', 1.5, 1.9),
      word('Bye', 3, 3.3, 'spk_2'),
    ];
    const { units, events } = buildTimelineFromAlignedWords(words, {
      bubbleId: 'bubble-narration' as BubbleId,
      layout: layoutFor('bubble-narration', 'narration'),
      confidence: 0.7,
    });
    expect(units.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBe(units.length);
    const engine = new TimelineEngine(events);
    expect(engine.getActiveDialogue({ value: 0.5, timebase, unit: 'seconds' })?.id)
      .toContain('timeline-caption');
    expect(engine.getActiveDialogue({ value: 4, timebase, unit: 'seconds' })).toBeNull();
  });

  it('emits auto-pipeline timeline cues in seconds', () => {
    const { events } = buildTimelineFromAlignedWords(
      [word('go', 0, 0.5)],
      {
        bubbleId: 'b' as BubbleId,
        layout: layoutFor('b', 'go'),
      },
    );
    const cues = timelineCuesFromDialogueEvents(events);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      bubbleId: 'b',
      start: 0,
      end: 0.5,
    });
    expect(cues[0]!.confidence).toBeGreaterThan(0);
  });

  it('assigns per-unit bubbles from a list', () => {
    const words = [
      word('First.', 0, 0.4),
      word('Second.', 2, 2.4),
    ];
    const units = chunkAlignedWordsForTimeline(words);
    const { events } = buildTimelineFromAlignedWords(
      words,
      units.map((unit, index) => ({
        unitId: unit.id,
        bubbleId: `bubble-${index + 1}` as BubbleId,
        layout: layoutFor(`bubble-${index + 1}`, unit.text),
      })),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.bubbleId).toBe('bubble-1');
    expect(events[1]!.bubbleId).toBe('bubble-2');
    // TimelineEngine accepts the mapped events without error.
    expect(() => new TimelineEngine(events)).not.toThrow();
  });
});
