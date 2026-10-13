import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import { createManualBubble } from '@comic-captioner/bubble-engine';
import {
  associateOCRLine,
  deduplicateOCRLines,
  groupOCRLines,
} from '../../apps/web/src/ocr-association.js';
import {
  editorReducer,
  emptyEditorHistory,
} from '../../apps/web/src/editor-model.js';

const space = createImageSpace('ocr-association-test', 200, 120);
const bubble = createManualBubble({
  id: 'bubble-a',
  coordinateSpace: space,
  polygon: {
    coordinateSpace: space,
    points: [
      { x: 20, y: 20, coordinateSpace: space },
      { x: 100, y: 20, coordinateSpace: space },
      { x: 100, y: 80, coordinateSpace: space },
      { x: 20, y: 80, coordinateSpace: space },
    ],
  },
});

describe('OCR geometry association', () => {
  it('assigns a text box using polygon coverage, not only its center', () => {
    expect(
      associateOCRLine({ x: 24, y: 35, width: 30, height: 12 }, [bubble]),
    ).toMatchObject({ classification: 'dialogue', bubbleId: 'bubble-a' });
  });

  it('leaves equally plausible bubble matches ambiguous', () => {
    const second = createManualBubble({
      ...bubble,
      id: 'bubble-b',
    });
    expect(
      associateOCRLine({ x: 40, y: 40, width: 20, height: 10 }, [
        bubble,
        second,
      ]),
    ).toMatchObject({ classification: 'ambiguous', bubbleId: null });
  });

  it('deduplicates repeated OCR boxes and groups lines by visual row', () => {
    const lines = [
      {
        id: 'b',
        text: 'second',
        confidence: 0.8,
        boundingBox: { x: 25, y: 44, width: 40, height: 10 },
      },
      {
        id: 'a-duplicate',
        text: ' FIRST ',
        confidence: 0.7,
        boundingBox: { x: 20, y: 30, width: 30, height: 10 },
      },
      {
        id: 'a',
        text: 'first',
        confidence: 0.9,
        boundingBox: { x: 20, y: 30, width: 30, height: 10 },
      },
      {
        id: 'c',
        text: 'third',
        confidence: 0.9,
        boundingBox: { x: 25, y: 70, width: 30, height: 10 },
      },
    ];
    const unique = deduplicateOCRLines(lines);
    expect(unique.map((line) => line.id)).toEqual(['a', 'b', 'c']);
    expect(
      groupOCRLines(unique).map((row) => row.map((line) => line.text)),
    ).toEqual([['first'], ['second'], ['third']]);
  });

  it('keeps unrelated OCR text available for explicit review', () => {
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    state = editorReducer(state, {
      type: 'import-analysis',
      bubbles: [
        {
          id: bubble.id,
          kind: 'speech',
          confidence: 0.9,
          points: bubble.polygon.points,
        },
      ],
    });
    state = editorReducer(state, {
      type: 'import-ocr',
      lines: [
        {
          id: 'sign-text',
          text: 'ICE COLD',
          confidence: 0.92,
          boundingBox: { x: 130, y: 24, width: 50, height: 12 },
        },
      ],
    });
    expect(state.present?.observations['ocr:sign-text']).toMatchObject({
      text: 'ICE COLD',
      classification: 'non-dialogue',
      reviewStatus: 'pending-review',
      associatedBubbleId: null,
      sourceLineIds: ['sign-text'],
    });
  });

  it('lets the user promote incidental OCR into a bubble caption explicitly', () => {
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    state = editorReducer(state, {
      type: 'import-analysis',
      bubbles: [
        {
          id: bubble.id,
          kind: 'speech',
          confidence: 0.9,
          points: bubble.polygon.points,
        },
      ],
    });
    state = editorReducer(state, {
      type: 'import-ocr',
      lines: [
        {
          id: 'review-me',
          text: 'ICE COLD',
          confidence: 0.92,
          boundingBox: { x: 130, y: 24, width: 50, height: 12 },
        },
      ],
    });
    state = editorReducer(state, {
      type: 'review-ocr-observation',
      observationId: 'ocr:review-me',
      classification: 'dialogue',
      reviewStatus: 'accepted',
      bubbleId: bubble.id,
    });

    expect(state.present?.observations['ocr:review-me']).toBeUndefined();
    expect(state.present?.observations['ocr:bubble-a']).toMatchObject({
      text: 'ICE COLD',
      classification: 'dialogue',
      reviewStatus: 'accepted',
      associatedBubbleId: bubble.id,
      manuallyEdited: true,
    });
    expect(state.present?.dialogues['dialogue:bubble-a']?.caption).toBe(
      'ICE COLD',
    );
  });
});
