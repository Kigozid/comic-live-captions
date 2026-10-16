import type {
  CaptionLayout,
  CaptionLinePlacement,
} from '@comic-captioner/core';
import type { ImageSpace, Point, Polygon } from '@comic-captioner/shared';
import type { CaptionSafeRegion } from '@comic-captioner/bubble-engine';

export { TimelineEngine, TimelineError } from './timeline.js';
export {
  TimelineMappingError,
  chunkAlignedWordsForTimeline,
  mapAlignedCaptionsToTimeline,
  buildTimelineFromAlignedWords,
  timelineCuesFromDialogueEvents,
} from './timeline-mapping.js';
export type {
  AlignedCaptionUnit,
  ChunkAlignedWordsOptions,
  TimelineCaptionAssignment,
} from './timeline-mapping.js';
export { proposePagePacing, PagePacingError } from './page-pacing.js';
export type {
  PageDialogueSegmentRef,
  PagePacingInput,
  PagePacingOverride,
  PagePacingProposal,
  PagePacingReason,
  PagePacingSignal,
  PacedPageInput,
} from './page-pacing.js';

export interface CaptionFontMetrics {
  readonly family: string;
  readonly unitsPerEm: number;
  /** Font metric units measured upward from the baseline. */
  readonly ascent: number;
  /** Positive descent below the baseline, in font metric units. */
  readonly descent: number;
  /** Per Unicode code point advance widths in font metric units. */
  readonly glyphAdvances: Readonly<Record<string, number>>;
  /** Used for characters absent from glyphAdvances. */
  readonly fallbackAdvance: number;
  /** Optional pair adjustments in font metric units, keyed as `left+right`. */
  readonly kerningPairs?: Readonly<Record<string, number>>;
}

export interface CaptionFittingInput {
  readonly caption: string;
  readonly font: CaptionFontMetrics;
  readonly fontSizeRange: Readonly<{ minPx: number; maxPx: number }>;
  /** Actual run-length encoded CaptionSafeRegion mask; its bounding box is ignored. */
  readonly safeRegion: CaptionSafeRegion;
  readonly paddingPx: number;
  readonly alignment?: 'left' | 'center' | 'right';
  /** Extra vertical distance between glyph boxes, in page ImageSpace pixels. */
  readonly lineSpacingPx: number;
}

export interface CaptionFittingOptions {
  readonly minimumReadabilityScore?: number;
  readonly maximumTextLength?: number;
}

export class CaptionFitError extends Error {
  readonly code:
    'invalid-input' | 'no-safe-region' | 'text-too-long' | 'minimum-font-size';

  constructor(code: CaptionFitError['code'], message: string) {
    super(message);
    this.name = 'CaptionFitError';
    this.code = code;
  }
}

interface Span {
  readonly left: number;
  readonly right: number;
}

interface PlacedLine {
  readonly text: string;
  readonly words: readonly string[];
  readonly paragraphIndex: number;
  readonly position: Point<ImageSpace>;
  readonly baselineY: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly availableSpanPx: number;
  readonly spanLeft: number;
  readonly spanRight: number;
  readonly anchorX: number;
  readonly alignment: 'left' | 'center' | 'right';
  readonly marginPx: number;
}

interface CandidateLayout {
  readonly top: number;
  readonly fontSize: number;
  readonly glyphHeight: number;
  readonly lines: readonly PlacedLine[];
  readonly width: number;
  readonly height: number;
  readonly fitScore: number;
  readonly readabilityScore: number;
  readonly safetyScore: number;
}

/**
 * Deterministic text layout constrained by the safe mask's actual horizontal
 * spans. Font advance metrics are supplied with the font so this package does
 * not depend on browser canvas, native font state, or an AI provider.
 */
export class CaptionFittingEngine {
  fit(
    input: CaptionFittingInput,
    options: CaptionFittingOptions = {},
  ): CaptionLayout {
    validateInput(input, options);
    const mask = input.safeRegion.mask;
    if (
      input.safeRegion.status !== 'ready' ||
      mask.width === 0 ||
      mask.runs.length === 0
    ) {
      throw new CaptionFitError(
        'no-safe-region',
        'The bubble has no usable caption-safe mask.',
      );
    }
    if (input.caption.trim().length > (options.maximumTextLength ?? 4000)) {
      throw new CaptionFitError(
        'text-too-long',
        'Caption exceeds the supported text length.',
      );
    }

    const fontHeightRatio =
      (input.font.ascent + input.font.descent) / input.font.unitsPerEm;
    const rows = createMaskRows(input.safeRegion);
    const extent = maskExtent(input.safeRegion, rows);
    if (!extent) {
      throw new CaptionFitError(
        'no-safe-region',
        'The bubble has no usable caption-safe mask.',
      );
    }
    const low = Math.ceil(input.fontSizeRange.minPx);
    const high = Math.floor(input.fontSizeRange.maxPx);
    let best: CandidateLayout | null = null;
    let lower = low;
    let upper = high;
    // Feasibility is monotone for ordinary outline fonts: reducing size cannot
    // increase glyph extents. Verify the resulting size and scan downward to
    // tolerate font-specific kerning and irregular-mask discontinuities.
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const candidate = tryFontSize(
        input,
        rows,
        extent,
        middle,
        fontHeightRatio,
      );
      if (candidate) {
        best = candidate;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    if (best) {
      for (
        let size = Math.min(high, best.fontSize + 2);
        size > best.fontSize;
        size -= 1
      ) {
        const candidate = tryFontSize(
          input,
          rows,
          extent,
          size,
          fontHeightRatio,
        );
        if (candidate) best = candidate;
      }
    }
    if (!best) {
      throw new CaptionFitError(
        'minimum-font-size',
        `Caption cannot fit in this safe mask at the minimum font size (${low}px).`,
      );
    }
    const minimumReadability = options.minimumReadabilityScore ?? 0;
    if (best.readabilityScore < minimumReadability) {
      throw new CaptionFitError(
        'minimum-font-size',
        'Caption fits geometrically, but its readability score is below the requested minimum.',
      );
    }
    return toCaptionLayout(input, best);
  }
}

export {
  ReferencePlacementEngine,
  ReferencePlacementError,
} from './reference-placement.js';
export type {
  ReferencePlacementInput,
  ReferencePlacementMode,
  ReferencePlacementOptions,
  ReferencePlacementResult,
} from './reference-placement.js';

function tryFontSize(
  input: CaptionFittingInput,
  rows: readonly (readonly Span[])[],
  extent: Readonly<{ top: number; bottom: number }>,
  fontSize: number,
  glyphHeightRatio: number,
): CandidateLayout | null {
  const glyphHeight = glyphHeightRatio * fontSize;
  const lineAdvance = glyphHeight + input.lineSpacingPx;
  const textWords = input.caption.trim().split(/\s+/u).filter(Boolean);
  const roughLines = Math.max(1, Math.ceil(textWords.length / 5));
  const anchorY =
    input.safeRegion.preferredAnchor?.y ?? (extent.top + extent.bottom) / 2;
  const targetTop =
    anchorY -
    (glyphHeight * roughLines + input.lineSpacingPx * (roughLines - 1)) / 2;
  const step = Math.max(
    0.5,
    Math.min(input.safeRegion.mask.coordinateSpace.maskToImageScaleY, 2),
  );
  const minTop = extent.top + input.paddingPx;
  const maxTop = extent.bottom - input.paddingPx - glyphHeight;
  if (maxTop < minTop) return null;
  const topCandidates = new Set<number>([clamp(targetTop, minTop, maxTop)]);
  const count = Math.ceil((maxTop - minTop) / step);
  for (let index = 0; index <= count; index += 1) {
    topCandidates.add(minTop + index * step);
  }
  const orderedTops = [...topCandidates]
    .filter((top) => top >= minTop - 1e-6 && top <= maxTop + 1e-6)
    .sort(
      (a, b) =>
        Math.abs(a + glyphHeight / 2 - anchorY) -
          Math.abs(b + glyphHeight / 2 - anchorY) || a - b,
    );

  for (const top of orderedTops) {
    const layout = fitAtTop(
      input,
      rows,
      top,
      fontSize,
      glyphHeight,
      lineAdvance,
    );
    if (layout) return layout;
  }
  return null;
}

function fitAtTop(
  input: CaptionFittingInput,
  rows: readonly (readonly Span[])[],
  top: number,
  fontSize: number,
  glyphHeight: number,
  lineAdvance: number,
): CandidateLayout | null {
  const paragraphs = input.caption
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((paragraph) => paragraph.trim().split(/\s+/u).filter(Boolean));
  const lines: PlacedLine[] = [];
  let y = top;
  const anchorX =
    input.safeRegion.preferredAnchor?.x ??
    (input.safeRegion.coordinateSpace.dimensions.width - 1) / 2;

  for (const [paragraphIndex, words] of paragraphs.entries()) {
    if (words.length === 0) continue;
    let cursor = 0;
    while (cursor < words.length) {
      const spans = spansAcrossGlyphHeight(
        rows,
        input.safeRegion,
        y,
        glyphHeight,
        input.paddingPx,
      );
      if (spans.length === 0) return null;
      const options = spans
        .map((span) => {
          let end = cursor;
          let text = '';
          let width = 0;
          while (end < words.length) {
            const nextText = text ? `${text} ${words[end]}` : words[end]!;
            const nextWidth = measureCaptionText(
              nextText,
              input.font,
              fontSize,
            );
            if (nextWidth > span.right - span.left + 1e-7) break;
            text = nextText;
            width = nextWidth;
            end += 1;
          }
          const center = (span.left + span.right) / 2;
          return {
            span,
            end,
            text,
            width,
            distance: Math.abs(center - anchorX),
          };
        })
        .filter((candidate) => candidate.end > cursor)
        .sort(
          (a, b) =>
            b.end - a.end || b.width - a.width || a.distance - b.distance,
        );
      const selected = options[0];
      if (!selected) return null;
      const x = alignedX(
        input.alignment ?? 'center',
        anchorX,
        selected.span,
        selected.width,
      );
      lines.push({
        text: selected.text,
        words: Object.freeze(words.slice(cursor, selected.end)),
        paragraphIndex,
        position: Object.freeze({
          x,
          y,
          coordinateSpace: input.safeRegion.coordinateSpace,
        }),
        baselineY: y + (input.font.ascent / input.font.unitsPerEm) * fontSize,
        widthPx: selected.width,
        heightPx: glyphHeight,
        availableSpanPx: selected.span.right - selected.span.left,
        spanLeft: selected.span.left,
        spanRight: selected.span.right,
        anchorX,
        alignment: input.alignment ?? 'center',
        marginPx: Math.min(
          x - selected.span.left,
          selected.span.right - x - selected.width,
        ),
      });
      cursor = selected.end;
      y += lineAdvance;
      if (lines.length > 256) return null;
    }
  }
  if (lines.length === 0) return null;
  rebalanceOrphans(lines, input.font, fontSize);
  const width = Math.max(...lines.map((line) => line.widthPx));
  const height =
    glyphHeight * lines.length + input.lineSpacingPx * (lines.length - 1);
  const usage = lines.map(
    (line) => line.widthPx / Math.max(1, line.availableSpanPx),
  );
  const averageFill =
    usage.reduce((sum, value) => sum + value, 0) / usage.length;
  const fillConsistency = 1 - Math.min(1, standardDeviation(usage));
  const fitScore = clamp(0.65 * averageFill + 0.35 * fillConsistency);
  const sizeRatio =
    input.fontSizeRange.maxPx === input.fontSizeRange.minPx
      ? 1
      : (fontSize - input.fontSizeRange.minPx) /
        (input.fontSizeRange.maxPx - input.fontSizeRange.minPx);
  const orphanPenalty = lines.some(
    (line, index) => line.words.length === 1 && index > 0,
  )
    ? 0.18
    : 0;
  const readabilityScore = clamp(
    0.72 * sizeRatio + 0.28 * fillConsistency - orphanPenalty,
  );
  const requiredMargin = input.paddingPx + Math.max(1, fontSize * 0.025);
  const safetyScore = clamp(
    Math.min(
      ...lines.map(
        (line) => (line.marginPx + input.paddingPx) / requiredMargin,
      ),
    ),
  );
  return {
    top,
    fontSize,
    glyphHeight,
    lines: Object.freeze(lines),
    width,
    height,
    fitScore,
    readabilityScore,
    safetyScore,
  };
}

function rebalanceOrphans(
  lines: PlacedLine[],
  font: CaptionFontMetrics,
  fontSize: number,
): void {
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const current = lines[index]!;
    const previous = lines[index - 1]!;
    if (previous.paragraphIndex !== current.paragraphIndex) {
      continue;
    }
    const trailingWord = previous.words[previous.words.length - 1]!;
    const awkwardEnding = new Set([
      'a',
      'an',
      'and',
      'at',
      'but',
      'for',
      'in',
      'of',
      'on',
      'or',
      'the',
      'to',
      'with',
    ]).has(trailingWord.toLocaleLowerCase('en'));
    if (
      !awkwardEnding &&
      (current.words.length !== 1 || previous.words.length < 2)
    ) {
      continue;
    }
    if (previous.words.length < 2) continue;
    const movedWord = trailingWord;
    const previousWords = previous.words.slice(0, -1);
    const currentWords = [movedWord, ...current.words];
    const previousText = previousWords.join(' ');
    const currentText = currentWords.join(' ');
    const previousWidth = measureCaptionText(previousText, font, fontSize);
    const currentWidth = measureCaptionText(currentText, font, fontSize);
    if (
      previousWidth > previous.availableSpanPx ||
      currentWidth > current.availableSpanPx
    )
      continue;
    lines[index - 1] = replaceLineText(
      previous,
      previousWords,
      previousText,
      previousWidth,
    );
    lines[index] = replaceLineText(
      current,
      currentWords,
      currentText,
      currentWidth,
    );
  }
}

function replaceLineText(
  line: PlacedLine,
  words: readonly string[],
  text: string,
  width: number,
): PlacedLine {
  const x = alignedX(
    line.alignment,
    line.anchorX,
    { left: line.spanLeft, right: line.spanRight },
    width,
  );
  return {
    ...line,
    text,
    words: Object.freeze([...words]),
    position: Object.freeze({ ...line.position, x }),
    widthPx: width,
    marginPx: Math.min(x - line.spanLeft, line.spanRight - x - width),
  };
}

function spansAcrossGlyphHeight(
  rows: readonly (readonly Span[])[],
  region: CaptionSafeRegion,
  top: number,
  height: number,
  padding: number,
): Span[] {
  const scaleY = region.mask.coordinateSpace.maskToImageScaleY;
  const maskOriginY = region.mask.origin.y;
  let current: Span[] | null = null;
  const firstRow = Math.max(0, Math.floor((top + 0.5) / scaleY) - maskOriginY);
  const endRow = Math.min(
    region.mask.height,
    Math.ceil((top + height + 0.5) / scaleY) - maskOriginY,
  );
  for (let row = firstRow; row < endRow; row += 1) {
    const rowSpans = rows[row] ?? [];
    if (rowSpans.length === 0) return [];
    current =
      current === null ? [...rowSpans] : intersectSpans(current, rowSpans);
    if (current.length === 0) return [];
  }
  return (current ?? [])
    .map((span) => ({ left: span.left + padding, right: span.right - padding }))
    .filter((span) => span.right > span.left);
}

function intersectSpans(left: readonly Span[], right: readonly Span[]): Span[] {
  const result: Span[] = [];
  for (const a of left) {
    for (const b of right) {
      const start = Math.max(a.left, b.left);
      const end = Math.min(a.right, b.right);
      if (end > start) result.push({ left: start, right: end });
    }
  }
  return result.sort((a, b) => a.left - b.left || a.right - b.right);
}

function createMaskRows(
  region: CaptionSafeRegion,
): readonly (readonly Span[])[] {
  const mask = region.mask;
  const scaleX = mask.coordinateSpace.maskToImageScaleX;
  const rows: Span[][] = Array.from({ length: mask.height }, () => []);
  for (const run of mask.runs) {
    if (
      !Number.isInteger(run.x) ||
      !Number.isInteger(run.y) ||
      !Number.isInteger(run.length) ||
      run.x < 0 ||
      run.y < 0 ||
      run.length <= 0 ||
      run.x + run.length > mask.width ||
      run.y >= mask.height
    ) {
      throw new CaptionFitError(
        'invalid-input',
        'Safe mask contains an invalid run.',
      );
    }
    const globalX = mask.origin.x + run.x;
    const left = globalX * scaleX - 0.5;
    const right = (globalX + run.length) * scaleX - 0.5;
    rows[run.y]!.push({ left, right });
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows;
}

function maskExtent(
  region: CaptionSafeRegion,
  rows: readonly (readonly Span[])[],
): { readonly top: number; readonly bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const scaleY = region.mask.coordinateSpace.maskToImageScaleY;
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row]!.length === 0) continue;
    const y = region.mask.origin.y + row;
    top = Math.min(top, y * scaleY - 0.5);
    bottom = Math.max(bottom, (y + 1) * scaleY - 0.5);
  }
  return Number.isFinite(top) && bottom > top ? { top, bottom } : null;
}

export function measureCaptionText(
  text: string,
  font: CaptionFontMetrics,
  fontSize: number,
): number {
  let units = 0;
  let previous = '';
  for (const character of text) {
    units += font.glyphAdvances[character] ?? font.fallbackAdvance;
    units += font.kerningPairs?.[`${previous}+${character}`] ?? 0;
    previous = character;
  }
  return (units / font.unitsPerEm) * fontSize;
}

function alignedX(
  alignment: 'left' | 'center' | 'right',
  anchorX: number,
  span: Span,
  width: number,
): number {
  if (alignment === 'left') return span.left;
  if (alignment === 'right') return span.right - width;
  return clamp(anchorX - width / 2, span.left, span.right - width);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
}

function toCaptionLayout(
  input: CaptionFittingInput,
  candidate: CandidateLayout,
): CaptionLayout {
  const space = input.safeRegion.coordinateSpace;
  const minX = Math.min(...candidate.lines.map((line) => line.position.x));
  const maxX = Math.max(
    ...candidate.lines.map((line) => line.position.x + line.widthPx),
  );
  const minY = candidate.top;
  const maxY = candidate.top + candidate.height;
  const placement: Polygon<ImageSpace> = Object.freeze({
    points: Object.freeze([
      point(minX, minY, space),
      point(maxX, minY, space),
      point(maxX, maxY, space),
      point(minX, maxY, space),
    ]),
    coordinateSpace: space,
  });
  const linePlacements: readonly CaptionLinePlacement[] = Object.freeze(
    candidate.lines.map((line) =>
      Object.freeze({
        text: line.text,
        position: line.position,
        baselineY: line.baselineY,
        widthPx: line.widthPx,
        heightPx: line.heightPx,
        availableSpanPx: line.availableSpanPx,
      }),
    ),
  );
  return Object.freeze({
    id: `caption:${input.safeRegion.id}:${stableHash(input.caption)}:${candidate.fontSize}`,
    bubbleId: input.safeRegion.bubbleId as CaptionLayout['bubbleId'],
    text: input.caption,
    lines: Object.freeze(candidate.lines.map((line) => line.text)),
    placement,
    position: point(minX, minY, space),
    widthPx: maxX - minX,
    heightPx: candidate.height,
    fontFamily: input.font.family,
    fontSizePx: candidate.fontSize,
    alignment: input.alignment ?? 'center',
    lineSpacingPx: input.lineSpacingPx,
    linePlacements,
    fitScore: candidate.fitScore,
    readabilityScore: candidate.readabilityScore,
    safetyScore: candidate.safetyScore,
  });
}

function point(x: number, y: number, space: ImageSpace): Point<ImageSpace> {
  return Object.freeze({ x, y, coordinateSpace: space });
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function validateInput(
  input: CaptionFittingInput,
  options: CaptionFittingOptions,
): void {
  const font = input.font;
  if (
    !input.caption.trim() ||
    !font.family.trim() ||
    !Number.isFinite(font.unitsPerEm) ||
    font.unitsPerEm <= 0 ||
    !Number.isFinite(font.ascent) ||
    font.ascent <= 0 ||
    !Number.isFinite(font.descent) ||
    font.descent < 0 ||
    !Number.isFinite(font.fallbackAdvance) ||
    font.fallbackAdvance <= 0 ||
    Object.values(font.glyphAdvances).some(
      (value) => !Number.isFinite(value) || value <= 0,
    ) ||
    Object.values(font.kerningPairs ?? {}).some(
      (value) => !Number.isFinite(value),
    )
  ) {
    throw new CaptionFitError(
      'invalid-input',
      'Caption text and font metrics must be valid.',
    );
  }
  if (
    !Number.isFinite(input.fontSizeRange.minPx) ||
    !Number.isFinite(input.fontSizeRange.maxPx) ||
    input.fontSizeRange.minPx < 1 ||
    input.fontSizeRange.maxPx < input.fontSizeRange.minPx ||
    input.fontSizeRange.maxPx > 512 ||
    Math.ceil(input.fontSizeRange.minPx) > Math.floor(input.fontSizeRange.maxPx)
  ) {
    throw new CaptionFitError(
      'invalid-input',
      'Font size range must contain integer pixel sizes from 1 to 512.',
    );
  }
  if (
    !Number.isFinite(input.paddingPx) ||
    input.paddingPx < 0 ||
    !Number.isFinite(input.lineSpacingPx) ||
    input.lineSpacingPx < 0
  ) {
    throw new CaptionFitError(
      'invalid-input',
      'Padding and line spacing must be non-negative finite pixel values.',
    );
  }
  const region = input.safeRegion;
  const mask = region.mask;
  if (
    region.coordinateSpace.kind !== 'image' ||
    mask.coordinateSpace.kind !== 'mask' ||
    mask.coordinateSpace.imageSpaceId !== region.coordinateSpace.id ||
    mask.origin.coordinateSpace.id !== mask.coordinateSpace.id ||
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height) ||
    mask.width < 0 ||
    mask.height < 0 ||
    !Number.isInteger(mask.origin.x) ||
    !Number.isInteger(mask.origin.y) ||
    mask.origin.x < 0 ||
    mask.origin.y < 0 ||
    mask.origin.x + mask.width > mask.coordinateSpace.dimensions.width ||
    mask.origin.y + mask.height > mask.coordinateSpace.dimensions.height ||
    mask.coordinateSpace.maskToImageScaleX !==
      region.coordinateSpace.dimensions.width /
        mask.coordinateSpace.dimensions.width ||
    mask.coordinateSpace.maskToImageScaleY !==
      region.coordinateSpace.dimensions.height /
        mask.coordinateSpace.dimensions.height
  ) {
    throw new CaptionFitError(
      'invalid-input',
      'Safe mask dimensions and coordinate spaces are inconsistent.',
    );
  }
  if (
    options.minimumReadabilityScore !== undefined &&
    (!Number.isFinite(options.minimumReadabilityScore) ||
      options.minimumReadabilityScore < 0 ||
      options.minimumReadabilityScore > 1)
  ) {
    throw new CaptionFitError(
      'invalid-input',
      'Minimum readability score must be within [0, 1].',
    );
  }
  if (
    options.maximumTextLength !== undefined &&
    (!Number.isInteger(options.maximumTextLength) ||
      options.maximumTextLength < 1)
  ) {
    throw new CaptionFitError(
      'invalid-input',
      'Maximum text length must be a positive integer.',
    );
  }
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}
