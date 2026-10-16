import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { IconClose, IconEye, IconLock } from './editor-icons.js';
import {
  inspectImglyFile,
  type ImglySceneInspection,
} from './imgly-scene.js';
import { WorkspaceInspectorSlot } from './WorkspaceInspectorSlot.js';

export type InspectorSelection =
  | { kind: 'none' }
  | {
      kind: 'page';
      id: string;
      label: string;
      width: number;
      height: number;
      durationSeconds: number;
      index: number;
    }
  | {
      kind: 'bubble';
      id: string;
      label: string;
      confidence?: number;
      classification?: string;
      captionText?: string;
      fontFamily?: string;
      fontSizePx?: number;
      bounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      onCaptionTextChange?: (value: string) => void;
      onFontSizeChange?: (value: number) => void;
      onBoundsChange?: (bounds: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }) => void;
      onClassificationChange?: (kind: string) => void;
    }
  | {
      kind: 'caption';
      id: string;
      text: string;
      startSeconds: number;
      endSeconds: number;
      fontFamily?: string;
      fontSizePx?: number;
      onTextChange?: (value: string) => void;
      onTimeChange?: (start: number, end: number) => void;
      onFontSizeChange?: (value: number) => void;
    }
  | {
      kind: 'audio';
      id: string;
      label: string;
      durationSeconds: number;
      mediaType?: string;
    }
  | {
      kind: 'transition';
      id: string;
      label: string;
    };

export interface EditorInspectorProps {
  readonly selection: InspectorSelection;
  readonly theme: 'light' | 'dark';
  readonly onThemeChange: (theme: 'light' | 'dark') => void;
  readonly onClose?: () => void;
  readonly projectName: string;
  readonly pageCount: number;
  readonly durationSeconds: number;
  readonly fps: number;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3 className="inspector-section-title">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="inspector-row">
      <span className="inspector-label">{label}</span>
      <div className="inspector-control">{children}</div>
    </div>
  );
}

function Pill({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="inspector-pill" title={title}>
      {children}
    </span>
  );
}

export function EditorInspector({
  selection,
  theme,
  onThemeChange,
  onClose,
  projectName,
  pageCount,
  durationSeconds,
  fps,
}: EditorInspectorProps) {
  const [imglyResult, setImglyResult] = useState<ImglySceneInspection | null>(
    null,
  );
  const [imglyError, setImglyError] = useState<string | null>(null);
  const imglyInputRef = useRef<HTMLInputElement>(null);
  const title =
    selection.kind === 'none'
      ? 'Project'
      : selection.kind === 'page'
        ? selection.label
        : selection.kind === 'bubble'
          ? selection.label
          : selection.kind === 'caption'
            ? 'Caption'
            : selection.kind === 'audio'
              ? selection.label
              : selection.label;

  return (
    <aside className="editor-inspector" aria-label="Inspector">
      <header className="inspector-header">
        {onClose ? (
          <button
            className="ui-btn icon ghost"
            type="button"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <IconClose />
          </button>
        ) : null}
        <div className="inspector-title">{title}</div>
      </header>

      <div className="inspector-tabs" role="tablist">
        <button
          className={`inspector-tab ${selection.kind !== 'none' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={selection.kind !== 'none'}
        >
          Design
        </button>
        <button
          className={`inspector-tab ${selection.kind === 'none' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={selection.kind === 'none'}
        >
          Project
        </button>
      </div>

      <div className="inspector-scroll">
        {selection.kind === 'none' && (
          <>
            <Section title="Project">
              <Row label="Name">
                <Pill>{projectName}</Pill>
              </Row>
              <Row label="Pages">
                <Pill>{pageCount}</Pill>
              </Row>
              <Row label="Duration">
                <Pill>{durationSeconds.toFixed(1)}s</Pill>
              </Row>
              <Row label="Frame rate">
                <Pill>{fps} fps</Pill>
              </Row>
            </Section>
            <Section title="Appearance">
              <Row label="Theme">
                <button
                  className="ui-btn"
                  type="button"
                  onClick={() =>
                    onThemeChange(theme === 'light' ? 'dark' : 'light')
                  }
                >
                  {theme === 'light' ? 'Light' : 'Dark'}
                </button>
              </Row>
            </Section>
            <Section title="Export">
              <Row label="Engine">
                <Pill>Remotion · H.264</Pill>
              </Row>
              <Row label="Notes">
                <span className="inspector-label">
                  Captions stay inside speech bubbles.
                </span>
              </Row>
            </Section>
            <Section title="CE.SDK scene">
              <Row label="Inspect .imgly">
                <button
                  className="ui-btn"
                  type="button"
                  onClick={() => imglyInputRef.current?.click()}
                >
                  Choose file…
                </button>
                <input
                  ref={imglyInputRef}
                  className="ui-sr"
                  type="file"
                  accept=".imgly,application/json"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (!file) return;
                    setImglyError(null);
                    void inspectImglyFile(file)
                      .then(setImglyResult)
                      .catch((cause: unknown) =>
                        setImglyError(
                          cause instanceof Error
                            ? cause.message
                            : 'Could not inspect scene file.',
                        ),
                      );
                  }}
                />
              </Row>
              {imglyError ? (
                <p className="inspector-label" style={{ color: 'var(--ui-danger)' }}>
                  {imglyError}
                </p>
              ) : null}
              {imglyResult ? (
                <div style={{ width: '100%', fontSize: 11, lineHeight: 1.45 }}>
                  <Row label="Encoding">
                    <Pill>{imglyResult.encodingGuess}</Pill>
                  </Row>
                  <Row label="Magic">
                    <Pill>{imglyResult.magic ?? '—'}</Pill>
                  </Row>
                  <Row label="Bytes">
                    <Pill>
                      {imglyResult.byteLength} → {imglyResult.decodedByteLength}
                    </Pill>
                  </Row>
                  <ul
                    style={{
                      margin: '8px 0 0',
                      padding: '0 0 0 14px',
                      color: 'var(--ui-muted)',
                    }}
                  >
                    {imglyResult.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                  {!imglyResult.parseable ? (
                    <p style={{ marginTop: 8, color: 'var(--ui-muted)' }}>
                      Tracks/clips are not extracted without CE.SDK — sample ad
                      content is never hard-coded into Comic Captioner.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </Section>
          </>
        )}

        {selection.kind === 'page' && (
          <>
            <Section title="Page">
              <Row label="Size">
                <Pill>
                  {selection.width} × {selection.height}
                </Pill>
              </Row>
              <Row label="Aspect">
                <Pill>
                  {(selection.width / Math.max(1, selection.height)).toFixed(2)}
                </Pill>
              </Row>
              <Row label="Duration">
                <Pill>{selection.durationSeconds.toFixed(1)}s</Pill>
              </Row>
              <Row label="Order">
                <Pill>#{selection.index + 1}</Pill>
              </Row>
            </Section>
            <Section title="Visibility">
              <Row label="Show">
                <IconEye />
              </Row>
              <Row label="Lock">
                <IconLock />
              </Row>
            </Section>
          </>
        )}

        {selection.kind === 'bubble' && (
          <>
            <Section title="Speech Bubble">
              <Row label="ID">
                <Pill title={selection.id}>{selection.id.slice(0, 14)}…</Pill>
              </Row>
              <Row label="Class">
                <select
                  className="inspector-field"
                  value={selection.classification ?? 'speech'}
                  onChange={(event) =>
                    selection.onClassificationChange?.(event.currentTarget.value)
                  }
                  aria-label="Bubble classification"
                >
                  <option value="speech">speech</option>
                  <option value="thought">thought</option>
                  <option value="narration">narration</option>
                  <option value="unknown">unknown</option>
                </select>
              </Row>
              <Row label="Confidence">
                <Pill>
                  {selection.confidence != null
                    ? `${Math.round(selection.confidence * 100)}%`
                    : '—'}
                </Pill>
              </Row>
            </Section>
            <Section title="Bounds">
              <Row label="X">
                <input
                  className="inspector-field"
                  type="number"
                  value={Math.round(selection.bounds?.x ?? 0)}
                  onChange={(event) =>
                    selection.onBoundsChange?.({
                      x: Number(event.currentTarget.value),
                    })
                  }
                  aria-label="Bubble x"
                />
              </Row>
              <Row label="Y">
                <input
                  className="inspector-field"
                  type="number"
                  value={Math.round(selection.bounds?.y ?? 0)}
                  onChange={(event) =>
                    selection.onBoundsChange?.({
                      y: Number(event.currentTarget.value),
                    })
                  }
                  aria-label="Bubble y"
                />
              </Row>
              <Row label="Width">
                <input
                  className="inspector-field"
                  type="number"
                  min={1}
                  value={Math.round(selection.bounds?.width ?? 0)}
                  onChange={(event) =>
                    selection.onBoundsChange?.({
                      width: Number(event.currentTarget.value),
                    })
                  }
                  aria-label="Bubble width"
                />
              </Row>
              <Row label="Height">
                <input
                  className="inspector-field"
                  type="number"
                  min={1}
                  value={Math.round(selection.bounds?.height ?? 0)}
                  onChange={(event) =>
                    selection.onBoundsChange?.({
                      height: Number(event.currentTarget.value),
                    })
                  }
                  aria-label="Bubble height"
                />
              </Row>
            </Section>
            <Section title="Caption">
              <div style={{ width: '100%' }}>
                <textarea
                  className="inspector-field"
                  style={{ width: '100%', height: 72, resize: 'vertical' }}
                  value={selection.captionText ?? ''}
                  onChange={(event) =>
                    selection.onCaptionTextChange?.(event.currentTarget.value)
                  }
                  aria-label="Caption text"
                />
              </div>
              <Row label="Font">
                <Pill>{selection.fontFamily ?? 'Helvetica'}</Pill>
              </Row>
              <Row label="Size">
                <input
                  className="inspector-field"
                  type="number"
                  min={8}
                  max={96}
                  value={selection.fontSizePx ?? 28}
                  onChange={(event) =>
                    selection.onFontSizeChange?.(
                      Number(event.currentTarget.value),
                    )
                  }
                  aria-label="Caption font size"
                />
              </Row>
            </Section>
            <Section title="Fit">
              <Row label="Safe margin">
                <Pill>8 px</Pill>
              </Row>
              <Row label="Placement">
                <Pill>Inside bubble</Pill>
              </Row>
            </Section>
          </>
        )}

        {selection.kind === 'caption' && (
          <>
            <Section title="Text">
              <textarea
                className="inspector-field"
                style={{ width: '100%', height: 72, resize: 'vertical' }}
                value={selection.text}
                onChange={(event) =>
                  selection.onTextChange?.(event.currentTarget.value)
                }
                aria-label="Caption text"
              />
              <Row label="Font">
                <Pill>{selection.fontFamily ?? 'Helvetica'}</Pill>
              </Row>
              <Row label="Size">
                <input
                  className="inspector-field"
                  type="number"
                  min={8}
                  max={96}
                  value={selection.fontSizePx ?? 28}
                  onChange={(event) =>
                    selection.onFontSizeChange?.(
                      Number(event.currentTarget.value),
                    )
                  }
                  aria-label="Caption font size"
                />
              </Row>
            </Section>
            <Section title="Timing">
              <Row label="Start">
                <input
                  className="inspector-field"
                  type="number"
                  step={0.05}
                  value={selection.startSeconds}
                  onChange={(event) =>
                    selection.onTimeChange?.(
                      Number(event.currentTarget.value),
                      selection.endSeconds,
                    )
                  }
                  aria-label="Caption start"
                />
              </Row>
              <Row label="End">
                <input
                  className="inspector-field"
                  type="number"
                  step={0.05}
                  value={selection.endSeconds}
                  onChange={(event) =>
                    selection.onTimeChange?.(
                      selection.startSeconds,
                      Number(event.currentTarget.value),
                    )
                  }
                  aria-label="Caption end"
                />
              </Row>
            </Section>
          </>
        )}

        {selection.kind === 'audio' && (
          <Section title="Narration">
            <Row label="Asset">
              <Pill title={selection.label}>{selection.label.slice(0, 18)}</Pill>
            </Row>
            <Row label="Duration">
              <Pill>{selection.durationSeconds.toFixed(2)}s</Pill>
            </Row>
            <Row label="Type">
              <Pill>{selection.mediaType ?? 'audio'}</Pill>
            </Row>
          </Section>
        )}

        {selection.kind === 'transition' && (
          <Section title="Transition">
            <Row label="Preset">
              <Pill>{selection.label}</Pill>
            </Row>
          </Section>
        )}

        <WorkspaceInspectorSlot />
      </div>
    </aside>
  );
}
