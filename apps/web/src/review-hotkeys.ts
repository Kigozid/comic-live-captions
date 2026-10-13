/**
 * Keyboard-first review shortcuts.
 *
 * The core review loop is "correct text, accept, next": every binding below is
 * mapped by the pure `mapReviewHotkey` function so the mapping can be unit
 * tested without a DOM. Callers pass `isEditingText` while focus is inside a
 * text field; only the undo/redo chords survive so typing stays untouched.
 */

export interface KeyboardEventLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  /** True while focus is inside an input, textarea, select, or editable node. */
  readonly isEditingText?: boolean;
}

export type ReviewAction =
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'accept' }
  | { readonly type: 'reject' }
  | { readonly type: 'next' }
  | { readonly type: 'previous' }
  | { readonly type: 'edit' }
  | { readonly type: 'toggle-play' }
  | { readonly type: 'seek-back' }
  | { readonly type: 'seek-forward' }
  | { readonly type: 'seek-start' }
  | { readonly type: 'seek-end' }
  | { readonly type: 'mode-select' }
  | { readonly type: 'mode-bubble' }
  | { readonly type: 'select-alternative'; readonly index: number };

export interface ReviewHotkeyDoc {
  readonly keys: string;
  readonly action: ReviewAction['type'];
  readonly description: string;
}

/** Human-readable documentation of every review binding. */
export const REVIEW_HOTKEYS: readonly ReviewHotkeyDoc[] = Object.freeze([
  Object.freeze({
    keys: 'Cmd/Ctrl+Z',
    action: 'undo',
    description: 'Undo the last editor action',
  }),
  Object.freeze({
    keys: 'Cmd/Ctrl+Shift+Z',
    action: 'redo',
    description: 'Redo the last undone action',
  }),
  Object.freeze({
    keys: 'Enter or A',
    action: 'accept',
    description: 'Accept the current review item',
  }),
  Object.freeze({
    keys: 'R',
    action: 'reject',
    description: 'Reject the current review item',
  }),
  Object.freeze({
    keys: 'J or ArrowDown',
    action: 'next',
    description: 'Move to the next review item',
  }),
  Object.freeze({
    keys: 'K or ArrowUp',
    action: 'previous',
    description: 'Move to the previous review item',
  }),
  Object.freeze({
    keys: 'E',
    action: 'edit',
    description: 'Edit the current item text',
  }),
  Object.freeze({
    keys: 'Space',
    action: 'toggle-play',
    description: 'Play or pause the narration audio',
  }),
  Object.freeze({
    keys: 'ArrowLeft',
    action: 'seek-back',
    description: 'Nudge the audio position backward',
  }),
  Object.freeze({
    keys: 'ArrowRight',
    action: 'seek-forward',
    description: 'Nudge the audio position forward',
  }),
  Object.freeze({
    keys: 'Home',
    action: 'seek-start',
    description: 'Seek to the start of the audio',
  }),
  Object.freeze({
    keys: 'End',
    action: 'seek-end',
    description: 'Seek to the end of the audio',
  }),
  Object.freeze({
    keys: 'V',
    action: 'mode-select',
    description: 'Switch the canvas to select mode',
  }),
  Object.freeze({
    keys: 'B',
    action: 'mode-bubble',
    description: 'Switch the canvas to bubble drawing mode',
  }),
  Object.freeze({
    keys: '1-9',
    action: 'select-alternative',
    description: 'Pick the nth alternative for the current item',
  }),
]);

/**
 * Maps a key event to a review action. Returns null for unbound keys and for
 * browser-reserved combinations (any Cmd/Ctrl/Alt chord other than undo/redo)
 * so nothing else is stolen from the platform.
 */
export function mapReviewHotkey(event: KeyboardEventLike): ReviewAction | null {
  const command = event.metaKey === true || event.ctrlKey === true;
  const key = event.key;
  if (command) {
    if (event.altKey) return null;
    if (key.toLowerCase() === 'z')
      return Object.freeze({
        type: event.shiftKey ? ('redo' as const) : ('undo' as const),
      });
    return null;
  }
  if (event.altKey) return null;
  // While typing, only undo/redo chords are forwarded; every other key is left
  // to the text field.
  if (event.isEditingText === true) return null;
  if (event.code === 'Space' || key === ' ' || key === 'Spacebar')
    return Object.freeze({ type: 'toggle-play' });
  if (key === 'Enter') return Object.freeze({ type: 'accept' });
  if (key === 'ArrowDown') return Object.freeze({ type: 'next' });
  if (key === 'ArrowUp') return Object.freeze({ type: 'previous' });
  if (key === 'ArrowLeft') return Object.freeze({ type: 'seek-back' });
  if (key === 'ArrowRight') return Object.freeze({ type: 'seek-forward' });
  if (key === 'Home') return Object.freeze({ type: 'seek-start' });
  if (key === 'End') return Object.freeze({ type: 'seek-end' });
  switch (key.toLowerCase()) {
    case 'a':
      return Object.freeze({ type: 'accept' });
    case 'r':
      return Object.freeze({ type: 'reject' });
    case 'j':
      return Object.freeze({ type: 'next' });
    case 'k':
      return Object.freeze({ type: 'previous' });
    case 'e':
      return Object.freeze({ type: 'edit' });
    case 'v':
      return Object.freeze({ type: 'mode-select' });
    case 'b':
      return Object.freeze({ type: 'mode-bubble' });
    default:
      break;
  }
  if (/^[1-9]$/.test(key))
    return Object.freeze({ type: 'select-alternative', index: Number(key) - 1 });
  return null;
}
