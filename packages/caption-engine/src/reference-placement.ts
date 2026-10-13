import type {
  CaptionLayout,
  DialogueTextAlignment,
} from '@comic-captioner/core';
import type {
  BinaryMask,
  ImageSpace,
  OriginalTextRegion,
  Point,
} from '@comic-captioner/shared';
import type { CaptionSafeRegion } from '@comic-captioner/bubble-engine';
import {
  CaptionFitError,
  CaptionFittingEngine,
  measureCaptionText,
  type CaptionFontMetrics,
} from './index.js';

export type ReferencePlacementMode = 'reference' | 'auto-fit';

export interface ReferencePlacementInput {
  readonly caption: string;
  readonly font: CaptionFontMetrics;
  readonly fontSizeRange: Readonly<{ minPx: number; maxPx: number }>;
  readonly originalTextRegion: OriginalTextRegion;
  readonly originalLineCount: number;
  readonly originalAlignment: DialogueTextAlignment;
  readonly safeRegion: CaptionSafeRegion;
  readonly paddingPx: number;
  readonly lineSpacingPx: number;
  readonly mode: ReferencePlacementMode;
}

export interface ReferencePlacementOptions {
  /** Reference mode falls back to safe auto-fit with an explicit warning by default. */
  readonly onReferenceFailure?: 'auto-fit' | 'error';
}

export interface ReferencePlacementResult {
  readonly layout: CaptionLayout;
  readonly requestedMode: ReferencePlacementMode;
  readonly mode: ReferencePlacementMode;
  readonly preserved: Readonly<{
    centerDistancePx: number;
    footprintWidthRatio: number;
    footprintHeightRatio: number;
    lineStructure: boolean;
    alignment: boolean;
  }>;
  readonly warnings: readonly string[];
}

export class ReferencePlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferencePlacementError';
  }
}

/** Place replacement dialogue in the original lettering footprint or auto-fit the whole safe mask. */
export class ReferencePlacementEngine {
  readonly #fitter: CaptionFittingEngine;

  constructor(fitter = new CaptionFittingEngine()) {
    this.#fitter = fitter;
  }

  place(
    input: ReferencePlacementInput,
    options: ReferencePlacementOptions = {},
  ): ReferencePlacementResult {
    validateInput(input);
    const anchor = maskCentroid(
      input.originalTextRegion.mask,
      input.originalTextRegion.coordinateSpace,
    );
    const anchoredRegion = withAnchor(input.safeRegion, anchor);

    if (input.mode === 'auto-fit') {
      const layout = this.#autoFit(input, anchoredRegion);
      return makeResult(input, layout, 'auto-fit', []);
    }

    const referenceLayout = this.#referenceFit(input, anchoredRegion);
    if (referenceLayout) {
      return makeResult(input, referenceLayout, 'reference', []);
    }

    const warning =
      'Original line count and footprint could not be preserved; the layout was placed with auto-fit.';
    if (options.onReferenceFailure === 'error') {
      throw new ReferencePlacementError(warning);
    }
    const layout = this.#autoFit(input, anchoredRegion);
    return makeResult(input, layout, 'auto-fit', [warning]);
  }

  #autoFit(
    input: ReferencePlacementInput,
    region: CaptionSafeRegion,
  ): CaptionLayout {
    return this.#fitter.fit({
      caption: input.caption,
      font: input.font,
      fontSizeRange: input.fontSizeRange,
      safeRegion: region,
      paddingPx: input.paddingPx,
      lineSpacingPx: input.lineSpacingPx,
      alignment: toFitAlignment(input.originalAlignment),
    });
  }

  #referenceFit(
    input: ReferencePlacementInput,
    region: CaptionSafeRegion,
  ): CaptionLayout | null {
    const bounds = input.originalTextRegion.boundingBox;
    const safeMask = clipMaskToBounds(input.safeRegion.mask, bounds);
    if (safeMask.runs.length === 0) return null;

    const lineCount = input.originalLineCount;
    const textWords = input.caption.trim().split(/\s+/u).filter(Boolean);
    if (lineCount > textWords.length) return null;
    const availableHeight =
      bounds.height - input.lineSpacingPx * Math.max(0, lineCount - 1);
    const glyphHeightRatio =
      (input.font.ascent + input.font.descent) / input.font.unitsPerEm;
    const estimatedFontSize = Math.floor(
      availableHeight / (lineCount * glyphHeightRatio),
    );
    const maximum = Math.min(
      Math.floor(input.fontSizeRange.maxPx),
      estimatedFontSize,
    );
    const minimum = Math.ceil(input.fontSizeRange.minPx);
    if (maximum < minimum) return null;

    const constrainedRegion: CaptionSafeRegion = Object.freeze({
      ...region,
      mask: safeMask,
      preferredAnchor: region.preferredAnchor,
    });
    for (let size = maximum; size >= minimum; size -= 1) {
      const lineBreaks = balanceLines(
        input.caption,
        lineCount,
        input.font,
        size,
        bounds.width - 2 * input.paddingPx,
      );
      if (!lineBreaks) continue;
      try {
        const layout = this.#fitter.fit({
          caption: lineBreaks.join('\n'),
          font: input.font,
          fontSizeRange: { minPx: size, maxPx: size },
          safeRegion: constrainedRegion,
          paddingPx: input.paddingPx,
          lineSpacingPx: input.lineSpacingPx,
          alignment: toFitAlignment(input.originalAlignment),
        });
        if (
          layout.lines.length === lineCount &&
          layout.widthPx <= bounds.width + 1e-6 &&
          layout.heightPx <= bounds.height + 1e-6
        ) {
          return layout;
        }
      } catch (error) {
        if (!(error instanceof CaptionFitError)) throw error;
      }
    }
    return null;
  }
}

function balanceLines(
  caption: string,
  lineCount: number,
  font: CaptionFontMetrics,
  fontSize: number,
  maximumWidth: number,
): string[] | null {
  const words = caption.trim().split(/\s+/u).filter(Boolean);
  if (lineCount <= 0 || lineCount > words.length || maximumWidth <= 0)
    return null;
  const totalWidth = measureCaptionText(caption, font, fontSize);
  const targetWidth = totalWidth / lineCount;
  const costs: Array<Array<number>> = Array.from(
    { length: lineCount + 1 },
    () =>
      Array.from({ length: words.length + 1 }, () => Number.POSITIVE_INFINITY),
  );
  const breaks: Array<Array<number>> = Array.from(
    { length: lineCount + 1 },
    () => Array.from({ length: words.length + 1 }, () => -1),
  );
  costs[0]![0] = 0;
  for (let usedLines = 1; usedLines <= lineCount; usedLines += 1) {
    for (let end = usedLines; end <= words.length; end += 1) {
      for (let start = usedLines - 1; start < end; start += 1) {
        if (!Number.isFinite(costs[usedLines - 1]![start]!)) continue;
        const text = words.slice(start, end).join(' ');
        const width = measureCaptionText(text, font, fontSize);
        if (width > maximumWidth) continue;
        const raggedness =
          ((targetWidth - width) / Math.max(1, maximumWidth)) ** 2;
        const candidate = costs[usedLines - 1]![start]! + raggedness;
        if (candidate < costs[usedLines]![end]!) {
          costs[usedLines]![end] = candidate;
          breaks[usedLines]![end] = start;
        }
      }
    }
  }
  if (!Number.isFinite(costs[lineCount]![words.length]!)) return null;
  const lines = new Array<string>(lineCount);
  let end = words.length;
  for (let usedLines = lineCount; usedLines > 0; usedLines -= 1) {
    const start = breaks[usedLines]![end]!;
    if (start < 0) return null;
    lines[usedLines - 1] = words.slice(start, end).join(' ');
    end = start;
  }
  return lines;
}

function clipMaskToBounds(
  mask: BinaryMask,
  bounds: OriginalTextRegion['boundingBox'],
): BinaryMask {
  const scaleX = mask.coordinateSpace.maskToImageScaleX;
  const scaleY = mask.coordinateSpace.maskToImageScaleY;
  const minGlobalX = Math.ceil((bounds.x + 0.5) / scaleX - 1e-9);
  const maxGlobalXExclusive = Math.floor(
    (bounds.x + bounds.width + 0.5) / scaleX + 1e-9,
  );
  const minGlobalY = Math.ceil((bounds.y + 0.5) / scaleY - 1e-9);
  const maxGlobalYExclusive = Math.floor(
    (bounds.y + bounds.height + 0.5) / scaleY + 1e-9,
  );
  const runs = mask.runs.flatMap((run) => {
    const globalY = mask.origin.y + run.y;
    const start = Math.max(mask.origin.x + run.x, minGlobalX);
    const end = Math.min(
      mask.origin.x + run.x + run.length,
      maxGlobalXExclusive,
    );
    if (
      globalY < minGlobalY ||
      globalY >= maxGlobalYExclusive ||
      end <= start
    ) {
      return [];
    }
    return [
      Object.freeze({
        y: run.y,
        x: start - mask.origin.x,
        length: end - start,
      }),
    ];
  });
  return Object.freeze({ ...mask, runs: Object.freeze(runs) });
}

function maskCentroid(mask: BinaryMask, space: ImageSpace): Point<ImageSpace> {
  const scaleX = mask.coordinateSpace.maskToImageScaleX;
  const scaleY = mask.coordinateSpace.maskToImageScaleY;
  let total = 0;
  let sumX = 0;
  let sumY = 0;
  for (const run of mask.runs) {
    const count = run.length;
    const firstX = mask.origin.x + run.x;
    const lastX = firstX + count - 1;
    const centerX = ((firstX + lastX) / 2 + 0.5) * scaleX - 0.5;
    const centerY = (mask.origin.y + run.y + 0.5) * scaleY - 0.5;
    total += count;
    sumX += centerX * count;
    sumY += centerY * count;
  }
  return Object.freeze({
    x: sumX / total,
    y: sumY / total,
    coordinateSpace: space,
  });
}

function withAnchor(
  region: CaptionSafeRegion,
  anchor: Point<ImageSpace>,
): CaptionSafeRegion {
  return Object.freeze({ ...region, preferredAnchor: anchor });
}

function toFitAlignment(
  alignment: DialogueTextAlignment,
): 'left' | 'center' | 'right' {
  return alignment === 'left' || alignment === 'right' ? alignment : 'center';
}

function makeResult(
  input: ReferencePlacementInput,
  layout: CaptionLayout,
  mode: ReferencePlacementMode,
  warnings: readonly string[],
): ReferencePlacementResult {
  const bounds = input.originalTextRegion.boundingBox;
  const originalCenter = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const layoutCenter = {
    x: layout.position.x + layout.widthPx / 2,
    y: layout.position.y + layout.heightPx / 2,
  };
  return Object.freeze({
    layout,
    requestedMode: input.mode,
    mode,
    preserved: Object.freeze({
      centerDistancePx: Math.hypot(
        layoutCenter.x - originalCenter.x,
        layoutCenter.y - originalCenter.y,
      ),
      footprintWidthRatio: layout.widthPx / bounds.width,
      footprintHeightRatio: layout.heightPx / bounds.height,
      lineStructure: layout.lines.length === input.originalLineCount,
      alignment: layout.alignment === toFitAlignment(input.originalAlignment),
    }),
    warnings: Object.freeze([...warnings]),
  });
}

function validateInput(input: ReferencePlacementInput): void {
  const region = input.originalTextRegion;
  const bounds = region.boundingBox;
  const mask = region.mask;
  if (
    (input.mode !== 'reference' && input.mode !== 'auto-fit') ||
    !input.caption.trim() ||
    !Number.isInteger(input.originalLineCount) ||
    input.originalLineCount < 1 ||
    input.originalLineCount > 256 ||
    !['left', 'center', 'right', 'unknown'].includes(input.originalAlignment) ||
    bounds.coordinateSpace.id !== input.safeRegion.coordinateSpace.id ||
    bounds.coordinateSpace.dimensions.width !==
      input.safeRegion.coordinateSpace.dimensions.width ||
    bounds.coordinateSpace.dimensions.height !==
      input.safeRegion.coordinateSpace.dimensions.height ||
    region.coordinateSpace.id !== input.safeRegion.coordinateSpace.id ||
    region.coordinateSpace.dimensions.width !==
      input.safeRegion.coordinateSpace.dimensions.width ||
    region.coordinateSpace.dimensions.height !==
      input.safeRegion.coordinateSpace.dimensions.height ||
    mask.coordinateSpace.imageSpaceId !== input.safeRegion.coordinateSpace.id ||
    mask.origin.coordinateSpace.id !== mask.coordinateSpace.id ||
    mask.width <= 0 ||
    mask.height <= 0 ||
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height) ||
    !Number.isInteger(mask.origin.x) ||
    !Number.isInteger(mask.origin.y) ||
    mask.origin.x < 0 ||
    mask.origin.y < 0 ||
    mask.origin.x + mask.width > mask.coordinateSpace.dimensions.width ||
    mask.origin.y + mask.height > mask.coordinateSpace.dimensions.height ||
    mask.coordinateSpace.maskToImageScaleX !==
      input.safeRegion.coordinateSpace.dimensions.width /
        mask.coordinateSpace.dimensions.width ||
    mask.coordinateSpace.maskToImageScaleY !==
      input.safeRegion.coordinateSpace.dimensions.height /
        mask.coordinateSpace.dimensions.height ||
    region.polygon.coordinateSpace.id !== input.safeRegion.coordinateSpace.id ||
    region.polygon.points.length < 3 ||
    region.polygon.points.some(
      (point) =>
        point.coordinateSpace.id !== input.safeRegion.coordinateSpace.id ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y),
    ) ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x < -0.5 ||
    bounds.y < -0.5 ||
    bounds.x + bounds.width >
      input.safeRegion.coordinateSpace.dimensions.width - 0.5 ||
    bounds.y + bounds.height >
      input.safeRegion.coordinateSpace.dimensions.height - 0.5 ||
    mask.runs.length === 0 ||
    mask.runs.some(
      (run) =>
        !Number.isInteger(run.x) ||
        !Number.isInteger(run.y) ||
        !Number.isInteger(run.length) ||
        run.x < 0 ||
        run.y < 0 ||
        run.length <= 0 ||
        run.x + run.length > mask.width ||
        run.y >= mask.height,
    )
  ) {
    throw new ReferencePlacementError(
      'Original text geometry, mask, line count, alignment, and safe region must be valid in the same ImageSpace.',
    );
  }
}
