/**
 * Composition input contract for motion-comic video export.
 *
 * Coordinate convention matches the rest of the app: image-space pixel
 * centers, top-left origin, x right, y down. Bubble and caption geometry is
 * always expressed in page/image pixels and scaled to the output frame.
 */

export type RevealMode =
  | 'smooth-phrase'
  | 'phrase'
  | 'word-by-word'
  | 'character-by-character';
export type CaptionAlignment = 'left' | 'center' | 'right';
export type CameraMode = 'none' | 'slow-zoom-in' | 'slow-zoom-out' | 'pan';
export type TransitionKind = 'none' | 'fade' | 'crossfade';
export type BubbleReusePolicy = 'retain' | 'replace' | 'clear';

export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WordTiming {
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/** One laid-out text line in image coordinates. */
export interface FittedCaptionLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly baselineY: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * Saved deterministic fit (from caption-engine). When present, the composer
 * renders these exact placements inside the assigned bubble.
 */
export interface FittedCaptionLayout {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly color: string;
  readonly strokeColor: string;
  readonly strokeWidthPx: number;
  readonly lineSpacingPx: number;
  readonly alignment: CaptionAlignment;
  readonly lines: readonly FittedCaptionLine[];
}

export interface BubbleGeometryInput {
  readonly id: string;
  /** Bubble contour in page/image coordinates. */
  readonly polygon: readonly ImagePoint[];
  /** Optional safe interior region; defaults to an inset of the contour. */
  readonly safeRegion?: readonly ImagePoint[];
  readonly classification?: 'speech' | 'thought' | 'shout' | 'unknown';
}

export interface PageInput {
  readonly id: string;
  /** URL or data: URL of the cleaned page. */
  readonly imageUrl: string;
  readonly width: number;
  readonly height: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly bubbles: readonly BubbleGeometryInput[];
  readonly label?: string;
  /**
   * Optional panel crop in image pixels. When set, the camera frames this
   * region (contain) instead of the whole page — used for panel sequences.
   */
  readonly cameraFocus?: ImageRect;
}

/** One timed shot in a multi-page / panel sequence. */
export interface PanelSequenceStep {
  readonly id: string;
  /** Panel bounds in page-image pixels. */
  readonly bounds: ImageRect;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly label?: string;
  /** Bubble ids that belong to this shot; empty means keep all bubbles. */
  readonly bubbleIds?: readonly string[];
}

export interface CaptionCue {
  readonly id: string;
  /** Null when bubble assignment is unreliable; fallback placement is used. */
  readonly bubbleId: string | null;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly words: readonly WordTiming[];
  readonly layout?: FittedCaptionLayout | null;
  /** Manual placement override in image coordinates. */
  readonly fallbackPosition?: ImageRect;
  /** True when assignment/placement needs human review before broadcast use. */
  readonly needsReview?: boolean;
  readonly confidence?: number;
}

export interface CaptionStyleSettings {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly color: string;
  readonly strokeColor: string;
  readonly strokeWidthPx: number;
  readonly lineSpacingPx: number;
  readonly safeMarginPx: number;
  readonly revealMode: RevealMode;
  readonly karaoke: boolean;
  readonly wordEmphasis: boolean;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  /** What a bubble shows when a later caption reuses it. */
  readonly bubbleReusePolicy: BubbleReusePolicy;
  /** Manual wrap width in image px; omitted means fit to bubble safe region. */
  readonly maxLineWidthPx?: number;
}

export interface CameraMotionSettings {
  readonly enabled: boolean;
  readonly mode: CameraMode;
  readonly zoomFrom: number;
  readonly zoomTo: number;
  /** Pan offsets are fractions of the page size (0 = centered). */
  readonly panFrom: ImagePoint;
  readonly panTo: ImagePoint;
}

export interface TransitionSettings {
  readonly enabled: boolean;
  readonly kind: TransitionKind;
  readonly durationSeconds: number;
}

export interface FallbackCaptionPlacement {
  /** Image-space rect used when a cue has no reliable bubble assignment. */
  readonly rect: ImageRect;
  readonly alignment: CaptionAlignment;
}

export interface MotionComicVideoProps {
  readonly pages: readonly PageInput[];
  /** Narration audio URL (file path under Remotion publicDir, or data:/http:). */
  readonly audioUrl: string;
  readonly cues: readonly CaptionCue[];
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly captionStyle: CaptionStyleSettings;
  readonly camera: CameraMotionSettings;
  readonly transitions: TransitionSettings;
  readonly fallbackPlacement: FallbackCaptionPlacement;
  /** Letterbox background around the page. */
  readonly backgroundColor: string;
}

export type ValidationIssueCode =
  | 'missing-asset'
  | 'invalid-dimensions'
  | 'invalid-fps'
  | 'invalid-duration'
  | 'malformed-timestamp'
  | 'invalid-coordinates'
  | 'missing-page'
  | 'missing-cue-text'
  | 'cue-out-of-range'
  | 'word-out-of-range'
  | 'unknown-bubble'
  | 'invalid-style'
  | 'invalid-camera'
  | 'invalid-transition';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export class VideoCompositionError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `Video composition input is invalid: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'VideoCompositionError';
  }
}
