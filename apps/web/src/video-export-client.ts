export interface VideoExportJobSummary {
  readonly id: string;
  readonly status:
    | 'queued'
    | 'preparing'
    | 'rendering'
    | 'validating'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  readonly progress: number;
  readonly frame: number;
  readonly createdAt: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly output?: {
    readonly fileName: string;
    readonly bytes: number;
    readonly durationSeconds: number;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
    readonly hasAudio: boolean;
    readonly codec: string;
    readonly pixelFormat: string;
  };
}

export interface VideoExportAvailability {
  readonly browserReady: boolean;
  readonly maxConcurrentJobs: number;
  readonly renderConcurrency: number;
  readonly licenseNote: string;
  readonly jobs: readonly VideoExportJobSummary[];
}

export type CaptionRevealMode = 'phrase' | 'word-by-word';

export interface VideoExportStyleOptions {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly color: string;
  readonly strokeColor: string;
  readonly strokeWidthPx: number;
  readonly lineSpacingPx: number;
  readonly safeMarginPx: number;
  readonly revealMode: CaptionRevealMode;
  readonly karaoke: boolean;
  readonly wordEmphasis: boolean;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
}

export interface VideoExportCameraOptions {
  readonly enabled: boolean;
  readonly mode: 'none' | 'slow-zoom-in' | 'slow-zoom-out' | 'pan';
  readonly zoomFrom: number;
  readonly zoomTo: number;
  readonly panFrom: { x: number; y: number };
  readonly panTo: { x: number; y: number };
}

export interface VideoExportTransitionOptions {
  readonly enabled: boolean;
  readonly kind: 'none' | 'fade' | 'crossfade';
  readonly durationSeconds: number;
}

function readErrorPayload(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    payload.error &&
    typeof payload.error === 'object' &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
  ) {
    return payload.error.message;
  }
  return `Video export request failed (${status}).`;
}

export async function fetchVideoExportAvailability(): Promise<VideoExportAvailability> {
  const response = await fetch('/api/video/export');
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readErrorPayload(payload, response.status));
  return payload as VideoExportAvailability;
}

export async function createVideoExportJob(body: {
  readonly pageImage?: Blob | ArrayBuffer | Uint8Array | null;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly audio: Blob | ArrayBuffer | Uint8Array;
  readonly audioFormat: string;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly resolution: {
    readonly resolution: '720p' | '1080p' | 'custom';
    readonly width?: number;
    readonly height?: number;
  };
  readonly captions: readonly unknown[];
  readonly bubbles: readonly unknown[];
  /** Multi-page comic sources (10–15 pages). */
  readonly sourcePages?: readonly {
    readonly id: string;
    readonly image: Blob | ArrayBuffer | Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly label?: string;
    readonly bubbles?: readonly unknown[];
  }[];
  readonly panelSequence?: readonly {
    readonly id: string;
    readonly bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly label?: string;
    readonly bubbleIds?: readonly string[];
    readonly pageId?: string;
  }[];
  readonly captionStyle?: Partial<VideoExportStyleOptions>;
  readonly camera?: Partial<VideoExportCameraOptions>;
  readonly transitions?: Partial<VideoExportTransitionOptions>;
  readonly backgroundColor?: string;
  readonly signal?: AbortSignal;
}): Promise<VideoExportJobSummary> {
  const pageImage = body.pageImage ? await toBase64(body.pageImage) : '';
  const audio = await toBase64(body.audio);
  const sourcePages = body.sourcePages
    ? await Promise.all(
        body.sourcePages.map(async (page) => ({
          id: page.id,
          image: await toBase64(page.image),
          width: page.width,
          height: page.height,
          startSeconds: page.startSeconds,
          endSeconds: page.endSeconds,
          ...(page.label ? { label: page.label } : {}),
          ...(page.bubbles ? { bubbles: page.bubbles } : {}),
        })),
      )
    : undefined;
  const response = await fetch('/api/video/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pageImage,
      pageWidth: body.pageWidth,
      pageHeight: body.pageHeight,
      audio,
      audioFormat: body.audioFormat,
      durationSeconds: body.durationSeconds,
      fps: body.fps,
      resolution: body.resolution,
      captions: body.captions,
      bubbles: body.bubbles,
      sourcePages,
      panelSequence: body.panelSequence,
      captionStyle: body.captionStyle,
      camera: body.camera,
      transitions: body.transitions,
      backgroundColor: body.backgroundColor,
    }),
    ...(body.signal ? { signal: body.signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readErrorPayload(payload, response.status));
  const job = (payload as { job?: VideoExportJobSummary }).job;
  if (!job) throw new Error('Video export job was not returned by the API.');
  return job;
}

export async function getVideoExportJob(
  id: string,
): Promise<VideoExportJobSummary> {
  const response = await fetch(`/api/video/export/${id}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readErrorPayload(payload, response.status));
  const job = (payload as { job?: VideoExportJobSummary }).job;
  if (!job) throw new Error('Video export job was not found.');
  return job;
}

export async function cancelVideoExportJob(
  id: string,
): Promise<VideoExportJobSummary> {
  const response = await fetch(`/api/video/export/${id}`, { method: 'DELETE' });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readErrorPayload(payload, response.status));
  const job = (payload as { job?: VideoExportJobSummary }).job;
  if (!job) throw new Error('Video export job was not returned by the API.');
  return job;
}

export async function downloadVideoExport(id: string): Promise<Blob> {
  const response = await fetch(`/api/video/export/${id}/file`);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(readErrorPayload(payload, response.status));
  }
  return response.blob();
}

async function toBase64(
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function waitForVideoExportJob(
  id: string,
  options: {
    readonly signal?: AbortSignal;
    readonly onUpdate?: (job: VideoExportJobSummary) => void;
    readonly intervalMs?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<VideoExportJobSummary> {
  const interval = options.intervalMs ?? 800;
  const timeout = options.timeoutMs ?? 15 * 60_000;
  const started = Date.now();
  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException('Export cancelled.', 'AbortError');
    }
    const job = await getVideoExportJob(id);
    options.onUpdate?.(job);
    if (
      job.status === 'succeeded' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return job;
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        'Video export timed out while waiting for the render job.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
