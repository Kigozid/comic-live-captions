import type {
  CaptionCue,
  MotionComicVideoProps,
  PageInput,
  WordTiming,
} from './types.js';
import {
  DEFAULT_CAMERA,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FALLBACK_PLACEMENT,
  DEFAULT_TRANSITIONS,
} from './defaults.js';

/**
 * Bridge from the existing export payload (`packages/rendering` ExportCaption /
 * ExportBubble) into Remotion composition props, preserving image-space
 * geometry and word timings when present.
 */

export interface ExportCaptionWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ExportCaption {
  readonly id: string;
  readonly bubbleId: string;
  readonly caption: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly mapped?: boolean;
  readonly needsReview?: boolean;
  readonly words?: readonly ExportCaptionWord[];
  readonly layout?: {
    readonly fontFamily: string;
    readonly fontSizePx: number;
    readonly color?: string;
    readonly strokeColor?: string;
    readonly strokeWidthPx?: number;
    readonly lineSpacingPx: number;
    readonly alignment: 'left' | 'center' | 'right' | 'unknown';
    /** Preferred: caption-engine `linePlacements`. */
    readonly linePlacements?: readonly {
      readonly text: string;
      readonly position: { readonly x: number; readonly y: number };
      readonly baselineY: number;
      readonly widthPx: number;
      readonly heightPx: number;
    }[];
    /** Alternate flat form accepted for simpler payloads. */
    readonly lines?: readonly {
      readonly text: string;
      readonly position: { readonly x: number; readonly y: number };
      readonly baselineY: number;
      readonly widthPx: number;
      readonly heightPx: number;
    }[];
  } | null;
}

export interface ExportBubble {
  readonly id: string;
  readonly polygon: {
    readonly points: readonly {
      readonly x: number;
      readonly y: number;
    }[];
  };
}

export function cuesFromExportCaptions(
  captions: readonly ExportCaption[],
): CaptionCue[] {
  return captions.map((caption): CaptionCue => {
    const words: WordTiming[] = (caption.words ?? []).map((word) => ({
      text: word.text,
      startSeconds: word.start,
      endSeconds: word.end,
    }));
    const rawLines =
      caption.layout?.linePlacements ?? caption.layout?.lines ?? null;
    const layout =
      caption.layout && rawLines && rawLines.length > 0
        ? {
            fontFamily: caption.layout.fontFamily,
            fontSizePx: caption.layout.fontSizePx,
            color: caption.layout.color ?? DEFAULT_CAPTION_STYLE.color,
            strokeColor:
              caption.layout.strokeColor ?? DEFAULT_CAPTION_STYLE.strokeColor,
            strokeWidthPx:
              caption.layout.strokeWidthPx ??
              DEFAULT_CAPTION_STYLE.strokeWidthPx,
            lineSpacingPx: caption.layout.lineSpacingPx,
            alignment:
              caption.layout.alignment === 'unknown'
                ? ('center' as const)
                : caption.layout.alignment,
            lines: rawLines.map((line) => ({
              text: line.text,
              x: line.position.x,
              y: line.position.y,
              baselineY: line.baselineY,
              widthPx: line.widthPx,
              heightPx: line.heightPx,
            })),
          }
        : null;
    return {
      id: caption.id,
      bubbleId: caption.bubbleId || null,
      text: caption.caption,
      startSeconds: caption.start ?? 0,
      endSeconds: caption.end ?? Math.max(0.01, (caption.start ?? 0) + 0.01),
      words,
      layout,
      needsReview: caption.needsReview ?? caption.mapped === false,
    };
  });
}

export interface CompositionPayload {
  readonly pageImage: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
  };
  readonly audioUrl: string;
  readonly captions: readonly ExportCaption[];
  readonly bubbles: readonly ExportBubble[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly captionStyle?: Partial<MotionComicVideoProps['captionStyle']>;
  readonly camera?: Partial<MotionComicVideoProps['camera']>;
  readonly transitions?: Partial<MotionComicVideoProps['transitions']>;
  readonly fallbackPlacement?: Partial<
    MotionComicVideoProps['fallbackPlacement']
  >;
  readonly backgroundColor?: string;
}

export function compositionPropsFromExportPayload(
  payload: CompositionPayload,
): MotionComicVideoProps {
  const pages: PageInput[] = [
    {
      id: 'page-1',
      imageUrl: payload.pageImage.url,
      width: payload.pageImage.width,
      height: payload.pageImage.height,
      startSeconds: 0,
      endSeconds: payload.durationSeconds,
      bubbles: payload.bubbles.map((bubble) => ({
        id: bubble.id,
        polygon: bubble.polygon.points.map((point) => ({
          x: point.x,
          y: point.y,
        })),
      })),
    },
  ];
  return {
    pages,
    audioUrl: payload.audioUrl,
    cues: cuesFromExportCaptions(payload.captions),
    width: payload.width,
    height: payload.height,
    fps: payload.fps,
    durationSeconds: payload.durationSeconds,
    captionStyle: { ...DEFAULT_CAPTION_STYLE, ...payload.captionStyle },
    camera: { ...DEFAULT_CAMERA, ...payload.camera },
    transitions: { ...DEFAULT_TRANSITIONS, ...payload.transitions },
    fallbackPlacement: {
      ...DEFAULT_FALLBACK_PLACEMENT,
      ...payload.fallbackPlacement,
    },
    backgroundColor: payload.backgroundColor ?? '#000000',
  };
}
