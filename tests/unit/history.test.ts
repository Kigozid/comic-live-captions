import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_DEPTH,
  HistoryStack,
  clearHistory,
  pushHistory,
  redoHistory,
  undoHistory,
  type HistoryState,
} from '../../apps/web/src/history.js';

function state<T>(present: T | null, past: T[] = [], future: T[] = []) {
  return { present, past, future, lastEdit: null } satisfies HistoryState<T>;
}

describe('HistoryStack', () => {
  it('pushes snapshots and undoes/redoes them in order', () => {
    const stack = new HistoryStack<string>('a');
    stack.push('b');
    stack.push('c');
    expect(stack.present).toBe('c');
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
    expect(stack.undo()).toBe('b');
    expect(stack.undo()).toBe('a');
    expect(stack.canUndo).toBe(false);
    expect(stack.undo()).toBe('a');
    expect(stack.canRedo).toBe(true);
    expect(stack.redo()).toBe('b');
    expect(stack.redo()).toBe('c');
    expect(stack.canRedo).toBe(false);
    expect(stack.redo()).toBe('c');
    expect(stack.present).toBe('c');
  });

  it('drops the redo branch after a new push', () => {
    const stack = new HistoryStack<number>(0);
    stack.push(1);
    stack.push(2);
    stack.undo();
    expect(stack.canRedo).toBe(true);
    stack.push(9);
    expect(stack.present).toBe(9);
    expect(stack.canRedo).toBe(false);
    expect(stack.undo()).toBe(1);
  });

  it('enforces a maximum undo depth and drops the oldest steps', () => {
    const stack = new HistoryStack<number>(0, { maxDepth: 3 });
    for (let value = 1; value <= 6; value += 1) stack.push(value);
    // Only the newest 3 predecessors are kept: 3, 4, 5 (present is 6).
    expect(stack.undo()).toBe(5);
    expect(stack.undo()).toBe(4);
    expect(stack.undo()).toBe(3);
    expect(stack.undo()).toBe(3);
    expect(stack.canUndo).toBe(false);
  });

  it('defaults to a depth of fifty steps', () => {
    const stack = new HistoryStack<number>(0);
    for (let value = 1; value <= DEFAULT_HISTORY_DEPTH + 5; value += 1)
      stack.push(value);
    let steps = 0;
    while (stack.canUndo) {
      stack.undo();
      steps += 1;
    }
    expect(steps).toBe(DEFAULT_HISTORY_DEPTH);
  });

  it('rejects invalid depth and window options', () => {
    expect(() => new HistoryStack<number>(0, { maxDepth: 0 })).toThrow(
      RangeError,
    );
    expect(
      () => new HistoryStack<number>(0, { coalesceWindowMs: -1 }),
    ).toThrow(RangeError);
  });

  it('coalesces rapid edits sharing a key into one undo step', () => {
    const stack = new HistoryStack<string>('Hello');
    stack.push('Hello ', { coalesceKey: 'caption:1', atMs: 1_000 });
    stack.push('Hello w', { coalesceKey: 'caption:1', atMs: 1_100 });
    stack.push('Hello world', { coalesceKey: 'caption:1', atMs: 1_250 });
    // The whole typing burst is a single undo step.
    expect(stack.present).toBe('Hello world');
    expect(stack.undo()).toBe('Hello');
    expect(stack.canUndo).toBe(false);
    expect(stack.redo()).toBe('Hello world');
  });

  it('starts a new undo step when typing pauses exceed the window', () => {
    const stack = new HistoryStack<string>('a', { coalesceWindowMs: 400 });
    stack.push('ab', { coalesceKey: 'ocr:1', atMs: 1_000 });
    stack.push('abc', { coalesceKey: 'ocr:1', atMs: 1_200 });
    stack.push('abcd', { coalesceKey: 'ocr:1', atMs: 2_000 });
    expect(stack.undo()).toBe('abc');
    expect(stack.undo()).toBe('a');
  });

  it('does not coalesce across different keys or after undo', () => {
    const stack = new HistoryStack<string>('base');
    stack.push('one', { coalesceKey: 'ocr:1', atMs: 1_000 });
    stack.push('two', { coalesceKey: 'ocr:2', atMs: 1_050 });
    expect(stack.undo()).toBe('one');
    // After undo the coalesce marker is reset; retyping is its own step.
    stack.push('one!', { coalesceKey: 'ocr:1', atMs: 1_100 });
    stack.push('one!!', { coalesceKey: 'ocr:1', atMs: 1_120 });
    expect(stack.undo()).toBe('one');
    expect(stack.undo()).toBe('base');
  });

  it('clears undo and redo while keeping the present state', () => {
    const stack = new HistoryStack<string>('a');
    stack.push('b');
    stack.undo();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);
    stack.clear();
    expect(stack.present).toBe('a');
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    expect(stack.undo()).toBe('a');
    expect(stack.redo()).toBe('a');
  });
});

describe('pure history transitions', () => {
  it('mirrors the stack semantics for the editor reducer', () => {
    const initial = state<string>(null);
    const first = pushHistory(initial, 'a');
    expect(first.past).toEqual([]);
    const second = pushHistory(first, 'b');
    expect(second.past).toEqual(['a']);
    expect(undoHistory(second).present).toBe('a');
    expect(redoHistory(undoHistory(second)).present).toBe('b');
    expect(clearHistory(second)).toMatchObject({ past: [], future: [] });
    // No-op undo/redo return the identical state reference.
    expect(undoHistory(first)).toBe(first);
    expect(redoHistory(first)).toBe(first);
  });

  it('coalesces through the pure API using the shared window', () => {
    const initial = pushHistory(state<string>('x'), 'xy', {
      coalesce: { key: 'caption', atMs: 10 },
    });
    expect(initial.past).toEqual(['x']);
    const merged = pushHistory(initial, 'xyz', {
      coalesce: { key: 'caption', atMs: 20 },
    });
    expect(merged.past).toEqual(['x']);
    expect(merged.present).toBe('xyz');
    expect(undoHistory(merged).present).toBe('x');
  });
});
