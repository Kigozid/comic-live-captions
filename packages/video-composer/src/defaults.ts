import type {
  BubbleReusePolicy,
  CameraMotionSettings,
  CaptionStyleSettings,
  FallbackCaptionPlacement,
  TransitionSettings,
} from './types.js';

/**
 * Effects are intentionally minimal by default. Narration timing stays the
 * authority; camera and caption motion never invent extra duration.
 */
export const DEFAULT_CAPTION_STYLE: CaptionStyleSettings = Object.freeze({
  fontFamily: 'Helvetica, Arial, sans-serif',
  fontSizePx: 28,
  color: '#111111',
  strokeColor: '#ffffff',
  strokeWidthPx: 2,
  lineSpacingPx: 6,
  safeMarginPx: 8,
  revealMode: 'smooth-phrase' as const,
  karaoke: false,
  wordEmphasis: false,
  fadeInSeconds: 0.12,
  fadeOutSeconds: 0.18,
  bubbleReusePolicy: 'replace' as BubbleReusePolicy,
});

export const DEFAULT_CAMERA: CameraMotionSettings = Object.freeze({
  enabled: false,
  mode: 'none' as const,
  zoomFrom: 1,
  zoomTo: 1,
  panFrom: Object.freeze({ x: 0, y: 0 }),
  panTo: Object.freeze({ x: 0, y: 0 }),
});

export const DEFAULT_TRANSITIONS: TransitionSettings = Object.freeze({
  enabled: false,
  kind: 'none' as const,
  durationSeconds: 0.35,
});

export const DEFAULT_FALLBACK_PLACEMENT: FallbackCaptionPlacement =
  Object.freeze({
    // Lower-third *of the page image*, never a separate subtitle track. This is
    // only used when bubble assignment is missing or unreliable.
    rect: Object.freeze({ x: 0.1, y: 0.82, width: 0.8, height: 0.12 }),
    alignment: 'center' as const,
  });

export function resolveCaptionStyle(
  overrides?: Partial<CaptionStyleSettings>,
): CaptionStyleSettings {
  return Object.freeze({ ...DEFAULT_CAPTION_STYLE, ...overrides });
}

export function resolveCamera(
  overrides?: Partial<CameraMotionSettings>,
): CameraMotionSettings {
  return Object.freeze({ ...DEFAULT_CAMERA, ...overrides });
}

export function resolveTransitions(
  overrides?: Partial<TransitionSettings>,
): TransitionSettings {
  return Object.freeze({ ...DEFAULT_TRANSITIONS, ...overrides });
}
