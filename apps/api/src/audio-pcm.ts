import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFfmpegAvailability } from './export.js';

export class AudioPcmError extends Error {
  constructor(
    readonly code: 'FFMPEG_MISSING' | 'DECODE_FAILED' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'AudioPcmError';
  }
}

export interface DecodedPcm {
  readonly pcm: Float32Array;
  readonly sampleRateHz: number;
  readonly durationSeconds: number;
  readonly channelCount: number;
}

/**
 * Decode compressed audio to mono Float32 PCM using FFmpeg.
 * wav2vec2 expects 16 kHz mono; we decode at `sampleRateHz` (default 16000).
 */
export async function decodeAudioToPcm(
  audioBytes: Uint8Array,
  options: {
    readonly sampleRateHz?: number;
    readonly fileName?: string;
  } = {},
): Promise<DecodedPcm> {
  if (!audioBytes || audioBytes.byteLength === 0) {
    throw new AudioPcmError('INVALID_INPUT', 'Audio bytes are required.');
  }
  const sampleRateHz = options.sampleRateHz ?? 16_000;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new AudioPcmError(
      'INVALID_INPUT',
      'sampleRateHz must be a positive finite number.',
    );
  }
  const availability = await checkFfmpegAvailability();
  if (!availability.available || !availability.path) {
    throw new AudioPcmError(
      'FFMPEG_MISSING',
      `FFmpeg is required to decode audio for forced alignment. ${availability.installHint}`,
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), 'comic-captioner-pcm-'));
  const inputName = options.fileName?.replace(/[^\w.-]/g, '_') || 'audio.bin';
  const inputPath = join(workDir, inputName);
  const outputPath = join(workDir, 'audio.f32le');
  try {
    await writeFile(inputPath, audioBytes);
    await runFfmpeg(availability.path, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      String(sampleRateHz),
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      outputPath,
    ]);
    const raw = await readFile(outputPath);
    const pcm = new Float32Array(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    );
    if (pcm.length === 0) {
      throw new AudioPcmError(
        'DECODE_FAILED',
        'FFmpeg produced no PCM samples from the audio file.',
      );
    }
    return {
      pcm,
      sampleRateHz,
      durationSeconds: pcm.length / sampleRateHz,
      channelCount: 1,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new AudioPcmError(
            'FFMPEG_MISSING',
            'FFmpeg is not installed or not on PATH.',
          ),
        );
        return;
      }
      reject(new AudioPcmError('DECODE_FAILED', error.message));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new AudioPcmError(
            'DECODE_FAILED',
            `FFmpeg PCM decode failed (exit ${code}): ${stderr.slice(0, 300)}`,
          ),
        );
    });
  });
}
