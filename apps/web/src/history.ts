/** A text-typing burst marker used to merge rapid edits into one undo step. */
export interface CoalesceHint {
  readonly key: string;
  readonly atMs: number;
}

export interface HistoryState<T> {
  readonly present: T | null;
  readonly past: readonly T[];
  readonly future: readonly T[];
  /** Last coalescable edit; undone as soon as any other action is pushed. */
  readonly lastEdit?: CoalesceHint | null;
}

export interface HistoryStackOptions {
  /** Maximum number of undo steps kept. Oldest entries are dropped first. */
  readonly maxDepth?: number;
  /** Window in which consecutive edits sharing a coalesce key merge into one step. */
  readonly coalesceWindowMs?: number;
}

export interface HistoryPushOptions extends HistoryStackOptions {
  readonly coalesce?: CoalesceHint | undefined;
}

export const DEFAULT_HISTORY_DEPTH = 50;
export const DEFAULT_COALESCE_WINDOW_MS = 400;

function limits(options?: HistoryStackOptions): {
  maxDepth: number;
  coalesceWindowMs: number;
} {
  const maxDepth = options?.maxDepth ?? DEFAULT_HISTORY_DEPTH;
  const coalesceWindowMs =
    options?.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  if (!Number.isInteger(maxDepth) || maxDepth < 1)
    throw new RangeError('History depth must be a positive integer.');
  if (!Number.isFinite(coalesceWindowMs) || coalesceWindowMs < 0)
    throw new RangeError('History coalesce window must be non-negative.');
  return { maxDepth, coalesceWindowMs };
}

function freezeState<T>(state: HistoryState<T>): HistoryState<T> {
  return Object.freeze({
    present: state.present,
    past: Object.freeze([...state.past]),
    future: Object.freeze([...state.future]),
    lastEdit: state.lastEdit ?? null,
  });
}

/**
 * Records `next` as the new present. When `coalesce` matches the previous
 * coalescable edit within the debounce window, the move replaces present in
 * place so the whole typing burst stays a single undo step.
 */
export function pushHistory<T>(
  state: HistoryState<T>,
  next: T,
  options?: HistoryPushOptions,
): HistoryState<T> {
  const { maxDepth, coalesceWindowMs } = limits(options);
  const coalesce = options?.coalesce;
  const previous = state.lastEdit ?? null;
  const merges =
    coalesce !== undefined &&
    previous !== null &&
    previous.key === coalesce.key &&
    coalesce.atMs - previous.atMs <= coalesceWindowMs &&
    coalesce.atMs >= previous.atMs;
  if (merges)
    return freezeState({
      present: next,
      past: state.past,
      future: state.future,
      lastEdit: coalesce,
    });
  const past =
    state.present === null
      ? state.past
      : [...state.past, state.present].slice(-maxDepth);
  return freezeState({
    present: next,
    past,
    future: [],
    lastEdit: coalesce ?? null,
  });
}

/** Moves one step back. Returns the state unchanged when there is nothing to undo. */
export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  const previous = state.past.at(-1);
  if (previous === undefined || state.present === null) return state;
  return freezeState({
    present: previous,
    past: state.past.slice(0, -1),
    future: [state.present, ...state.future],
    lastEdit: null,
  });
}

/** Moves one step forward. Returns the state unchanged when there is nothing to redo. */
export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  const next = state.future[0];
  if (next === undefined || state.present === null) return state;
  return freezeState({
    present: next,
    past: [...state.past, state.present],
    future: state.future.slice(1),
    lastEdit: null,
  });
}

/** Drops every undo/redo step while keeping the present state. */
export function clearHistory<T>(state: HistoryState<T>): HistoryState<T> {
  return freezeState({ present: state.present, past: [], future: [], lastEdit: null });
}

/**
 * Mutable undo/redo stack for editor actions. Snapshot-based with a depth
 * limit; consecutive text edits that share a coalesce key inside the debounce
 * window collapse into one undo step.
 */
export class HistoryStack<T> {
  private state: HistoryState<T>;
  private readonly maxDepth: number;
  private readonly coalesceWindowMs: number;

  constructor(initial: T | null = null, options?: HistoryStackOptions) {
    const { maxDepth, coalesceWindowMs } = limits(options);
    this.maxDepth = maxDepth;
    this.coalesceWindowMs = coalesceWindowMs;
    this.state = Object.freeze({
      present: initial,
      past: Object.freeze([]) as readonly T[],
      future: Object.freeze([]) as readonly T[],
      lastEdit: null,
    });
  }

  get present(): T | null {
    return this.state.present;
  }

  get canUndo(): boolean {
    return this.state.past.length > 0;
  }

  get canRedo(): boolean {
    return this.state.future.length > 0;
  }

  push(
    state: T,
    options?: { readonly coalesceKey?: string; readonly atMs?: number },
  ): void {
    const coalesce =
      options?.coalesceKey === undefined
        ? undefined
        : {
            key: options.coalesceKey,
            atMs: options.atMs ?? Date.now(),
          };
    this.state = pushHistory(this.state, state, {
      coalesce,
      maxDepth: this.maxDepth,
      coalesceWindowMs: this.coalesceWindowMs,
    });
  }

  undo(): T | null {
    this.state = undoHistory(this.state);
    return this.state.present;
  }

  redo(): T | null {
    this.state = redoHistory(this.state);
    return this.state.present;
  }

  clear(): void {
    this.state = clearHistory(this.state);
  }
}
