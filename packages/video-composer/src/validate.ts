import type {
  CaptionCue,
  FallbackCaptionPlacement,
  ImagePoint,
  ImageRect,
  MotionComicVideoProps,
  PageInput,
  ValidationIssue,
  ValidationResult,
  WordTiming,
} from './types.js';
import { VideoCompositionError } from './types.js';

const MAX_DIMENSION = 7680;
const MIN_DIMENSION = 16;
const MAX_FPS = 60;
const MAX_DURATION_SECONDS = 30 * 60;

function issue(
  code: ValidationIssue['code'],
  path: string,
  message: string,
): ValidationIssue {
  return Object.freeze({ code, path, message });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validatePoint(
  point: ImagePoint,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    issues.push(
      issue(
        'invalid-coordinates',
        path,
        'Point coordinates must be finite numbers.',
      ),
    );
  }
}

function validateRect(
  rect: ImageRect,
  path: string,
  issues: ValidationIssue[],
): void {
  if (
    !rect ||
    !isFiniteNumber(rect.x) ||
    !isFiniteNumber(rect.y) ||
    !isFiniteNumber(rect.width) ||
    !isFiniteNumber(rect.height)
  ) {
    issues.push(
      issue('invalid-coordinates', path, 'Rect values must be finite numbers.'),
    );
    return;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    issues.push(
      issue(
        'invalid-coordinates',
        path,
        'Rect width and height must be positive.',
      ),
    );
  }
}

function validatePolygon(
  points: readonly ImagePoint[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(points) || points.length < 3) {
    issues.push(
      issue('invalid-coordinates', path, 'Polygon requires at least 3 points.'),
    );
    return;
  }
  points.forEach((point, index) => {
    validatePoint(point, `${path}[${index}]`, issues);
  });
}

function validateWords(
  words: readonly WordTiming[],
  cue: CaptionCue,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(words)) {
    issues.push(issue('malformed-timestamp', path, 'words must be an array.'));
    return;
  }
  words.forEach((word, index) => {
    const wordPath = `${path}.words[${index}]`;
    if (typeof word?.text !== 'string' || !word.text.trim()) {
      issues.push(
        issue('missing-cue-text', wordPath, 'Word text is required.'),
      );
    }
    if (
      !isFiniteNumber(word?.startSeconds) ||
      !isFiniteNumber(word?.endSeconds) ||
      word.startSeconds < 0 ||
      word.endSeconds <= word.startSeconds
    ) {
      issues.push(
        issue(
          'malformed-timestamp',
          wordPath,
          'Word timestamps must satisfy 0 <= start < end.',
        ),
      );
      return;
    }
    if (
      word.startSeconds < cue.startSeconds - 1e-3 ||
      word.endSeconds > cue.endSeconds + 1e-3
    ) {
      issues.push(
        issue(
          'word-out-of-range',
          wordPath,
          'Word timing must fall inside its caption cue.',
        ),
      );
    }
  });
}

function validateCue(
  cue: CaptionCue,
  index: number,
  pages: readonly PageInput[],
  durationSeconds: number,
  fallback: FallbackCaptionPlacement,
  issues: ValidationIssue[],
): void {
  const path = `cues[${index}]`;
  if (!cue || typeof cue.id !== 'string' || !cue.id.trim()) {
    issues.push(issue('missing-cue-text', path, 'Cue id is required.'));
    return;
  }
  if (typeof cue.text !== 'string' || !cue.text.trim()) {
    issues.push(
      issue('missing-cue-text', `${path}.text`, 'Cue text is required.'),
    );
  }
  if (
    !isFiniteNumber(cue.startSeconds) ||
    !isFiniteNumber(cue.endSeconds) ||
    cue.startSeconds < 0 ||
    cue.endSeconds <= cue.startSeconds
  ) {
    issues.push(
      issue(
        'malformed-timestamp',
        `${path}.timestamps`,
        'Cue must satisfy 0 <= startSeconds < endSeconds.',
      ),
    );
  } else if (cue.endSeconds > durationSeconds + 1e-3) {
    issues.push(
      issue(
        'cue-out-of-range',
        `${path}.timestamps`,
        'Cue ends after the composition duration.',
      ),
    );
  }

  if (cue.bubbleId != null) {
    const bubbleExists = pages.some((page) =>
      page.bubbles.some((bubble) => bubble.id === cue.bubbleId),
    );
    if (!bubbleExists) {
      issues.push(
        issue(
          'unknown-bubble',
          `${path}.bubbleId`,
          `No page bubble matches id "${cue.bubbleId}".`,
        ),
      );
    }
  } else if (!cue.fallbackPosition && !cue.layout) {
    // Allowed: composer will use the global fallback placement and flag review.
    if (!fallback.rect) {
      issues.push(
        issue(
          'invalid-coordinates',
          `${path}.fallbackPosition`,
          'Cue has no bubble assignment and no fallback placement is available.',
        ),
      );
    }
  }

  if (cue.fallbackPosition) {
    validateRect(cue.fallbackPosition, `${path}.fallbackPosition`, issues);
  }
  if (cue.layout) {
    if (!isFiniteNumber(cue.layout.fontSizePx) || cue.layout.fontSizePx <= 0) {
      issues.push(
        issue(
          'invalid-style',
          `${path}.layout.fontSizePx`,
          'Font size must be positive.',
        ),
      );
    }
    if (!Array.isArray(cue.layout.lines) || cue.layout.lines.length === 0) {
      issues.push(
        issue(
          'invalid-style',
          `${path}.layout.lines`,
          'Fitted layout needs at least one line.',
        ),
      );
    } else {
      cue.layout.lines.forEach((line, lineIndex) => {
        if (
          !isFiniteNumber(line.x) ||
          !isFiniteNumber(line.baselineY) ||
          !isFiniteNumber(line.widthPx) ||
          !isFiniteNumber(line.heightPx)
        ) {
          issues.push(
            issue(
              'invalid-coordinates',
              `${path}.layout.lines[${lineIndex}]`,
              'Line geometry must be finite numbers.',
            ),
          );
        }
      });
    }
  }
  validateWords(cue.words ?? [], cue, `${path}.words`, issues);
}

function validatePage(
  page: PageInput,
  index: number,
  issues: ValidationIssue[],
): void {
  const path = `pages[${index}]`;
  if (!page || typeof page.id !== 'string' || !page.id.trim()) {
    issues.push(issue('missing-page', path, 'Page id is required.'));
    return;
  }
  if (typeof page.imageUrl !== 'string' || !page.imageUrl.trim()) {
    issues.push(
      issue('missing-asset', `${path}.imageUrl`, 'Page image URL is required.'),
    );
  }
  if (
    !isFiniteNumber(page.width) ||
    !isFiniteNumber(page.height) ||
    page.width <= 0 ||
    page.height <= 0
  ) {
    issues.push(
      issue(
        'invalid-dimensions',
        `${path}.dimensions`,
        'Page dimensions must be positive.',
      ),
    );
  }
  if (
    !isFiniteNumber(page.startSeconds) ||
    !isFiniteNumber(page.endSeconds) ||
    page.startSeconds < 0 ||
    page.endSeconds <= page.startSeconds
  ) {
    issues.push(
      issue(
        'malformed-timestamp',
        `${path}.timestamps`,
        'Page must satisfy 0 <= startSeconds < endSeconds.',
      ),
    );
  }
  (page.bubbles ?? []).forEach((bubble, bubbleIndex) => {
    const bubblePath = `${path}.bubbles[${bubbleIndex}]`;
    if (!bubble?.id) {
      issues.push(
        issue('invalid-coordinates', bubblePath, 'Bubble id is required.'),
      );
    }
    if (bubble?.polygon) {
      validatePolygon(bubble.polygon, `${bubblePath}.polygon`, issues);
    } else {
      issues.push(
        issue(
          'invalid-coordinates',
          `${bubblePath}.polygon`,
          'Bubble polygon is required.',
        ),
      );
    }
    if (bubble?.safeRegion) {
      validatePolygon(bubble.safeRegion, `${bubblePath}.safeRegion`, issues);
    }
  });
  if (page.cameraFocus) {
    validateRect(page.cameraFocus, `${path}.cameraFocus`, issues);
    if (
      isFiniteNumber(page.cameraFocus.width) &&
      isFiniteNumber(page.cameraFocus.height) &&
      isFiniteNumber(page.width) &&
      isFiniteNumber(page.height) &&
      (page.cameraFocus.width > page.width + 1e-3 ||
        page.cameraFocus.height > page.height + 1e-3)
    ) {
      issues.push(
        issue(
          'invalid-coordinates',
          `${path}.cameraFocus`,
          'cameraFocus must stay inside the page image.',
        ),
      );
    }
  }
}

/** Validate every composition input. Throws `VideoCompositionError` when invalid. */
export function validateVideoComposition(
  input: MotionComicVideoProps,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!input || typeof input !== 'object') {
    return Object.freeze({
      valid: false,
      issues: [
        issue('missing-asset', 'input', 'Composition props are required.'),
      ],
    });
  }

  if (typeof input.audioUrl !== 'string' || !input.audioUrl.trim()) {
    issues.push(
      issue('missing-asset', 'audioUrl', 'Narration audio URL is required.'),
    );
  }

  if (
    !isFiniteNumber(input.width) ||
    !isFiniteNumber(input.height) ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < MIN_DIMENSION ||
    input.height < MIN_DIMENSION ||
    input.width > MAX_DIMENSION ||
    input.height > MAX_DIMENSION
  ) {
    issues.push(
      issue(
        'invalid-dimensions',
        'width/height',
        `Output size must be integers between ${MIN_DIMENSION} and ${MAX_DIMENSION}.`,
      ),
    );
  } else if (input.width % 2 !== 0 || input.height % 2 !== 0) {
    issues.push(
      issue(
        'invalid-dimensions',
        'width/height',
        'Output width and height must be even for H.264 yuv420p.',
      ),
    );
  }

  if (!isFiniteNumber(input.fps) || input.fps <= 0 || input.fps > MAX_FPS) {
    issues.push(
      issue('invalid-fps', 'fps', `fps must be between 0 and ${MAX_FPS}.`),
    );
  }

  if (
    !isFiniteNumber(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > MAX_DURATION_SECONDS
  ) {
    issues.push(
      issue(
        'invalid-duration',
        'durationSeconds',
        `durationSeconds must be between 0 and ${MAX_DURATION_SECONDS}.`,
      ),
    );
  }

  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    issues.push(
      issue('missing-page', 'pages', 'At least one page is required.'),
    );
  } else {
    input.pages.forEach((page, index) => validatePage(page, index, issues));
  }

  const style = input.captionStyle;
  if (!style) {
    issues.push(
      issue('invalid-style', 'captionStyle', 'Caption style is required.'),
    );
  } else {
    if (!isFiniteNumber(style.fontSizePx) || style.fontSizePx <= 0) {
      issues.push(
        issue(
          'invalid-style',
          'captionStyle.fontSizePx',
          'Font size must be positive.',
        ),
      );
    }
    if (!isFiniteNumber(style.lineSpacingPx) || style.lineSpacingPx < 0) {
      issues.push(
        issue(
          'invalid-style',
          'captionStyle.lineSpacingPx',
          'Line spacing must be >= 0.',
        ),
      );
    }
    if (!isFiniteNumber(style.safeMarginPx) || style.safeMarginPx < 0) {
      issues.push(
        issue(
          'invalid-style',
          'captionStyle.safeMarginPx',
          'Safe margin must be >= 0.',
        ),
      );
    }
    if (
      !isFiniteNumber(style.fadeInSeconds) ||
      !isFiniteNumber(style.fadeOutSeconds) ||
      style.fadeInSeconds < 0 ||
      style.fadeOutSeconds < 0
    ) {
      issues.push(
        issue(
          'invalid-style',
          'captionStyle.fade',
          'Fade durations must be >= 0.',
        ),
      );
    }
  }

  const camera = input.camera;
  if (!camera) {
    issues.push(
      issue('invalid-camera', 'camera', 'Camera settings are required.'),
    );
  } else {
    if (!isFiniteNumber(camera.zoomFrom) || !isFiniteNumber(camera.zoomTo)) {
      issues.push(
        issue('invalid-camera', 'camera.zoom', 'Zoom values must be finite.'),
      );
    } else if (camera.zoomFrom <= 0 || camera.zoomTo <= 0) {
      issues.push(
        issue('invalid-camera', 'camera.zoom', 'Zoom values must be positive.'),
      );
    }
    validatePoint(camera.panFrom, 'camera.panFrom', issues);
    validatePoint(camera.panTo, 'camera.panTo', issues);
  }

  const transitions = input.transitions;
  if (!transitions) {
    issues.push(
      issue(
        'invalid-transition',
        'transitions',
        'Transition settings are required.',
      ),
    );
  } else if (transitions.enabled) {
    if (
      !isFiniteNumber(transitions.durationSeconds) ||
      transitions.durationSeconds < 0
    ) {
      issues.push(
        issue(
          'invalid-transition',
          'transitions.durationSeconds',
          'Transition duration must be >= 0.',
        ),
      );
    }
    if (transitions.kind === 'none') {
      issues.push(
        issue(
          'invalid-transition',
          'transitions.kind',
          'Enabled transitions cannot use kind "none".',
        ),
      );
    }
  }

  const fallback = input.fallbackPlacement;
  if (!fallback?.rect) {
    issues.push(
      issue(
        'invalid-coordinates',
        'fallbackPlacement.rect',
        'A fallback caption rect is required for cues without bubble assignment.',
      ),
    );
  } else {
    validateRect(fallback.rect, 'fallbackPlacement.rect', issues);
  }

  if (Array.isArray(input.cues) && input.pages) {
    input.cues.forEach((cue, index) =>
      validateCue(
        cue,
        index,
        input.pages,
        input.durationSeconds,
        fallback ?? {
          rect: { x: 0, y: 0, width: 1, height: 1 },
          alignment: 'center',
        },
        issues,
      ),
    );
  } else if (!Array.isArray(input.cues)) {
    issues.push(issue('missing-cue-text', 'cues', 'cues must be an array.'));
  }

  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

/** Validate or throw — used by the export job before rendering starts. */
export function assertValidVideoComposition(
  input: MotionComicVideoProps,
): void {
  const report = validateVideoComposition(input);
  if (!report.valid) throw new VideoCompositionError(report.issues);
}
