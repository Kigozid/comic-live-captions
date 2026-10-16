export type {
  BubbleGeometryInput,
  CameraMode,
  CameraMotionSettings,
  CaptionAlignment,
  CaptionCue,
  CaptionStyleSettings,
  FallbackCaptionPlacement,
  FittedCaptionLayout,
  FittedCaptionLine,
  ImagePoint,
  ImageRect,
  MotionComicVideoProps,
  PageInput,
  PanelSequenceStep,
  RevealMode,
  TransitionKind,
  TransitionSettings,
  ValidationIssue,
  ValidationIssueCode,
  ValidationResult,
  WordTiming,
} from './types.js';
export { VideoCompositionError } from './types.js';

export {
  activeWordAt,
  clampFrame,
  cueProgress,
  durationInFrames,
  frameToSeconds,
  isCueVisibleAt,
  isCueVisibleAtFrame,
  mapWordsToLines,
  secondsToFrame,
  visibleWordsAt,
} from './timing.js';
export type { LineWordSpan } from './timing.js';

export {
  assertValidVideoComposition,
  validateVideoComposition,
} from './validate.js';

export {
  bubbleSafeRect,
  focusPlacement,
  insetRect,
  pageAtTime,
  pagePlacement,
  pointInPolygon,
  polygonBounds,
  resolveFallbackRect,
  resolvePageCameraPlacement,
} from './geometry.js';

export {
  assignBubblesToPanels,
  buildPanelPageSequence,
  proposePanelSequenceTimings,
} from './panel-sequence.js';
export type {
  BuildPanelSequenceInput,
  PanelAssignmentBubble,
  PanelRef,
} from './panel-sequence.js';

export {
  DEFAULT_CAMERA,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FALLBACK_PLACEMENT,
  DEFAULT_TRANSITIONS,
  resolveCamera,
  resolveCaptionStyle,
  resolveTransitions,
} from './defaults.js';

export type { ExportCaption, ExportBubble } from './converters.js';
export {
  compositionPropsFromExportPayload,
  cuesFromExportCaptions,
} from './converters.js';

export { MOTION_COMIC_COMPOSITION_ID } from './remotion/composition-id.js';
