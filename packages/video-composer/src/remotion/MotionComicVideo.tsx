import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  CaptionCue,
  FittedCaptionLayout,
  FittedCaptionLine,
  ImageRect,
  MotionComicVideoProps,
  PageInput,
  WordTiming,
} from '../types.js';
import {
  activeWordAt,
  isCueVisibleAt,
  mapWordsToLines,
  visibleWordsAt,
} from '../timing.js';
import {
  bubbleSafeRect,
  pageAtTime,
  resolvePageCameraPlacement,
  resolveFallbackRect,
} from '../geometry.js';

interface ResolvedPlacement {
  readonly rect: ImageRect;
  readonly alignment: FittedCaptionLayout['alignment'];
  readonly lines: readonly FittedCaptionLine[];
  readonly layout: FittedCaptionLayout | null;
  readonly needsReview: boolean;
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((part) => part.length > 0);
}

/**
 * Deterministic wrap of cue text into a safe rect when no saved fitted layout
 * exists. Character-proportional metrics avoid browser text measurement so
 * preview and SSR stay identical.
 */
function wrapIntoLines(
  text: string,
  rect: ImageRect,
  fontSizePx: number,
  lineSpacingPx: number,
  alignment: FittedCaptionLayout['alignment'],
  fontFamily: string,
  color: string,
  strokeColor: string,
  strokeWidthPx: number,
): FittedCaptionLayout {
  const avgCharWidth = fontSizePx * 0.55;
  const maxChars = Math.max(1, Math.floor(rect.width / avgCharWidth));
  const words = splitWords(text);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines.push(text);

  const lineHeight = fontSizePx + lineSpacingPx;
  const blockHeight = lines.length * lineHeight;
  const startY = rect.y + Math.max(0, (rect.height - blockHeight) / 2);
  return {
    fontFamily,
    fontSizePx,
    color,
    strokeColor,
    strokeWidthPx,
    lineSpacingPx,
    alignment,
    lines: lines.map((line, index) => {
      const widthPx = line.length * avgCharWidth;
      const y = startY + index * lineHeight;
      const x =
        alignment === 'center'
          ? rect.x + (rect.width - widthPx) / 2
          : alignment === 'right'
            ? rect.x + rect.width - widthPx
            : rect.x;
      return {
        text: line,
        x,
        y,
        baselineY: y + fontSizePx * 0.85,
        widthPx,
        heightPx: fontSizePx,
      };
    }),
  };
}

function resolveCuePlacement(
  cue: CaptionCue,
  page: PageInput | null,
  props: MotionComicVideoProps,
): ResolvedPlacement {
  const style = props.captionStyle;
  const fallbackRect = resolveFallbackRect(
    page ?? {
      id: 'fallback-page',
      imageUrl: '',
      width: props.width,
      height: props.height,
      startSeconds: 0,
      endSeconds: props.durationSeconds,
      bubbles: [],
    },
    cue.fallbackPosition ?? props.fallbackPlacement.rect,
    style.safeMarginPx,
  );

  if (cue.layout && cue.layout.lines.length > 0) {
    return {
      rect: {
        x: cue.layout.lines[0]!.x,
        y: cue.layout.lines[0]!.y,
        width: Math.max(...cue.layout.lines.map((line) => line.widthPx)),
        height: Math.max(...cue.layout.lines.map((line) => line.heightPx)),
      },
      alignment: cue.layout.alignment,
      lines: cue.layout.lines,
      layout: cue.layout,
      needsReview: cue.needsReview ?? false,
    };
  }

  const bubble = cue.bubbleId
    ? (page?.bubbles.find((candidate) => candidate.id === cue.bubbleId) ?? null)
    : null;

  if (bubble) {
    const safe = bubbleSafeRect(bubble, style.safeMarginPx);
    const layout = wrapIntoLines(
      cue.text,
      safe,
      style.fontSizePx,
      style.lineSpacingPx,
      'center',
      style.fontFamily,
      style.color,
      style.strokeColor,
      style.strokeWidthPx,
    );
    return {
      rect: safe,
      alignment: 'center',
      lines: layout.lines,
      layout,
      needsReview: cue.needsReview ?? false,
    };
  }

  const layout = wrapIntoLines(
    cue.text,
    fallbackRect,
    style.fontSizePx,
    style.lineSpacingPx,
    props.fallbackPlacement.alignment,
    style.fontFamily,
    style.color,
    style.strokeColor,
    style.strokeWidthPx,
  );
  return {
    rect: fallbackRect,
    alignment: props.fallbackPlacement.alignment,
    lines: layout.lines,
    layout,
    needsReview: true,
  };
}

function captionOpacity(
  cue: CaptionCue,
  timeSeconds: number,
  props: MotionComicVideoProps,
): number {
  const fadeIn = props.captionStyle.fadeInSeconds;
  const fadeOut = props.captionStyle.fadeOutSeconds;
  const entrance =
    fadeIn <= 0
      ? 1
      : interpolate(
          timeSeconds,
          [cue.startSeconds, cue.startSeconds + fadeIn],
          [0, 1],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        );
  const exit =
    fadeOut <= 0
      ? 1
      : interpolate(
          timeSeconds,
          [cue.endSeconds - fadeOut, cue.endSeconds],
          [1, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        );
  return Math.min(entrance, exit);
}

const CaptionWords: React.FC<{
  readonly line: FittedCaptionLine;
  readonly words: readonly WordTiming[];
  readonly lineWords: readonly string[];
  readonly timeSeconds: number;
  readonly revealMode: MotionComicVideoProps['captionStyle']['revealMode'];
  readonly karaoke: boolean;
  readonly wordEmphasis: boolean;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly color: string;
  readonly strokeColor: string;
  readonly strokeWidthPx: number;
  readonly opacity: number;
}> = ({
  line,
  words,
  lineWords,
  timeSeconds,
  revealMode,
  karaoke,
  wordEmphasis,
  fontFamily,
  fontSizePx,
  color,
  strokeColor,
  strokeWidthPx,
  opacity,
}) => {
  const visible = visibleWordsAt(words, timeSeconds);
  const active = activeWordAt(words, timeSeconds);
  return (
    <div
      style={{
        position: 'absolute',
        left: line.x,
        top: line.y,
        width: line.widthPx,
        height: line.heightPx,
        fontFamily,
        fontSize: fontSizePx,
        lineHeight: `${line.heightPx}px`,
        color,
        opacity,
        whiteSpace: 'pre',
        WebkitTextStroke:
          strokeWidthPx > 0 ? `${strokeWidthPx}px ${strokeColor}` : undefined,
        paintOrder: 'stroke fill',
      }}
    >
      {lineWords.map((word, index) => {
        const isSpoken =
          revealMode === 'phrase' ||
          words.length === 0 ||
          visible.some((item) => item.text === word);
        const isActive = karaoke && active?.text === word;
        const emphasisScale = wordEmphasis && isActive ? 1.08 : 1;
        return (
          <span
            key={`${word}-${index}`}
            style={{
              display: 'inline-block',
              marginRight: fontSizePx * 0.28,
              opacity: isSpoken ? 1 : 0,
              color: isActive ? '#7c3aed' : undefined,
              transform: `scale(${emphasisScale})`,
              transformOrigin: 'left center',
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

const CueLayer: React.FC<{
  readonly cue: CaptionCue;
  readonly page: PageInput | null;
  readonly props: MotionComicVideoProps;
  readonly timeSeconds: number;
}> = ({ cue, page, props, timeSeconds }) => {
  const placement = resolveCuePlacement(cue, page, props);
  const opacity = captionOpacity(cue, timeSeconds, props);
  if (opacity <= 0.001) return null;
  const style = props.captionStyle;
  const words = cue.words ?? [];
  const spans =
    placement.layout && words.length > 0
      ? mapWordsToLines(
          placement.lines.map((line) => line.text),
          words,
        )
      : [];

  return (
    <>
      {placement.lines.map((line, lineIndex) => {
        const lineWords = splitWords(line.text);
        const lineSpans = spans.filter((span) => span.lineIndex === lineIndex);
        // Prefer timed words mapped to this line; otherwise treat tokens as untimed.
        const timedWords: WordTiming[] =
          lineSpans.length > 0
            ? lineSpans.map((span) => ({
                text: span.text,
                startSeconds: span.startSeconds,
                endSeconds: span.endSeconds,
              }))
            : lineWords.map((word, index) => {
                // Distribute cue timing evenly across tokens when word times
                // were not provided for this line.
                const span = Math.max(0, cue.endSeconds - cue.startSeconds);
                const slice = span / Math.max(1, lineWords.length);
                return {
                  text: word,
                  startSeconds: cue.startSeconds + index * slice,
                  endSeconds: cue.startSeconds + (index + 1) * slice,
                };
              });
        return (
          <CaptionWords
            key={`${cue.id}-${lineIndex}`}
            line={line}
            words={timedWords}
            lineWords={lineWords}
            timeSeconds={timeSeconds}
            revealMode={style.revealMode}
            karaoke={style.karaoke}
            wordEmphasis={style.wordEmphasis}
            fontFamily={placement.layout?.fontFamily ?? style.fontFamily}
            fontSizePx={placement.layout?.fontSizePx ?? style.fontSizePx}
            color={placement.layout?.color ?? style.color}
            strokeColor={placement.layout?.strokeColor ?? style.strokeColor}
            strokeWidthPx={
              placement.layout?.strokeWidthPx ?? style.strokeWidthPx
            }
            opacity={opacity}
          />
        );
      })}
    </>
  );
};

function getCameraTransform(
  props: MotionComicVideoProps,
  timeSeconds: number,
): React.CSSProperties {
  const { camera, durationSeconds, pages } = props;
  if (!camera.enabled || camera.mode === 'none') {
    return { transform: 'none' };
  }
  const page = pageAtTime(pages, timeSeconds);
  const localStart = page?.startSeconds ?? 0;
  const localEnd = page?.endSeconds ?? durationSeconds;
  const span = Math.max(1e-3, localEnd - localStart);
  const t = Math.min(1, Math.max(0, (timeSeconds - localStart) / span));
  const zoom =
    camera.mode === 'slow-zoom-in'
      ? camera.zoomFrom + (camera.zoomTo - camera.zoomFrom) * t
      : camera.mode === 'slow-zoom-out'
        ? camera.zoomTo + (camera.zoomFrom - camera.zoomTo) * (1 - t)
        : 1;
  const panX =
    camera.mode === 'pan'
      ? camera.panFrom.x + (camera.panTo.x - camera.panFrom.x) * t
      : camera.panFrom.x + (camera.panTo.x - camera.panFrom.x) * t;
  const panY = camera.panFrom.y + (camera.panTo.y - camera.panFrom.y) * t;
  return {
    transform: `scale(${zoom}) translate(${panX * 100}%, ${panY * 100}%)`,
    transformOrigin: 'center center',
    transition: 'none',
  };
}

function pageOpacity(
  page: PageInput,
  timeSeconds: number,
  props: MotionComicVideoProps,
): number {
  const { transitions } = props;
  if (!transitions.enabled || transitions.kind === 'none') {
    return 1;
  }
  const fade = Math.max(0, transitions.durationSeconds);
  if (fade === 0) return 1;
  const fadeIn = interpolate(
    timeSeconds,
    [page.startSeconds, page.startSeconds + fade],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  const fadeOut = interpolate(
    timeSeconds,
    [page.endSeconds - fade, page.endSeconds],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return Math.min(fadeIn, fadeOut);
}

export const MotionComicVideo: React.FC<MotionComicVideoProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeSeconds = frame / fps;
  const page = pageAtTime(props.pages, timeSeconds);
  const placement = page
    ? resolvePageCameraPlacement(page, props.width, props.height)
    : null;
  const cameraStyle = getCameraTransform(props, timeSeconds);
  const activeCues = useMemo(
    () => props.cues.filter((cue) => isCueVisibleAt(cue, timeSeconds)),
    [props.cues, timeSeconds],
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: props.backgroundColor,
        overflow: 'hidden',
      }}
    >
      {props.audioUrl ? <Audio src={props.audioUrl} /> : null}
      {page && placement ? (
        <div
          style={{
            position: 'absolute',
            left: placement.offsetX,
            top: placement.offsetY,
            width: placement.width,
            height: placement.height,
            overflow: 'hidden',
            opacity: pageOpacity(page, timeSeconds, props),
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              position: 'relative',
              ...cameraStyle,
            }}
          >
            <img
              src={page.imageUrl}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'fill',
                display: 'block',
              }}
            />
            {/* Captions live in page coordinates, scaled with the art. */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                // Image-space → fitted-page scale is already applied by the
                // wrapper size; caption geometry uses 0..page.width units.
                width: page.width,
                height: page.height,
                transform: `scale(${placement.width / page.width}, ${placement.height / page.height})`,
                transformOrigin: 'top left',
              }}
            >
              {activeCues.map((cue) => (
                <CueLayer
                  key={cue.id}
                  cue={cue}
                  page={page}
                  props={props}
                  timeSeconds={timeSeconds}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
