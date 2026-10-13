import { describe, expect, it } from 'vitest';
import {
  correctDialogueMapping,
  DialogueMappingCorrectionError,
  type BubbleDialogueReference,
  type TranscriptSegment,
} from '@comic-captioner/core';
import {
  DialogueMappingEngine,
  DialogueMappingError,
  type DialogueMappingInput,
} from '@comic-captioner/ai';
import type {
  BubbleId,
  CoordinateSpaceId,
  AudioTimebaseId,
} from '@comic-captioner/shared';

const imageSpace = {
  id: 'image:test-page' as CoordinateSpaceId,
  kind: 'image' as const,
  dimensions: { width: 1000, height: 1000 },
};
const timebase = 'audio:test' as AudioTimebaseId;

function reference(
  id: string,
  text: string,
  x: number,
  y: number,
): BubbleDialogueReference {
  return {
    id: `ref-${id}`,
    bubbleId: id as BubbleId,
    textRegionIds: [`text-${id}`],
    originalText: text,
    originalTextBounds: {
      x,
      y,
      width: 150,
      height: 60,
      coordinateSpace: imageSpace,
    },
    lineCount: 1,
    alignment: 'center',
    confidence: 0.95,
    status: 'accepted',
    method: 'spatial',
    revision: 1,
  };
}

function segment(
  id: string,
  text: string,
  start: number,
  speakerId: string | null = null,
): TranscriptSegment {
  return {
    id,
    text,
    interval: {
      start: { value: start, timebase, unit: 'seconds' },
      end: { value: start + 0.8, timebase, unit: 'seconds' },
    },
    speakerId,
    words: [],
    confidence: 0.9,
  };
}

function input(
  overrides: Partial<DialogueMappingInput> = {},
): DialogueMappingInput {
  const refs = [
    reference('bubble-a', 'Hello there!', 100, 100),
    reference('bubble-b', 'I am right here.', 550, 180),
  ];
  return {
    bubbleReferences: refs,
    readingOrder: refs.map((item) => item.bubbleId),
    transcriptSegments: [
      segment('seg-a', 'Hello there!', 0.2, 'speaker-a'),
      segment('seg-b', 'I am right here.', 1.4, 'speaker-b'),
    ],
    ...overrides,
  };
}

describe('DialogueMappingEngine', () => {
  it('maps exact OCR dialogue in reading order and keeps every proposal reviewable', () => {
    const result = new DialogueMappingEngine().map(input());
    expect(result.mappings.map((item) => item.bubbleId)).toEqual([
      'bubble-a',
      'bubble-b',
    ]);
    expect(
      result.mappings.every((item) => item.status === 'pending-review'),
    ).toBe(true);
    expect(result.mappings.every((item) => item.needsReview)).toBe(true);
    expect(result.mappings[0]?.reasons.map((item) => item.signal)).toContain(
      'text-similarity',
    );
    expect(result.unmappedTranscriptSegmentIds).toEqual([]);
  });

  it('flags equally plausible repeated dialogue as ambiguous', () => {
    const refs = [
      reference('bubble-a', 'Stop!', 100, 100),
      reference('bubble-b', 'Stop!', 500, 600),
    ];
    const mapped = new DialogueMappingEngine().map(
      input({
        bubbleReferences: refs,
        readingOrder: refs.map((item) => item.bubbleId),
        transcriptSegments: [segment('seg-repeat', 'Stop!', 0.2)],
      }),
    ).mappings[0]!;
    expect(mapped.reviewFlag).toBe('ambiguous');
    expect(mapped.needsReview).toBe(true);
    expect(mapped.alternatives).toHaveLength(2);
  });

  it('leaves unsupported dialogue unmapped rather than forcing the closest bubble', () => {
    const result = new DialogueMappingEngine().map(
      input({
        transcriptSegments: [
          segment('seg-unknown', 'A completely unrelated sentence.', 0.2),
        ],
      }),
    );
    expect(result.mappings[0]).toMatchObject({
      bubbleId: null,
      reviewFlag: 'low-confidence',
      needsReview: true,
    });
    expect(result.unmappedTranscriptSegmentIds).toEqual(['seg-unknown']);
  });

  it('uses validated semantic evidence when exact words differ', () => {
    const refs = [reference('bubble-a', 'Where have you gone?', 100, 100)];
    const mapped = new DialogueMappingEngine().map(
      input({
        bubbleReferences: refs,
        readingOrder: [refs[0]!.bubbleId],
        transcriptSegments: [segment('seg-semantic', 'Where did you go?', 0.2)],
        semanticScores: [
          {
            transcriptSegmentId: 'seg-semantic',
            bubbleId: refs[0]!.bubbleId,
            score: 0.96,
            evidence: 'Validated paraphrase match.',
          },
        ],
      }),
    ).mappings[0]!;
    expect(mapped.bubbleId).toBe('bubble-a');
    expect(mapped.reasons).toContainEqual(
      expect.objectContaining({
        signal: 'semantic-similarity',
        score: 0.96,
      }),
    );
  });

  it('uses speaker hints and temporal/spatial context with explicit reasons', () => {
    const refs = [
      reference('bubble-a', 'First exact line.', 100, 100),
      reference('bubble-b', 'Second exact line.', 350, 130),
      reference('bubble-c', 'Third exact line.', 700, 180),
    ];
    const result = new DialogueMappingEngine().map(
      input({
        bubbleReferences: refs,
        readingOrder: refs.map((item) => item.bubbleId),
        transcriptSegments: [
          segment('seg-1', 'First exact line.', 0.1, 'speaker-a'),
          segment('seg-2', 'Second exact line.', 1, 'speaker-a'),
          segment('seg-3', 'Third exact line.', 2, 'speaker-b'),
        ],
        speakerHints: [
          {
            speakerId: 'speaker-a',
            bubbleId: refs[1]!.bubbleId,
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(result.mappings[1]?.reasons.map((item) => item.signal)).toEqual(
      expect.arrayContaining([
        'temporal-order',
        'spatial-context',
        'speaker-consistency',
      ]),
    );
    expect(result.mappings.map((item) => item.bubbleId)).toEqual([
      'bubble-a',
      'bubble-b',
      'bubble-c',
    ]);
  });

  it('rejects invalid order, coordinate spaces, semantic scores, and timestamps', () => {
    const base = input();
    const engine = new DialogueMappingEngine();
    expect(() =>
      engine.map({ ...base, readingOrder: ['bubble-a' as BubbleId] }),
    ).toThrow(DialogueMappingError);
    expect(() =>
      engine.map({
        ...base,
        semanticScores: [
          {
            transcriptSegmentId: 'seg-a',
            bubbleId: 'bubble-a' as BubbleId,
            score: 2,
          },
        ],
      }),
    ).toThrow(DialogueMappingError);
    expect(() =>
      engine.map({
        ...base,
        transcriptSegments: [
          segment('seg-a', 'Hello', 1),
          segment('seg-b', 'There', 0),
        ],
      }),
    ).toThrow(DialogueMappingError);
    const wrongSpace = reference('bubble-a', 'Hello', 0, 0);
    const otherSpace = {
      ...wrongSpace,
      originalTextBounds: {
        ...wrongSpace.originalTextBounds,
        coordinateSpace: {
          ...imageSpace,
          id: 'image:other' as CoordinateSpaceId,
        },
      },
    };
    expect(() =>
      engine.map({
        ...base,
        bubbleReferences: [otherSpace, base.bubbleReferences[1]!],
      }),
    ).toThrow(DialogueMappingError);
  });
});

describe('manual dialogue remapping', () => {
  it('immutably selects a valid bubble, records a manual reason, and increments revision', () => {
    const mapping = new DialogueMappingEngine().map(input()).mappings[0]!;
    const edited = correctDialogueMapping(mapping, 'bubble-b' as BubbleId, {
      transcriptSegmentIds: ['seg-a', 'seg-b'],
      bubbleIds: ['bubble-a', 'bubble-b'] as BubbleId[],
    });
    expect(mapping.bubbleId).toBe('bubble-a');
    expect(edited).toMatchObject({
      bubbleId: 'bubble-b',
      status: 'edited',
      confidence: 1,
      needsReview: false,
      reviewFlag: 'none',
      revision: 2,
    });
    expect(edited.reasons[0]?.signal).toBe('manual-correction');
  });

  it('rejects remapping to stale segments or unknown bubbles', () => {
    const mapping = new DialogueMappingEngine().map(input()).mappings[0]!;
    expect(() =>
      correctDialogueMapping(mapping, 'missing' as BubbleId, {
        transcriptSegmentIds: ['seg-a'],
        bubbleIds: ['bubble-a'] as BubbleId[],
      }),
    ).toThrow(DialogueMappingCorrectionError);
  });
});
