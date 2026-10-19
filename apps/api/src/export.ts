import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import {
  ExportValidationError,
  renderFrameSequence,
} from '@comic-captioner/rendering';
import type {
  ExportBubble,
  ExportCaption,
} from '@comic-captioner/rendering';

export class FfmpegExportError extends Error {
  constructor(
    readonly code:
      | 'FFMPEG_MISSING'
      | 'INVALID_INPUT'
      | 'ENCODE_FAILED'
      | 'ABORTED',
    message: string,
  ) {
    super(message);
    this.name = 'FfmpegExportError';
  }
}

export interface FfmpegExportInput {
  /** PNG/JPEG frame bytes in playback order. */
  readonly frames: readonly Uint8Array[];
  /** Optional audio bytes (wav/m4a/mp3) muxed into the output. */
  readonly audio?: Uint8Array;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly audioFileName?: string;
  readonly signal?: AbortSignal;
}

export interface FfmpegExportResult {
  readonly bytes: Buffer;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly fps: number;
  readonly codec: 'h264';
}

export interface FfmpegStreamExportInput {
  /** PNG/JPEG frame bytes in playback order, produced lazily. */
  readonly frames: AsyncIterable<Uint8Array>;
  /** Optional hard cap on streamed frames; the stream stops at the cap. */
  readonly maxFrames?: number;
  /** Optional audio bytes (wav/m4a/mp3) muxed into the output. */
  readonly audio?: Uint8Array;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly audioFileName?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface FfmpegAvailability {
  readonly available: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly installHint: string;
}

const INSTALL_HINT =
  'Install FFmpeg (https://ffmpeg.org/download.html) and ensure it is on PATH. On macOS: brew install ffmpeg. On Debian/Ubuntu: apt-get install ffmpeg.';

/** Probe whether the ffmpeg binary is available. */
export async function checkFfmpegAvailability(): Promise<FfmpegAvailability> {
  const path = await whichFfmpeg();
  if (!path) {
    return Object.freeze({
      available: false,
      path: null,
      version: null,
      installHint: INSTALL_HINT,
    });
  }
  const version = await captureFfmpegVersion(path);
  return Object.freeze({
    available: true,
    path,
    version,
    installHint: INSTALL_HINT,
  });
}

/**
 * Stream frames straight into FFmpeg's stdin (`-f image2pipe`) and encode an
 * H.264 MP4, optionally muxing audio. Faster than realtime and frame-exact —
 * replaces browser captureStream.
 *
 * Frames are never materialized in RAM or on disk: at most a couple are in
 * flight at once (stdin backpressure), so long exports stay flat in memory
 * instead of accumulating every frame twice (RAM array + on-disk PNGs).
 * Only the output MP4 and a single audio file touch disk.
 *
 * Never pretends to succeed: missing FFmpeg is a typed FFMPEG_MISSING error.
 */
export async function exportMp4StreamingWithFfmpeg(
  input: FfmpegStreamExportInput,
): Promise<FfmpegExportResult> {
  validateStreamInput(input);
  if (input.signal?.aborted) {
    throw new FfmpegExportError('ABORTED', 'Export was cancelled.');
  }
  const availability = await checkFfmpegAvailability();
  if (!availability.available || !availability.path) {
    throw new FfmpegExportError(
      'FFMPEG_MISSING',
      `FFmpeg is not installed or not on PATH. ${INSTALL_HINT}`,
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), 'comic-captioner-export-'));
  try {
    const audioPath = input.audio
      ? join(workDir, input.audioFileName ?? 'audio.wav')
      : null;
    if (input.audio && audioPath) {
      await writeFile(audioPath, input.audio);
    }

    const outputPath = join(workDir, 'output.mp4');
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(input.fps),
      '-i',
      '-',
      ...(audioPath ? ['-i', audioPath] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-r',
      String(input.fps),
      ...(audioPath
        ? ['-c:a', 'aac', '-b:a', '192k', '-shortest']
        : ['-an']),
      '-movflags',
      '+faststart',
      outputPath,
    ];

    const frameCount = await streamFramesToFfmpeg(availability.path, args, input);
    const bytes = await readFile(outputPath);
    return Object.freeze({
      bytes,
      durationSeconds: frameCount / input.fps,
      frameCount,
      fps: input.fps,
      codec: 'h264' as const,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Encode a deterministic frame sequence into H.264 MP4, optionally muxing
 * audio. Faster than realtime and frame-exact — replaces browser captureStream.
 *
 * Never pretends to succeed: missing FFmpeg is a typed FFMPEG_MISSING error.
 */
export async function exportMp4WithFfmpeg(
  input: FfmpegExportInput,
): Promise<FfmpegExportResult> {
  validateInput(input);
  const frames = input.frames;
  return exportMp4StreamingWithFfmpeg({
    frames: (async function* () {
      for (const frame of frames) yield frame;
    })(),
    maxFrames: frames.length,
    fps: input.fps,
    width: input.width,
    height: input.height,
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioFileName ? { audioFileName: input.audioFileName } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * Render frames then encode server-side. Frame production is injected so the
 * compositor stays deterministic and testable without FFmpeg.
 */
export async function exportVideoWithRenderedFrames(
  input: Omit<FfmpegExportInput, 'frames'> & {
    readonly frameCount: number;
    readonly renderFrame: (index: number) => Promise<Uint8Array>;
    readonly onProgress?: (done: number, total: number) => void;
  },
): Promise<FfmpegExportResult> {
  if (
    !Number.isInteger(input.frameCount) ||
    input.frameCount <= 0 ||
    input.frameCount > 100_000
  ) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'frameCount must be an integer between 1 and 100000.',
    );
  }
  const frameCount = input.frameCount;
  const renderFrame = input.renderFrame;
  return exportMp4StreamingWithFfmpeg({
    frames: (async function* () {
      for (let index = 0; index < frameCount; index += 1) {
        if (input.signal?.aborted) {
          throw new FfmpegExportError('ABORTED', 'Export was cancelled.');
        }
        yield await renderFrame(index);
      }
    })(),
    maxFrames: frameCount,
    fps: input.fps,
    width: input.width,
    height: input.height,
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioFileName ? { audioFileName: input.audioFileName } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
}

function validateInput(input: FfmpegExportInput): void {
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'At least one frame is required for MP4 export.',
    );
  }
  validateStreamInput(input);
}

function validateStreamInput(input: {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}): void {
  if (!Number.isFinite(input.fps) || input.fps <= 0 || input.fps > 240) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'fps must be a finite number between 0 and 240.',
    );
  }
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 16 ||
    input.height < 16 ||
    input.width > 7680 ||
    input.height > 7680
  ) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'Export dimensions must be even-friendly whole numbers between 16 and 7680 pixels.',
    );
  }
}

async function whichFfmpeg(): Promise<string | null> {
  const homeBin =
    process.env.HOME != null
      ? [join(process.env.HOME, '.local', 'bin', 'ffmpeg')]
      : [];
  const candidates =
    process.platform === 'win32'
      ? ['ffmpeg.exe', 'ffmpeg']
      : [
          ...homeBin,
          '/opt/homebrew/bin/ffmpeg',
          '/usr/local/bin/ffmpeg',
          '/usr/bin/ffmpeg',
          'ffmpeg',
        ];
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/') || candidate.includes('\\')) {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // keep looking
    }
  }
  // Fall back to PATH lookup via `ffmpeg -version`.
  try {
    await runCapture('ffmpeg', ['-version']);
    return 'ffmpeg';
  } catch {
    return null;
  }
}

async function captureFfmpegVersion(ffmpegPath: string): Promise<string | null> {
  try {
    const { stdout } = await runCapture(ffmpegPath, ['-version']);
    return stdout.split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Spawn FFmpeg and stream frames into its stdin with backpressure. Resolves
 * with the number of frames written. Abort kills the child and rejects
 * ABORTED; stdin stream errors are swallowed so the child's exit code
 * reports the authoritative failure.
 */
function streamFramesToFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  input: FfmpegStreamExportInput,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ffmpegPath, [...args], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let frameCount = 0;
    let settled = false;
    const settleResolve = (count: number) => {
      if (settled) return;
      settled = true;
      resolvePromise(count);
    };
    const settleReject = (error: FfmpegExportError) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    // EPIPE surfaces when the child dies mid-stream; the close handler
    // reports the real failure, so keep stdin errors from crashing the process.
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const onAbort = () => {
      child.kill('SIGTERM');
      settleReject(new FfmpegExportError('ABORTED', 'Export was cancelled.'));
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      input.signal?.removeEventListener('abort', onAbort);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        settleReject(
          new FfmpegExportError(
            'FFMPEG_MISSING',
            `FFmpeg is not installed or not on PATH. ${INSTALL_HINT}`,
          ),
        );
        return;
      }
      settleReject(new FfmpegExportError('ENCODE_FAILED', error.message));
    });
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      if (code === 0) settleResolve(frameCount);
      else
        settleReject(
          new FfmpegExportError(
            'ENCODE_FAILED',
            `FFmpeg exited with code ${code}: ${stderr.slice(0, 400)}`,
          ),
        );
    });

    void (async () => {
      const total = input.maxFrames ?? 0;
      try {
        for await (const frame of input.frames) {
          if (input.signal?.aborted) {
            child.kill('SIGTERM');
            settleReject(new FfmpegExportError('ABORTED', 'Export was cancelled.'));
            return;
          }
          if (input.maxFrames != null && frameCount >= input.maxFrames) break;
          const drained = child.stdin.write(frame);
          frameCount += 1;
          input.onProgress?.(frameCount, total > 0 ? total : frameCount);
          if (!drained) {
            await new Promise<void>((resolveDrain) =>
              child.stdin.once('drain', resolveDrain),
            );
          }
        }
        child.stdin.end();
      } catch (error) {
        child.kill('SIGTERM');
        settleReject(
          error instanceof FfmpegExportError
            ? error
            : new FfmpegExportError(
                'ENCODE_FAILED',
                error instanceof Error ? error.message : 'Frame rendering failed.',
              ),
        );
      }
    })();
  });
}

function runCapture(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr || `Command failed: ${command}`));
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP request handler for server-side deterministic export
// ---------------------------------------------------------------------------

export interface ExportRequestBody {
  readonly pageImage: string;
  readonly audio?: string;
  readonly audioFormat?: string;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly resolution: {
    readonly resolution: '720p' | '1080p' | 'custom';
    readonly width?: number;
    readonly height?: number;
  };
  readonly captions: readonly unknown[];
  readonly bubbles: readonly unknown[];
}

export interface ExportJobResult {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly frameCount: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly codec: 'h264';
}


const DEFAULT_EXPORT_FPS = 24;

/**
 * Parse and run one export job: render deterministic frames from the page
 * image + fitted captions, then encode with FFmpeg. Never emits a bottom
 * subtitle track. Missing FFmpeg is a typed FFMPEG_MISSING failure so the
 * client can fall back to browser captureStream.
 */
export async function runExportJob(
  body: ExportRequestBody,
  signal?: AbortSignal,
): Promise<ExportJobResult> {
  const pageImage = decodeBase64Bytes(body.pageImage, 'pageImage');
  const audio = body.audio ? decodeBase64Bytes(body.audio, 'audio') : undefined;
  const fps = body.fps ?? DEFAULT_EXPORT_FPS;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 60) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'fps must be between 0 and 60 for server export.',
    );
  }
  if (
    !Number.isFinite(body.durationSeconds) ||
    body.durationSeconds <= 0 ||
    body.durationSeconds > 30 * 60
  ) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'durationSeconds must be between 0 and 1800.',
    );
  }
  const resolution = body.resolution ?? { resolution: '720p' as const };
  const { width, height } = resolveExportDimensions(resolution);

  const captions = body.captions as readonly ExportCaption[];
  const bubbles = body.bubbles as readonly ExportBubble[];

  // Frames stream straight from the renderer into FFmpeg's stdin; nothing is
  // accumulated in RAM or on disk beyond the encoder's bounded write window.
  const frames = (async function* () {
    try {
      for await (const frame of renderFrameSequence(
        {
          pageImage,
          captions,
          bubbles,
          width,
          height,
        },
        fps,
        body.durationSeconds,
      )) {
        if (signal?.aborted) {
          throw new FfmpegExportError('ABORTED', 'Export was cancelled.');
        }
        yield new Uint8Array(frame.png);
      }
    } catch (error) {
      if (error instanceof ExportValidationError) {
        throw new FfmpegExportError(
          'INVALID_INPUT',
          `Export validation failed: ${error.report.issues
            .map((issue) => `${issue.captionId}: ${issue.code}`)
            .join(', ')}`,
        );
      }
      throw error;
    }
  })();

  const result = await exportMp4StreamingWithFfmpeg({
    frames,
    ...(audio ? { audio, audioFileName: `audio.${sanitizeAudioFormat(body.audioFormat)}` } : {}),
    fps,
    width,
    height,
    ...(signal ? { signal } : {}),
  });

  return Object.freeze({
    ok: true as const,
    bytes: result.bytes,
    frameCount: result.frameCount,
    fps: result.fps,
    durationSeconds: result.durationSeconds,
    codec: result.codec,
  });
}

function resolveExportDimensions(options: {
  readonly resolution: '720p' | '1080p' | 'custom';
  readonly width?: number;
  readonly height?: number;
}): { width: number; height: number } {
  if (options.resolution === '720p') return { width: 1280, height: 720 };
  if (options.resolution === '1080p') return { width: 1920, height: 1080 };
  const width = Number(options.width);
  const height = Number(options.height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 7680 ||
    height > 7680
  ) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'Custom export dimensions must be whole numbers between 16 and 7680 pixels.',
    );
  }
  return {
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
  };
}

function decodeBase64Bytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      `${label} must be base64-encoded bytes.`,
    );
  }
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(normalized, 'base64');
  } catch {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      `${label} is not valid base64.`,
    );
  }
  if (buffer.byteLength === 0) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      `${label} decoded to zero bytes.`,
    );
  }
  return new Uint8Array(buffer);
}

function sanitizeAudioFormat(format: unknown): string {
  if (typeof format !== 'string') return 'wav';
  const cleaned = format.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.slice(0, 8) || 'wav';
}
