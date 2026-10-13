import { describe, expect, it } from 'vitest';
import {
  buildReviewQueue,
  candidatesFromBubbles,
  candidatesFromMappings,
  candidatesFromObservations,
  ReviewQueueError,
  type ReviewCandidateInput,
} from '../../apps/web/src/review-queue.js';
import { runAutoPipeline } from '../../apps/web/src/auto-pipeline.js';
import type { DialogueMapping, TextObservation } from '@comic-captioner/core';
import type {
  AudioTimebase,
  AudioTimebaseId,
  BubbleId,
  CoordinateSpaceId,
  ImageSpace,
} from '@comic-captioner/shared';

const imageSpace: ImageSpace = {
  id: 'image:page' as CoordinateSpaceId,
  kind: 'image',
  dimensions: { width: 800, height: 1200 },
};

function candidate(
  id: string,
  confidence: number,
  overrides: Partial<ReviewCandidateInput> = {},
): ReviewCandidateInput {
  return {
    id,
    kind: 'ocr-line',
    confidence,
    label: id,
    ...overrides,
  };
}

describe('buildReviewQueue', () => {
  it('queues only low-confidence items, sorted ascending', () => {
    const queue = buildReviewQueue([
      candidate('a', 0.95),
      candidate('b', 0.4),
      candidate('c', 0.7),
      candidate('d', 0.2),
    ]);
    expect(queue.items.map((item) => item.id)).toEqual(['d', 'b', 'c']);
    expect(queue.summary.queued).toBe(3);
    expect(queue.summary.critical).toBe(1);
    expect(queue.summary.high).toBe(1);
  });

  it('omits accepted and rejected items by default', () => {
    const queue = buildReviewQueue([
      candidate('low', 0.3, { reviewStatus: 'pending-review' }),
      candidate('ok', 0.2, { reviewStatus: 'accepted' }),
      candidate('no', 0.2, { reviewStatus: 'rejected' }),
    ]);
    expect(queue.items.map((item) => item.id)).toEqual(['low']);
  });

  it('respects maxItems and custom threshold', () => {
    const queue = buildReviewQueue(
      [
        candidate('a', 0.1),
        candidate('b', 0.2),
        candidate('c', 0.3),
        candidate('d', 0.9),
      ],
      { confidenceThreshold: 0.5, maxItems: 2 },
    );
    expect(queue.items).toHaveLength(2);
    expect(queue.items[0]?.id).toBe('a');
    expect(queue.items[1]?.id).toBe('b');
  });

  it('rejects invalid confidence and missing ids', () => {
    expect(() =>
      buildReviewQueue([{ id: '', kind: 'bubble', confidence: 0.5, label: 'x' }]),
    ).toThrow(ReviewQueueError);
    expect(() =>
      buildReviewQueue([{ id: 'x', kind: 'bubble', confidence: 2, label: 'x' }]),
    ).toThrow(ReviewQueueError);
    expect(() =>
      buildReviewQueue([], { confidenceThreshold: 2 }),
    ).toThrow(ReviewQueueError);
  });

  it('reports average queued confidence', () => {
    const queue = buildReviewQueue([candidate('a', 0.2), candidate('b', 0.4)]);
    expect(queue.summary.averageQueuedConfidence).toBeCloseTo(0.3);
    expect(queue.summary.byKind['ocr-line']).toBe(2);
  });
});

describe('candidate collectors', () => {
  it('collects low-confidence OCR observations', () => {
    const observations = [
      {
        id: 'ocr:1',
        text: 'Hello',
        polygon: { points: [], coordinateSpace: imageSpace },
        confidence: 0.5,
        coordinateSpace: imageSpace,
      },
    ] as unknown as TextObservation[];
    const items = candidatesFromObservations(observations);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'ocr:1', kind: 'ocr-line', confidence: 0.5 });
  });

  it('collects mappings that need review with suggested alternatives', () => {
    const mappings = [
      {
        id: 'mapping:seg-1',
        transcriptSegmentId: 'seg-1',
        bubbleId: null,
        confidence: 0.3,
        reasons: [
          { signal: 'text-similarity' as const, score: 0.2, evidence: 'Low overlap.' },
        ],
        alternatives: [
          {
            bubbleId: 'bubble-a' as BubbleId,
            confidence: 0.5,
            reasons: [],
          },
        ],
        needsReview: true,
        reviewFlag: 'low-confidence' as const,
        status: 'pending-review' as const,
        revision: 1,
      },
    ] as unknown as DialogueMapping[];
    const items = candidatesFromMappings(mappings);
    expect(items[0]?.suggestedFix).toContain('bubble-a');
    expect(items[0]?.kind).toBe('mapping');
  });

  it('collects uncertain bubbles', () => {
    const items = candidatesFromBubbles([
      { id: 'b1', kind: 'speech', confidence: 0.4 },
      { id: 'b2', kind: 'speech', confidence: 0.95 },
    ]);
    expect(items.find((item) => item.id === 'bubble:b1')?.confidence).toBe(0.4);
    expect(items).toHaveLength(2);
  });
});

describe('runAutoPipeline', () => {
  const segments = [
    {
      id: 'seg-a',
      text: 'Hello there!',
      interval: {
        start: { value: 0, timebase: 'audio:1' as never, unit: 'seconds' as const },
        end: { value: 1, timebase: 'audio:1' as never, unit: 'seconds' as const },
      },
      speakerId: null,
      words: [],
      confidence: 0.9,
    },
    {
      id: 'seg-b',
      text: 'I am right here.',
      interval: {
        start: { value: 1, timebase: 'audio:1' as never, unit: 'seconds' as const },
        end: { value: 2, timebase: 'audio:1' as never, unit: 'seconds' as const },
      },
      speakerId: null,
      words: [],
      confidence: 0.9,
    },
  ];

  const baseInput = {
    hasOriginalPage: true,
    hasAudio: true,
    imageSpace,
    bubbles: [
      {
        id: 'bubble-a',
        kind: 'speech' as const,
        confidence: 0.9,
        points: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
          { x: 110, y: 80 },
          { x: 10, y: 80 },
        ],
      },
      {
        id: 'bubble-b',
        kind: 'speech' as const,
        confidence: 0.9,
        points: [
          { x: 400, y: 100 },
          { x: 500, y: 100 },
          { x: 500, y: 180 },
          { x: 400, y: 180 },
        ],
      },
    ],
    ocrLines: [
      {
        id: 'ocr:bubble-a',
        text: 'Hello there!',
        confidence: 0.92,
        bubbleId: 'bubble-a',
      },
      {
        id: 'ocr:bubble-b',
        text: 'I am right here.',
        confidence: 0.88,
        bubbleId: 'bubble-b',
      },
    ],
    transcript: {
      id: 't1',
      audioAssetId: 'audio-1',
      text: 'Hello there! I am right here.',
      durationSeconds: 2,
      timebase: {
        id: 'audio:1' as AudioTimebaseId,
        unit: 'seconds',
      } satisfies AudioTimebase,
      speakers: [],
      segments,
      confidence: 0.9,
      reviewStatus: 'pending-review' as const,
      revision: 1,
      provenance: {
        provider: 'test',
        version: '1',
        inputHashes: [],
      },
    },
  };

  it('reports stage readiness and maps content-first dialogue', () => {
    const result = runAutoPipeline(baseInput);
    const stage = Object.fromEntries(
      result.stages.map((item) => [item.name, item]),
    );
    expect(stage.import?.status).toBe('succeeded');
    expect(stage.detect?.status).toBe('succeeded');
    expect(stage.ocr?.status).toBe('succeeded');
    expect(stage.transcribe?.status).toBe('succeeded');
    expect(stage.map?.status).toBe('succeeded');
    expect(result.mappings.map((m) => m.bubbleId)).toEqual([
      'bubble-a',
      'bubble-b',
    ]);
  });

  it('builds a confidence-sorted review queue from uncertain stages', () => {
    const result = runAutoPipeline(
      {
        ...baseInput,
        ocrLines: [
          { id: 'ocr:a', text: 'Hello there!', confidence: 0.4, bubbleId: 'bubble-a' },
          { id: 'ocr:b', text: 'I am right here.', confidence: 0.95, bubbleId: 'bubble-b' },
        ],
      },
      { confidenceThreshold: 0.85 },
    );
    expect(result.reviewQueue.items.length).toBeGreaterThan(0);
    expect(result.reviewQueue.items[0]?.confidence).toBeLessThan(0.85);
  });

  it('marks missing stages and is not export-ready without a timeline', () => {
    const result = runAutoPipeline({
      ...baseInput,
      hasAudio: false,
      transcript: null,
    });
    const stage = Object.fromEntries(
      result.stages.map((item) => [item.name, item]),
    );
    expect(stage.transcribe?.status).toBe('failed');
    expect(stage.map?.status).toBe('failed');
    expect(result.readyForExport).toBe(false);
    expect(result.overallConfidence).toBeLessThan(1);
  });

  it('becomes export-ready when fits and timeline cues exist', () => {
    const result = runAutoPipeline({
      ...baseInput,
      captionFits: [
        {
          bubbleId: 'bubble-a',
          text: 'Hello there!',
          fitConfidence: 0.95,
          overflow: false,
          warnings: [],
        },
        {
          bubbleId: 'bubble-b',
          text: 'I am right here.',
          fitConfidence: 0.95,
          overflow: false,
          warnings: [],
        },
      ],
      timelineCues: [
        {
          id: 'cue-1',
          bubbleId: 'bubble-a',
          start: 0,
          end: 1,
          confidence: 0.9,
        },
        {
          id: 'cue-2',
          bubbleId: 'bubble-b',
          start: 1,
          end: 2,
          confidence: 0.9,
        },
      ],
    });
    expect(result.readyForExport).toBe(true);
    const stage = Object.fromEntries(
      result.stages.map((item) => [item.name, item]),
    );
    expect(stage.fit?.status).toBe('succeeded');
    expect(stage.timeline?.status).toBe('succeeded');
  });
});
