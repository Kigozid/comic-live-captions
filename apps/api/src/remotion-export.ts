import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import {
  ensureBrowser,
  getVideoMetadata,
  makeCancelSignal,
  renderMedia,
  selectComposition,
  type CancelSignal,
} from '@remotion/renderer';
import type {
  CameraMotionSettings,
  CaptionStyleSettings,
  CaptionCue,
  ImageRect,
  MotionComicVideoProps,
  PageInput,
  PanelSequenceStep,
  TransitionSettings,
  ValidationResult,
} from '@comic-captioner/video-composer';
import {
  MOTION_COMIC_COMPOSITION_ID,
  assertValidVideoComposition,
  buildPanelPageSequence,
  compositionPropsFromExportPayload,
  validateVideoComposition,
  VideoCompositionError,
} from '@comic-captioner/video-composer';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../../..');
const COMPOSITION_ENTRY = resolve(
  REPO_ROOT,
  'packages/video-composer/src/remotion/index.ts',
);
const PUBLIC_DIR = resolve(REPO_ROOT, 'output/remotion-public');
const EXPORT_DIR = resolve(REPO_ROOT, 'output/video-exports');

export type VideoExportJobStatus =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'validating'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface VideoExportJob {
  readonly id: string;
  readonly status: VideoExportJobStatus;
  readonly createdAt: string;
  readonly progress: number;
  readonly frame: number;
  readonly jobId: string;
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
    readonly path: string;
  };
}

export class VideoExportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'VALIDATION_FAILED'
      | 'BUNDLE_FAILED'
      | 'RENDER_FAILED'
      | 'BROWSER_MISSING'
      | 'OUTPUT_INVALID'
      | 'NOT_FOUND'
      | 'BUSY'
      | 'ABORTED',
    message: string,
  ) {
    super(message);
    this.name = 'VideoExportError';
  }
}

export interface VideoExportRequest {
  readonly pageImage: string;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly audio?: string;
  readonly audioFormat?: string;
  readonly fps?: number;
  readonly durationSeconds: number;
  readonly resolution?: {
    readonly resolution?: '720p' | '1080p' | 'custom';
    readonly width?: number;
    readonly height?: number;
  };
  readonly width?: number;
  readonly height?: number;
  readonly captions?: readonly unknown[];
  readonly bubbles?: readonly unknown[];
  readonly cues?: readonly unknown[];
  readonly pages?: readonly unknown[];
  /**
   * Multi-page comic sources. When present, each entry becomes one (or more,
   * via panelSequence) Remotion page with its own image data URL.
   */
  readonly sourcePages?: readonly {
    readonly id: string;
    readonly image: string;
    readonly width: number;
    readonly height: number;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly label?: string;
    readonly bubbles?: readonly unknown[];
    readonly cameraFocus?: ImageRect;
  }[];
  /**
   * Optional multi-shot panel sequence. Steps with `pageId` bind to a
   * `sourcePages` entry; steps without `pageId` use the single `pageImage`.
   */
  readonly panelSequence?: readonly {
    readonly id: string;
    readonly bounds: ImageRect;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly label?: string;
    readonly bubbleIds?: readonly string[];
    readonly pageId?: string;
  }[];
  readonly captionStyle?: Partial<CaptionStyleSettings>;
  readonly camera?: Partial<CameraMotionSettings>;
  readonly transitions?: Partial<TransitionSettings>;
  readonly backgroundColor?: string;
}

const DEFAULT_FPS = 24;

function envInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Protect an 8 GB development machine: few jobs, few threads per job. */
function maxConcurrentJobs(): number {
  return envInt('COMIC_VIDEO_CONCURRENT_JOBS', 1, 1, 2);
}

function renderConcurrency(): number {
  return envInt('COMIC_VIDEO_CONCURRENCY', 1, 1, 4);
}

function resolveDimensions(request: VideoExportRequest): {
  width: number;
  height: number;
} {
  if (
    request.resolution?.resolution === '720p' ||
    (!request.resolution && request.width == null && request.height == null)
  ) {
    return { width: 1280, height: 720 };
  }
  if (request.resolution?.resolution === '1080p') {
    return { width: 1920, height: 1080 };
  }
  const width = Number(request.resolution?.width ?? request.width);
  const height = Number(request.resolution?.height ?? request.height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 7680 ||
    height > 7680
  ) {
    throw new VideoExportError(
      'INVALID_INPUT',
      'Export dimensions must be whole numbers between 16 and 7680 pixels.',
    );
  }
  return {
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
  };
}

function decodeBase64Bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VideoExportError(
      'INVALID_INPUT',
      `${label} must be base64-encoded bytes.`,
    );
  }
  const normalized = value.includes(',')
    ? value.slice(value.indexOf(',') + 1)
    : value;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(normalized, 'base64');
  } catch {
    throw new VideoExportError(
      'INVALID_INPUT',
      `${label} is not valid base64.`,
    );
  }
  if (buffer.byteLength === 0) {
    throw new VideoExportError(
      'INVALID_INPUT',
      `${label} decoded to zero bytes.`,
    );
  }
  return new Uint8Array(buffer);
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function imageMimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50)
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return 'image/jpeg';
  return 'image/webp';
}

function audioMimeFromFormat(format: unknown): string {
  const cleaned = sanitizeAudioFormat(format);
  if (cleaned.startsWith('mp3')) return 'audio/mpeg';
  if (cleaned.startsWith('m4a') || cleaned.startsWith('aac'))
    return 'audio/mp4';
  if (cleaned.startsWith('ogg')) return 'audio/ogg';
  return 'audio/wav';
}

function sanitizeAudioFormat(format: unknown): string {
  if (typeof format !== 'string') return 'wav';
  const cleaned = format.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.slice(0, 8) || 'wav';
}

function asRecordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object',
  );
}

interface InternalJob extends VideoExportJob {
  status: VideoExportJobStatus;
  progress: number;
  frame: number;
  error?: { code: string; message: string };
  output?: NonNullable<VideoExportJob['output']>;
  cancelSignal: CancelSignal;
  cancel: () => void;
  workDir?: string | undefined;
  request: VideoExportRequest;
}

const jobs = new Map<string, InternalJob>();
let bundlePromise: Promise<string> | null = null;
let activeRenders = 0;
const queue: string[] = [];

function publicJob(id: string): string {
  return join(PUBLIC_DIR, 'jobs', id);
}

function exportJobDir(id: string): string {
  return join(EXPORT_DIR, id);
}

/** Bundle the Remotion entry once and reuse it for every export job. */
async function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = bundle({
      entryPoint: COMPOSITION_ENTRY,
      // Assets are copied under output/remotion-public/jobs/<id>/ and referenced
      // with staticFile() so each job stays isolated.
      publicDir: PUBLIC_DIR,
      onProgress: () => undefined,
      webpackOverride: (config) => {
        config.resolve = config.resolve ?? {};
        // The monorepo uses TypeScript ESM `./foo.js` import specifiers that
        // resolve to `./foo.ts` / `./foo.tsx`.
        config.resolve.extensionAlias = {
          '.js': ['.ts', '.tsx', '.js'],
          '.jsx': ['.tsx', '.jsx'],
          '.mjs': ['.mts', '.mjs'],
        };
        return config;
      },
    }).catch(async (error: unknown) => {
      bundlePromise = null;
      throw new VideoExportError(
        'BUNDLE_FAILED',
        `Could not bundle the Remotion composition: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  return bundlePromise;
}

function toCompositionProps(
  request: VideoExportRequest,
  assetUrls: {
    pageImageUrl: string;
    audioUrl: string;
    sourcePageUrls?: Readonly<Record<string, string>>;
  },
  size: { width: number; height: number },
): MotionComicVideoProps {
  const fps = request.fps ?? DEFAULT_FPS;
  const { width, height } = size;

  if (request.pages && request.cues && request.pages.length > 0) {
    // Full multi-page payload already in composition shape.
    const base = compositionPropsFromExportPayload({
      pageImage: {
        url: assetUrls.pageImageUrl,
        width: request.pageWidth,
        height: request.pageHeight,
      },
      audioUrl: assetUrls.audioUrl,
      captions: [],
      bubbles: [],
      width,
      height,
      fps,
      durationSeconds: request.durationSeconds,
      ...(request.captionStyle ? { captionStyle: request.captionStyle } : {}),
      ...(request.camera ? { camera: request.camera } : {}),
      ...(request.transitions ? { transitions: request.transitions } : {}),
      ...(request.backgroundColor
        ? { backgroundColor: request.backgroundColor }
        : {}),
    });
    return {
      ...base,
      pages: request.pages as PageInput[],
      cues: request.cues as CaptionCue[],
    };
  }

  const baseProps = compositionPropsFromExportPayload({
    pageImage: {
      url: assetUrls.pageImageUrl,
      width: request.pageWidth,
      height: request.pageHeight,
    },
    audioUrl: assetUrls.audioUrl,
    captions: asRecordArray(request.captions) as never,
    bubbles: asRecordArray(request.bubbles) as never,
    width,
    height,
    fps,
    durationSeconds: request.durationSeconds,
    ...(request.captionStyle ? { captionStyle: request.captionStyle } : {}),
    ...(request.camera ? { camera: request.camera } : {}),
    ...(request.transitions ? { transitions: request.transitions } : {}),
    ...(request.backgroundColor
      ? { backgroundColor: request.backgroundColor }
      : {}),
  });

  // Multi-page comic sources (one job can hold 10–15 pages).
  if (request.sourcePages && request.sourcePages.length > 0) {
    const sourcePages = request.sourcePages;
    const pages: PageInput[] = sourcePages.map((source, index) => {
      const imageUrl =
        assetUrls.sourcePageUrls?.[source.id] ??
        (index === 0 ? assetUrls.pageImageUrl : '');
      const normalizedBubbles = asRecordArray(source.bubbles).map((bubble) => {
        const polygon = bubble.polygon as
          { points?: readonly { x: number; y: number }[] } | undefined;
        return {
          id: String(bubble.id ?? ''),
          polygon: (polygon?.points ?? []).map((point) => ({
            x: Number(point.x),
            y: Number(point.y),
          })),
        };
      });
      return {
        id: source.id || `page-${index + 1}`,
        imageUrl,
        width: source.width,
        height: source.height,
        startSeconds: source.startSeconds,
        endSeconds: source.endSeconds,
        ...(source.label ? { label: source.label } : {}),
        ...(source.cameraFocus ? { cameraFocus: source.cameraFocus } : {}),
        bubbles: normalizedBubbles,
      };
    });

    let cues = baseProps.cues;
    if (request.panelSequence && request.panelSequence.length > 0) {
      const expanded: PageInput[] = [];
      const stepsByPage = new Map<
        string,
        NonNullable<typeof request.panelSequence>
      >();
      for (const step of request.panelSequence) {
        const key = step.pageId ?? sourcePages[0]?.id ?? '';
        const list = stepsByPage.get(key) ?? [];
        stepsByPage.set(key, [...list, step]);
      }
      for (const page of pages) {
        const steps = stepsByPage.get(page.id);
        if (!steps || steps.length === 0) {
          expanded.push(page);
          continue;
        }
        const pageSpan = Math.max(1e-3, page.endSeconds - page.startSeconds);
        const sequence = buildPanelPageSequence({
          imageUrl: page.imageUrl,
          pageWidth: page.width,
          pageHeight: page.height,
          durationSeconds: pageSpan,
          steps: steps.map((step) => ({
            id: step.id,
            bounds: step.bounds,
            // Steps are page-local; allow global times by clamping to the page.
            startSeconds: Math.max(
              0,
              Math.min(step.startSeconds, pageSpan) -
                Math.max(0, page.startSeconds),
            ),
            endSeconds: Math.max(
              1e-3,
              Math.min(step.endSeconds, page.endSeconds) - page.startSeconds,
            ),
            ...(step.label ? { label: step.label } : {}),
            ...(step.bubbleIds ? { bubbleIds: step.bubbleIds } : {}),
          })),
          bubbles: page.bubbles,
          cues: cues.filter(
            (cue) =>
              cue.startSeconds >= page.startSeconds - 1e-3 &&
              cue.startSeconds < page.endSeconds,
          ),
        });
        for (const shot of sequence.pages) {
          expanded.push({
            ...shot,
            startSeconds: page.startSeconds + shot.startSeconds,
            endSeconds: Math.min(
              page.endSeconds,
              page.startSeconds + shot.endSeconds,
            ),
          });
        }
        const otherCues = cues.filter(
          (cue) =>
            cue.startSeconds < page.startSeconds ||
            cue.startSeconds >= page.endSeconds,
        );
        cues = [
          ...otherCues,
          ...sequence.cues.map((cue) => ({
            ...cue,
            startSeconds: page.startSeconds + cue.startSeconds,
            endSeconds: Math.min(
              page.endSeconds,
              page.startSeconds + cue.endSeconds,
            ),
          })),
        ];
      }
      return { ...baseProps, pages: expanded, cues };
    }

    return { ...baseProps, pages, cues };
  }

  if (request.panelSequence && request.panelSequence.length > 0) {
    const steps = request.panelSequence.map((step): PanelSequenceStep => ({
      id: step.id,
      bounds: step.bounds,
      startSeconds: step.startSeconds,
      endSeconds: step.endSeconds,
      ...(step.label ? { label: step.label } : {}),
      ...(step.bubbleIds ? { bubbleIds: step.bubbleIds } : {}),
    }));
    const sequence = buildPanelPageSequence({
      imageUrl: assetUrls.pageImageUrl,
      pageWidth: request.pageWidth,
      pageHeight: request.pageHeight,
      durationSeconds: request.durationSeconds,
      steps,
      bubbles: baseProps.pages[0]?.bubbles ?? [],
      cues: baseProps.cues,
    });
    return {
      ...baseProps,
      pages: sequence.pages,
      cues: sequence.cues,
    };
  }

  return baseProps;
}

function validationResultToError(report: ValidationResult): VideoExportError {
  return new VideoExportError(
    'VALIDATION_FAILED',
    `Export validation failed: ${report.issues
      .map((issue) => `${issue.path} (${issue.code}): ${issue.message}`)
      .join('; ')}`,
  );
}

async function probeOutput(filePath: string): Promise<{
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec: string;
  pixelFormat: string;
  bytes: number;
}> {
  const info = await stat(filePath).catch(() => null);
  if (!info || info.size <= 0) {
    throw new VideoExportError(
      'OUTPUT_INVALID',
      'Rendered MP4 is missing or empty.',
    );
  }
  const header = await readFile(filePath).then((bytes) =>
    bytes.subarray(0, 64),
  );
  const ftyp = String.fromCharCode(...header.subarray(4, 8));
  if (ftyp !== 'ftyp') {
    throw new VideoExportError(
      'OUTPUT_INVALID',
      'Rendered file is not an MP4 (missing ftyp box).',
    );
  }

  let durationSeconds = 0;
  let fps = 0;
  let width = 0;
  let height = 0;
  let hasAudio = false;
  let codec = 'h264';
  let pixelFormat = 'yuv420p';
  try {
    const metadata = await getVideoMetadata(filePath);
    durationSeconds = metadata.durationInSeconds ?? 0;
    fps = metadata.fps;
    width = metadata.width;
    height = metadata.height;
    codec = metadata.codec;
    pixelFormat = metadata.pixelFormat ?? pixelFormat;
    hasAudio = Boolean(metadata.audioCodec);
  } catch (error) {
    if (error instanceof VideoExportError) throw error;
    // Metadata probe may be unavailable; MP4 signature + size still checked.
  }

  return {
    durationSeconds,
    fps,
    width,
    height,
    hasAudio,
    codec,
    pixelFormat,
    bytes: info.size,
  };
}

function updateJob(
  id: string,
  patch: Partial<Omit<InternalJob, 'id' | 'createdAt' | 'abort'>>,
): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

function snapshot(job: InternalJob): VideoExportJob {
  return Object.freeze({
    id: job.id,
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    progress: job.progress,
    frame: job.frame,
    ...(job.error ? { error: { ...job.error } } : {}),
    ...(job.output ? { output: { ...job.output } } : {}),
  });
}

async function cleanupJobFiles(job: InternalJob): Promise<void> {
  const workDir = job.workDir;
  if (workDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    job.workDir = undefined;
  }
  await rm(publicJob(job.id), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

async function processQueue(): Promise<void> {
  while (activeRenders < maxConcurrentJobs() && queue.length > 0) {
    const jobId = queue.shift();
    if (!jobId) break;
    const job = jobs.get(jobId);
    if (!job || job.status === 'cancelled') continue;
    activeRenders += 1;
    void runJob(job)
      .catch(() => undefined)
      .finally(() => {
        activeRenders -= 1;
        void processQueue();
      });
  }
}

async function runJob(job: InternalJob): Promise<void> {
  const request = job.request;
  try {
    updateJob(job.id, { status: 'preparing', progress: 2 });
    await ensureBrowser();
    const size = resolveDimensions(request);
    const sourcePages = request.sourcePages ?? [];
    const primaryImage =
      request.pageImage ||
      sourcePages.find((page) => typeof page.image === 'string' && page.image)
        ?.image ||
      '';
    const pageBytes = decodeBase64Bytes(primaryImage, 'pageImage');
    const audioBytes = request.audio
      ? decodeBase64Bytes(request.audio, 'audio')
      : null;

    const workDir = await mkdtemp(join(tmpdir(), 'comic-video-export-'));
    job.workDir = workDir;
    // Data URLs keep assets inside the job payload so the webpack publicDir
    // snapshot does not need to be rebuilt for every export.
    const pageImageUrl = toDataUrl(pageBytes, imageMimeFromBytes(pageBytes));
    const audioUrl = audioBytes
      ? toDataUrl(audioBytes, audioMimeFromFormat(request.audioFormat))
      : '';
    const sourcePageUrls: Record<string, string> = {};
    for (const page of sourcePages) {
      if (!page?.image) continue;
      const bytes = decodeBase64Bytes(
        page.image,
        `sourcePages[${page.id}].image`,
      );
      sourcePageUrls[page.id] = toDataUrl(bytes, imageMimeFromBytes(bytes));
    }

    const props = toCompositionProps(
      {
        ...request,
        width: size.width,
        height: size.height,
        fps: request.fps ?? DEFAULT_FPS,
      },
      {
        pageImageUrl,
        audioUrl,
        sourcePageUrls,
      },
      size,
    );

    const report = validateVideoComposition(props);
    if (!report.valid) throw validationResultToError(report);
    try {
      assertValidVideoComposition(props);
    } catch (error) {
      if (error instanceof VideoCompositionError) {
        throw new VideoExportError('VALIDATION_FAILED', error.message);
      }
      throw error;
    }

    updateJob(job.id, { status: 'rendering', progress: 5, frame: 0 });
    const serveUrl = await getBundle();
    const composition = await selectComposition({
      serveUrl,
      id: MOTION_COMIC_COMPOSITION_ID,
      inputProps: props as unknown as Record<string, unknown>,
    });

    const outputPath = join(workDir, 'video.mp4');
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      outputLocation: outputPath,
      inputProps: props as unknown as Record<string, unknown>,
      // Keep memory bounded on small development machines.
      concurrency: renderConcurrency(),
      timeoutInMilliseconds: 120_000,
      cancelSignal: job.cancelSignal,
      chromiumOptions: {
        // Headless shell is faster for CPU-bound render and is the default.
        gl: 'swangle',
      },
      onProgress: ({ progress, renderedFrames }) => {
        updateJob(job.id, {
          progress: Math.min(95, 5 + progress * 90),
          frame: renderedFrames,
        });
      },
    });

    updateJob(job.id, { status: 'validating', progress: 96 });
    const probed = await probeOutput(outputPath);
    if (request.audio && !probed.hasAudio) {
      throw new VideoExportError(
        'OUTPUT_INVALID',
        'Rendered MP4 is missing the narration audio stream.',
      );
    }
    if (probed.durationSeconds > 0) {
      const expected = request.durationSeconds;
      const drift = Math.abs(probed.durationSeconds - expected);
      if (drift > Math.max(0.25, expected * 0.1)) {
        throw new VideoExportError(
          'OUTPUT_INVALID',
          `Rendered duration ${probed.durationSeconds.toFixed(2)}s does not match requested ${expected.toFixed(2)}s.`,
        );
      }
    }
    if (probed.width && probed.width !== size.width) {
      throw new VideoExportError(
        'OUTPUT_INVALID',
        `Rendered width ${probed.width}px does not match requested ${size.width}px.`,
      );
    }

    await mkdir(exportJobDir(job.id), { recursive: true });
    const finalPath = join(exportJobDir(job.id), 'video.mp4');
    await writeFile(finalPath, await readFile(outputPath));

    updateJob(job.id, {
      status: 'succeeded',
      progress: 100,
      output: {
        fileName: 'video.mp4',
        bytes: probed.bytes,
        durationSeconds: probed.durationSeconds || request.durationSeconds,
        fps: probed.fps || request.fps || DEFAULT_FPS,
        width: probed.width || size.width,
        height: probed.height || size.height,
        hasAudio: probed.hasAudio,
        codec: probed.codec,
        pixelFormat: probed.pixelFormat,
        path: finalPath,
      },
    });
    await cleanupJobFiles(job);
  } catch (error) {
    if (job.status === 'cancelled' || job.status === undefined) {
      // already marked cancelled
    } else if (error instanceof Error && /cancel/i.test(error.message)) {
      updateJob(job.id, {
        status: 'cancelled',
        error: { code: 'ABORTED', message: 'Export was cancelled.' },
      });
    } else if (error instanceof VideoExportError) {
      updateJob(job.id, {
        status: 'failed',
        error: { code: error.code, message: error.message },
      });
    } else {
      updateJob(job.id, {
        status: 'failed',
        error: {
          code: 'RENDER_FAILED',
          message:
            error instanceof Error ? error.message : 'Video export failed.',
        },
      });
    }
    await cleanupJobFiles(job);
  }
}

function preflightRequest(request: VideoExportRequest): void {
  const sourcePages = request.sourcePages ?? [];
  const hasSourcePages = sourcePages.length > 0;
  const hasPageImage =
    typeof request.pageImage === 'string' &&
    request.pageImage.trim().length > 0;
  if (!hasPageImage && !hasSourcePages) {
    throw new VideoExportError(
      'INVALID_INPUT',
      'Provide pageImage or sourcePages (non-empty base64 image data).',
    );
  }
  if (
    typeof request.durationSeconds !== 'number' ||
    !Number.isFinite(request.durationSeconds) ||
    request.durationSeconds <= 0 ||
    request.durationSeconds > 30 * 60
  ) {
    throw new VideoExportError(
      'INVALID_INPUT',
      'durationSeconds must be between 0 and 1800.',
    );
  }
  if (request.audio != null && typeof request.audio !== 'string') {
    throw new VideoExportError(
      'INVALID_INPUT',
      'audio must be base64-encoded.',
    );
  }
  if (
    typeof request.pageWidth !== 'number' ||
    typeof request.pageHeight !== 'number' ||
    request.pageWidth <= 0 ||
    request.pageHeight <= 0
  ) {
    throw new VideoExportError(
      'INVALID_INPUT',
      'pageWidth and pageHeight must be positive numbers.',
    );
  }
  const fps = request.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 60) {
    throw new VideoExportError(
      'INVALID_INPUT',
      'fps must be between 0 and 60.',
    );
  }
  // Size is validated before any render work starts.
  resolveDimensions(request);

  // Reuse composition validation on a dry-run payload so missing bubble
  // mappings, bad coordinates, and malformed timestamps fail at create time.
  try {
    if (hasPageImage) decodeBase64Bytes(request.pageImage, 'pageImage');
    if (request.audio) decodeBase64Bytes(request.audio, 'audio');
    if (hasSourcePages) {
      if (sourcePages.length > 40) {
        throw new VideoExportError(
          'INVALID_INPUT',
          'sourcePages supports at most 40 pages per job.',
        );
      }
      for (const [index, page] of sourcePages.entries()) {
        if (
          !page ||
          typeof page.id !== 'string' ||
          typeof page.image !== 'string' ||
          !Number.isFinite(page.width) ||
          !Number.isFinite(page.height) ||
          page.width <= 0 ||
          page.height <= 0 ||
          !Number.isFinite(page.startSeconds) ||
          !Number.isFinite(page.endSeconds) ||
          page.startSeconds < 0 ||
          page.endSeconds <= page.startSeconds
        ) {
          throw new VideoExportError(
            'INVALID_INPUT',
            `sourcePages[${index}] must include id, image, positive dimensions, and 0 <= startSeconds < endSeconds.`,
          );
        }
        if (page.endSeconds > request.durationSeconds + 1e-3) {
          throw new VideoExportError(
            'INVALID_INPUT',
            `sourcePages[${index}] ends after durationSeconds.`,
          );
        }
        decodeBase64Bytes(page.image, `sourcePages[${index}].image`);
      }
    }
  } catch (error) {
    if (error instanceof VideoExportError) throw error;
    throw new VideoExportError(
      'INVALID_INPUT',
      'Asset bytes could not be decoded.',
    );
  }

  const size = resolveDimensions(request);
  if (request.panelSequence) {
    if (
      !Array.isArray(request.panelSequence) ||
      request.panelSequence.length === 0
    ) {
      throw new VideoExportError(
        'INVALID_INPUT',
        'panelSequence must be a non-empty array when provided.',
      );
    }
    for (const [index, step] of request.panelSequence.entries()) {
      if (
        !step ||
        typeof step.id !== 'string' ||
        !Number.isFinite(step.startSeconds) ||
        !Number.isFinite(step.endSeconds) ||
        step.startSeconds < 0 ||
        step.endSeconds <= step.startSeconds
      ) {
        throw new VideoExportError(
          'INVALID_INPUT',
          `panelSequence[${index}] must include id and 0 <= startSeconds < endSeconds.`,
        );
      }
      if (step.endSeconds > request.durationSeconds + 1e-3) {
        throw new VideoExportError(
          'INVALID_INPUT',
          `panelSequence[${index}] ends after durationSeconds.`,
        );
      }
      if (
        !step.bounds ||
        !Number.isFinite(step.bounds.x) ||
        !Number.isFinite(step.bounds.y) ||
        !Number.isFinite(step.bounds.width) ||
        !Number.isFinite(step.bounds.height) ||
        step.bounds.width <= 0 ||
        step.bounds.height <= 0
      ) {
        throw new VideoExportError(
          'INVALID_INPUT',
          `panelSequence[${index}].bounds must be a positive finite rect.`,
        );
      }
    }
  }
  const props = toCompositionProps(
    {
      ...request,
      width: size.width,
      height: size.height,
      fps,
    },
    {
      pageImageUrl: 'jobs/preflight/page.png',
      audioUrl: 'jobs/preflight/audio.wav',
      sourcePageUrls: Object.fromEntries(
        sourcePages.map((page) => [page.id, `jobs/preflight/${page.id}.png`]),
      ),
    },
    size,
  );
  const report = validateVideoComposition(props);
  if (!report.valid) throw validationResultToError(report);
}

/**
 * Create an explicit Remotion export job. Does not render synchronously; the
 * job is queued so ordinary UI interactions never trigger a browser render.
 * Inputs are validated before the job is accepted.
 */
export async function createVideoExportJob(
  request: VideoExportRequest,
): Promise<VideoExportJob> {
  if (!request || typeof request !== 'object') {
    throw new VideoExportError('INVALID_INPUT', 'Export request is required.');
  }
  preflightRequest(request);

  const id = randomUUID();
  const { cancelSignal, cancel } = makeCancelSignal();
  const job: InternalJob = {
    id,
    jobId: id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    progress: 0,
    frame: 0,
    cancelSignal,
    cancel,
    request,
  };
  jobs.set(id, job);
  queue.push(id);
  void processQueue();
  return snapshot(job);
}

export function getVideoExportJob(id: string): VideoExportJob {
  const job = jobs.get(id);
  if (!job) {
    throw new VideoExportError('NOT_FOUND', `Export job ${id} was not found.`);
  }
  return snapshot(job);
}

export function listVideoExportJobs(): VideoExportJob[] {
  return [...jobs.values()].map(snapshot);
}

export function cancelVideoExportJob(id: string): VideoExportJob {
  const job = jobs.get(id);
  if (!job) {
    throw new VideoExportError('NOT_FOUND', `Export job ${id} was not found.`);
  }
  if (
    job.status === 'succeeded' ||
    job.status === 'failed' ||
    job.status === 'cancelled'
  ) {
    return snapshot(job);
  }
  job.cancel();
  updateJob(job.id, {
    status: 'cancelled',
    error: { code: 'ABORTED', message: 'Export was cancelled.' },
  });
  void cleanupJobFiles(job);
  return snapshot(job);
}

export async function readVideoExportArtifact(
  id: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  const job = jobs.get(id);
  if (!job) {
    throw new VideoExportError('NOT_FOUND', `Export job ${id} was not found.`);
  }
  if (job.status !== 'succeeded' || !job.output) {
    throw new VideoExportError(
      'NOT_FOUND',
      `Export job ${id} has no downloadable artifact (status=${job.status}).`,
    );
  }
  const bytes = await readFile(job.output.path).catch(() => null);
  if (!bytes) {
    throw new VideoExportError(
      'NOT_FOUND',
      `Export job ${id} artifact is missing on disk.`,
    );
  }
  return { bytes, fileName: job.output.fileName };
}

export async function checkVideoExportAvailability(): Promise<{
  browserReady: boolean;
  compositionEntry: string;
  maxConcurrentJobs: number;
  renderConcurrency: number;
  licenseNote: string;
}> {
  return {
    browserReady: true,
    compositionEntry: COMPOSITION_ENTRY,
    maxConcurrentJobs: maxConcurrentJobs(),
    renderConcurrency: renderConcurrency(),
    licenseNote:
      'Remotion free license covers individuals and for-profit orgs up to 3 employees. Company License required for larger orgs and for hosted automated video-generation products (see https://www.remotion.dev/docs/license).',
  };
}

// Internal helper for tests.
export function __testing__resetJobs(): void {
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
  queue.length = 0;
  activeRenders = 0;
  bundlePromise = null;
}
