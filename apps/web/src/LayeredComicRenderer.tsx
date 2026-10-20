import { useMemo } from 'react';
import type { CaptionLayout } from '@comic-captioner/core';
import {
  renderCaptionLayerSvg,
  renderTimedCaptionLayerSvg,
  renderDebugLayerSvg,
  captionMotionAtTime,
  timedCaptionLayoutsFromExport,
  type ExportWordTiming,
} from '../../../packages/rendering/src/svg.js';
import type { RenderDebugOverlay } from '../../../packages/rendering/src/svg.js';

/** Retained comic image plus independently replaceable caption/debug layers. */
export function LayeredComicRenderer({
  src,
  width,
  height,
  layouts,
  debugOverlays = [],
  className,
  motionTimeSeconds,
  motionStartSeconds,
  motionEndSeconds,
  /** When set with `timed`, captions reveal word-by-word at this playback time. */
  playbackTimeSeconds,
  timed,
}: {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly layouts: readonly CaptionLayout[];
  readonly debugOverlays?: readonly RenderDebugOverlay[];
  readonly className?: string;
  readonly motionTimeSeconds?: number | undefined;
  readonly motionStartSeconds?: number | undefined;
  readonly motionEndSeconds?: number | undefined;
  readonly playbackTimeSeconds?: number | undefined;
  readonly timed?:
    | readonly {
        readonly layout: CaptionLayout | null;
        readonly start: number | null;
        readonly end: number | null;
        readonly words?: readonly ExportWordTiming[] | undefined;
      }[]
    | undefined;
}) {
  const motion = useMemo(
    () =>
      motionTimeSeconds !== undefined &&
      motionStartSeconds !== undefined &&
      motionEndSeconds !== undefined
        ? captionMotionAtTime(
            motionStartSeconds,
            motionEndSeconds,
            motionTimeSeconds,
          )
        : undefined,
    [motionEndSeconds, motionStartSeconds, motionTimeSeconds],
  );
  const useTimed =
    playbackTimeSeconds !== undefined &&
    Number.isFinite(playbackTimeSeconds) &&
    timed !== undefined;
  const captionSvg = useMemo(() => {
    if (useTimed) {
      return renderTimedCaptionLayerSvg(
        width,
        height,
        timedCaptionLayoutsFromExport(timed),
        playbackTimeSeconds!,
      );
    }
    return renderCaptionLayerSvg(width, height, layouts, motion);
  }, [useTimed, width, height, timed, playbackTimeSeconds, layouts, motion]);
  const debugSvg = useMemo(
    () => renderDebugLayerSvg(width, height, debugOverlays),
    [width, height, debugOverlays],
  );
  return (
    <div
      className={`relative ${className ?? ''}`}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <img
        className="absolute inset-0 h-full w-full"
        src={src}
        alt="Comic page"
      />
      <img
        aria-label="Caption overlay"
        className="pointer-events-none absolute inset-0 h-full w-full"
        src={`data:image/svg+xml,${encodeURIComponent(captionSvg)}`}
        alt=""
      />
      <img
        aria-label="Editor and debug overlay"
        className="pointer-events-none absolute inset-0 h-full w-full"
        src={`data:image/svg+xml,${encodeURIComponent(debugSvg)}`}
        alt=""
      />
    </div>
  );
}
