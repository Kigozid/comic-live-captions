import { describe, expect, it } from 'vitest';
import { createImageSpace } from '@comic-captioner/shared';
import {
  editorReducer,
  emptyEditorHistory,
} from '../../apps/web/src/editor-model.js';

describe('editing workspace document', () => {
  it('imports bubble geometry before OCR and later associates OCR undoably', () => {
    const space = createImageSpace('image:analysis-test', 200, 100);
    const initialized = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const imported = editorReducer(initialized, {
      type: 'import-analysis',
      bubbles: [
        {
          id: 'auto-1',
          kind: 'speech',
          confidence: 0.84,
          points: [
            { x: 10, y: 10 },
            { x: 90, y: 10 },
            { x: 90, y: 70 },
            { x: 10, y: 70 },
          ],
        },
      ],
    });
    expect(imported.present?.bubbles['auto-1']).toMatchObject({
      confidence: 0.84,
      source: 'detected',
      boundingBox: { coordinateSpace: space },
    });
    expect(imported.present?.observations['ocr:auto-1']?.text).toBe('');
    const withOcr = editorReducer(imported, {
      type: 'import-ocr',
      lines: [
        {
          id: 'line-1',
          text: 'Hello there',
          confidence: 0.93,
          boundingBox: { x: 30, y: 30, width: 40, height: 10 },
        },
      ],
    });
    expect(withOcr.present?.observations['ocr:auto-1']?.text).toBe(
      'Hello there',
    );
    expect(withOcr.present?.dialogues['dialogue:auto-1']?.caption).toBe(
      'Hello there',
    );
    expect(
      editorReducer(withOcr, { type: 'undo' }).present?.observations[
        'ocr:auto-1'
      ]?.text,
    ).toBe('');
    expect(
      editorReducer(editorReducer(withOcr, { type: 'undo' }), { type: 'undo' })
        .present?.bubbles['auto-1'],
    ).toBeUndefined();
  });

  it('keeps OCR available when bubbles are detected later', () => {
    const space = createImageSpace('image:ocr-first', 200, 100);
    const initialized = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const withOcr = editorReducer(initialized, {
      type: 'import-ocr',
      lines: [
        {
          id: 'line-before-bubble',
          text: 'Wait!',
          confidence: 0.88,
          boundingBox: { x: 30, y: 30, width: 30, height: 10 },
        },
      ],
    });
    const detected = editorReducer(withOcr, {
      type: 'import-analysis',
      bubbles: [
        {
          id: 'later-bubble',
          kind: 'speech',
          confidence: 0.8,
          points: [
            { x: 10, y: 10 },
            { x: 90, y: 10 },
            { x: 90, y: 70 },
            { x: 10, y: 70 },
          ],
        },
      ],
    });
    const associated = editorReducer(detected, {
      type: 'import-ocr',
      lines: [
        {
          id: 'line-before-bubble',
          text: 'Wait!',
          confidence: 0.88,
          boundingBox: { x: 30, y: 30, width: 30, height: 10 },
        },
      ],
    });
    expect(associated.present?.observations['ocr:later-bubble']?.text).toBe(
      'Wait!',
    );
  });

  it('preserves manually corrected OCR and captions when OCR is rerun', () => {
    const space = createImageSpace('image:manual-ocr', 200, 100);
    const initialized = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const detected = editorReducer(initialized, {
      type: 'import-analysis',
      bubbles: [
        {
          id: 'bubble-manual-ocr',
          kind: 'speech',
          confidence: 0.9,
          points: [
            { x: 10, y: 10 },
            { x: 190, y: 10 },
            { x: 190, y: 90 },
            { x: 10, y: 90 },
          ],
        },
      ],
    });
    const firstPass = editorReducer(detected, {
      type: 'import-ocr',
      lines: [
        {
          id: 'ocr-pass-1',
          text: 'H3LLO',
          confidence: 0.42,
          boundingBox: { x: 40, y: 35, width: 50, height: 14 },
        },
      ],
    });
    const corrected = editorReducer(firstPass, {
      type: 'edit-ocr',
      bubbleId: 'bubble-manual-ocr',
      text: 'HELLO',
    });
    const captionEdited = editorReducer(corrected, {
      type: 'edit-dialogue',
      dialogueId: 'dialogue:bubble-manual-ocr',
      patch: { caption: 'HELLO!' },
    });
    const rerun = editorReducer(captionEdited, {
      type: 'import-ocr',
      lines: [
        {
          id: 'ocr-pass-2',
          text: 'H3LLO AGAIN',
          confidence: 0.93,
          boundingBox: { x: 42, y: 36, width: 80, height: 14 },
        },
      ],
    });
    expect(rerun.present?.observations['ocr:bubble-manual-ocr']).toMatchObject({
      text: 'HELLO',
      rawText: 'H3LLO',
      manuallyEdited: true,
    });
    expect(
      rerun.present?.dialogues['dialogue:bubble-manual-ocr']?.caption,
    ).toBe('HELLO!');
  });

  it('keeps punctuation-only OCR artifacts reviewable instead of adding captions', () => {
    const space = createImageSpace('punctuation-ocr', 200, 100);
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    state = editorReducer(state, {
      type: 'import-analysis',
      bubbles: [
        {
          id: 'bubble-punctuation',
          kind: 'speech',
          confidence: 0.9,
          points: [
            { x: 10, y: 10 },
            { x: 190, y: 10 },
            { x: 190, y: 90 },
            { x: 10, y: 90 },
          ],
        },
      ],
    });
    state = editorReducer(state, {
      type: 'import-ocr',
      lines: [
        {
          id: 'punctuation-artifact',
          text: '-',
          confidence: 0.23,
          boundingBox: { x: 90, y: 40, width: 8, height: 6 },
        },
      ],
    });

    expect(
      state.present?.observations['ocr:punctuation-artifact'],
    ).toMatchObject({
      text: '-',
      rawText: '-',
      classification: 'non-dialogue',
      reviewStatus: 'pending-review',
    });
    expect(
      state.present?.dialogues['dialogue:bubble-punctuation']?.caption,
    ).toBe('');
  });

  it('removes stale automatic captions when a rerun reclassifies their text', () => {
    const space = createImageSpace('stale-ocr', 200, 100);
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    state = editorReducer(state, {
      type: 'import-analysis',
      bubbles: [
        {
          id: 'bubble-stale',
          kind: 'speech',
          confidence: 0.9,
          points: [
            { x: 10, y: 10 },
            { x: 190, y: 10 },
            { x: 190, y: 90 },
            { x: 10, y: 90 },
          ],
        },
      ],
    });
    state = editorReducer(state, {
      type: 'import-ocr',
      lines: [
        {
          id: 'line-first-pass',
          text: 'Hello',
          confidence: 0.93,
          boundingBox: { x: 80, y: 40, width: 35, height: 12 },
        },
      ],
    });
    expect(state.present?.dialogues['dialogue:bubble-stale']?.caption).toBe(
      'Hello',
    );

    state = editorReducer(state, {
      type: 'import-ocr',
      lines: [
        {
          id: 'line-second-pass',
          text: '-',
          confidence: 0.23,
          boundingBox: { x: 90, y: 42, width: 8, height: 6 },
        },
      ],
    });
    expect(state.present?.observations['ocr:bubble-stale']).toBeUndefined();
    expect(state.present?.dialogues['dialogue:bubble-stale']?.caption).toBe('');
    expect(state.present?.observations['ocr:line-second-pass']).toMatchObject({
      classification: 'non-dialogue',
      rawText: '-',
    });
  });

  it('reviews, merges touching regions and splits a region with undoable edits', () => {
    const space = createImageSpace('image:region-review', 200, 100);
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const rectangle = (x: number, right: number) => ({
      coordinateSpace: space,
      points: [
        { x, y: 10, coordinateSpace: space },
        { x: right, y: 10, coordinateSpace: space },
        { x: right, y: 70, coordinateSpace: space },
        { x, y: 70, coordinateSpace: space },
      ],
    });
    state = editorReducer(state, {
      type: 'add-bubble',
      id: 'region-a',
      polygon: rectangle(10, 70),
    });
    state = editorReducer(state, {
      type: 'add-bubble',
      id: 'region-b',
      polygon: rectangle(60, 120),
    });
    state = editorReducer(state, {
      type: 'review-bubble',
      bubbleId: 'region-a',
      reviewStatus: 'accepted',
    });
    expect(state.present?.bubbles['region-a']?.reviewStatus).toBe('accepted');
    state = editorReducer(state, {
      type: 'merge-bubbles',
      bubbleIds: ['region-a', 'region-b'],
    });
    expect(Object.keys(state.present?.bubbles ?? {})).toEqual(['region-a']);
    expect(state.present?.bubbles['region-a']?.boundingBox).toMatchObject({
      x: 10,
      width: 110,
    });
    expect(state.present?.bubbles['region-a']?.reviewStatus).toBe('edited');
    state = editorReducer(state, {
      type: 'split-bubble',
      bubbleId: 'region-a',
      secondBubbleId: 'region-a-split',
    });
    expect(Object.keys(state.present?.bubbles ?? {})).toEqual([
      'region-a',
      'region-a-split',
    ]);
    expect(state.present?.bubbles['region-a']?.boundingBox.width).toBeCloseTo(
      55,
    );
    expect(
      state.present?.bubbles['region-a-split']?.boundingBox.width,
    ).toBeCloseTo(55);
    expect(
      editorReducer(state, { type: 'undo' }).present?.bubbles['region-a-split'],
    ).toBeUndefined();
  });

  it('keeps geometry, OCR, captions and timing in one undoable document', () => {
    const space = createImageSpace('image:editor-test', 200, 100);
    const initialized = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const polygon = {
      coordinateSpace: space,
      points: [
        { x: 10, y: 10, coordinateSpace: space },
        { x: 80, y: 10, coordinateSpace: space },
        { x: 80, y: 50, coordinateSpace: space },
        { x: 10, y: 50, coordinateSpace: space },
      ],
    };
    const added = editorReducer(initialized, {
      type: 'add-bubble',
      id: 'bubble-a',
      polygon,
    });
    expect(added.present?.bubbles['bubble-a']?.boundingBox).toMatchObject({
      x: 10,
      y: 10,
      width: 70,
      height: 40,
      coordinateSpace: space,
    });
    const withOcr = editorReducer(added, {
      type: 'edit-ocr',
      bubbleId: 'bubble-a',
      text: 'Original lettering',
    });
    const withCaption = editorReducer(withOcr, {
      type: 'edit-dialogue',
      dialogueId: 'dialogue:bubble-a',
      patch: {
        caption: 'Replacement',
        start: 2,
        end: 4,
        fontSizePx: 18,
        lineSpacingPx: 3,
        paddingPx: 5,
      },
    });
    expect(withCaption.present?.observations['ocr:bubble-a']?.text).toBe(
      'Original lettering',
    );
    expect(withCaption.present?.dialogues['dialogue:bubble-a']).toMatchObject({
      caption: 'Replacement',
      start: 2,
      end: 4,
      fontSizePx: 18,
      lineSpacingPx: 3,
      paddingPx: 5,
    });
    const moved = editorReducer(withCaption, {
      type: 'edit-bubble',
      bubbleId: 'bubble-a',
      patch: { x: 20 },
    });
    expect(moved.present?.bubbles['bubble-a']?.boundingBox.x).toBe(20);
    expect(
      editorReducer(moved, { type: 'undo' }).present?.bubbles['bubble-a']
        ?.boundingBox.x,
    ).toBe(10);
    expect(
      editorReducer(editorReducer(moved, { type: 'undo' }), { type: 'redo' })
        .present?.bubbles['bubble-a']?.boundingBox.x,
    ).toBe(20);
  });

  it('rejects invalid geometry and timing without adding history entries', () => {
    const space = createImageSpace('image:editor-invalid', 20, 20);
    const initialized = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const polygon = {
      coordinateSpace: space,
      points: [
        { x: 1, y: 1, coordinateSpace: space },
        { x: 10, y: 1, coordinateSpace: space },
        { x: 10, y: 10, coordinateSpace: space },
        { x: 1, y: 10, coordinateSpace: space },
      ],
    };
    const added = editorReducer(initialized, {
      type: 'add-bubble',
      id: 'bubble-b',
      polygon,
    });
    expect(
      editorReducer(added, {
        type: 'edit-bubble',
        bubbleId: 'bubble-b',
        patch: { width: -3 },
      }),
    ).toBe(added);
    expect(
      editorReducer(added, {
        type: 'edit-dialogue',
        dialogueId: 'dialogue:bubble-b',
        patch: { end: 0 },
      }),
    ).toBe(added);
  });

  it('collapses a burst of text typing into one undo step', () => {
    const space = createImageSpace('image:editor-typing', 200, 100);
    const initialized = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    const added = editorReducer(initialized, {
      type: 'add-bubble',
      id: 'bubble-t',
      polygon: {
        coordinateSpace: space,
        points: [
          { x: 10, y: 10, coordinateSpace: space },
          { x: 90, y: 10, coordinateSpace: space },
          { x: 90, y: 70, coordinateSpace: space },
          { x: 10, y: 70, coordinateSpace: space },
        ],
      },
    });
    const coalesce = (atMs: number) =>
      ({ key: 'ocr:bubble-t', atMs }) as const;
    let state = editorReducer(added, {
      type: 'edit-ocr',
      bubbleId: 'bubble-t',
      text: 'H',
      coalesce: coalesce(1_000),
    });
    state = editorReducer(state, {
      type: 'edit-ocr',
      bubbleId: 'bubble-t',
      text: 'Hi',
      coalesce: coalesce(1_050),
    });
    state = editorReducer(state, {
      type: 'edit-ocr',
      bubbleId: 'bubble-t',
      text: 'Hi!',
      coalesce: coalesce(1_100),
    });
    expect(state.present?.observations['ocr:bubble-t']?.text).toBe('Hi!');
    // Three keystrokes added only one undo step on top of initialize + add-bubble.
    expect(state.past.length).toBe(2);
    const undone = editorReducer(state, { type: 'undo' });
    expect(undone.present?.observations['ocr:bubble-t']?.text).toBe('');
    // A typing pause starts a fresh undo step.
    const later = editorReducer(state, {
      type: 'edit-ocr',
      bubbleId: 'bubble-t',
      text: 'Hi!!',
      coalesce: coalesce(2_000),
    });
    expect(
      editorReducer(later, { type: 'undo' }).present?.observations['ocr:bubble-t']
        ?.text,
    ).toBe('Hi!');
  });

  it('splits a dialogue at the playhead into two timing clips', () => {
    const space = createImageSpace('image:split-test', 200, 100);
    let state = editorReducer(emptyEditorHistory, {
      type: 'initialize',
      imageSpace: space,
    });
    state = editorReducer(state, {
      type: 'import-analysis',
      bubbles: [
        {
          id: 'split-b',
          kind: 'speech',
          confidence: 0.9,
          points: [
            { x: 10, y: 10 },
            { x: 90, y: 10 },
            { x: 90, y: 70 },
            { x: 10, y: 70 },
          ],
        },
      ],
    });
    const source = state.present?.dialogues['dialogue:split-b'];
    expect(source).toBeTruthy();
    // Default clip is 0–1s; stretch it so a mid-clip split is valid.
    state = editorReducer(state, {
      type: 'edit-dialogue',
      dialogueId: 'dialogue:split-b',
      patch: { start: 0, end: 3 },
    });
    const split = editorReducer(state, {
      type: 'split-dialogue',
      dialogueId: 'dialogue:split-b',
      atSeconds: 1.5,
      newDialogueId: 'dialogue:split-b:tail',
    });
    const first = split.present?.dialogues['dialogue:split-b'];
    const second = split.present?.dialogues['dialogue:split-b:tail'];
    expect(first?.start).toBeCloseTo(0);
    expect(first?.end).toBeCloseTo(1.5);
    expect(second?.start).toBeCloseTo(1.5);
    expect(second?.end).toBeCloseTo(3);
    expect(second?.caption).toBe(source!.caption);
    expect(split.present?.order).toContain('dialogue:split-b:tail');
    // Out-of-range split is a no-op.
    const rejected = editorReducer(split, {
      type: 'split-dialogue',
      dialogueId: 'dialogue:split-b',
      atSeconds: first!.start,
      newDialogueId: 'dialogue:nope',
    });
    expect(rejected.present?.dialogues['dialogue:nope']).toBeUndefined();
  });
});
