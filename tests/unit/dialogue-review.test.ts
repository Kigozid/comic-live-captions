import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import type { Transcript } from '@comic-captioner/audio-engine';
import {
  emptyEditorHistory,
  editorReducer,
} from '../../apps/web/src/editor-model.js';
import { proposeTranscriptBubbleMappings } from '../../apps/web/src/dialogue-review.js';

describe('live dialogue review proposals', () => {
  it('automatically matches transcript text to edited OCR while retaining review status and timing', () => {
    const imageSpace = createImageSpace('image:live-review', 300, 180);
    const polygon = {
      coordinateSpace: imageSpace,
      points: [
        { x: 20, y: 20, coordinateSpace: imageSpace },
        { x: 150, y: 20, coordinateSpace: imageSpace },
        { x: 150, y: 100, coordinateSpace: imageSpace },
        { x: 20, y: 100, coordinateSpace: imageSpace },
      ],
    };
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace,
    });
    state = editorReducer(state, {
      type: 'add-bubble',
      id: 'bubble-a',
      polygon,
    });
    state = editorReducer(state, {
      type: 'edit-ocr',
      bubbleId: 'bubble-a',
      text: 'Hello there!',
    });
    const document = state.present!;
    const transcript = {
      id: 'transcript-a',
      audioAssetId: 'audio-a',
      text: 'Hello there!',
      durationSeconds: 2,
      timebase: { id: 'audio:test', unit: 'seconds' },
      speakers: [],
      segments: [
        {
          id: 'segment-a',
          text: 'Hello there!',
          speakerId: null,
          words: [],
          confidence: 0.9,
          interval: {
            start: { value: 0.2, timebase: 'audio:test', unit: 'seconds' },
            end: { value: 1.1, timebase: 'audio:test', unit: 'seconds' },
          },
        },
      ],
      confidence: 0.9,
      reviewStatus: 'pending-review',
      revision: 1,
      provenance: { provider: 'test', version: '1', inputHashes: [] },
    } as unknown as Transcript;

    const [proposal] = proposeTranscriptBubbleMappings(document, transcript);
    expect(proposal).toMatchObject({
      transcriptSegmentId: 'segment-a',
      bubbleId: 'bubble-a',
      status: 'pending-review',
      needsReview: true,
    });
  });
});
