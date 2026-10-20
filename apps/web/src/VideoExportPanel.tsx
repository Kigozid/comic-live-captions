import { useCallback, useMemo, useRef, useState } from 'react';
import type { ExportBubble, ExportCaption } from './export-types.js';
import {
  cancelVideoExportJob,
  createVideoExportJob,
  downloadVideoExport,
  fetchVideoExportAvailability,
  isVideoExportSuccess,
  waitForVideoExportJob,
  type VideoExportJobSummary,
  type VideoExportStyleOptions,
} from './video-export-client.js';
import {
  DEFAULT_CAMERA,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_TRANSITIONS,
  compositionPropsFromExportPayload,
  type PanelSequenceStep,
} from '@comic-captioner/video-composer';
import {
  buildEditorPanelSequence,
  type PanelBounds,
} from './panel-sequence.js';
import { Player } from '@remotion/player';
import { MotionComicVideo } from '@comic-captioner/video-composer/remotion';

export interface VideoExportPanelProps {
  readonly pageBlob: Blob | null;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly audioBlob: Blob | null;
  readonly audioFormat: string;
  readonly durationSeconds: number;
  readonly captions: readonly ExportCaption[];
  readonly bubbles: readonly ExportBubble[];
  /** Detected page panels for multi-shot sequence export. */
  readonly panels?: readonly PanelBounds[];
  /** Multi-page comic sources for issue-length export. */
  readonly sourcePages?: readonly {
    readonly id: string;
    readonly blob: Blob;
    readonly width: number;
    readonly height: number;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly label: string;
    readonly bubbles: readonly unknown[];
  }[];
  readonly multiPageWarnings?: readonly string[];
  readonly projectName: string;
  readonly disabled?: boolean;
  readonly onMessage: (message: string) => void;
}

type ResolutionChoice = '720p' | '1080p' | 'custom';
type SequenceMode = 'full-page' | 'panel-sequence';

const PREVIEW_FPS = 12;

export function VideoExportPanel({
  pageBlob,
  pageWidth,
  pageHeight,
  audioBlob,
  audioFormat,
  durationSeconds,
  captions,
  bubbles,
  panels = [],
  sourcePages = [],
  multiPageWarnings = [],
  projectName,
  disabled = false,
  onMessage,
}: VideoExportPanelProps) {
  const [resolution, setResolution] = useState<ResolutionChoice>('720p');
  const [customWidth, setCustomWidth] = useState('1280');
  const [customHeight, setCustomHeight] = useState('720');
  const [fps, setFps] = useState('24');
  const [sequenceMode, setSequenceMode] =
    useState<SequenceMode>('panel-sequence');
  const [revealMode, setRevealMode] =
    useState<VideoExportStyleOptions['revealMode']>('smooth-phrase');
  const [karaoke, setKaraoke] = useState(false);
  const [wordEmphasis, setWordEmphasis] = useState(false);
  const [bubbleReusePolicy, setBubbleReusePolicy] =
    useState<VideoExportStyleOptions['bubbleReusePolicy']>('replace');
  const [fontFamily, setFontFamily] = useState(
    DEFAULT_CAPTION_STYLE.fontFamily,
  );
  const [fontSizePx, setFontSizePx] = useState(
    String(DEFAULT_CAPTION_STYLE.fontSizePx),
  );
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraMode, setCameraMode] = useState<
    'slow-zoom-in' | 'slow-zoom-out' | 'pan'
  >('slow-zoom-in');
  const [transitionsEnabled, setTransitionsEnabled] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [job, setJob] = useState<VideoExportJobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const style: VideoExportStyleOptions = useMemo(
    () => ({
      ...DEFAULT_CAPTION_STYLE,
      fontFamily,
      fontSizePx: Number(fontSizePx) || DEFAULT_CAPTION_STYLE.fontSizePx,
      revealMode,
      karaoke,
      wordEmphasis,
      bubbleReusePolicy,
    }),
    [
      fontFamily,
      fontSizePx,
      revealMode,
      karaoke,
      wordEmphasis,
      bubbleReusePolicy,
    ],
  );

  const resolvedSize = useMemo(() => {
    if (resolution === '720p') return { width: 1280, height: 720 };
    if (resolution === '1080p') return { width: 1920, height: 1080 };
    return {
      width: Math.round((Number(customWidth) || 1280) / 2) * 2,
      height: Math.round((Number(customHeight) || 720) / 2) * 2,
    };
  }, [resolution, customWidth, customHeight]);

  const panelSequenceResult = useMemo(() => {
    if (sequenceMode !== 'panel-sequence') return null;
    return buildEditorPanelSequence({
      panels,
      captions,
      bubbles,
      durationSeconds,
      pageWidth,
      pageHeight,
    });
  }, [
    sequenceMode,
    panels,
    captions,
    bubbles,
    durationSeconds,
    pageWidth,
    pageHeight,
  ]);

  const panelSteps: readonly PanelSequenceStep[] = useMemo(
    () => panelSequenceResult?.steps ?? [],
    [panelSequenceResult],
  );

  const multiPageMode = sourcePages.length > 1;

  const previewInputProps = useMemo(() => {
    if (!audioBlob || !showPreview) return null;
    if (multiPageMode && sourcePages.length > 0) {
      const urls = sourcePages.map((page) => URL.createObjectURL(page.blob));
      const base = compositionPropsFromExportPayload({
        pageImage: {
          url: urls[0] ?? '',
          width: sourcePages[0]!.width,
          height: sourcePages[0]!.height,
        },
        audioUrl: URL.createObjectURL(audioBlob),
        captions: captions as never,
        bubbles: bubbles as never,
        width: resolvedSize.width,
        height: resolvedSize.height,
        fps: PREVIEW_FPS,
        durationSeconds,
        captionStyle: style,
        camera: {
          ...DEFAULT_CAMERA,
          enabled: cameraEnabled,
          mode: cameraEnabled ? cameraMode : 'none',
          zoomFrom: cameraMode === 'slow-zoom-out' ? 1.12 : 1,
          zoomTo: cameraMode === 'slow-zoom-out' ? 1 : 1.12,
        },
        transitions: {
          ...DEFAULT_TRANSITIONS,
          enabled: transitionsEnabled,
          kind: transitionsEnabled ? 'fade' : 'none',
        },
      });
      return {
        ...base,
        pages: sourcePages.map((page, index) => ({
          id: page.id,
          imageUrl: urls[index] ?? '',
          width: page.width,
          height: page.height,
          startSeconds: page.startSeconds,
          endSeconds: page.endSeconds,
          label: page.label,
          bubbles: (page.bubbles ?? []) as never,
        })),
      };
    }
    if (!pageBlob) return null;
    const base = compositionPropsFromExportPayload({
      pageImage: {
        url: URL.createObjectURL(pageBlob),
        width: pageWidth,
        height: pageHeight,
      },
      audioUrl: URL.createObjectURL(audioBlob),
      captions: captions as never,
      bubbles: bubbles as never,
      width: resolvedSize.width,
      height: resolvedSize.height,
      fps: PREVIEW_FPS,
      durationSeconds,
      captionStyle: style,
      camera: {
        ...DEFAULT_CAMERA,
        enabled: cameraEnabled,
        mode: cameraEnabled ? cameraMode : 'none',
        zoomFrom: cameraMode === 'slow-zoom-out' ? 1.12 : 1,
        zoomTo: cameraMode === 'slow-zoom-out' ? 1 : 1.12,
      },
      transitions: {
        ...DEFAULT_TRANSITIONS,
        enabled: transitionsEnabled,
        kind: transitionsEnabled ? 'fade' : 'none',
      },
    });
    if (panelSequenceResult && panelSequenceResult.pages.length > 1) {
      return {
        ...base,
        pages: panelSequenceResult.pages.map((page) => ({
          ...page,
          imageUrl: base.pages[0]?.imageUrl ?? '',
        })),
        cues: panelSequenceResult.cues,
      };
    }
    return base;
  }, [
    showPreview,
    pageBlob,
    audioBlob,
    pageWidth,
    pageHeight,
    captions,
    bubbles,
    resolvedSize.width,
    resolvedSize.height,
    durationSeconds,
    style,
    cameraEnabled,
    cameraMode,
    transitionsEnabled,
    panelSequenceResult,
    multiPageMode,
    sourcePages,
  ]);

  const startExport = useCallback(async () => {
    if (!audioBlob) {
      setError('Narration audio is required for export.');
      return;
    }
    if (!multiPageMode && !pageBlob) {
      setError('A cleaned page and narration audio are required for export.');
      return;
    }
    if (multiPageMode && sourcePages.length === 0) {
      setError('Import comic pages before multi-page export.');
      return;
    }
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const availability = await fetchVideoExportAvailability();
      if (!availability.browserReady) {
        throw new Error('Remotion browser prerequisites are not ready.');
      }
      const firstSource = sourcePages[0];
      const created = await createVideoExportJob({
        ...(pageBlob
          ? { pageImage: pageBlob }
          : firstSource
            ? { pageImage: firstSource.blob }
            : {}),
        pageWidth: multiPageMode
          ? (firstSource?.width ?? pageWidth)
          : pageWidth,
        pageHeight: multiPageMode
          ? (firstSource?.height ?? pageHeight)
          : pageHeight,
        audio: audioBlob,
        audioFormat,
        durationSeconds,
        fps: Number(fps) || 24,
        resolution:
          resolution === 'custom'
            ? {
                resolution: 'custom',
                width: resolvedSize.width,
                height: resolvedSize.height,
              }
            : { resolution },
        captions: captions as never,
        bubbles: bubbles as never,
        ...(multiPageMode
          ? {
              sourcePages: sourcePages.map((page) => ({
                id: page.id,
                image: page.blob,
                width: page.width,
                height: page.height,
                startSeconds: page.startSeconds,
                endSeconds: page.endSeconds,
                label: page.label,
                bubbles: page.bubbles,
              })),
            }
          : {}),
        ...(panelSteps.length > 1 && !multiPageMode
          ? {
              panelSequence: panelSteps.map((step) => ({
                id: step.id,
                bounds: step.bounds,
                startSeconds: step.startSeconds,
                endSeconds: step.endSeconds,
                ...(step.label ? { label: step.label } : {}),
                ...(step.bubbleIds ? { bubbleIds: step.bubbleIds } : {}),
              })),
            }
          : {}),
        captionStyle: style,
        camera: {
          ...DEFAULT_CAMERA,
          enabled: cameraEnabled,
          mode: cameraEnabled ? cameraMode : 'none',
          zoomFrom: cameraMode === 'slow-zoom-out' ? 1.12 : 1,
          zoomTo: cameraMode === 'slow-zoom-out' ? 1 : 1.12,
        },
        transitions: {
          ...DEFAULT_TRANSITIONS,
          enabled: transitionsEnabled,
          kind: transitionsEnabled ? 'fade' : 'none',
        },
        signal: controller.signal,
      });
      setJob(created);
      const finished = await waitForVideoExportJob(created.id, {
        signal: controller.signal,
        onUpdate: setJob,
      });
      setJob(finished);
      if (isVideoExportSuccess(finished.status)) {
        onMessage('Remotion MP4 export completed.');
      } else if (finished.status === 'cancelled') {
        onMessage('Remotion export cancelled.');
      } else {
        throw new Error(finished.error?.message ?? 'Remotion export failed.');
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        onMessage('Remotion export cancelled.');
      } else {
        const message =
          cause instanceof Error ? cause.message : 'Remotion export failed.';
        setError(message);
        onMessage(message);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [
    pageBlob,
    audioBlob,
    pageWidth,
    pageHeight,
    audioFormat,
    durationSeconds,
    fps,
    resolution,
    resolvedSize.width,
    resolvedSize.height,
    captions,
    bubbles,
    panelSteps,
    multiPageMode,
    sourcePages,
    style,
    cameraEnabled,
    cameraMode,
    transitionsEnabled,
    onMessage,
  ]);

  const download = useCallback(async () => {
    if (!job || !isVideoExportSuccess(job.status)) return;
    try {
      const blob = await downloadVideoExport(job.id);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${projectName.replace(/[^a-z0-9-_]+/gi, '-') || 'comic'}.mp4`;
      link.click();
      URL.revokeObjectURL(url);
      onMessage('Downloaded Remotion MP4.');
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Download failed.';
      setError(message);
      onMessage(message);
    }
  }, [job, projectName, onMessage]);

  const cancel = useCallback(() => {
    if (!job) return;
    abortRef.current?.abort();
    void cancelVideoExportJob(job.id)
      .then(setJob)
      .catch(() => undefined);
  }, [job]);

  return (
    <section
      className="rounded-xl border border-slate-200 p-3 text-sm shadow-sm"
      style={{
        background: 'var(--ui-surface, #ffffff)',
        color: 'var(--ui-text, #1c1c22)',
        borderColor: 'var(--ui-border, #e2e2e8)',
      }}
      aria-label="Remotion video export"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          Remotion motion-comic export
        </h3>
        <span className="text-xs text-slate-500">
          Job-based H.264 render · captions stay in bubbles
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Caption reveal mode"
          className="editor-input"
          disabled={disabled || busy}
          value={revealMode}
          onChange={(event) =>
            setRevealMode(
              event.currentTarget
                .value as VideoExportStyleOptions['revealMode'],
            )
          }
        >
          <option value="smooth-phrase">Smooth phrase (default)</option>
          <option value="word-by-word">Word-by-word</option>
          <option value="phrase">Full sentence</option>
          <option value="character-by-character">
            Character-by-character
          </option>
        </select>
        <select
          aria-label="Bubble reuse policy"
          className="editor-input"
          disabled={disabled || busy}
          value={bubbleReusePolicy}
          onChange={(event) =>
            setBubbleReusePolicy(
              event.currentTarget
                .value as VideoExportStyleOptions['bubbleReusePolicy'],
            )
          }
        >
          <option value="replace">Reuse · replace</option>
          <option value="retain">Reuse · retain</option>
          <option value="clear">Reuse · clear</option>
        </select>
        <select
          aria-label="Caption font family"
          className="editor-input"
          disabled={disabled || busy}
          value={fontFamily}
          onChange={(event) => setFontFamily(event.currentTarget.value)}
        >
          <option value="Helvetica, Arial, sans-serif">Helvetica</option>
          <option value="Georgia, serif">Georgia</option>
          <option value="'Comic Sans MS', 'Chalkboard SE', sans-serif">
            Comic
          </option>
          <option value="'Times New Roman', serif">Times</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          Size
          <input
            aria-label="Caption font size"
            className="editor-input w-16"
            type="number"
            min="8"
            max="96"
            disabled={disabled || busy}
            value={fontSizePx}
            onChange={(event) => setFontSizePx(event.currentTarget.value)}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            disabled={disabled || busy}
            checked={karaoke}
            onChange={(event) => setKaraoke(event.currentTarget.checked)}
          />
          Karaoke
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            disabled={disabled || busy}
            checked={wordEmphasis}
            onChange={(event) => setWordEmphasis(event.currentTarget.checked)}
          />
          Word emphasis
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Export sequence mode"
          className="editor-input"
          disabled={disabled || busy}
          value={sequenceMode}
          onChange={(event) =>
            setSequenceMode(event.currentTarget.value as SequenceMode)
          }
        >
          <option value="panel-sequence">Panel sequence</option>
          <option value="full-page">Full page</option>
        </select>
        {sequenceMode === 'panel-sequence' && (
          <span className="text-xs text-slate-600">
            {panels.length > 0
              ? `${panels.length} panel${panels.length === 1 ? '' : 's'}${
                  panelSteps.length > 0
                    ? ` → ${panelSteps.length} timed shot${panelSteps.length === 1 ? '' : 's'}`
                    : ''
                }`
              : 'No panels yet — detect bubbles first'}
          </span>
        )}
        {panelSequenceResult?.warnings.map((warning) => (
          <span key={warning} className="text-xs text-amber-700">
            {warning}
          </span>
        ))}
        {multiPageMode && (
          <span className="text-xs text-indigo-800">
            Multi-page export · {sourcePages.length} pages
          </span>
        )}
        {multiPageWarnings.map((warning) => (
          <span key={warning} className="text-xs text-slate-600">
            {warning}
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Remotion export resolution"
          className="editor-input"
          disabled={disabled || busy}
          value={resolution}
          onChange={(event) =>
            setResolution(event.currentTarget.value as ResolutionChoice)
          }
        >
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="custom">Custom</option>
        </select>
        {resolution === 'custom' && (
          <>
            <input
              aria-label="Custom Remotion width"
              className="editor-input w-20"
              type="number"
              min="16"
              max="7680"
              step="2"
              disabled={disabled || busy}
              value={customWidth}
              onChange={(event) => setCustomWidth(event.currentTarget.value)}
            />
            <span>×</span>
            <input
              aria-label="Custom Remotion height"
              className="editor-input w-20"
              type="number"
              min="16"
              max="7680"
              step="2"
              disabled={disabled || busy}
              value={customHeight}
              onChange={(event) => setCustomHeight(event.currentTarget.value)}
            />
          </>
        )}
        <label className="flex items-center gap-1 text-xs text-slate-600">
          FPS
          <input
            aria-label="Remotion export FPS"
            className="editor-input w-16"
            type="number"
            min="1"
            max="60"
            disabled={disabled || busy}
            value={fps}
            onChange={(event) => setFps(event.currentTarget.value)}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            disabled={disabled || busy}
            checked={cameraEnabled}
            onChange={(event) => setCameraEnabled(event.currentTarget.checked)}
          />
          Camera motion
        </label>
        {cameraEnabled && (
          <select
            aria-label="Camera motion mode"
            className="editor-input"
            disabled={disabled || busy}
            value={cameraMode}
            onChange={(event) =>
              setCameraMode(event.currentTarget.value as typeof cameraMode)
            }
          >
            <option value="slow-zoom-in">Slow zoom in</option>
            <option value="slow-zoom-out">Slow zoom out</option>
            <option value="pan">Pan</option>
          </select>
        )}
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            disabled={disabled || busy}
            checked={transitionsEnabled}
            onChange={(event) =>
              setTransitionsEnabled(event.currentTarget.checked)
            }
          />
          Page fade
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          className="editor-button"
          type="button"
          disabled={
            disabled || busy || (!pageBlob && !multiPageMode) || !audioBlob
          }
          onClick={() => setShowPreview((value) => !value)}
        >
          {showPreview ? 'Hide preview' : 'Preview'}
        </button>
        {!busy ? (
          <button
            className="editor-button"
            type="button"
            disabled={
              disabled ||
              !audioBlob ||
              (!multiPageMode && !pageBlob) ||
              (multiPageMode
                ? sourcePages.length === 0
                : !captions.length && !multiPageMode)
            }
            onClick={() => void startExport()}
          >
            {multiPageMode
              ? `Render ${sourcePages.length}-page MP4`
              : 'Render MP4 (Remotion)'}
          </button>
        ) : (
          <button className="editor-button" type="button" onClick={cancel}>
            Cancel render
          </button>
        )}
        {isVideoExportSuccess(job?.status) && (
          <button
            className="editor-button"
            type="button"
            onClick={() => void download()}
          >
            Download MP4
          </button>
        )}
        {job && (
          <div className="flex min-w-52 items-center gap-2" aria-live="polite">
            <progress
              aria-label="Remotion export progress"
              className="w-28"
              max="100"
              value={job.progress}
            />
            <span className="text-xs tabular-nums">
              {job.status} · {Math.floor(job.progress)}%
              {job.output
                ? ` · ${job.output.width}×${job.output.height} · ${job.output.codec}/${job.output.pixelFormat}`
                : ''}
            </span>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}

      {showPreview && previewInputProps && (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-black">
          <Player
            component={MotionComicVideo as never}
            inputProps={previewInputProps as never}
            durationInFrames={Math.max(
              1,
              Math.round(durationSeconds * PREVIEW_FPS),
            )}
            fps={PREVIEW_FPS}
            compositionWidth={previewInputProps.width}
            compositionHeight={previewInputProps.height}
            controls
            loop
            style={{ width: '100%', aspectRatio: '16 / 9' }}
          />
        </div>
      )}
    </section>
  );
}
