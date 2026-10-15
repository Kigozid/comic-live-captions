import type {
  Bounds,
  ImageSpace,
  Polygon,
} from '@comic-captioner/shared';
import {
  InpaintError,
  type InpaintBubbleInput,
  type InpaintMode,
  type RasterImage,
} from './inpaint.js';

/**
 * Production comic lettering-removal engine.
 *
 * Removes original lettering while preserving speech-bubble interiors,
 * bubble outlines, panel borders, character artwork, and page dimensions.
 *
 * Region-aware strategies:
 * - `white-fill`      — plain white balloon: replace only the text mask with white
 * - `background-fill` — coloured balloon: sample interior background outside the mask
 * - `local-reconstruct` — textured/gradient interior: iterative neighborhood fill
 * - `lama`            — optional generative fallback for text over artwork
 *
 * Geometry provenance and method choices are always recorded per region.
 * Confidence channels stay separate. The original raster is never mutated.
 */

export type LetteringRemovalMethod =
  | 'white-fill'
  | 'background-fill'
  | 'local-reconstruct'
  | 'lama'
  | 'skipped'
  | 'manual';

export type LetteringRegionContext =
  | 'white-balloon'
  | 'coloured-balloon'
  | 'textured-balloon'
  | 'artwork'
  | 'unknown';

export type LetteringWarningCode =
  | 'near-outline'
  | 'low-confidence'
  | 'mask-empty'
  | 'mask-invalid'
  | 'method-unavailable'
  | 'method-failed'
  | 'crosses-boundary'
  | 'adjacent-text'
  | 'uncertain-context'
  | 'needs-review'
  | 'out-of-scope';

/**
 * Who may erase a region without a human pass:
 * - `bubble-interior` (default): only regions tied to a detected bubble, plus
 *   explicit manual mask edits. Free-floating text regions are never
 *   auto-erased.
 * - `approved`: also erase regions marked `approved` or
 *   `reviewStatus: 'accepted'` / `'edited'`.
 */
export type LetteringErasureScope = 'bubble-interior' | 'approved';

export interface LetteringWarning {
  readonly code: LetteringWarningCode;
  readonly regionId: string;
  readonly message: string;
}

export interface LetteringSourceRegion {
  readonly id: string;
  /**
   * Preferred geometry. When `mask` is set it defines erasure pixels.
   * Otherwise `polygon` is rasterized; bounding boxes are a last resort.
   */
  readonly mask?: Uint8Array | null;
  readonly polygon?: Polygon<ImageSpace> | null;
  readonly boundingBox?: Bounds<ImageSpace> | null;
  /** Detection confidence for the text region itself (not association). */
  readonly detectionConfidence?: number;
  /** Bubble this region was assigned to, when known. */
  readonly associatedBubbleId?: string | null;
  /** Association confidence; never reused as detection confidence. */
  readonly associationConfidence?: number;
  /** Force a removal method; otherwise the engine chooses. */
  readonly preferredMethod?: LetteringRemovalMethod;
  /**
   * Human review state. Unreviewed regions outside bubbles are held for
   * review and are never auto-erased under the default scope.
   */
  readonly reviewStatus?: 'pending' | 'accepted' | 'rejected' | 'edited';
  /** Explicit user approval (equivalent to reviewStatus 'accepted'). */
  readonly approved?: boolean;
}

export interface ManualMaskEdit {
  readonly regionId?: string;
  /** Pixels to force into the removal mask (dense page-sized). */
  readonly addPixels?: Uint8Array | null;
  /** Pixels to exclude from removal (dense page-sized). */
  readonly excludePixels?: Uint8Array | null;
}

export interface LetteringRemovalInput {
  readonly image: RasterImage;
  readonly coordinateSpace: ImageSpace;
  readonly bubbles?: readonly LetteringBubbleInput[];
  readonly textRegions: readonly LetteringSourceRegion[];
  readonly manualEdits?: readonly ManualMaskEdit[];
  readonly options?: LetteringRemovalOptions;
}

export interface LetteringBubbleInput extends InpaintBubbleInput {
  /** Optional dense outline-protection mask (1 = do not erase). */
  readonly outlineMask?: Uint8Array | null;
  /** Interior classification hint from detection. */
  readonly interiorHint?: LetteringRegionContext;
}

export interface LetteringRemovalOptions {
  /** Mask expansion radius in pixels for antialiasing (default 2). */
  readonly expansionPx?: number;
  /**
   * Maximum expansion allowed near a protected outline. When the expanded
   * mask would reach an outline, expansion is reduced to this radius and the
   * region is flagged (default 0).
   */
  readonly maximumOutlineAdjacentExpansionPx?: number;
  /** Luminance at or above which interior counts as white (default 235). */
  readonly whiteLuminance?: number;
  /** Interior luminance deviation for plain vs textured (default 8). */
  readonly plainTextureDeviation?: number;
  /** Minimum samples for a robust background estimate (default 12). */
  readonly minimumBackgroundSamples?: number;
  /** Regions below this detection confidence are flagged (default 0.55). */
  readonly reviewConfidenceThreshold?: number;
  /** Prefer LaMa for artwork regions when the provider is configured. */
  readonly preferLamaForArtwork?: boolean;
  /**
   * Maximum pixels for generative inpainting. Larger holes fall back to
   * deterministic reconstruction so LaMa cannot rewrite whole panels.
   * Default 40_000 pixels (≈6% of a 640×480 page).
   */
  readonly maximumGenerativeMaskPixels?: number;
  /** Merge nearby text masks when their gap is at most this many pixels. */
  readonly mergeGapPx?: number;
  /**
   * Default `bubble-interior`: erase only bubble-associated lettering (plus
   * manual edits). Set `approved` to also erase regions explicitly marked
   * `approved` / `reviewStatus: 'accepted'` or `'edited'`. Unreviewed
   * free-floating text is never erased automatically.
   */
  readonly erasureScope?: LetteringErasureScope;
}

export interface LetteringRegionResult {
  readonly id: string;
  readonly sourceRegionId: string;
  readonly associatedBubbleId: string | null;
  readonly method: LetteringRemovalMethod;
  readonly context: LetteringRegionContext;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly maskPixelCount: number;
  /** Erasure confidence for this region's method choice + mask quality. */
  readonly methodConfidence: number;
  readonly success: boolean;
  readonly needsReview: boolean;
  readonly geometryProvenance: 'mask' | 'polygon' | 'bounding-box' | 'manual';
}

export interface LetteringRemovalResult {
  /** Cleaned RGBA raster, same dimensions as the input. Never the same buffer. */
  readonly cleaned: RasterImage;
  /** Dense page-sized removal mask (1 = erased / planned erase). */
  readonly removalMask: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly regions: readonly LetteringRegionResult[];
  readonly warnings: readonly LetteringWarning[];
  /** True when every attempted region succeeded. */
  readonly complete: boolean;
  /** Human-readable summary of methods used. */
  readonly methodSummary: Readonly<Record<LetteringRemovalMethod, number>>;
}

/**
 * Optional generative inpainting port (e.g. LaMa). Implementations must be
 * invoked only on tight text masks and must return a full-page raster or a
 * crop that the engine maps back. Failures are reported; the original pixels
 * in the mask are preserved so the operation is never a silent no-op success.
 */
export interface GenerativeInpaintProvider {
  readonly name: string;
  readonly available: () => Promise<boolean> | boolean;
  inpaint(input: {
    readonly image: RasterImage;
    readonly mask: Uint8Array;
    readonly boundingBox: Bounds<ImageSpace>;
  }): Promise<RasterImage>;
}

export interface LetteringRemoverOptions {
  readonly generative?: GenerativeInpaintProvider | null;
}

export class LetteringRemovalError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_MASK'
      | 'DIMENSION_MISMATCH'
      | 'METHOD_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'LetteringRemovalError';
  }
}

const DEFAULT_EXPANSION_PX = 2;
const DEFAULT_OUTLINE_ADJACENT_EXPANSION_PX = 0;
const DEFAULT_WHITE_LUMINANCE = 235;
const DEFAULT_PLAIN_TEXTURE_DEVIATION = 8;
const DEFAULT_MINIMUM_BACKGROUND_SAMPLES = 12;
const DEFAULT_REVIEW_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_MERGE_GAP_PX = 3;
const DEFAULT_MAXIMUM_GENERATIVE_MASK_PIXELS = 40_000;
const MAX_RASTER_PIXELS = 40_000_000;

/**
 * Deterministic, region-aware lettering removal. Heavy model inference stays
 * behind `GenerativeInpaintProvider` and is optional; the default path is pure
 * TypeScript over RGBA rasters so unit tests need no model downloads.
 */
export class LetteringRemover {
  readonly #generative: GenerativeInpaintProvider | null;

  constructor(options: LetteringRemoverOptions = {}) {
    this.#generative = options.generative ?? null;
    Object.freeze(this);
  }

  async removeLettering(
    input: LetteringRemovalInput,
  ): Promise<LetteringRemovalResult> {
    const settings = resolveOptions(input.options);
    validateRaster(input.image);
    const { width, height } = input.image;
    const pixelCount = width * height;
    validateSpace(input.coordinateSpace, width, height);

    const warnings: LetteringWarning[] = [];
    const protectedOutline = buildOutlineProtection(
      input.bubbles ?? [],
      width,
      height,
    );
    const methodSummary: Record<LetteringRemovalMethod, number> = {
      'white-fill': 0,
      'background-fill': 0,
      'local-reconstruct': 0,
      lama: 0,
      skipped: 0,
      manual: 0,
    };

    // Validate every source region up front — including held ones — so
    // malformed masks fail loudly instead of being silently skipped.
    for (const region of input.textRegions) {
      if (region.mask) {
        validateDenseMask(region.mask, pixelCount, `region ${region.id} mask`);
      } else if (
        !(region.polygon && region.polygon.points.length >= 3) &&
        !region.boundingBox
      ) {
        throw new LetteringRemovalError(
          'INVALID_MASK',
          `Text region ${region.id} needs a mask, polygon, or bounding box.`,
        );
      }
    }

    // Safety policy: default erasure is bubble-interior only. Unreviewed
    // free-floating text is held for review and never auto-erased (real-page
    // runs showed full-page text false-positives damaging artwork).
    const scope = settings.erasureScope;
    const eraseIndices: number[] = [];
    const heldResults: LetteringRegionResult[] = [];
    for (const [index, source] of input.textRegions.entries()) {
      const decision = decideErasability(source, scope);
      if (decision.erase) {
        eraseIndices.push(index);
        continue;
      }
      warnings.push({
        code: decision.code,
        regionId: source.id,
        message: decision.message,
      });
      heldResults.push({
        id: `lettering:${source.id}`,
        sourceRegionId: source.id,
        associatedBubbleId: source.associatedBubbleId ?? null,
        method: 'skipped',
        context: 'unknown',
        boundingBox:
          source.boundingBox ??
          Object.freeze({
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            coordinateSpace: input.coordinateSpace,
          }),
        maskPixelCount: 0,
        methodConfidence: 0,
        success: true,
        needsReview: true,
        geometryProvenance: source.mask
          ? 'mask'
          : source.polygon
            ? 'polygon'
            : 'bounding-box',
      });
      methodSummary.skipped += 1;
    }

    const activeRegions = eraseIndices.map((index) => input.textRegions[index]!);
    const baseMasks = activeRegions.map((region) =>
      rasterizeSourceRegion(
        region,
        width,
        height,
        input.coordinateSpace,
        input.image,
      ),
    );

    // Manual additions join their region's mask. Exclusions always win.
    for (const edit of input.manualEdits ?? []) {
      if (!edit.addPixels) continue;
      validateDenseMask(edit.addPixels, pixelCount, 'manual addPixels');
      const targetIndex = edit.regionId
        ? activeRegions.findIndex((region) => region.id === edit.regionId)
        : -1;
      if (targetIndex >= 0) {
        const target = baseMasks[targetIndex]!;
        for (let i = 0; i < pixelCount; i += 1) {
          if (edit.addPixels[i]) target.mask[i] = 1;
        }
      }
    }

    // Per-region conservative expansion so each fill keeps its own erase area.
    const expandedMasks = baseMasks.map((entry) => {
      const expanded = expandMaskConservative(
        entry.mask,
        protectedOutline,
        width,
        height,
        settings.expansionPx,
        settings.maximumOutlineAdjacentExpansionPx,
      );
      if (expanded.reducedNearOutline) {
        warnings.push({
          code: 'near-outline',
          regionId:
            activeRegions[baseMasks.indexOf(entry)]?.id ?? 'unknown',
          message:
            'Mask expansion was reduced near a protected bubble/panel outline.',
        });
      }
      return expanded.mask;
    });

    // Unscoped manual additions are their own erase overlay.
    let unscopedAdd: Uint8Array | null = null;
    for (const edit of input.manualEdits ?? []) {
      if (edit.addPixels && !edit.regionId) {
        unscopedAdd ??= new Uint8Array(pixelCount);
        for (let i = 0; i < pixelCount; i += 1) {
          if (edit.addPixels[i]) unscopedAdd[i] = 1;
        }
      }
    }

    let workingMask = unionMasks(expandedMasks, pixelCount);
    if (unscopedAdd) {
      for (let i = 0; i < pixelCount; i += 1) {
        if (unscopedAdd[i]) workingMask[i] = 1;
      }
    }
    for (const edit of input.manualEdits ?? []) {
      if (edit.excludePixels) {
        validateDenseMask(edit.excludePixels, pixelCount, 'manual excludePixels');
        for (let i = 0; i < pixelCount; i += 1) {
          if (edit.excludePixels[i]) {
            workingMask[i] = 0;
            for (const regionMask of expandedMasks) regionMask[i] = 0;
          }
        }
      }
    }

    // Merge nearby masks so overlapping lettering is one hole, not seams.
    if (settings.mergeGapPx > 0) {
      workingMask = mergeNearbyMaskBlobs(workingMask, width, height, settings.mergeGapPx);
      // Keep per-region masks aligned with the merged union.
      for (const regionMask of expandedMasks) {
        for (let i = 0; i < pixelCount; i += 1) {
          if (regionMask[i] && workingMask[i]) regionMask[i] = 1;
          else if (!workingMask[i]) regionMask[i] = 0;
        }
      }
    }

    // Never erase protected outline pixels.
    for (let i = 0; i < pixelCount; i += 1) {
      if (protectedOutline[i]) {
        workingMask[i] = 0;
        for (const regionMask of expandedMasks) regionMask[i] = 0;
      }
    }

    const cleaned = new Uint8ClampedArray(input.image.data);
    const regionResults: LetteringRegionResult[] = [...heldResults];

    for (const [index, source] of activeRegions.entries()) {
      const base = baseMasks[index]!;
      const regionMask = expandedMasks[index]!;
      if (countMask(regionMask) === 0) {
        warnings.push({
          code: 'mask-empty',
          regionId: source.id,
          message: 'No erasure pixels remained after protection and exclusions.',
        });
        regionResults.push({
          id: `lettering:${source.id}`,
          sourceRegionId: source.id,
          associatedBubbleId: source.associatedBubbleId ?? null,
          method: 'skipped',
          context: 'unknown',
          boundingBox: base.boundingBox,
          maskPixelCount: 0,
          methodConfidence: 0,
          success: true,
          needsReview: true,
          geometryProvenance: base.geometryProvenance,
        });
        methodSummary.skipped += 1;
        continue;
      }

      const bubble = findBubble(input.bubbles ?? [], source.associatedBubbleId);
      const context = classifyContext(
        input.image,
        regionMask,
        bubble,
        settings,
      );
      if (context === 'unknown') {
        warnings.push({
          code: 'uncertain-context',
          regionId: source.id,
          message: 'Could not classify the lettering background confidently.',
        });
      }

      if (crossesBoundary(regionMask, protectedOutline, width, height)) {
        warnings.push({
          code: 'crosses-boundary',
          regionId: source.id,
          message:
            'Text mask approaches a protected outline; erasure was clipped and flagged.',
        });
      }

      let method: LetteringRemovalMethod =
        source.preferredMethod ?? chooseMethod(context, settings, this.#generative);
      let success = true;
      let methodConfidence = methodConfidenceFor(method, context, source);

      if (method === 'lama') {
        const maskPixels = countMask(regionMask);
        if (maskPixels > settings.maximumGenerativeMaskPixels) {
          warnings.push({
            code: 'method-unavailable',
            regionId: source.id,
            message:
              `Mask covers ${maskPixels} pixels; generative inpainting is limited to ${settings.maximumGenerativeMaskPixels} so LaMa cannot rewrite whole panels. Falling back to local reconstruction.`,
          });
          method = 'local-reconstruct';
          methodConfidence = Math.min(methodConfidence, 0.5);
        }
      }

      if (method === 'lama') {
        if (!this.#generative) {
          warnings.push({
            code: 'method-unavailable',
            regionId: source.id,
            message:
              'LaMa inpainting is not configured; falling back to local reconstruction.',
          });
          method = 'local-reconstruct';
          methodConfidence = Math.min(methodConfidence, 0.45);
        } else {
          const available = await this.#generative.available();
          if (!available) {
            warnings.push({
              code: 'method-unavailable',
              regionId: source.id,
              message:
                'LaMa provider reported unavailable; falling back to local reconstruction.',
            });
            method = 'local-reconstruct';
            methodConfidence = Math.min(methodConfidence, 0.45);
          } else {
            try {
              const filled = await this.#generative.inpaint({
                image: { width, height, data: cleaned },
                mask: regionMask,
                boundingBox: base.boundingBox,
              });
              if (
                filled.width !== width ||
                filled.height !== height ||
                filled.data.length !== cleaned.length
              ) {
                throw new Error('LaMa returned an unexpected raster size.');
              }
              for (let i = 0; i < pixelCount; i += 1) {
                if (regionMask[i]) {
                  cleaned[i * 4] = filled.data[i * 4]!;
                  cleaned[i * 4 + 1] = filled.data[i * 4 + 1]!;
                  cleaned[i * 4 + 2] = filled.data[i * 4 + 2]!;
                  cleaned[i * 4 + 3] = 255;
                }
              }
            } catch (cause) {
              success = false;
              warnings.push({
                code: 'method-failed',
                regionId: source.id,
                message: `LaMa inpainting failed: ${cause instanceof Error ? cause.message : 'unknown error'}. Pixels left unchanged for this region.`,
              });
              method = 'skipped';
              methodConfidence = 0;
            }
          }
        }
      }

      if (method === 'white-fill' || method === 'background-fill' || method === 'local-reconstruct') {
        applyDeterministicFill(
          cleaned,
          regionMask,
          protectedOutline,
          base.boundingBox,
          width,
          height,
          method,
          settings,
        );
      }

      methodSummary[method] += 1;
      const needsReview =
        methodConfidence < settings.reviewConfidenceThreshold ||
        context === 'unknown' ||
        context === 'artwork' ||
        (source.detectionConfidence !== undefined &&
          source.detectionConfidence < settings.reviewConfidenceThreshold) ||
        !success;

      if (
        source.detectionConfidence !== undefined &&
        source.detectionConfidence < settings.reviewConfidenceThreshold
      ) {
        warnings.push({
          code: 'low-confidence',
          regionId: source.id,
          message: 'Text-region detection confidence is below the review threshold.',
        });
      }

      regionResults.push({
        id: `lettering:${source.id}`,
        sourceRegionId: source.id,
        associatedBubbleId: source.associatedBubbleId ?? null,
        method,
        context,
        boundingBox: base.boundingBox,
        maskPixelCount: countMask(regionMask),
        methodConfidence,
        success,
        needsReview,
        geometryProvenance: base.geometryProvenance,
      });
    }

    // Fill any unscoped manual erase pixels that no source region claimed.
    // Merge artifacts from nearby region masks are already claimed; only
    // explicit unscoped additions land here.
    const leftover = new Uint8Array(pixelCount);
    let leftoverCount = 0;
    if (unscopedAdd) {
      for (let i = 0; i < pixelCount; i += 1) {
        if (!workingMask[i] || !unscopedAdd[i]) continue;
        let claimed = false;
        for (const regionMask of expandedMasks) {
          if (regionMask[i]) {
            claimed = true;
            break;
          }
        }
        if (!claimed) {
          leftover[i] = 1;
          leftoverCount += 1;
        }
      }
    }
    if (leftoverCount > 0) {
      applyDeterministicFill(
        cleaned,
        leftover,
        protectedOutline,
        maskBounds(leftover, width, height, input.coordinateSpace),
        width,
        height,
        'background-fill',
        settings,
      );
      methodSummary.manual += 1;
      regionResults.push({
        id: 'lettering:manual',
        sourceRegionId: 'manual',
        associatedBubbleId: null,
        method: 'manual',
        context: 'unknown',
        boundingBox: maskBounds(leftover, width, height, input.coordinateSpace),
        maskPixelCount: leftoverCount,
        methodConfidence: 0.7,
        success: true,
        needsReview: true,
        geometryProvenance: 'manual',
      });
    }

    const removalMask = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i += 1) {
      // Erased pixels are those that differ from the source inside the mask.
      const src = input.image.data;
      const changed =
        cleaned[i * 4] !== src[i * 4] ||
        cleaned[i * 4 + 1] !== src[i * 4 + 1] ||
        cleaned[i * 4 + 2] !== src[i * 4 + 2];
      removalMask[i] = workingMask[i] && changed ? 1 : workingMask[i]!;
    }

    return Object.freeze({
      cleaned: Object.freeze({ width, height, data: cleaned }),
      removalMask,
      width,
      height,
      regions: Object.freeze(regionResults),
      warnings: Object.freeze(warnings),
      complete: regionResults.every((region) => region.success),
      methodSummary: Object.freeze(methodSummary),
    });
  }
}

// ---------------------------------------------------------------------------
// Mask construction
// ---------------------------------------------------------------------------

interface RasterizedRegion {
  readonly mask: Uint8Array;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly geometryProvenance: LetteringRegionResult['geometryProvenance'];
}

function rasterizeSourceRegion(
  region: LetteringSourceRegion,
  width: number,
  height: number,
  space: ImageSpace,
  image?: RasterImage,
  inkThreshold?: number,
): RasterizedRegion {
  const pixelCount = width * height;
  if (region.mask) {
    validateDenseMask(region.mask, pixelCount, `region ${region.id} mask`);
    return {
      mask: Uint8Array.from(region.mask),
      boundingBox: region.boundingBox ?? maskBounds(region.mask, width, height, space),
      geometryProvenance: 'mask',
    };
  }
  if (region.polygon && region.polygon.points.length >= 3) {
    const mask = rasterizePolygon(region.polygon, width, height);
    const refined = image
      ? refineMaskWithInk(image, mask, width, height, inkThreshold ?? 150)
      : mask;
    return {
      mask: refined,
      boundingBox:
        region.boundingBox ?? polygonBounds(region.polygon, space),
      geometryProvenance: 'polygon',
    };
  }
  if (region.boundingBox) {
    const mask = rasterizeBounds(region.boundingBox, width, height);
    const refined = image
      ? refineMaskWithInk(image, mask, width, height, inkThreshold ?? 150)
      : mask;
    return {
      mask: refined,
      boundingBox: region.boundingBox,
      geometryProvenance: 'bounding-box',
    };
  }
  throw new LetteringRemovalError(
    'INVALID_MASK',
    `Text region ${region.id} needs a mask, polygon, or bounding box.`,
  );
}

/**
 * Grow a region mask to cover dark glyph ink near the region. Tight OCR or
 * ground-truth polygons often clip letters (e.g. "HELLO" → "H O"); capturing
 * ink inside a small halo keeps erasure character-accurate without erasing
 * the whole balloon.
 *
 * Work is limited to the seed bounding box + halo so full-resolution pages
 * stay cheap (critical for 1988×3056 scans on 8 GB machines).
 */
function refineMaskWithInk(
  image: RasterImage,
  seed: Uint8Array,
  width: number,
  height: number,
  inkLuminance: number,
): Uint8Array {
  const result = Uint8Array.from(seed);
  // Restrict analysis to the seed's bbox expanded by the halo.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!seed[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return result;
  const halo = 8;
  minX = Math.max(0, minX - halo);
  minY = Math.max(0, minY - halo);
  maxX = Math.min(width - 1, maxX + halo);
  maxY = Math.min(height - 1, maxY + halo);
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const boxPixels = boxW * boxH;

  // Local seed crop.
  const localSeed = new Uint8Array(boxPixels);
  const localHalo = new Uint8Array(boxPixels);
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const local = y * boxW + x;
      const global = (minY + y) * width + (minX + x);
      localSeed[local] = seed[global]!;
    }
  }
  // Dilate seed within the crop (3 px is enough to bridge glyph halves).
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const local = y * boxW + x;
      if (!localSeed[local]) continue;
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dx = -3; dx <= 3; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= boxW || ny >= boxH) continue;
          localHalo[ny * boxW + nx] = 1;
        }
      }
    }
  }

  // Dark ink in the crop.
  const ink = new Uint8Array(boxPixels);
  for (let y = 0; y < boxH; y += 1) {
    for (let x = 0; x < boxW; x += 1) {
      const local = y * boxW + x;
      if (!localHalo[local]) continue;
      const global = (minY + y) * width + (minX + x);
      const r = image.data[global * 4]!;
      const g = image.data[global * 4 + 1]!;
      const b = image.data[global * 4 + 2]!;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma < inkLuminance) ink[local] = 1;
    }
  }

  // Keep ink components that touch the seed halo (character bodies).
  const visited = new Uint8Array(boxPixels);
  const stack: number[] = [];
  for (let start = 0; start < boxPixels; start += 1) {
    if (!ink[start] || visited[start]) continue;
    const component: number[] = [];
    let touches = false;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      component.push(index);
      if (localHalo[index]) touches = true;
      const x = index % boxW;
      const y = (index / boxW) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= boxW || ny >= boxH) continue;
        const n = ny * boxW + nx;
        if (ink[n] && !visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (!touches) continue;
    for (const index of component) {
      const x = index % boxW;
      const y = (index / boxW) | 0;
      result[(minY + y) * width + (minX + x)] = 1;
    }
  }
  return result;
}

function rasterizePolygon(
  polygon: Polygon<ImageSpace>,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const points = polygon.points;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const yStart = Math.max(0, Math.ceil(minY - 1e-9));
  const yEnd = Math.min(height - 1, Math.ceil(maxY - 1e-9) - 1);
  for (let y = yStart; y <= yEnd; y += 1) {
    const crossings: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const first = points[i]!;
      const second = points[j]!;
      if (first.y > y === second.y > y) continue;
      const t = (y - first.y) / (second.y - first.y);
      crossings.push(first.x + t * (second.x - first.x));
    }
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const start = Math.max(0, Math.ceil(crossings[pair]! - 1e-9));
      const end = Math.min(width - 1, Math.ceil(crossings[pair + 1]! - 1e-9) - 1);
      for (let x = start; x <= end; x += 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function rasterizeBounds(
  bounds: Bounds<ImageSpace>,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.floor(bounds.x));
  const y0 = Math.max(0, Math.floor(bounds.y));
  const x1 = Math.min(width - 1, Math.ceil(bounds.x + bounds.width) - 1);
  const y1 = Math.min(height - 1, Math.ceil(bounds.y + bounds.height) - 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) mask[y * width + x] = 1;
  }
  return mask;
}

function buildOutlineProtection(
  bubbles: readonly LetteringBubbleInput[],
  width: number,
  height: number,
): Uint8Array {
  const pixelCount = width * height;
  const outline = new Uint8Array(pixelCount);
  for (const bubble of bubbles) {
    if (bubble.outlineMask) {
      validateDenseMask(bubble.outlineMask, pixelCount, `bubble ${bubble.id} outlineMask`);
      for (let i = 0; i < pixelCount; i += 1) {
        if (bubble.outlineMask[i]) outline[i] = 1;
      }
      continue;
    }
    // Derive a thin outline from the contour: rasterize filled, then keep the
    // boundary band. This works for irregular balloons, tails, and boxes.
    const filled = rasterizePolygon(bubble.contour, width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!filled[i]) continue;
        const nearEdge =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          !filled[i - 1] ||
          !filled[i + 1] ||
          !filled[i - width] ||
          !filled[i + width];
        if (nearEdge) outline[i] = 1;
      }
    }
  }
  return outline;
}

function expandMaskConservative(
  mask: Uint8Array,
  outline: Uint8Array,
  width: number,
  height: number,
  radius: number,
  outlineAdjacentRadius: number,
): { mask: Uint8Array; reducedNearOutline: boolean } {
  if (radius <= 0) return { mask, reducedNearOutline: false };
  const pixelCount = width * height;
  const result = Uint8Array.from(mask);
  let reducedNearOutline = false;
  const queue: number[] = [];
  const distance = new Int32Array(pixelCount).fill(-1);
  for (let i = 0; i < pixelCount; i += 1) {
    if (mask[i]) {
      queue.push(i);
      distance[i] = 0;
    }
  }
  let head = 0;
  while (head < queue.length) {
    const index = queue[head++]!;
    const d = distance[index]!;
    if (d >= radius) continue;
    const x = index % width;
    const y = (index / width) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if ((distance[n] ?? -1) >= 0) continue;
      // Reduced expansion near outlines keeps bubble borders intact.
      if (outline[n] && d + 1 > outlineAdjacentRadius) {
        reducedNearOutline = true;
        continue;
      }
      // Also stop expansion if a neighbor is outline-adjacent.
      if (nearOutline(outline, nx, ny, width, height) && d + 1 > outlineAdjacentRadius) {
        reducedNearOutline = true;
        continue;
      }
      distance[n] = d + 1;
      result[n] = 1;
      queue.push(n);
    }
  }
  return { mask: result, reducedNearOutline };
}

function nearOutline(
  outline: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (outline[ny * width + nx]) return true;
    }
  }
  return false;
}

function mergeNearbyMaskBlobs(
  mask: Uint8Array,
  width: number,
  height: number,
  gap: number,
): Uint8Array {
  if (gap <= 0) return mask;
  return dilateThenErode(mask, width, height, gap);
}

function dilateThenErode(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const dilated = Uint8Array.from(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          dilated[ny * width + nx] = 1;
        }
      }
    }
  }
  // Erode back to approximate original thickness while keeping bridges.
  const eroded = Uint8Array.from(dilated);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!dilated[i]) continue;
      let keep = false;
      for (let dy = -radius; dy <= radius && !keep; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (mask[ny * width + nx]) {
            keep = true;
            break;
          }
        }
      }
      if (!keep && !mask[i]) eroded[i] = 0;
    }
  }
  return eroded;
}

function crossesBoundary(
  mask: Uint8Array,
  outline: Uint8Array,
  width: number,
  height: number,
): boolean {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (nearOutline(outline, x, y, width, height)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Context classification and fill
// ---------------------------------------------------------------------------

function classifyContext(
  image: RasterImage,
  mask: Uint8Array,
  bubble: LetteringBubbleInput | null,
  settings: RequiredOptions,
): LetteringRegionContext {
  if (bubble?.interiorHint && bubble.interiorHint !== 'unknown') {
    return bubble.interiorHint;
  }
  const samples = sampleBackgroundRing(image, mask);
  if (samples.count < 4) return 'unknown';
  const meanLuma = samples.meanLuma;
  const lumaDev = samples.lumaDeviation;
  const colourSpread = samples.colourSpread;
  if (meanLuma >= settings.whiteLuminance && colourSpread <= 12) {
    return 'white-balloon';
  }
  if (lumaDev <= settings.plainTextureDeviation && colourSpread <= 28) {
    return 'coloured-balloon';
  }
  if (lumaDev <= settings.plainTextureDeviation * 2.5) {
    return 'textured-balloon';
  }
  return 'artwork';
}

function chooseMethod(
  context: LetteringRegionContext,
  settings: RequiredOptions,
  generative: GenerativeInpaintProvider | null,
): LetteringRemovalMethod {
  switch (context) {
    case 'white-balloon':
      return 'white-fill';
    case 'coloured-balloon':
      return 'background-fill';
    case 'textured-balloon':
      return 'local-reconstruct';
    case 'artwork':
      return generative && settings.preferLamaForArtwork
        ? 'lama'
        : 'local-reconstruct';
    default:
      return 'local-reconstruct';
  }
}

function methodConfidenceFor(
  method: LetteringRemovalMethod,
  context: LetteringRegionContext,
  source: LetteringSourceRegion,
): number {
  const base =
    method === 'white-fill'
      ? 0.92
      : method === 'background-fill'
        ? 0.82
        : method === 'local-reconstruct'
          ? 0.68
          : method === 'lama'
            ? 0.78
            : 0.2;
  const contextPenalty =
    context === 'unknown' ? 0.25 : context === 'artwork' ? 0.12 : 0;
  const detection =
    source.detectionConfidence !== undefined
      ? source.detectionConfidence
      : 0.8;
  return Math.min(1, Math.max(0, (base - contextPenalty) * (0.7 + 0.3 * detection)));
}

function applyDeterministicFill(
  pixels: Uint8ClampedArray,
  mask: Uint8Array,
  outline: Uint8Array,
  bounds: Bounds<ImageSpace>,
  width: number,
  height: number,
  method: LetteringRemovalMethod,
  settings: RequiredOptions,
): void {
  const pixelCount = width * height;
  if (method === 'white-fill') {
    for (let i = 0; i < pixelCount; i += 1) {
      if (!mask[i] || outline[i]) continue;
      pixels[i * 4] = 255;
      pixels[i * 4 + 1] = 255;
      pixels[i * 4 + 2] = 255;
      pixels[i * 4 + 3] = 255;
    }
    return;
  }

  const background = estimateRobustBackground(pixels, mask, bounds, width, height, settings);
  if (method === 'background-fill') {
    for (let i = 0; i < pixelCount; i += 1) {
      if (!mask[i] || outline[i]) continue;
      pixels[i * 4] = background[0];
      pixels[i * 4 + 1] = background[1];
      pixels[i * 4 + 2] = background[2];
      pixels[i * 4 + 3] = 255;
    }
    return;
  }

  // local-reconstruct: seed with background, then diffuse from neighbors.
  for (let i = 0; i < pixelCount; i += 1) {
    if (!mask[i] || outline[i]) continue;
    pixels[i * 4] = background[0];
    pixels[i * 4 + 1] = background[1];
    pixels[i * 4 + 2] = background[2];
    pixels[i * 4 + 3] = 255;
  }
  const holeIndices: number[] = [];
  for (let i = 0; i < pixelCount; i += 1) {
    if (mask[i] && !outline[i]) holeIndices.push(i);
  }
  for (let iteration = 0; iteration < 64; iteration += 1) {
    let maxDelta = 0;
    for (const index of holeIndices) {
      const x = index % width;
      const y = (index / width) | 0;
      const neighbors = [
        y * width + Math.max(0, x - 1),
        y * width + Math.min(width - 1, x + 1),
        Math.max(0, y - 1) * width + x,
        Math.min(height - 1, y + 1) * width + x,
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (const n of neighbors) sum += pixels[n * 4 + channel]!;
        const next = sum / 4;
        const delta = Math.abs(next - pixels[index * 4 + channel]!);
        if (delta > maxDelta) maxDelta = delta;
        pixels[index * 4 + channel] = next;
      }
    }
    if (maxDelta < 0.75) break;
  }
}

function estimateRobustBackground(
  pixels: Uint8ClampedArray,
  mask: Uint8Array,
  bounds: Bounds<ImageSpace>,
  width: number,
  height: number,
  settings: RequiredOptions,
): readonly [number, number, number] {
  const left = Math.max(0, Math.floor(bounds.x) - 2);
  const top = Math.max(0, Math.floor(bounds.y) - 2);
  const right = Math.min(width - 1, Math.ceil(bounds.x + bounds.width) + 1);
  const bottom = Math.min(height - 1, Math.ceil(bounds.y + bounds.height) + 1);
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const i = y * width + x;
      if (mask[i]) continue;
      r.push(pixels[i * 4]!);
      g.push(pixels[i * 4 + 1]!);
      b.push(pixels[i * 4 + 2]!);
    }
  }
  if (r.length < settings.minimumBackgroundSamples) {
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i]) continue;
      r.push(pixels[i * 4]!);
      g.push(pixels[i * 4 + 1]!);
      b.push(pixels[i * 4 + 2]!);
    }
  }
  if (r.length === 0) return [255, 255, 255];
  return [median(r), median(g), median(b)] as const;
}

function sampleBackgroundRing(
  image: RasterImage,
  mask: Uint8Array,
): {
  count: number;
  meanLuma: number;
  lumaDeviation: number;
  colourSpread: number;
} {
  const { width, height, data } = image;
  const lumas: number[] = [];
  const spreads: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      // Ring just outside the mask.
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (mask[n]) continue;
          const r = data[n * 4]!;
          const g = data[n * 4 + 1]!;
          const b = data[n * 4 + 2]!;
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          lumas.push(luma);
          spreads.push(Math.max(r, g, b) - Math.min(r, g, b));
        }
      }
    }
  }
  if (lumas.length === 0) {
    return { count: 0, meanLuma: 0, lumaDeviation: 0, colourSpread: 0 };
  }
  const meanLuma = lumas.reduce((s, v) => s + v, 0) / lumas.length;
  const lumaDeviation = Math.sqrt(
    lumas.reduce((s, v) => s + (v - meanLuma) ** 2, 0) / lumas.length,
  );
  const colourSpread = spreads.reduce((s, v) => s + v, 0) / spreads.length;
  return {
    count: lumas.length,
    meanLuma,
    lumaDeviation,
    colourSpread,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findBubble(
  bubbles: readonly LetteringBubbleInput[],
  id: string | null | undefined,
): LetteringBubbleInput | null {
  if (!id) return null;
  return bubbles.find((bubble) => bubble.id === id) ?? null;
}

/**
 * Decide whether a source region may be auto-erased under `scope`.
 * Bubble-associated lettering is the default safe path. Free-floating text
 * that has not been explicitly approved is held for manual review.
 */
function decideErasability(
  source: LetteringSourceRegion,
  scope: LetteringErasureScope,
):
  | { erase: true }
  | {
      erase: false;
      code: LetteringWarningCode;
      message: string;
    } {
  if (source.reviewStatus === 'rejected') {
    return {
      erase: false,
      code: 'out-of-scope',
      message: 'Region was rejected in review; it will not be erased.',
    };
  }
  const inBubble = Boolean(source.associatedBubbleId);
  const approved =
    source.approved === true ||
    source.reviewStatus === 'accepted' ||
    source.reviewStatus === 'edited';

  if (inBubble) {
    // Bubble-interior lettering is the default cleaning path.
    return { erase: true };
  }
  if (approved && scope === 'approved') {
    return { erase: true };
  }
  if (approved) {
    // Explicitly approved, but caller asked for bubble-interior only.
    return {
      erase: false,
      code: 'out-of-scope',
      message:
        'Region is outside a speech bubble; erasureScope is bubble-interior so it was not erased.',
    };
  }
  return {
    erase: false,
    code: 'needs-review',
    message:
      'Unreviewed text region outside a speech bubble is held for manual review and was not erased.',
  };
}

function unionMasks(
  masks: readonly Uint8Array[],
  pixelCount: number,
): Uint8Array {
  const out = new Uint8Array(pixelCount);
  for (const mask of masks) {
    for (let i = 0; i < pixelCount; i += 1) if (mask[i]) out[i] = 1;
  }
  return out;
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) if (value) count += 1;
  return count;
}

function maskBounds(
  mask: Uint8Array,
  width: number,
  height: number,
  space: ImageSpace,
): Bounds<ImageSpace> {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return Object.freeze({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      coordinateSpace: space,
    });
  }
  return Object.freeze({
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    coordinateSpace: space,
  });
}

function polygonBounds(
  polygon: Polygon<ImageSpace>,
  space: ImageSpace,
): Bounds<ImageSpace> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Object.freeze({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    coordinateSpace: space,
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function validateRaster(image: RasterImage): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'Raster dimensions must be positive integers.',
    );
  }
  if (image.width * image.height > MAX_RASTER_PIXELS) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'Raster exceeds the supported 40 megapixel limit.',
    );
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'Raster data must contain exactly width × height RGBA pixels.',
    );
  }
}

function validateSpace(
  space: ImageSpace,
  width: number,
  height: number,
): void {
  if (space.kind !== 'image') {
    throw new LetteringRemovalError(
      'DIMENSION_MISMATCH',
      'Lettering removal geometry must use an ImageSpace.',
    );
  }
  if (space.dimensions.width !== width || space.dimensions.height !== height) {
    throw new LetteringRemovalError(
      'DIMENSION_MISMATCH',
      'Raster dimensions must match the declared ImageSpace.',
    );
  }
}

function validateDenseMask(
  mask: Uint8Array,
  pixelCount: number,
  label: string,
): void {
  if (mask.length !== pixelCount) {
    throw new LetteringRemovalError(
      'INVALID_MASK',
      `${label} must be a dense page-sized mask.`,
    );
  }
}

type RequiredOptions = Required<
  Pick<
    LetteringRemovalOptions,
    | 'expansionPx'
    | 'maximumOutlineAdjacentExpansionPx'
    | 'whiteLuminance'
    | 'plainTextureDeviation'
    | 'minimumBackgroundSamples'
    | 'reviewConfidenceThreshold'
    | 'preferLamaForArtwork'
    | 'mergeGapPx'
    | 'maximumGenerativeMaskPixels'
    | 'erasureScope'
  >
>;

function resolveOptions(
  options: LetteringRemovalOptions = {},
): RequiredOptions {
  const expansionPx = options.expansionPx ?? DEFAULT_EXPANSION_PX;
  const maximumOutlineAdjacentExpansionPx =
    options.maximumOutlineAdjacentExpansionPx ??
    DEFAULT_OUTLINE_ADJACENT_EXPANSION_PX;
  const whiteLuminance = options.whiteLuminance ?? DEFAULT_WHITE_LUMINANCE;
  const plainTextureDeviation =
    options.plainTextureDeviation ?? DEFAULT_PLAIN_TEXTURE_DEVIATION;
  const minimumBackgroundSamples =
    options.minimumBackgroundSamples ?? DEFAULT_MINIMUM_BACKGROUND_SAMPLES;
  const reviewConfidenceThreshold =
    options.reviewConfidenceThreshold ?? DEFAULT_REVIEW_CONFIDENCE_THRESHOLD;
  const preferLamaForArtwork = options.preferLamaForArtwork ?? true;
  const mergeGapPx = options.mergeGapPx ?? DEFAULT_MERGE_GAP_PX;
  const maximumGenerativeMaskPixels =
    options.maximumGenerativeMaskPixels ?? DEFAULT_MAXIMUM_GENERATIVE_MASK_PIXELS;
  const erasureScope = options.erasureScope ?? 'bubble-interior';

  if (expansionPx < 0 || !Number.isFinite(expansionPx)) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'expansionPx must be a non-negative finite number.',
    );
  }
  if (
    maximumOutlineAdjacentExpansionPx < 0 ||
    maximumOutlineAdjacentExpansionPx > expansionPx
  ) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'maximumOutlineAdjacentExpansionPx must be in [0, expansionPx].',
    );
  }
  if (whiteLuminance < 0 || whiteLuminance > 255) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'whiteLuminance must be in [0, 255].',
    );
  }
  if (plainTextureDeviation < 0) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'plainTextureDeviation must be non-negative.',
    );
  }
  if (minimumBackgroundSamples < 1) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'minimumBackgroundSamples must be at least 1.',
    );
  }
  if (
    reviewConfidenceThreshold < 0 ||
    reviewConfidenceThreshold > 1
  ) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'reviewConfidenceThreshold must be in [0, 1].',
    );
  }
  if (mergeGapPx < 0) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'mergeGapPx must be non-negative.',
    );
  }
  if (maximumGenerativeMaskPixels < 1) {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'maximumGenerativeMaskPixels must be at least 1.',
    );
  }
  if (erasureScope !== 'bubble-interior' && erasureScope !== 'approved') {
    throw new LetteringRemovalError(
      'INVALID_INPUT',
      'erasureScope must be bubble-interior or approved.',
    );
  }

  return {
    expansionPx,
    maximumOutlineAdjacentExpansionPx,
    whiteLuminance,
    plainTextureDeviation,
    minimumBackgroundSamples,
    reviewConfidenceThreshold,
    preferLamaForArtwork,
    mergeGapPx,
    maximumGenerativeMaskPixels,
    erasureScope,
  };
}

// Re-export inpaint raster type for callers that only need the remover.
export type { InpaintMode, RasterImage };
export { InpaintError };
