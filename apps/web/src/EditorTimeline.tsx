import { useCallback, useMemo, useRef } from 'react';
import {
  IconCollapse,
  IconExpand,
  IconFit,
  IconLock,
  IconLoop,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
  IconSplit,
  IconEye,
} from './editor-icons.js';

export interface TimelinePageClip {
  readonly id: string;
  readonly label: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly thumbnailUrl?: string | null;
  readonly selected?: boolean;
}

export interface TimelineAudioClip {
  readonly id: string;
  readonly label: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly selected?: boolean;
}

export interface TimelineCaptionClip {
  readonly id: string;
  readonly label: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly pageId?: string;
  readonly selected?: boolean;
}

export interface EditorTimelineProps {
  readonly durationSeconds: number;
  readonly currentTime: number;
  readonly playing: boolean;
  readonly collapsed: boolean;
  readonly heightPx: number;
  readonly zoom: number;
  readonly pages: readonly TimelinePageClip[];
  readonly audioClips: readonly TimelineAudioClip[];
  readonly captions: readonly TimelineCaptionClip[];
  readonly selectedClipId?: string | null;
  readonly loop?: boolean;
  readonly showBackground?: boolean;
  readonly onSeek: (time: number) => void;
  readonly onTogglePlay: () => void;
  readonly onToggleCollapse: () => void;
  readonly onToggleLoop?: () => void;
  readonly onToggleBackground?: () => void;
  readonly onResizeHeight: (height: number) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onSelectClip: (clip: {
    readonly kind: 'page' | 'audio' | 'caption';
    readonly id: string;
  }) => void;
  readonly onSelectPage: (pageId: string) => void;
  readonly onSplitClip?: () => void;
  readonly onAddPage?: () => void;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function EditorTimeline({
  durationSeconds,
  currentTime,
  playing,
  collapsed,
  heightPx,
  zoom,
  pages,
  audioClips,
  captions,
  selectedClipId,
  loop = false,
  showBackground = true,
  onSeek,
  onTogglePlay,
  onToggleCollapse,
  onToggleLoop,
  onToggleBackground,
  onResizeHeight,
  onZoom,
  onSelectClip,
  onSelectPage,
  onSplitClip,
  onAddPage,
}: EditorTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const pxPerSecond = zoom;
  const contentWidth = Math.max(600, durationSeconds * pxPerSecond + 80);

  const ticks = useMemo(() => {
    const step = durationSeconds > 40 ? 5 : durationSeconds > 16 ? 2 : 1;
    const values: number[] = [];
    for (let t = 0; t <= durationSeconds + step; t += step) values.push(t);
    return values;
  }, [durationSeconds]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      const x = clientX - rect.left + scroll.scrollLeft;
      const time = Math.min(durationSeconds, Math.max(0, x / pxPerSecond));
      onSeek(time);
    },
    [durationSeconds, onSeek, pxPerSecond],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    seekFromClientX(event.clientX);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekFromClientX(event.clientX);
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };

  const playheadLeft = currentTime * pxPerSecond;

  return (
    <section
      className="editor-timeline"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ height: collapsed ? 40 : heightPx }}
      aria-label="Timeline"
    >
      {!collapsed && (
        <div
          className="timeline-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize timeline"
          onMouseDown={(event) => {
            const startY = event.clientY;
            const startH = heightPx;
            const onMove = (move: MouseEvent) => {
              const next = Math.min(
                480,
                Math.max(160, startH + (startY - move.clientY)),
              );
              onResizeHeight(next);
            };
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        />
      )}
      <div className="timeline-header">
        <button
          className={`ui-btn icon ${showBackground ? 'active' : ''}`}
          type="button"
          title="Toggle canvas background"
          aria-label="Toggle canvas background"
          aria-pressed={showBackground}
          onClick={() => onToggleBackground?.()}
        >
          <IconEye />
        </button>
        <button
          className="ui-btn"
          type="button"
          disabled={!onSplitClip}
          onClick={() => onSplitClip?.()}
        >
          <IconSplit size={14} /> Split Clip
        </button>
        <div className="timeline-time">
          {formatTime(currentTime)} / {formatTime(durationSeconds)}
        </div>
        <button
          className="ui-btn icon primary"
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={onTogglePlay}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button
          className={`ui-btn icon ${loop ? 'active' : ''}`}
          type="button"
          aria-label="Loop"
          aria-pressed={loop}
          disabled={!onToggleLoop}
          onClick={() => onToggleLoop?.()}
        >
          <IconLoop />
        </button>
        <div className="timeline-header-spacer" />
        <span className="inspector-label">Timeline Scale</span>
        <button
          className="ui-btn icon"
          type="button"
          aria-label="Zoom out timeline"
          onClick={() => onZoom(Math.max(12, zoom / 1.25))}
        >
          <IconMinus />
        </button>
        <button
          className="ui-btn icon"
          type="button"
          aria-label="Zoom in timeline"
          onClick={() => onZoom(Math.min(160, zoom * 1.25))}
        >
          <IconPlus />
        </button>
        <button
          className="ui-btn"
          type="button"
          onClick={() => {
            const scroll = scrollRef.current;
            if (!scroll) return;
            const target = scroll.clientWidth / Math.max(20, durationSeconds);
            onZoom(Math.min(160, Math.max(12, target)));
            scroll.scrollLeft = 0;
          }}
        >
          <IconFit size={14} /> Fit View
        </button>
        <button
          className="ui-btn icon"
          type="button"
          aria-label={collapsed ? 'Expand timeline' : 'Collapse timeline'}
          onClick={onToggleCollapse}
        >
          {collapsed ? <IconExpand /> : <IconCollapse />}
        </button>
      </div>

      {!collapsed && (
        <div className="timeline-body">
          <div className="timeline-tracks-head">
            <div className="track-head">Pages</div>
            <div className="track-head">Narration</div>
            <div className="track-head">Captions</div>
            <div className="track-head">
              <IconLock size={12} /> SFX
            </div>
          </div>
          <div
            ref={scrollRef}
            className="timeline-scroll"
            style={
              {
                ['--tl-zoom' as string]: String(pxPerSecond),
                height: '100%',
              } as React.CSSProperties
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="timeline-ruler" style={{ width: contentWidth }}>
              {ticks.map((tick) => (
                <div
                  className="ruler-tick"
                  key={tick}
                  style={{ left: tick * pxPerSecond }}
                >
                  {tick}s
                </div>
              ))}
            </div>

            <div className="track-row" style={{ width: contentWidth }}>
              {pages.map((clip) => (
                <div
                  key={clip.id}
                  className={`track-clip page ${clip.selected || selectedClipId === clip.id ? 'selected' : ''}`}
                  style={{
                    left: clip.startSeconds * pxPerSecond,
                    width: Math.max(
                      36,
                      (clip.endSeconds - clip.startSeconds) * pxPerSecond - 2,
                    ),
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectClip({ kind: 'page', id: clip.id });
                    onSelectPage(clip.id);
                  }}
                  title={clip.label}
                >
                  {clip.thumbnailUrl ? (
                    <img className="clip-thumb" src={clip.thumbnailUrl} alt="" />
                  ) : null}
                  <span>{clip.label}</span>
                </div>
              ))}
            </div>

            <div className="track-row" style={{ width: contentWidth }}>
              {audioClips.map((clip) => (
                <div
                  key={clip.id}
                  className={`track-clip audio ${clip.selected || selectedClipId === clip.id ? 'selected' : ''}`}
                  style={{
                    left: clip.startSeconds * pxPerSecond,
                    width: Math.max(
                      48,
                      (clip.endSeconds - clip.startSeconds) * pxPerSecond - 2,
                    ),
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectClip({ kind: 'audio', id: clip.id });
                  }}
                  title={clip.label}
                >
                  <span>♪</span>
                  <span>{clip.label}</span>
                </div>
              ))}
            </div>

            <div className="track-row" style={{ width: contentWidth }}>
              {captions.map((clip) => (
                <div
                  key={clip.id}
                  className={`track-clip caption ${clip.selected || selectedClipId === clip.id ? 'selected' : ''}`}
                  style={{
                    left: clip.startSeconds * pxPerSecond,
                    width: Math.max(
                      40,
                      (clip.endSeconds - clip.startSeconds) * pxPerSecond - 2,
                    ),
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectClip({ kind: 'caption', id: clip.id });
                  }}
                  title={clip.label}
                >
                  <span>T</span>
                  <span>{clip.label}</span>
                </div>
              ))}
            </div>

            <div
              className="timeline-playhead"
              style={{ left: playheadLeft, height: '100%' }}
            />
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="timeline-footer">
          {pages.map((clip, index) => (
            <button
              key={clip.id}
              type="button"
              className={`page-chip ${clip.selected ? 'selected' : ''}`}
              onClick={() => {
                onSelectPage(clip.id);
                onSelectClip({ kind: 'page', id: clip.id });
                onSeek(clip.startSeconds);
              }}
            >
              {clip.thumbnailUrl ? (
                <img src={clip.thumbnailUrl} alt="" />
              ) : null}
              {index + 1}. {clip.label}
            </button>
          ))}
          {onAddPage ? (
            <button className="ui-btn primary" type="button" onClick={onAddPage}>
              + Add Page
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
