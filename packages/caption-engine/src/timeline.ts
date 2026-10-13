import type { DialogueEvent } from '@comic-captioner/core';
import type { AudioTime } from '@comic-captioner/shared';

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

/**
 * Stateless audio-time lookup for dialogue events. Intervals are half-open
 * [start, end): a segment is active at its start and inactive at its end.
 * When intervals overlap, latest start wins, then earliest end, then ID.
 */
export class TimelineEngine {
  readonly #events: readonly DialogueEvent[];
  readonly #timebase: AudioTime['timebase'] | undefined;
  readonly #unit: AudioTime['unit'] | undefined;

  constructor(events: readonly DialogueEvent[]) {
    const ids = new Set<string>();
    const first = events[0];
    this.#timebase = first?.start.timebase;
    this.#unit = first?.start.unit;
    for (const event of events) {
      if (!event.id || ids.has(event.id))
        throw new TimelineError(
          'Dialogue event IDs must be unique and non-empty.',
        );
      ids.add(event.id);
      if (
        event.start.timebase !== event.end.timebase ||
        event.start.unit !== event.end.unit ||
        (this.#timebase !== undefined &&
          (event.start.timebase !== this.#timebase ||
            event.start.unit !== this.#unit))
      ) {
        throw new TimelineError(
          'All event times must use one matching timebase and unit.',
        );
      }
      if (
        !Number.isFinite(event.start.value) ||
        !Number.isFinite(event.end.value) ||
        event.start.value < 0 ||
        event.end.value <= event.start.value
      ) {
        throw new TimelineError(
          'Dialogue event intervals must be finite, non-negative, and non-empty.',
        );
      }
      if (!event.caption.trim() || event.layout.bubbleId !== event.bubbleId)
        throw new TimelineError(
          'Dialogue event caption and layout must match its bubble.',
        );
      if (
        !Number.isFinite(event.confidence) ||
        event.confidence < 0 ||
        event.confidence > 1
      )
        throw new TimelineError(
          'Dialogue event confidence must be between 0 and 1.',
        );
    }
    this.#events = Object.freeze([...events]);
    Object.freeze(this);
  }

  /** Returns one deterministic active event, or null during a gap. */
  getActiveDialogue(time: AudioTime): DialogueEvent | null {
    if (!Number.isFinite(time.value) || time.value < 0)
      throw new TimelineError('Lookup time must be finite and non-negative.');
    if (
      this.#timebase !== undefined &&
      (time.timebase !== this.#timebase || time.unit !== this.#unit)
    ) {
      throw new TimelineError(
        'Lookup time must use the timeline timebase and unit.',
      );
    }
    const active = this.#events.filter(
      (event) =>
        event.start.value <= time.value && time.value < event.end.value,
    );
    active.sort(
      (a, b) =>
        b.start.value - a.start.value ||
        a.end.value - b.end.value ||
        a.id.localeCompare(b.id),
    );
    return active[0] ?? null;
  }
}
