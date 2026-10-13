import { describe, expect, it } from 'vitest';
import {
  REVIEW_HOTKEYS,
  mapReviewHotkey,
  type KeyboardEventLike,
  type ReviewAction,
} from '../../apps/web/src/review-hotkeys.js';

function keyEvent(
  key: string,
  modifiers: Partial<KeyboardEventLike> = {},
): KeyboardEventLike {
  return { key, ...modifiers };
}

describe('review hotkey mapping', () => {
  it('maps undo and redo chords', () => {
    expect(mapReviewHotkey(keyEvent('z', { metaKey: true }))).toEqual({
      type: 'undo',
    });
    expect(mapReviewHotkey(keyEvent('z', { ctrlKey: true }))).toEqual({
      type: 'undo',
    });
    expect(
      mapReviewHotkey(keyEvent('z', { metaKey: true, shiftKey: true })),
    ).toEqual({ type: 'redo' });
    expect(
      mapReviewHotkey(keyEvent('Z', { ctrlKey: true, shiftKey: true })),
    ).toEqual({ type: 'redo' });
  });

  it('maps the review flow bindings', () => {
    expect(mapReviewHotkey(keyEvent('Enter'))).toEqual({ type: 'accept' });
    expect(mapReviewHotkey(keyEvent('a'))).toEqual({ type: 'accept' });
    expect(mapReviewHotkey(keyEvent('A', { shiftKey: true }))).toEqual({
      type: 'accept',
    });
    expect(mapReviewHotkey(keyEvent('r'))).toEqual({ type: 'reject' });
    expect(mapReviewHotkey(keyEvent('j'))).toEqual({ type: 'next' });
    expect(mapReviewHotkey(keyEvent('ArrowDown'))).toEqual({ type: 'next' });
    expect(mapReviewHotkey(keyEvent('k'))).toEqual({ type: 'previous' });
    expect(mapReviewHotkey(keyEvent('ArrowUp'))).toEqual({ type: 'previous' });
    expect(mapReviewHotkey(keyEvent('e'))).toEqual({ type: 'edit' });
    expect(mapReviewHotkey(keyEvent(' ', { code: 'Space' }))).toEqual({
      type: 'toggle-play',
    });
    expect(mapReviewHotkey(keyEvent('Spacebar'))).toEqual({
      type: 'toggle-play',
    });
  });

  it('maps audio seeking and canvas mode bindings', () => {
    expect(mapReviewHotkey(keyEvent('ArrowLeft'))).toEqual({
      type: 'seek-back',
    });
    expect(mapReviewHotkey(keyEvent('ArrowRight'))).toEqual({
      type: 'seek-forward',
    });
    expect(mapReviewHotkey(keyEvent('Home'))).toEqual({ type: 'seek-start' });
    expect(mapReviewHotkey(keyEvent('End'))).toEqual({ type: 'seek-end' });
    expect(mapReviewHotkey(keyEvent('v'))).toEqual({ type: 'mode-select' });
    expect(mapReviewHotkey(keyEvent('b'))).toEqual({ type: 'mode-bubble' });
  });

  it('maps digits one through nine to alternative indexes', () => {
    for (let digit = 1; digit <= 9; digit += 1) {
      expect(mapReviewHotkey(keyEvent(String(digit)))).toEqual({
        type: 'select-alternative',
        index: digit - 1,
      });
    }
  });

  it('ignores unknown keys and zero', () => {
    for (const key of ['0', 'q', 'Escape', 'F5', 'Tab', 'Backspace', '']) {
      expect(mapReviewHotkey(keyEvent(key))).toBeNull();
    }
  });

  it('never steals browser chords outside undo/redo', () => {
    expect(mapReviewHotkey(keyEvent('a', { metaKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent('e', { ctrlKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent('Enter', { ctrlKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent('1', { metaKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent('z', { altKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent('a', { altKey: true }))).toBeNull();
    expect(
      mapReviewHotkey(keyEvent('z', { metaKey: true, altKey: true })),
    ).toBeNull();
    expect(mapReviewHotkey(keyEvent('ArrowDown', { metaKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent(' ', { ctrlKey: true }))).toBeNull();
    expect(mapReviewHotkey(keyEvent('Home', { ctrlKey: true }))).toBeNull();
  });

  it('leaves every key to the text field while editing except undo/redo', () => {
    for (const key of ['a', 'Enter', 'j', 'e', 'r', ' ', '1', 'ArrowDown']) {
      expect(mapReviewHotkey(keyEvent(key, { isEditingText: true }))).toBeNull();
    }
    expect(
      mapReviewHotkey(keyEvent('z', { metaKey: true, isEditingText: true })),
    ).toEqual({ type: 'undo' });
    expect(
      mapReviewHotkey(
        keyEvent('z', {
          ctrlKey: true,
          shiftKey: true,
          isEditingText: true,
        }),
      ),
    ).toEqual({ type: 'redo' });
  });

  it('matches every documented binding and keeps aliases consistent', () => {
    const expectations: readonly {
      event: KeyboardEventLike;
      action: { readonly type: ReviewAction['type']; readonly index?: number };
    }[] = [
      { event: keyEvent('z', { metaKey: true }), action: { type: 'undo' } },
      {
        event: keyEvent('z', { ctrlKey: true, shiftKey: true }),
        action: { type: 'redo' },
      },
      { event: keyEvent('Enter'), action: { type: 'accept' } },
      { event: keyEvent('a'), action: { type: 'accept' } },
      { event: keyEvent('r'), action: { type: 'reject' } },
      { event: keyEvent('j'), action: { type: 'next' } },
      { event: keyEvent('ArrowDown'), action: { type: 'next' } },
      { event: keyEvent('k'), action: { type: 'previous' } },
      { event: keyEvent('ArrowUp'), action: { type: 'previous' } },
      { event: keyEvent('e'), action: { type: 'edit' } },
      {
        event: keyEvent(' ', { code: 'Space' }),
        action: { type: 'toggle-play' },
      },
      { event: keyEvent('ArrowLeft'), action: { type: 'seek-back' } },
      { event: keyEvent('ArrowRight'), action: { type: 'seek-forward' } },
      { event: keyEvent('Home'), action: { type: 'seek-start' } },
      { event: keyEvent('End'), action: { type: 'seek-end' } },
      { event: keyEvent('v'), action: { type: 'mode-select' } },
      { event: keyEvent('b'), action: { type: 'mode-bubble' } },
      {
        event: keyEvent('3'),
        action: { type: 'select-alternative', index: 2 },
      },
    ];
    for (const { event, action } of expectations)
      expect(mapReviewHotkey(event)).toEqual(action);
    const documented = new Map(
      REVIEW_HOTKEYS.map((doc) => [doc.action, doc.keys]),
    );
    for (const { action } of expectations)
      expect(documented.has(action.type)).toBe(true);
    // Aliases of one action must not introduce a second action for that key set.
    expect(mapReviewHotkey(keyEvent('j'))).toEqual(
      mapReviewHotkey(keyEvent('ArrowDown')),
    );
    expect(mapReviewHotkey(keyEvent('a'))).toEqual(
      mapReviewHotkey(keyEvent('Enter')),
    );
    expect(mapReviewHotkey(keyEvent('k'))).toEqual(
      mapReviewHotkey(keyEvent('ArrowUp')),
    );
  });

  it('documents each binding once with a description', () => {
    expect(REVIEW_HOTKEYS.length).toBeGreaterThan(0);
    const keys = new Set(REVIEW_HOTKEYS.map((doc) => doc.keys));
    expect(keys.size).toBe(REVIEW_HOTKEYS.length);
    for (const doc of REVIEW_HOTKEYS) {
      expect(doc.keys.length).toBeGreaterThan(0);
      expect(doc.description.length).toBeGreaterThan(0);
    }
  });
});
