import type {
  AnalysisProposal,
  AudioTimebase,
  AudioTime,
  ImageSpace,
  ImageDimensions,
  Polygon,
  Point,
  ProjectId,
  PageId,
  AssetId,
  BubbleId,
  Bounds,
  TimeInterval,
} from '@comic-captioner/shared';

export type {
  AnalysisProposal,
  AudioTime,
  AudioTimebase,
  Confidence,
  CoordinateSpaceRef,
  ImageSpace,
  NormalizedSpace,
  ImageDimensions,
  Point,
  Polygon,
  ProjectId,
  PageId,
  AssetId,
  BubbleId,
  TimeInterval,
} from '@comic-captioner/shared';

export interface ImageAssetRef {
  readonly id: AssetId;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly dimensions: ImageDimensions;
  readonly coordinateSpace: ImageSpace;
}

export interface AudioAssetRef {
  readonly id: AssetId;
  readonly filename: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly durationSeconds: number;
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly timebase: AudioTimebase;
}

export interface Page {
  readonly id: PageId;
  readonly originalImage?: ImageAssetRef;
  readonly cleanedImage?: ImageAssetRef;
  readonly canonicalSpace?: ImageSpace;
  readonly geometryRevision: number;
}

export interface TextObservation {
  readonly id: string;
  readonly text: string;
  /** OCR text as recognized before user correction or normalization. */
  readonly rawText?: string;
  readonly polygon: Polygon<ImageSpace>;
  readonly confidence: number;
  readonly sourceProposalId?: string;
  /** True after a user edits OCR text; subsequent OCR passes preserve it. */
  readonly manuallyEdited?: boolean;
  readonly classification?: 'dialogue' | 'non-dialogue' | 'ambiguous';
  readonly reviewStatus?: 'pending-review' | 'accepted' | 'rejected';
  readonly associatedBubbleId?: BubbleId | null;
  readonly associationConfidence?: number;
  readonly sourceLineIds?: readonly string[];
}

export interface BubbleGeometry {
  readonly id: BubbleId;
  readonly contour: Polygon<ImageSpace>;
  readonly tail?: Polygon<ImageSpace>;
  readonly classification?: 'speech' | 'thought' | 'shout' | 'unknown';
}

export interface TextRegionGeometry {
  readonly bubbleId: BubbleId;
  readonly interior: Polygon<ImageSpace>;
  readonly safeRegion: Polygon<ImageSpace>;
}

export interface TranscriptSegment {
  readonly id: string;
  readonly text: string;
  readonly interval: TimeInterval;
  readonly speakerId: string | null;
  readonly words: readonly WordTimestamp[];
  /** Null means the provider does not expose calibrated confidence values. */
  readonly confidence: number | null;
}

export interface WordTimestamp {
  readonly id: string;
  readonly text: string;
  readonly start: AudioTime;
  readonly end: AudioTime;
  readonly speakerId: string | null;
  readonly confidence: number | null;
}

export interface Transcript {
  readonly id: string;
  readonly audioAssetId: string;
  readonly text: string;
  readonly durationSeconds: number;
  readonly timebase: AudioTimebase;
  readonly speakers: readonly Readonly<{ id: string; label?: string }>[];
  readonly segments: readonly TranscriptSegment[];
  readonly confidence: number | null;
  readonly reviewStatus: 'pending-review' | 'accepted' | 'edited' | 'rejected';
  readonly revision: number;
  readonly provenance: Readonly<{
    provider: string;
    version: string;
    inputHashes: readonly string[];
  }>;
}

export interface DialogueLink {
  readonly transcriptSegmentId: string;
  readonly textObservationId: string;
  readonly bubbleId: BubbleId;
  readonly confidence: number;
  readonly status: 'pending-review' | 'accepted' | 'edited' | 'rejected';
}

export type DialogueTextAlignment = 'left' | 'center' | 'right' | 'unknown';

/** Reviewable relationship between page geometry and the source comic text. */
export interface BubbleDialogueReference {
  readonly id: string;
  readonly bubbleId: BubbleId;
  readonly textRegionIds: readonly string[];
  readonly originalText: string;
  readonly originalTextBounds: Bounds<ImageSpace>;
  readonly lineCount: number;
  readonly alignment: DialogueTextAlignment;
  readonly confidence: number;
  readonly status: 'pending-review' | 'accepted' | 'edited' | 'rejected';
  readonly method: 'spatial' | 'semantic' | 'manual';
  readonly revision: number;
}

export type DialogueMappingSignal =
  | 'text-similarity'
  | 'semantic-similarity'
  | 'reading-order'
  | 'temporal-order'
  | 'speaker-consistency'
  | 'spatial-context'
  | 'manual-correction';

export interface DialogueMappingReason {
  readonly signal: DialogueMappingSignal;
  /** Normalized signal score in [0, 1]. */
  readonly score: number;
  readonly evidence: string;
}

export interface DialogueMappingCandidate {
  readonly bubbleId: BubbleId;
  readonly confidence: number;
  readonly reasons: readonly DialogueMappingReason[];
}

/** A proposal only; project state must not treat it as accepted without review. */
export interface DialogueMapping {
  readonly id: string;
  readonly transcriptSegmentId: string;
  /** Null when no candidate meets the minimum evidence threshold. */
  readonly bubbleId: BubbleId | null;
  readonly confidence: number;
  readonly reasons: readonly DialogueMappingReason[];
  readonly alternatives: readonly DialogueMappingCandidate[];
  readonly needsReview: boolean;
  readonly reviewFlag:
    'low-confidence' | 'ambiguous' | 'review-required' | 'none';
  readonly status: 'pending-review' | 'edited' | 'accepted' | 'rejected';
  readonly revision: number;
}

export interface DialogueMappingCorrectionContext {
  readonly transcriptSegmentIds: readonly string[];
  readonly bubbleIds: readonly BubbleId[];
}

export class DialogueMappingCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialogueMappingCorrectionError';
  }
}

/** Apply a user remapping immutably; generated proposals never mutate projects. */
export function correctDialogueMapping(
  current: DialogueMapping,
  bubbleId: BubbleId,
  context: DialogueMappingCorrectionContext,
): DialogueMapping {
  if (!context.transcriptSegmentIds.includes(current.transcriptSegmentId)) {
    throw new DialogueMappingCorrectionError(
      'The transcript segment no longer exists.',
    );
  }
  if (!context.bubbleIds.includes(bubbleId)) {
    throw new DialogueMappingCorrectionError(
      'The selected bubble does not exist.',
    );
  }
  return Object.freeze({
    ...current,
    bubbleId,
    confidence: 1,
    reasons: Object.freeze([
      Object.freeze({
        signal: 'manual-correction' as const,
        score: 1,
        evidence: 'Selected by the user.',
      }),
    ]),
    alternatives: Object.freeze([]),
    needsReview: false,
    reviewFlag: 'none',
    status: 'edited',
    revision: current.revision + 1,
  });
}

export interface BubbleDialogueCorrection {
  readonly bubbleId?: BubbleId;
  readonly textRegionIds?: readonly string[];
  readonly originalText?: string;
  readonly originalTextBounds?: Bounds<ImageSpace>;
  readonly lineCount?: number;
  readonly alignment?: DialogueTextAlignment;
}

export interface BubbleDialogueCorrectionContext {
  readonly bubbleIds: readonly BubbleId[];
  readonly textRegionIds: readonly string[];
  readonly coordinateSpace: ImageSpace;
}

export class BubbleDialogueCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BubbleDialogueCorrectionError';
  }
}

/** Apply user changes immutably after validating all referenced entities. */
export function correctBubbleDialogueReference(
  current: BubbleDialogueReference,
  correction: BubbleDialogueCorrection,
  context: BubbleDialogueCorrectionContext,
): BubbleDialogueReference {
  const bubbleId = correction.bubbleId ?? current.bubbleId;
  const textRegionIds = correction.textRegionIds ?? current.textRegionIds;
  const originalTextBounds =
    correction.originalTextBounds ?? current.originalTextBounds;
  const lineCount = correction.lineCount ?? current.lineCount;
  const alignment = correction.alignment ?? current.alignment;
  if (!context.bubbleIds.includes(bubbleId)) {
    throw new BubbleDialogueCorrectionError(
      'The selected bubble does not exist.',
    );
  }
  if (
    textRegionIds.length === 0 ||
    textRegionIds.some((id) => !context.textRegionIds.includes(id))
  ) {
    throw new BubbleDialogueCorrectionError(
      'Select one or more existing original text regions.',
    );
  }
  if (
    originalTextBounds.coordinateSpace.id !== context.coordinateSpace.id ||
    originalTextBounds.coordinateSpace.kind !== 'image' ||
    originalTextBounds.coordinateSpace.dimensions.width !==
      context.coordinateSpace.dimensions.width ||
    originalTextBounds.coordinateSpace.dimensions.height !==
      context.coordinateSpace.dimensions.height ||
    ![
      originalTextBounds.x,
      originalTextBounds.y,
      originalTextBounds.width,
      originalTextBounds.height,
    ].every(Number.isFinite) ||
    originalTextBounds.width <= 0 ||
    originalTextBounds.height <= 0 ||
    originalTextBounds.x < -0.5 ||
    originalTextBounds.y < -0.5 ||
    originalTextBounds.x + originalTextBounds.width >
      context.coordinateSpace.dimensions.width - 0.5 ||
    originalTextBounds.y + originalTextBounds.height >
      context.coordinateSpace.dimensions.height - 0.5
  ) {
    throw new BubbleDialogueCorrectionError(
      'Corrected text bounds must be valid geometry in the page ImageSpace.',
    );
  }
  if (!Number.isInteger(lineCount) || lineCount < 0) {
    throw new BubbleDialogueCorrectionError(
      'Line count must be a non-negative integer.',
    );
  }
  if (!['left', 'center', 'right', 'unknown'].includes(alignment)) {
    throw new BubbleDialogueCorrectionError('Text alignment is not supported.');
  }
  if (
    correction.originalText !== undefined &&
    typeof correction.originalText !== 'string'
  ) {
    throw new BubbleDialogueCorrectionError('Original text must be a string.');
  }
  return Object.freeze({
    ...current,
    bubbleId,
    textRegionIds: Object.freeze([...textRegionIds]),
    originalText: correction.originalText ?? current.originalText,
    originalTextBounds: Object.freeze({ ...originalTextBounds }),
    lineCount,
    alignment,
    confidence: 1,
    status: 'edited',
    method: 'manual',
    revision: current.revision + 1,
  });
}

export interface CaptionLayout {
  readonly id: string;
  readonly bubbleId: BubbleId;
  readonly text: string;
  readonly lines: readonly string[];
  readonly placement: Polygon<ImageSpace>;
  /** Top-left image-space origin of the laid-out text block. */
  readonly position: Point<ImageSpace>;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly alignment: 'left' | 'center' | 'right' | 'unknown';
  readonly lineSpacingPx: number;
  readonly linePlacements: readonly CaptionLinePlacement[];
  readonly fitScore: number;
  readonly readabilityScore: number;
  readonly safetyScore: number;
}

export interface CaptionLinePlacement {
  readonly text: string;
  /** Image-space top-left of the glyph box. */
  readonly position: Point<ImageSpace>;
  readonly baselineY: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** The actual horizontal span available in the safe mask at this line's Y. */
  readonly availableSpanPx: number;
}

export interface TimelineCue {
  readonly id: string;
  readonly dialogueLink: DialogueLink;
  readonly layoutId: string;
  readonly interval: TimeInterval;
}

/** Caption approved for display inside a bubble over an audio-time interval. */
export interface DialogueEvent {
  readonly id: string;
  readonly bubbleId: BubbleId;
  readonly caption: string;
  readonly start: AudioTime;
  readonly end: AudioTime;
  readonly layout: CaptionLayout;
  readonly confidence: number;
}

export interface Project {
  readonly id: ProjectId;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pages: readonly Page[];
  readonly audioAssets: readonly AudioAssetRef[];
  readonly proposals: readonly AnalysisProposal<unknown>[];
}
