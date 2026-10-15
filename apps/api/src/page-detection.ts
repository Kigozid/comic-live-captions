import { createHash, randomUUID } from 'node:crypto';
import {
  BubbleDetectionEngine,
  HybridBubbleDetector,
  YoloBubbleProposalProvider,
  associateTextRegionsToBubbles,
  matchOcrBoxToTextRegion,
  type Bubble,
  type BubbleForAssociation,
  type HybridBubble,
  type HybridBubbleDetectionResult,
  type TextBubbleAssociationResult,
  type TextRegionForAssociation,
} from '@comic-captioner/bubble-engine';
import {
  TextRegionDetector,
  TextRegionDetectionError,
  type DetectedTextRegion,
  type TextRegionDetectionResult,
} from '@comic-captioner/image-engine';
import {
  createImageSpace,
  type Bounds,
  type ImageSpace,
  type OCRDocument,
  type OCRLine,
} from '@comic-captioner/shared';
import { OnnxModelError, loadYoloOnnxSession } from './onnx-models.js';

/**
 * Comic-aware page detection orchestration.
 *
 * Runs speech-bubble detection, independent text-region detection, optional
 * PaddleOCR recognition, and bubble↔text association on the server. Heavy
 * models are cached and executed sequentially so an 8 GB RAM machine stays
 * stable. Each confidence channel is reported separately and never reused as
 * another channel's score.
 */

export type PageDetectionGeometryProvenance =
  | 'model'
  | 'derived'
  | 'hybrid';

export interface PageDetectionBubble {
  readonly id: string;
  readonly kind: string;
  readonly shape: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly polygon: unknown;
  readonly contour: unknown;
  readonly tail: readonly unknown[] | null;
  /** Bubble-detection confidence. Not OCR or association confidence. */
  readonly confidence: number;
  /** Label confidence when the detector classifies bubble type. */
  readonly classificationConfidence: number;
  readonly geometryProvenance: PageDetectionGeometryProvenance;
  readonly sources: readonly string[];
  readonly support: readonly unknown[];
  readonly quality?: unknown;
  readonly algorithmVersion: string;
  readonly coordinateSpaceId: string;
}

export interface PageDetectionTextRegion {
  readonly id: string;
  readonly boundingBox: Bounds<ImageSpace>;
  readonly polygon: unknown;
  readonly mask: unknown;
  /** Text-region detection confidence only. */
  readonly confidence: number;
  readonly geometryProvenance: PageDetectionGeometryProvenance;
  readonly detectionSource: string;
  readonly kindHint: string;
  readonly order: number;
  /** Bubble association when a reliable spatial match exists. */
  readonly associatedBubbleId: string | null;
  /** Association confidence only. Never a detection or OCR score. */
  readonly associationConfidence: number;
  readonly associationClassification: 'dialogue' | 'non-dialogue' | 'ambiguous';
  readonly associationNeedsReview: boolean;
  readonly needsReview: boolean;
  readonly coordinateSpaceId: string;
  readonly algorithmVersion: string;
}

export interface PageDetectionOcrLine {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: Bounds<ImageSpace>;
  /** OCR recognition confidence only. */
  readonly confidence: number;
  /** Best-matching text region from geometric overlap, when available. */
  readonly textRegionId: string | null;
  /** Geometric match confidence for the OCR↔region link. */
  readonly textRegionMatchConfidence: number;
  /** Bubble from association when available. */
  readonly associatedBubbleId: string | null;
  readonly associationConfidence: number;
  readonly needsReview: boolean;
}

export interface PageDetectionConfidences {
  /** Mean bubble-detection confidence across emitted bubbles. */
  readonly bubbleDetection: number;
  /** Mean text-region detection confidence across emitted regions. */
  readonly textRegionDetection: number;
  /** Mean OCR recognition confidence; null when OCR was not run. */
  readonly ocrRecognition: number | null;
  /** Mean bubble-association confidence; null when no associations. */
  readonly bubbleAssociation: number | null;
}

export interface PageDetectionResponse {
  readonly requestId: string;
  readonly analysisId: string;
  readonly status: 'complete' | 'stale' | 'cancelled';
  readonly coordinateSpace: ImageSpace;
  readonly imageDimensions: { readonly width: number; readonly height: number };
  readonly bubbles: readonly PageDetectionBubble[];
  readonly textRegions: readonly PageDetectionTextRegion[];
  readonly ocr: {
    readonly available: boolean;
    readonly document: OCRDocument | null;
    readonly lines: readonly PageDetectionOcrLine[];
    readonly provider: string | null;
  };
  readonly associations: TextBubbleAssociationResult | null;
  readonly confidences: PageDetectionConfidences;
  readonly detection: {
    readonly bubbleMode: 'hybrid' | 'deterministic';
    readonly bubbleProvider: string | null;
    readonly textRegionProvider: string;
    readonly modelMissing: readonly string[];
  };
  readonly warnings: readonly string[];
}

export interface PageDetectionRequest {
  readonly pageImage: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly spaceId?: string;
  /** Client-supplied id used for stale-result protection. */
  readonly requestId?: string;
  readonly includeOcr?: boolean;
  readonly confidenceThreshold?: number;
  readonly maximumProposals?: number;
  readonly requireYolo?: boolean;
  /** Optional precomputed OCR document (e.g. PaddleOCR from `/api/ocr`). */
  readonly ocrDocument?: OCRDocument | null;
}

export interface PageDetectionDependencies {
  readonly bubbleEngine?: BubbleDetectionEngine;
  readonly textRegionDetector?: TextRegionDetector;
  /** Returns a PaddleOCR document when available. Injected to keep OCR pluggable. */
  readonly recognizeOcr?: (
    image: Uint8Array,
    space: ImageSpace,
  ) => Promise<OCRDocument>;
  readonly loadYoloSession?: () => Promise<unknown>;
}

export class PageDetectionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'IMAGE_TOO_LARGE'
      | 'MODEL_MISSING'
      | 'DETECT_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'PageDetectionError';
  }
}

const MAX_PAGE_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

/** In-flight request registry for stale-result protection. */
export class PageDetectionCoordinator {
  readonly #deps: PageDetectionDependencies;
  readonly #bubbleEngine: BubbleDetectionEngine;
  readonly #textRegionDetector: TextRegionDetector;
  #yoloSessionPromise: Promise<unknown> | null = null;
  #latestRequestId: string | null = null;
  #sequence = 0;

  constructor(deps: PageDetectionDependencies = {}) {
    this.#deps = deps;
    this.#bubbleEngine = deps.bubbleEngine ?? new BubbleDetectionEngine();
    this.#textRegionDetector =
      deps.textRegionDetector ?? new TextRegionDetector();
  }

  /** Mark `requestId` as the newest analysis; older ones become stale. */
  begin(requestId?: string): string {
    const id = requestId?.trim() || `detect-${randomUUID()}`;
    this.#latestRequestId = id;
    return id;
  }

  isStale(requestId: string): boolean {
    return this.#latestRequestId !== requestId;
  }

  async detect(
    request: PageDetectionRequest,
  ): Promise<PageDetectionResponse> {
    const requestId = this.begin(request.requestId);
    this.#sequence += 1;
    const analysisId = `analysis-${this.#sequence}-${requestId}`;
    const warnings: string[] = [];
    const modelMissing: string[] = [];

    validateRequest(request);
    const space = await resolveSpace(request);
    const image = request.pageImage;

    // 1. Speech bubbles (ML proposals + deterministic refinement).
    const bubbleResult = await this.#detectBubbles(image, space, request, {
      warnings,
      modelMissing,
    });

    // 2. Independent text regions (sequential after bubbles for RAM safety).
    let textRegionResult: TextRegionDetectionResult;
    try {
      textRegionResult = await this.#textRegionDetector.detect(image, space);
    } catch (error) {
      if (error instanceof TextRegionDetectionError) {
        throw new PageDetectionError('DETECT_FAILED', error.message);
      }
      throw error;
    }

    if (this.isStale(requestId)) {
      return this.#staleResponse(
        requestId,
        analysisId,
        space,
        bubbleResult,
        textRegionResult,
      );
    }

    // 3. Optional OCR recognition (PaddleOCR or injected provider).
    let ocrDocument: OCRDocument | null = request.ocrDocument ?? null;
    let ocrProvider: string | null = null;
    if (!ocrDocument && request.includeOcr && this.#deps.recognizeOcr) {
      try {
        ocrDocument = await this.#deps.recognizeOcr(image, space);
        ocrProvider = ocrDocument.provenance.source;
      } catch (error) {
        warnings.push(
          `OCR recognition failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        ocrDocument = null;
      }
    }

    // 4. Bubble ↔ text-region association.
    const associations = associateTextRegionsToBubbles(
      textRegionResult.regions.map(toAssociationRegion),
      bubbleResult.bubbles.map(toAssociationBubble),
    );

    // 5. OCR line ↔ text-region geometric matching.
    const ocrLines = mapOcrLines(ocrDocument, textRegionResult.regions, associations);

    const textRegions = textRegionResult.regions.map((region) => {
      const association = associations.associations.find(
        (item) => item.textRegionId === region.id,
      );
      return mapTextRegion(region, association, space);
    });

    const bubbles = bubbleResult.hybrid
      ? bubbleResult.hybrid.map(mapHybrid)
      : bubbleResult.bubbles.map(mapBubble);
    const confidences = computeConfidences(
      bubbles,
      textRegions,
      ocrLines,
      associations,
    );

    return Object.freeze({
      requestId,
      analysisId,
      status: 'complete' as const,
      coordinateSpace: space,
      imageDimensions: {
        width: space.dimensions.width,
        height: space.dimensions.height,
      },
      bubbles: Object.freeze(bubbles),
      textRegions: Object.freeze(textRegions),
      ocr: Object.freeze({
        available: Boolean(ocrDocument),
        document: ocrDocument,
        lines: Object.freeze(ocrLines),
        provider: ocrProvider,
      }),
      associations: Object.freeze(associations),
      confidences,
      detection: Object.freeze({
        bubbleMode: bubbleResult.mode,
        bubbleProvider: bubbleResult.providerName,
        textRegionProvider: textRegionResult.provider,
        modelMissing: Object.freeze([...modelMissing]),
      }),
      warnings: Object.freeze(warnings),
    });
  }

  async #detectBubbles(
    image: Uint8Array,
    space: ImageSpace,
    request: PageDetectionRequest,
    context: { warnings: string[]; modelMissing: string[] },
  ): Promise<{
    bubbles: readonly Bubble[];
    hybrid: readonly HybridBubble[] | null;
    mode: 'hybrid' | 'deterministic';
    providerName: string | null;
  }> {
    let detector: HybridBubbleDetector | BubbleDetectionEngine =
      this.#bubbleEngine;
    let providerName: string | null = null;
    let mode: 'hybrid' | 'deterministic' = 'deterministic';
    try {
      this.#yoloSessionPromise ??=
        this.#deps.loadYoloSession?.() ?? loadYoloOnnxSession();
      const yoloSession = (await this.#yoloSessionPromise) as ConstructorParameters<
        typeof YoloBubbleProposalProvider
      >[0]['session'] & { classLabels?: readonly string[] };
      providerName = yoloSession.name;
      mode = 'hybrid';
      detector = new HybridBubbleDetector({
        deterministic: this.#bubbleEngine,
        provider: new YoloBubbleProposalProvider({
          session: yoloSession,
          ...(yoloSession.classLabels
            ? { classLabels: yoloSession.classLabels }
            : {}),
          confidenceThreshold: request.confidenceThreshold ?? 0.25,
          bubbleClassesOnly: true,
          maximumProposals: request.maximumProposals ?? 32,
        }),
      });
    } catch (error) {
      this.#yoloSessionPromise = null;
      const isModelMissing =
        error instanceof OnnxModelError
          ? error.code === 'MODEL_MISSING'
          : typeof error === 'object' &&
            error !== null &&
            (error as { code?: string }).code === 'MODEL_MISSING';
      const message =
        error instanceof Error ? error.message : 'YOLO bubble detection failed.';
      if (request.requireYolo) {
        if (isModelMissing) {
          throw new PageDetectionError('MODEL_MISSING', message);
        }
        throw new PageDetectionError('DETECT_FAILED', message);
      }
      if (isModelMissing || error instanceof OnnxModelError) {
        context.modelMissing.push('yolo-bubble');
        context.warnings.push(message);
      }
      detector = this.#bubbleEngine;
      mode = 'deterministic';
      providerName = null;
    }

    const detection = await detector.detect(image, space);
    const isHybrid =
      detection &&
      typeof detection === 'object' &&
      'proposalCount' in detection;
    if (isHybrid) {
      const hybrid = detection as HybridBubbleDetectionResult;
      return {
        bubbles: hybrid.bubbles.map((entry) => entry.bubble),
        hybrid: hybrid.bubbles,
        mode,
        providerName,
      };
    }
    return {
      bubbles: (detection as { bubbles: readonly Bubble[] }).bubbles,
      hybrid: null,
      mode,
      providerName,
    };
  }

  #staleResponse(
    requestId: string,
    analysisId: string,
    space: ImageSpace,
    bubbleResult: {
      bubbles: readonly Bubble[];
      hybrid: readonly HybridBubble[] | null;
      mode: 'hybrid' | 'deterministic';
      providerName: string | null;
    },
    textRegionResult: TextRegionDetectionResult,
  ): PageDetectionResponse {
    return Object.freeze({
      requestId,
      analysisId,
      status: 'stale' as const,
      coordinateSpace: space,
      imageDimensions: {
        width: space.dimensions.width,
        height: space.dimensions.height,
      },
      bubbles: Object.freeze([]),
      textRegions: Object.freeze([]),
      ocr: Object.freeze({
        available: false,
        document: null,
        lines: Object.freeze([]),
        provider: null,
      }),
      associations: null,
      confidences: Object.freeze({
        bubbleDetection: 0,
        textRegionDetection: 0,
        ocrRecognition: null,
        bubbleAssociation: null,
      }),
      detection: Object.freeze({
        bubbleMode: bubbleResult.mode,
        bubbleProvider: bubbleResult.providerName,
        textRegionProvider: textRegionResult.provider,
        modelMissing: Object.freeze([]),
      }),
      warnings: Object.freeze([
        'A newer page analysis superseded this request; discard these results.',
      ]),
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapBubble(bubble: Bubble): PageDetectionBubble {
  return {
    id: bubble.id,
    kind: bubble.kind,
    shape: bubble.shape,
    boundingBox: bubble.boundingBox,
    polygon: bubble.polygon,
    contour: bubble.contour,
    tail: bubble.tail?.points ?? null,
    confidence: bubble.confidence,
    classificationConfidence: bubble.classificationConfidence,
    geometryProvenance: 'derived',
    sources: bubble.source === 'manual' ? ['manual'] : ['detected'],
    support: [],
    algorithmVersion: bubble.algorithmVersion,
    coordinateSpaceId: bubble.coordinateSpace.id,
  };
}

function mapHybrid(hybrid: HybridBubble): PageDetectionBubble {
  const base = mapBubble(hybrid.bubble);
  const hasModel = hybrid.support.some((item) => item.provenance === 'ml');
  return {
    ...base,
    geometryProvenance: hasModel ? 'hybrid' : 'derived',
    sources: [...hybrid.sources],
    support: hybrid.support.map((item) => ({ ...item })),
    quality: hybrid.quality,
  };
}

function mapTextRegion(
  region: DetectedTextRegion,
  association:
    | TextBubbleAssociationResult['associations'][number]
    | undefined,
  space: ImageSpace,
): PageDetectionTextRegion {
  return {
    id: region.id,
    boundingBox: region.boundingBox,
    polygon: region.polygon,
    mask: region.mask,
    confidence: region.confidence,
    geometryProvenance: region.geometryProvenance,
    detectionSource: region.detectionSource,
    kindHint: region.kindHint,
    order: region.order,
    associatedBubbleId: association?.bubbleId ?? null,
    associationConfidence: association?.confidence ?? 0,
    associationClassification: association?.classification ?? 'non-dialogue',
    associationNeedsReview: association?.needsReview ?? true,
    needsReview: region.needsReview || (association?.needsReview ?? true),
    coordinateSpaceId: space.id,
    algorithmVersion: region.algorithmVersion,
  };
}

function mapOcrLines(
  document: OCRDocument | null,
  regions: readonly DetectedTextRegion[],
  associations: TextBubbleAssociationResult,
): PageDetectionOcrLine[] {
  if (!document) return [];
  const lines: OCRLine[] = document.blocks.flatMap((block) => block.lines);
  return lines.map((line) => {
    let bestRegion: DetectedTextRegion | null = null;
    let bestMatch = 0;
    for (const region of regions) {
      const score = matchOcrBoxToTextRegion(line.boundingBox, {
        id: region.id,
        boundingBox: region.boundingBox,
      });
      if (score > bestMatch) {
        bestMatch = score;
        bestRegion = region;
      }
    }
    const association = bestRegion
      ? associations.associations.find(
          (item) => item.textRegionId === bestRegion!.id,
        )
      : undefined;
    return {
      id: line.id,
      text: line.text,
      boundingBox: line.boundingBox,
      confidence: line.confidence,
      textRegionId: bestMatch >= 0.25 ? (bestRegion?.id ?? null) : null,
      textRegionMatchConfidence: bestMatch >= 0.25 ? bestMatch : 0,
      associatedBubbleId: association?.bubbleId ?? null,
      associationConfidence: association?.confidence ?? 0,
      needsReview:
        line.confidence < 0.75 ||
        (association?.needsReview ?? true) ||
        bestMatch < 0.25,
    };
  });
}

function toAssociationRegion(
  region: DetectedTextRegion,
): TextRegionForAssociation {
  return {
    id: region.id,
    boundingBox: region.boundingBox,
    polygon: region.polygon,
    detectionConfidence: region.confidence,
  };
}

function toAssociationBubble(bubble: Bubble): BubbleForAssociation {
  return {
    id: bubble.id,
    boundingBox: bubble.boundingBox,
    polygon: bubble.polygon,
    detectionConfidence: bubble.confidence,
  };
}

function computeConfidences(
  bubbles: readonly PageDetectionBubble[],
  textRegions: readonly PageDetectionTextRegion[],
  ocrLines: readonly PageDetectionOcrLine[],
  associations: TextBubbleAssociationResult,
): PageDetectionConfidences {
  const mean = (values: readonly number[]): number =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    bubbleDetection: mean(bubbles.map((bubble) => bubble.confidence)),
    textRegionDetection: mean(
      textRegions.map((region) => region.confidence),
    ),
    ocrRecognition:
      ocrLines.length === 0
        ? null
        : mean(ocrLines.map((line) => line.confidence)),
    bubbleAssociation:
      associations.associations.length === 0
        ? null
        : associations.meanAssociationConfidence,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRequest(request: PageDetectionRequest): void {
  if (!(request.pageImage instanceof Uint8Array) || request.pageImage.byteLength === 0) {
    throw new PageDetectionError(
      'INVALID_REQUEST',
      'pageImage must be non-empty PNG/JPEG bytes.',
    );
  }
  if (request.pageImage.byteLength > MAX_PAGE_BYTES) {
    throw new PageDetectionError(
      'IMAGE_TOO_LARGE',
      `pageImage exceeds ${MAX_PAGE_BYTES / (1024 * 1024)} MB.`,
    );
  }
  if (
    request.width !== undefined &&
    (!Number.isFinite(request.width) || request.width <= 0)
  ) {
    throw new PageDetectionError(
      'INVALID_REQUEST',
      'width must be a positive finite number when provided.',
    );
  }
  if (
    request.height !== undefined &&
    (!Number.isFinite(request.height) || request.height <= 0)
  ) {
    throw new PageDetectionError(
      'INVALID_REQUEST',
      'height must be a positive finite number when provided.',
    );
  }
  if (
    request.confidenceThreshold !== undefined &&
    (!Number.isFinite(request.confidenceThreshold) ||
      request.confidenceThreshold < 0 ||
      request.confidenceThreshold > 1)
  ) {
    throw new PageDetectionError(
      'INVALID_REQUEST',
      'confidenceThreshold must be in [0, 1].',
    );
  }
  if (
    request.maximumProposals !== undefined &&
    (!Number.isFinite(request.maximumProposals) ||
      request.maximumProposals < 1 ||
      request.maximumProposals > 128)
  ) {
    throw new PageDetectionError(
      'INVALID_REQUEST',
      'maximumProposals must be in [1, 128].',
    );
  }
}

async function resolveSpace(
  request: PageDetectionRequest,
): Promise<ImageSpace> {
  let width = request.width ?? 0;
  let height = request.height ?? 0;
  if (!width || !height) {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(request.pageImage).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  }
  if (!width || !height) {
    throw new PageDetectionError(
      'INVALID_REQUEST',
      'Could not determine page dimensions; pass width and height.',
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new PageDetectionError(
      'IMAGE_TOO_LARGE',
      'Page exceeds 40 megapixels.',
    );
  }
  return createImageSpace(
    request.spaceId?.trim() || `image:page-${sha16(request.pageImage)}`,
    width,
    height,
  );
}

function sha16(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export { mapHybrid };
