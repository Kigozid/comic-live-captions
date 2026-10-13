import type {
  Bounds,
  ImageSpace,
  OCRDocument,
  SourceImageRole,
} from '@comic-captioner/shared';

export interface PaddleOCRStatus {
  readonly phase:
    'preparing' | 'loading-models' | 'recognizing' | 'ready' | 'error';
  readonly message: string;
}

export interface LocalOCRResult {
  readonly document: OCRDocument;
  readonly preprocessing?: 'original' | 'enhanced';
  readonly metrics: {
    readonly initializationMs: number;
    readonly detectionMs: number;
    readonly recognitionMs: number;
    readonly totalMs: number;
    readonly detectedTextRegions: number;
    readonly averageConfidence: number;
  };
}

export interface OCRSource {
  readonly role: SourceImageRole;
  readonly sha256: string;
  readonly imageSpace: ImageSpace;
}

export interface OCRBubbleRegion {
  readonly id: string;
  readonly polygon: readonly { readonly x: number; readonly y: number }[];
  readonly tail?: readonly { readonly x: number; readonly y: number }[] | null;
  readonly reviewStatus?: string;
  readonly cropPadding?: number;
}

/** Convert Paddle's local crop polygon into validated page-pixel bounds. */
export function paddlePolygonBounds(
  polygon: readonly (readonly [number, number])[],
  imageSpace: ImageSpace,
): Bounds<ImageSpace> | null {
  const points = polygon.filter(
    (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  if (points.length < 3) return null;
  const { width, height } = imageSpace.dimensions;
  const x = Math.max(
    -0.5,
    Math.min(width - 1, ...points.map((point) => point[0])),
  );
  const y = Math.max(
    -0.5,
    Math.min(height - 1, ...points.map((point) => point[1])),
  );
  const right = Math.min(
    width - 0.5,
    Math.max(...points.map((point) => point[0])),
  );
  const bottom = Math.min(
    height - 0.5,
    Math.max(...points.map((point) => point[1])),
  );
  return {
    x,
    y,
    width: Math.min(width - 0.5 - x, Math.max(0.5, right - x)),
    height: Math.min(height - 0.5 - y, Math.max(0.5, bottom - y)),
    coordinateSpace: imageSpace,
  };
}

/** Map a box in an upscaled bubble crop back into page pixel coordinates. */
export function cropBoundsToImage(
  crop: Bounds<ImageSpace>,
  origin: { readonly x: number; readonly y: number },
  scale: number,
  imageSpace: ImageSpace,
): Bounds<ImageSpace> {
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error('OCR crop scale must be positive and finite.');
  const x = Math.max(-0.5, origin.x + crop.x / scale);
  const y = Math.max(-0.5, origin.y + crop.y / scale);
  const right = Math.min(
    imageSpace.dimensions.width - 0.5,
    origin.x + (crop.x + crop.width) / scale,
  );
  const bottom = Math.min(
    imageSpace.dimensions.height - 0.5,
    origin.y + (crop.y + crop.height) / scale,
  );
  return {
    x,
    y,
    width: Math.max(0.5, right - x),
    height: Math.max(0.5, bottom - y),
    coordinateSpace: imageSpace,
  };
}

/** Browser client for local API OCR; Paddle and OpenCV never enter the web bundle. */
export function recognizeComicPage(
  source: OCRSource,
  onStatus: (status: PaddleOCRStatus) => void,
  enhanced = false,
  signal?: AbortSignal,
): Promise<LocalOCRResult> {
  return requestLocalOCR(source, onStatus, enhanced, [], signal);
}

export function recognizeComicBubbles(
  source: OCRSource,
  bubbles: readonly OCRBubbleRegion[],
  onStatus: (status: PaddleOCRStatus) => void,
  enhanced = false,
  signal?: AbortSignal,
): Promise<LocalOCRResult> {
  const active = bubbles.filter((bubble) => bubble.reviewStatus !== 'rejected');
  if (!active.length)
    return requestLocalOCR(source, onStatus, enhanced, [], signal);
  return requestLocalOCR(source, onStatus, enhanced, active, signal);
}

async function requestLocalOCR(
  source: OCRSource,
  onStatus: (status: PaddleOCRStatus) => void,
  enhanced: boolean,
  bubbles: readonly OCRBubbleRegion[],
  signal?: AbortSignal,
): Promise<LocalOCRResult> {
  onStatus({ phase: 'preparing', message: 'Preparing the local OCR request…' });
  const controller = signal;
  try {
    onStatus({
      phase: 'loading-models',
      message: 'The local API is loading or reusing PaddleOCR models…',
    });
    onStatus({
      phase: 'recognizing',
      message: bubbles.length
        ? `Reading ${bubbles.length} bubble crop${bubbles.length === 1 ? '' : 's'} on this device…`
        : 'Reading text on the comic page locally…',
    });
    const response = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: source.role,
        sourceHash: source.sha256,
        coordinateSpaceId: source.imageSpace.id,
        enhanced,
        bubbles,
      }),
      ...(controller ? { signal: controller } : {}),
    });
    const payload = (await response.json()) as {
      readonly document?: OCRDocument;
      readonly preprocessing?: 'original' | 'enhanced';
      readonly metrics?: LocalOCRResult['metrics'];
      readonly error?: { readonly message?: string };
    };
    if (!response.ok || !payload.document || !payload.metrics)
      throw new Error(
        payload.error?.message ?? 'The local OCR request could not complete.',
      );
    validateOCRResult(payload.document, payload.metrics, source.imageSpace);
    onStatus({
      phase: 'ready',
      message: payload.metrics.detectedTextRegions
        ? `Local OCR found ${payload.metrics.detectedTextRegions} text regions.`
        : 'PaddleOCR found no readable text. Try a larger crop or enhanced preprocessing.',
    });
    return {
      document: payload.document,
      preprocessing: payload.preprocessing ?? 'original',
      metrics: payload.metrics,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    const message =
      error instanceof Error ? error.message : 'Local OCR failed.';
    onStatus({ phase: 'error', message });
    throw error;
  }
}

function validateOCRResult(
  document: OCRDocument,
  metrics: LocalOCRResult['metrics'],
  imageSpace: ImageSpace,
): void {
  if (
    document.coordinateSpace.id !== imageSpace.id ||
    document.coordinateSpace.dimensions.width !== imageSpace.dimensions.width ||
    document.coordinateSpace.dimensions.height !== imageSpace.dimensions.height
  )
    throw new Error(
      'OCR results refer to a different page coordinate space and were rejected.',
    );
  if (
    !Array.isArray(document.blocks) ||
    typeof document.text !== 'string' ||
    !Number.isFinite(document.confidence) ||
    document.confidence < 0 ||
    document.confidence > 1 ||
    Object.values(metrics).some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error(
      'The local OCR service returned malformed results. Retry OCR.',
    );
}
