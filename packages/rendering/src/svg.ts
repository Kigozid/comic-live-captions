import type { CaptionLayout } from '@comic-captioner/core';

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
