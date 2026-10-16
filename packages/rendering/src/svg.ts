import type { CaptionLayout } from '@comic-captioner/core';
import {
  activeCaptionsAt,
  captionRevealAt,
  type BubbleReusePolicy,
  type CaptionRevealMode,
  type RevealToken,
} from '@comic-captioner/core';

export interface RenderDebugOverlay {
  readonly id: string;
  readonly points: readonly Readonly<{ x: number; y: number }>[];
  readonly color?: string;
  readonly label?: string;
}

export interface CaptionMotion {
  readonly opacity: number;
  readonly scale: number;
}

/** Deterministic, audio-clock-driven entrance/exit. Motion stays anchored inside the fitted bubble. */
export function captionMotionAtTime(
  startSeconds: number,
  endSeconds: number,
  timeSeconds: number,
): CaptionMotion {
  if (
    ![startSeconds, endSeconds, timeSeconds].every(Number.isFinite) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  )
    throw new RangeError(
      'Caption motion requires a valid positive audio interval and finite time.',
    );
  const duration = endSeconds - startSeconds;
  const fadeDuration = Math.min(0.22, duration * 0.18);
  const ease = (value: number) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  const entrance = ease((timeSeconds - startSeconds) / fadeDuration);
  const exit = ease((endSeconds - timeSeconds) / fadeDuration);
  const opacity = Math.min(entrance, exit);
  return Object.freeze({ opacity, scale: 0.96 + 0.04 * entrance });
}

/** Shared deterministic caption layer primitive used by browser preview and export. */
export function renderCaptionLayerSvg(
  width: number,
  height: number,
  layouts: readonly CaptionLayout[],
  motion?: CaptionMotion,
): string {
  assertDimensions(width, height);
  const captions = layouts
    .map((layout) => {
      const lines = layout.linePlacements
        .map(
          (line) =>
            `<text x="${number(alignmentX(layout.alignment, line.position.x, line.widthPx))}" y="${number(line.baselineY)}" text-anchor="${anchor(layout.alignment)}" font-family="${escapeXml(layout.fontFamily)}" font-size="${number(layout.fontSizePx)}">${escapeXml(line.text)}</text>`,
        )
        .join('');
      const centerX = layout.position.x + layout.widthPx / 2;
      const centerY = layout.position.y + layout.heightPx / 2;
      const motionAttributes = motion
        ? ` opacity="${number(Math.max(0, Math.min(1, motion.opacity)))}" transform="translate(${number(centerX)} ${number(centerY)}) scale(${number(Math.max(0.01, motion.scale))}) translate(${number(-centerX)} ${number(-centerY)})"`
        : '';
      return `<g data-bubble-id="${escapeXml(layout.bubbleId)}" fill="#111111"${motionAttributes}>${lines}</g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${captions}</svg>`;
}

/** A caption with its timing and (optionally) aligned word timings. */
export interface TimedCaptionLayout {
  readonly layout: CaptionLayout;
  readonly words?: readonly RevealToken[];
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface TimedCaptionRenderOptions {
  readonly revealMode?: CaptionRevealMode;
  readonly reusePolicy?: BubbleReusePolicy;
  readonly fadeInSeconds?: number;
  readonly karaokeColor?: string;
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((part) => part.length > 0);
}

/**
 * Word-by-word caption layer shared by preview and every export path. Delegates
 * reveal to the deterministic engine so a given timestamp always renders the
 * same words; inactive bubbles stay empty and finished lines persist per the
 * reuse policy. Hidden words keep their full width so the layout never jumps.
 */
export function renderTimedCaptionLayerSvg(
  width: number,
  height: number,
  captions: readonly TimedCaptionLayout[],
  timeSeconds: number,
  options: TimedCaptionRenderOptions = {},
): string {
  assertDimensions(width, height);
  if (!Number.isFinite(timeSeconds))
    throw new RangeError('Caption reveal requires a finite playback time.');
  const mode = options.revealMode ?? 'word-by-word';
  const karaokeColor = options.karaokeColor ?? '#7c3aed';
  const activeRefs = activeCaptionsAt(
    captions.map((caption) => ({
      id: caption.layout.id,
      bubbleId: caption.layout.bubbleId,
      startSeconds: caption.startSeconds,
      endSeconds: caption.endSeconds,
    })),
    timeSeconds,
    { reusePolicy: options.reusePolicy },
  );
  const activeIds = new Set(activeRefs.map((ref) => ref.id));

  const groups = captions
    .filter((caption) => activeIds.has(caption.layout.id))
    .map((caption) => {
      const layout = caption.layout;
      const lineWords = layout.linePlacements.map((line) =>
        splitWords(line.text),
      );
      const totalWords = lineWords.flat();
      const span = Math.max(0, caption.endSeconds - caption.startSeconds);
      const slice = span / Math.max(1, totalWords.length);
      const useReal =
        caption.words !== undefined &&
        caption.words.length === totalWords.length;
      const tokens: readonly RevealToken[] = totalWords.map((word, index) =>
        useReal
          ? {
              text: word,
              startSeconds: caption.words![index]!.startSeconds,
              endSeconds: caption.words![index]!.endSeconds,
            }
          : {
              text: word,
              startSeconds: caption.startSeconds + index * slice,
              endSeconds: caption.startSeconds + (index + 1) * slice,
              estimated: true,
            },
      );
      const reveal = captionRevealAt(tokens, timeSeconds, { mode });

      const lines = layout.linePlacements
        .map((line, lineIndex) => {
          const words = lineWords[lineIndex]!;
          const baseIndex = lineWords
            .slice(0, lineIndex)
            .reduce((sum, entry) => sum + entry.length, 0);
          const charMode = mode === 'character-by-character';
          const tspans = words
            .map((word, k) => {
              const state = reveal.tokens[baseIndex + k];
              const isActive = state?.active === true;
              const content = charMode ? (state?.text ?? '') : word;
              const shown = charMode
                ? content.length > 0
                : state?.revealed === true;
              const fill = isActive ? ` fill="${escapeXml(karaokeColor)}"` : '';
              const trailing = k < words.length - 1 ? ' ' : '';
              return `<tspan fill-opacity="${shown ? 1 : 0}"${fill}>${escapeXml(content)}${trailing}</tspan>`;
            })
            .join('');
          return `<text x="${number(
            alignmentX(layout.alignment, line.position.x, line.widthPx),
          )}" y="${number(line.baselineY)}" text-anchor="${anchor(
            layout.alignment,
          )}" font-family="${escapeXml(
            layout.fontFamily,
          )}" font-size="${number(
            layout.fontSizePx,
          )}" xml:space="preserve">${tspans}</text>`;
        })
        .join('');

      // Entrance-only fade so finished lines persist at full opacity.
      const fadeIn = options.fadeInSeconds ?? 0.12;
      const entrance =
        fadeIn <= 0
          ? 1
          : Math.min(
              1,
              Math.max(0, (timeSeconds - caption.startSeconds) / fadeIn),
            );
      return `<g data-bubble-id="${escapeXml(
        layout.bubbleId,
      )}" data-caption-id="${escapeXml(
        layout.id,
      )}" fill="#111111" opacity="${number(entrance)}">${lines}</g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${groups}</svg>`;
}

/** Independent editor/debug layer; never baked into the comic image layer. */
export function renderDebugLayerSvg(
  width: number,
  height: number,
  overlays: readonly RenderDebugOverlay[],
): string {
  assertDimensions(width, height);
  const items = overlays
    .map((overlay) => {
      const points = overlay.points
        .map((point) => `${number(point.x)},${number(point.y)}`)
        .join(' ');
      const label = overlay.label
        ? `<text x="${number(overlay.points[0]?.x ?? 0)}" y="${number(overlay.points[0]?.y ?? 0)}" fill="${escapeXml(overlay.color ?? '#ff00aa')}" font-size="16">${escapeXml(overlay.label)}</text>`
        : '';
      return `<g data-overlay-id="${escapeXml(overlay.id)}"><polygon points="${points}" fill="none" stroke="${escapeXml(overlay.color ?? '#ff00aa')}" stroke-width="2"/>${label}</g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${items}</svg>`;
}

function anchor(alignment: CaptionLayout['alignment']): string {
  return alignment === 'center'
    ? 'middle'
    : alignment === 'right'
      ? 'end'
      : 'start';
}
function alignmentX(
  alignment: CaptionLayout['alignment'],
  x: number,
  width: number,
): number {
  return alignment === 'center'
    ? x + width / 2
    : alignment === 'right'
      ? x + width
      : x;
}
function number(value: number): string {
  if (!Number.isFinite(value))
    throw new RangeError('Render geometry must be finite.');
  return String(Math.round(value * 1000) / 1000);
}
function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new RangeError('Render dimensions must be positive integers.');
}
function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character]!,
  );
}
