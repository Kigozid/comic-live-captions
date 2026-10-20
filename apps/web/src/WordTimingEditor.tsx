import { useCallback, useRef } from 'react';
import {
  applyWordDrag,
  wordsForEditing,
  type EditableWordTiming,
} from './word-timing-edit.js';

/**
 * Per-caption word cue strip. Each word is a bar on the dialogue interval;
 * drag the bar to move it, drag edges to resize. Emits clamped timings.
 */
export function WordTimingEditor({
  captionText,
  startSeconds,
  endSeconds,
  words,
  onWordsChange,
  estimated,
}: {
  readonly captionText: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly words?: readonly EditableWordTiming[] | undefined;
  readonly onWordsChange?: ((words: readonly EditableWordTiming[]) => void) | undefined;
  readonly estimated?: boolean | undefined;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const rows = wordsForEditing(
    captionText,
    startSeconds,
    endSeconds,
    words,
  );
  const span = Math.max(0.05, endSeconds - startSeconds);

  const secondsFromPointer = useCallback(
    (clientX: number): number => {
      const rect = stripRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return startSeconds;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return startSeconds + ratio * span;
    },
    [span, startSeconds],
  );

  const beginDrag = useCallback(
    (
      index: number,
      mode: 'move' | 'start' | 'end',
      event: React.PointerEvent<HTMLElement>,
    ) => {
      if (!onWordsChange) return;
      event.preventDefault();
      event.stopPropagation();
      const originX = event.clientX;
      const origin = rows[index];
      if (!origin) return;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const at = secondsFromPointer(moveEvent.clientX);
        if (mode === 'move') {
          const delta = at - secondsFromPointer(originX);
          onWordsChange(applyWordDrag(rows, { index, delta }, startSeconds, endSeconds));
        } else if (mode === 'start') {
          onWordsChange(
            applyWordDrag(rows, { index, start: at }, startSeconds, endSeconds),
          );
        } else {
          onWordsChange(
            applyWordDrag(rows, { index, end: at }, startSeconds, endSeconds),
          );
        }
      };
      const onUp = () => {
        target.releasePointerCapture(event.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onWordsChange, rows, secondsFromPointer, startSeconds, endSeconds],
  );

  return (
    <div className="word-timing-editor">
      <div
        ref={stripRef}
        className="word-timing-strip"
        role="list"
        aria-label="Word timing cues"
        style={{ position: 'relative', height: 56, touchAction: 'none' }}
      >
        {rows.map((word, index) => {
          const left = ((word.start - startSeconds) / span) * 100;
          const width = Math.max(1.5, ((word.end - word.start) / span) * 100);
          return (
            <div
              key={`${index}-${word.text}`}
              role="listitem"
              aria-label={`Word ${word.text} ${word.start.toFixed(2)}–${word.end.toFixed(2)}s`}
              title={`${word.text} · ${word.start.toFixed(2)}–${word.end.toFixed(2)}s`}
              style={{
                position: 'absolute',
                top: 8 + (index % 2) * 22,
                left: `${left}%`,
                width: `${width}%`,
                height: 18,
                background: 'var(--ui-accent, #4f6ef7)',
                color: '#fff',
                borderRadius: 4,
                fontSize: 10,
                lineHeight: '18px',
                padding: '0 2px',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                cursor: 'grab',
                userSelect: 'none',
                boxSizing: 'border-box',
                borderLeft: '3px solid #1e3a8a',
                borderRight: '3px solid #1e3a8a',
              }}
              onPointerDown={(event) => beginDrag(index, 'move', event)}
            >
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 3,
                  height: '100%',
                  cursor: 'ew-resize',
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginDrag(index, 'start', event);
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  width: 3,
                  height: '100%',
                  cursor: 'ew-resize',
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginDrag(index, 'end', event);
                }}
              />
              {word.text}
            </div>
          );
        })}
      </div>
      <p
        style={{
          margin: '4px 0 0',
          fontSize: 10,
          color: 'var(--ui-muted)',
          lineHeight: 1.35,
        }}
      >
        {estimated !== false
          ? 'Drag a word to move it · drag edges to resize. Times may be estimated.'
          : 'Drag a word to move it · drag edges to resize.'}
      </p>
    </div>
  );
}
