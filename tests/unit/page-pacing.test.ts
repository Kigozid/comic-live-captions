import { describe, expect, it } from 'vitest';
import {
  PagePacingError,
  proposePagePacing,
  type PacedPageInput,
  type PageDialogueSegmentRef,
  type PagePacingInput,
  type PagePacingOverride,
} from '@comic-captioner/caption-engine';
import type {
  AudioTime,
  AudioTimebase,
  AudioTimebaseId,
  BubbleId,
  PageId,
  TimeInterval,
} from '@comic-captioner/shared';

const timebase: AudioTimebase = Object.freeze({
  id: 'audio:page-pacing-test' as AudioTimebaseId,
  unit: 'seconds',
});

function at(value: number): AudioTime {
  return { value, timebase: timebase.id, unit: 'seconds' };
}

function interval(start: number, end: number): TimeInterval {
  return { start: at(start), end: at(end) };
}

function page(
  id: string,
  segments: readonly PageDialogueSegmentRef[] = [],
): PacedPageInput {
  return { id: id as PageId, segments };
}

function segment(
  id: string,
  bubbleId: string,
  start: number,
  end: number,
): PageDialogueSegmentRef {
  return {
    id,
    bubbleId: bubbleId as BubbleId,
    interval: interval(start, end),
  };
}

function override(
  pageId: string,
  start: number,
  end: number,
): PagePacingOverride {
  return { pageId: pageId as PageId, start: at(start), end: at(end) };
}

function pacing(
  pages: readonly PacedPageInput[],
  audioSpan: TimeInterval,
  overrides?: readonly PagePacingOverride[],
): PagePacingInput {
  return { pages, timebase, audioSpan, ...(overrides ? { overrides } : {}) };
}

describe('proposePagePacing', () => {
  it('returns no proposals for an empty page list', () => {
    expect(proposePagePacing(pacing([], interval(0, 10)))).toEqual([]);
  });

  it('covers the full audio span with a single page', () => {
    const proposals = proposePagePacing(
      pacing([page('p1', [segment('s1', 'b1', 2, 4)])], interval(0, 10)),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      pageId: 'p1',
      start: { value: 0 },
      end: { value: 10 },
      source: 'dialogue',
      status: 'pending-review',
    });
  });

  it('splits the span evenly when no page has mapped dialogue', () => {
    const proposals = proposePagePacing(
      pacing([page('p1'), page('p2'), page('p3')], interval(0, 9)),
    );
    expect(
      proposals.map((proposal) => [
        proposal.start.value,
        proposal.end.value,
        proposal.source,
      ]),
    ).toEqual([
      [0, 3, 'fallback'],
      [3, 6, 'fallback'],
      [6, 9, 'fallback'],
    ]);
    for (const proposal of proposals) expect(proposal.confidence).toBe(0.5);
  });

  it('derives boundaries from mapped dialogue and absorbs edge silence', () => {
    const proposals = proposePagePacing(
      pacing(
        [
          page('p1', [segment('s1', 'b1', 3, 5)]),
          page('p2', [segment('s2', 'b2', 5, 7)]),
        ],
        interval(0, 12),
      ),
    );
    expect(
      proposals.map((proposal) => [proposal.start.value, proposal.end.value]),
    ).toEqual([
      [0, 5],
      [5, 12],
    ]);
    expect(proposals[0]!.reasons.map((reason) => reason.signal)).toContain(
      'mapped-dialogue',
    );
    expect(proposals[1]!.source).toBe('dialogue');
  });

  it('distributes unmapped gaps proportionally to dialogue duration', () => {
    const proposals = proposePagePacing(
      pacing(
        [
          page('p1', [segment('s1', 'b1', 0.5, 1.5)]),
          page('p2', [segment('s2', 'b2', 4.5, 7.5)]),
        ],
        interval(0, 10),
      ),
    );
    // Gap of 3s between dialogue; page 1 holds 1s of dialogue, page 2 holds
    // 3s, so page 1 absorbs 0.75s and page 2 absorbs 2.25s of the gap.
    expect(proposals[0]!.end.value).toBeCloseTo(2.25, 10);
    expect(proposals[1]!.start.value).toBeCloseTo(2.25, 10);
    expect(proposals[0]!.start.value).toBe(0);
    expect(proposals[1]!.end.value).toBe(10);
    expect(proposals[0]!.reasons.map((reason) => reason.signal)).toContain(
      'gap-distribution',
    );
  });

  it('clamps overlapping dialogue to the midpoint of the overlap', () => {
    const proposals = proposePagePacing(
      pacing(
        [
          page('p1', [segment('s1', 'b1', 0, 6)]),
          page('p2', [segment('s2', 'b2', 4, 8)]),
        ],
        interval(0, 10),
      ),
    );
    // Overlap [4, 6] has midpoint 5.
    expect(proposals[0]!.end.value).toBe(5);
    expect(proposals[1]!.start.value).toBe(5);
    expect(proposals[0]!.reasons.map((reason) => reason.signal)).toContain(
      'overlap-midpoint',
    );
    expect(proposals[0]!.confidence).toBeLessThan(0.85);
  });

  it('gives pages without dialogue an even share of the intervening span', () => {
    const proposals = proposePagePacing(
      pacing(
        [
          page('p1', [segment('s1', 'b1', 1, 2)]),
          page('p2'),
          page('p3'),
          page('p4', [segment('s4', 'b4', 5, 6)]),
        ],
        interval(0, 8),
      ),
    );
    // Two empty pages split the 3s between the mapped dialogue evenly.
    expect(
      proposals.map((proposal) => [
        proposal.start.value,
        proposal.end.value,
        proposal.source,
      ]),
    ).toEqual([
      [0, 2, 'dialogue'],
      [2, 3.5, 'fallback'],
      [3.5, 5, 'fallback'],
      [5, 8, 'dialogue'],
    ]);
    expect(proposals[1]!.reasons.map((reason) => reason.signal)).toContain(
      'even-split-fallback',
    );
  });

  it('applies explicit overrides verbatim and clamps neighbours to them', () => {
    const proposals = proposePagePacing(
      pacing(
        [
          page('p1', [segment('s1', 'b1', 1, 3)]),
          page('p2', [segment('s2', 'b2', 5, 7)]),
        ],
        interval(0, 10),
        [override('p1', 0, 4)],
      ),
    );
    expect(proposals[0]).toMatchObject({
      start: { value: 0 },
      end: { value: 4 },
      source: 'override',
      confidence: 1,
    });
    expect(proposals[0]!.reasons.map((reason) => reason.signal)).toEqual([
      'explicit-override',
    ]);
    // The neighbour clamps flush to the override instead of gap-splitting.
    expect(proposals[1]!.start.value).toBe(4);
    expect(proposals[1]!.end.value).toBe(10);
  });

  it('lets an override win on the right-hand page as well', () => {
    const proposals = proposePagePacing(
      pacing(
        [
          page('p1', [segment('s1', 'b1', 1, 3)]),
          page('p2', [segment('s2', 'b2', 5, 7)]),
        ],
        interval(0, 10),
        [override('p2', 6, 8)],
      ),
    );
    expect(proposals[1]).toMatchObject({
      start: { value: 6 },
      end: { value: 8 },
      source: 'override',
    });
    expect(proposals[0]!.end.value).toBe(6);
    expect(proposals[0]!.start.value).toBe(0);
  });

  it('returns frozen proposals carrying stable IDs and pending review status', () => {
    const proposals = proposePagePacing(
      pacing([page('p1', [segment('s1', 'b1', 1, 2)])], interval(0, 4)),
    );
    expect(Object.isFrozen(proposals)).toBe(true);
    expect(Object.isFrozen(proposals[0])).toBe(true);
    expect(proposals[0]!.id).toBe('page-pacing:page-1');
    expect(proposals[0]!.status).toBe('pending-review');
  });

  it('rejects invalid timebases, spans, and segment placement', () => {
    expect(() =>
      proposePagePacing({
        pages: [page('p1')],
        timebase: { id: '' as AudioTimebaseId, unit: 'seconds' },
        audioSpan: interval(0, 10),
      }),
    ).toThrow(PagePacingError);
    expect(() =>
      proposePagePacing(pacing([page('p1')], interval(5, 5))),
    ).toThrow(PagePacingError);
    expect(() =>
      proposePagePacing(
        pacing([page('p1', [segment('s1', 'b1', 20, 30)])], interval(0, 10)),
      ),
    ).toThrow(PagePacingError);
  });

  it('rejects duplicate pages, unknown override targets, and overlapping overrides', () => {
    expect(() =>
      proposePagePacing(pacing([page('p1'), page('p1')], interval(0, 10))),
    ).toThrow(PagePacingError);
    expect(() =>
      proposePagePacing(
        pacing([page('p1')], interval(0, 10), [override('missing', 0, 4)]),
      ),
    ).toThrow(PagePacingError);
    expect(() =>
      proposePagePacing(
        pacing(
          [page('p1'), page('p2')],
          interval(0, 10),
          [override('p1', 0, 6), override('p2', 4, 8)],
        ),
      ),
    ).toThrow(PagePacingError);
  });
});
