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
 * Encode a deterministic frame sequence into H.264 MP4, optionally muxing
 * audio. Faster than realtime and frame-exact — replaces browser captureStream.
 *
 * Never pretends to succeed: missing FFmpeg is a typed FFMPEG_MISSING error.
 */
export async function exportMp4WithFfmpeg(
  input: FfmpegExportInput,
): Promise<FfmpegExportResult> {
  validateInput(input);
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
    const framePattern = join(workDir, 'frame-%06d.png');
    for (const [index, frame] of input.frames.entries()) {
      await writeFile(join(workDir, `frame-${String(index).padStart(6, '0')}.png`), frame);
    }

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
      '-framerate',
      String(input.fps),
      '-i',
      framePattern,
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

    await runFfmpeg(availability.path, args, input.signal);
    const bytes = await readFile(outputPath);
    const durationSeconds = input.frames.length / input.fps;
    return Object.freeze({
      bytes,
      durationSeconds,
      frameCount: input.frames.length,
      fps: input.fps,
      codec: 'h264' as const,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
  const frames: Uint8Array[] = [];
  for (let index = 0; index < input.frameCount; index += 1) {
    if (input.signal?.aborted) {
      throw new FfmpegExportError('ABORTED', 'Export was cancelled.');
    }
    frames.push(await input.renderFrame(index));
    input.onProgress?.(index + 1, input.frameCount);
  }
  return exportMp4WithFfmpeg({ ...input, frames });
}

function validateInput(input: FfmpegExportInput): void {
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new FfmpegExportError(
      'INVALID_INPUT',
      'At least one frame is required for MP4 export.',
    );
  }
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

function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new FfmpegExportError('ABORTED', 'Export was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new FfmpegExportError(
            'FFMPEG_MISSING',
            `FFmpeg is not installed or not on PATH. ${INSTALL_HINT}`,
          ),
        );
        return;
      }
      reject(
        new FfmpegExportError('ENCODE_FAILED', error.message),
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else
        reject(
          new FfmpegExportError(
            'ENCODE_FAILED',
            `FFmpeg exited with code ${code}: ${stderr.slice(0, 400)}`,
          ),
        );
    });
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

  const frames: Uint8Array[] = [];
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
      frames.push(new Uint8Array(frame.png));
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

  const result = await exportMp4WithFfmpeg({
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
