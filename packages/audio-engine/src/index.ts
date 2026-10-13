import type { AudioTime, AudioTimebase } from '@comic-captioner/shared';
import type { AudioAssetRef } from '@comic-captioner/core';
export {
  MockTranscriptionProvider,
  TranscriptionError,
  TranscriptionService,
} from './transcription.js';
export type {
  ProviderTranscriptOutput,
  ProviderWordTimestamp,
  Transcript,
  TranscriptSegment,
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionServiceOptions,
  WordTimestamp,
} from './transcription.js';

export const SUPPORTED_AUDIO_FORMATS = [
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'webm',
] as const;
export type AudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number];
export type AudioPlaybackStatus = 'empty' | 'ready' | 'playing' | 'paused';

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 2 * 60 * 60;
const DEFAULT_WAVEFORM_BINS = 1200;

export interface AudioAssetMetadata {
  readonly id: string;
  readonly filename: string;
  readonly format: AudioFormat;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly durationSeconds: number;
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly frameCount: number;
  readonly timebase: AudioTimebase;
}

export function toAudioAssetRef(metadata: AudioAssetMetadata): AudioAssetRef {
  return Object.freeze({
    id: metadata.id as AudioAssetRef['id'],
    filename: metadata.filename,
    mediaType: metadata.mediaType,
    contentHash: metadata.sha256,
    sizeBytes: metadata.sizeBytes,
    durationSeconds: metadata.durationSeconds,
    sampleRateHz: metadata.sampleRateHz,
    channelCount: metadata.channelCount,
    timebase: metadata.timebase,
  });
}

/** Immutable imported audio bytes with copy-on-read access. */
export class ImmutableAudioAsset {
  readonly metadata: AudioAssetMetadata;
  readonly #bytes: Uint8Array;

  constructor(metadata: AudioAssetMetadata, bytes: Uint8Array) {
    this.metadata = Object.freeze({
      ...metadata,
      timebase: Object.freeze({ ...metadata.timebase }),
    });
    this.#bytes = Uint8Array.from(bytes);
    Object.freeze(this);
  }

  getBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

export interface Waveform {
  readonly bins: Float32Array;
  readonly durationSeconds: number;
}

export interface AudioImportResult {
  readonly asset: ImmutableAudioAsset;
  readonly waveform: Waveform;
}

export class AudioImportError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_FILE'
      | 'FILE_TOO_LARGE'
      | 'UNSUPPORTED_FORMAT'
      | 'CORRUPT_AUDIO'
      | 'AUDIO_TOO_LONG',
    message: string,
  ) {
    super(message);
    this.name = 'AudioImportError';
  }
}

export interface ClockSnapshot {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly playbackRate: number;
  readonly status: AudioPlaybackStatus;
}

export interface ClockOptions {
  readonly now?: () => number;
  readonly setInterval?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

/** Monotonic audio-time clock. UI subscribers observe it; they do not drive it. */
export class ApplicationAudioClock {
  readonly #now: () => number;
  readonly #schedule: NonNullable<ClockOptions['setInterval']>;
  readonly #cancel: NonNullable<ClockOptions['clearInterval']>;
  readonly #listeners = new Set<() => void>();
  #duration = 0;
  #position = 0;
  #rate = 1;
  #startedAt = 0;
  #status: AudioPlaybackStatus = 'empty';
  #timer: ReturnType<typeof setInterval> | null = null;
  #snapshot: ClockSnapshot = Object.freeze({
    positionSeconds: 0,
    durationSeconds: 0,
    playbackRate: 1,
    status: 'empty',
  });

  constructor(options: ClockOptions = {}) {
    this.#now = options.now ?? (() => performance.now() / 1000);
    this.#schedule =
      options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.#cancel = options.clearInterval ?? ((timer) => clearInterval(timer));
  }

  getSnapshot = (): ClockSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setDuration(durationSeconds: number): void {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
      throw new RangeError('Duration must be positive and finite.');
    this.pause();
    this.#duration = durationSeconds;
    this.#position = 0;
    this.#status = 'ready';
    this.#emit();
  }

  play(): void {
    if (this.#duration <= 0 || this.#status === 'empty') return;
    if (this.#currentPosition() >= this.#duration) this.#position = 0;
    this.#startedAt = this.#now();
    this.#status = 'playing';
    if (this.#timer === null)
      this.#timer = this.#schedule(() => this.#tick(), 16);
    this.#emit();
  }

  pause(): void {
    if (this.#status !== 'playing') return;
    this.#position = this.#currentPosition();
    this.#status = 'paused';
    this.#stopTimer();
    this.#emit();
  }

  seek(positionSeconds: number): void {
    if (!Number.isFinite(positionSeconds))
      throw new RangeError('Seek position must be finite.');
    const wasPlaying = this.#status === 'playing';
    this.#position = clamp(positionSeconds, 0, this.#duration);
    if (wasPlaying && this.#position < this.#duration) {
      this.#startedAt = this.#now();
    } else if (this.#position >= this.#duration) {
      this.#status = 'paused';
      this.#stopTimer();
    }
    if (this.#status === 'empty') this.#status = 'ready';
    this.#emit();
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4)
      throw new RangeError('Playback speed must be between 0.25× and 4×.');
    const wasPlaying = this.#status === 'playing';
    this.#position = this.#currentPosition();
    this.#rate = rate;
    if (wasPlaying) this.#startedAt = this.#now();
    this.#emit();
  }

  dispose(): void {
    this.#stopTimer();
    this.#listeners.clear();
  }

  #currentPosition(): number {
    if (this.#status !== 'playing') return this.#position;
    return clamp(
      this.#position + (this.#now() - this.#startedAt) * this.#rate,
      0,
      this.#duration,
    );
  }

  #tick(): void {
    if (this.#currentPosition() >= this.#duration) {
      this.#position = this.#duration;
      this.#status = 'paused';
      this.#stopTimer();
    }
    this.#emit();
  }

  #stopTimer(): void {
    if (this.#timer !== null) this.#cancel(this.#timer);
    this.#timer = null;
  }

  #emit(): void {
    this.#snapshot = Object.freeze({
      positionSeconds: this.#currentPosition(),
      durationSeconds: this.#duration,
      playbackRate: this.#rate,
      status: this.#status,
    });
    for (const listener of this.#listeners) listener();
  }
}

/** Deterministic conversions use nearest-sample rounding and clamp only through the interval validator. */
export function secondsToSample(seconds: number, sampleRateHz: number): number {
  assertTimeValue(seconds, 'Seconds');
  assertSampleRate(sampleRateHz);
  return Math.round(seconds * sampleRateHz);
}

export function sampleToSeconds(sample: number, sampleRateHz: number): number {
  if (!Number.isSafeInteger(sample) || sample < 0)
    throw new RangeError(
      'Sample position must be a non-negative safe integer.',
    );
  assertSampleRate(sampleRateHz);
  return sample / sampleRateHz;
}

export function createAudioTime(
  value: number,
  timebase: AudioTimebase,
): AudioTime {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Audio time must be a non-negative finite value.');
  if (timebase.unit === 'samples' && !Number.isSafeInteger(value))
    throw new RangeError('Sample-based audio time must be an integer.');
  if (
    timebase.unit === 'samples' &&
    (!timebase.sampleRateHz || !Number.isFinite(timebase.sampleRateHz))
  )
    throw new RangeError('Sample timebase requires a valid sample rate.');
  return Object.freeze({ value, unit: timebase.unit, timebase: timebase.id });
}

export function validateAudioInterval(
  start: AudioTime,
  end: AudioTime,
  durationSeconds: number,
  sampleRateHz: number,
): void {
  if (start.timebase !== end.timebase || start.unit !== end.unit)
    throw new RangeError(
      'Interval endpoints must use the same audio timebase and unit.',
    );
  const startSeconds =
    start.unit === 'samples'
      ? sampleToSeconds(start.value, sampleRateHz)
      : start.value;
  const endSeconds =
    end.unit === 'samples'
      ? sampleToSeconds(end.value, sampleRateHz)
      : end.value;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    startSeconds >= endSeconds ||
    endSeconds > durationSeconds + 1 / sampleRateHz
  ) {
    throw new RangeError(
      'Audio interval must be ordered and stay within the asset duration.',
    );
  }
}

export function createWaveform(
  buffer: AudioBuffer,
  requestedBins = DEFAULT_WAVEFORM_BINS,
): Waveform {
  if (!Number.isInteger(requestedBins) || requestedBins <= 0)
    throw new RangeError('Waveform bin count must be a positive integer.');
  const binCount = Math.min(requestedBins, Math.max(1, buffer.length));
  const bins = new Float32Array(binCount);
  for (let bin = 0; bin < binCount; bin += 1) {
    const start = Math.floor((bin / binCount) * buffer.length);
    const end = Math.max(
      start + 1,
      Math.floor(((bin + 1) / binCount) * buffer.length),
    );
    let peak = 0;
    const stride = Math.max(1, Math.floor((end - start) / 2048));
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let index = start; index < end; index += stride)
        peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    bins[bin] = peak;
  }
  return Object.freeze({ bins, durationSeconds: buffer.duration });
}

export interface AudioEngineOptions {
  readonly createAudioContext?: () => AudioContext;
  readonly waveformBins?: number;
  readonly maximumBytes?: number;
}

/** Browser decode and transport adapter. All transport state is owned by its clock, outside React. */
export class AudioEngine {
  readonly clock: ApplicationAudioClock;
  readonly #context: AudioContext;
  readonly #gain: GainNode;
  readonly #waveformBins: number;
  readonly #maximumBytes: number;
  #asset: ImmutableAudioAsset | null = null;
  #buffer: AudioBuffer | null = null;
  #waveform: Waveform | null = null;
  #source: AudioBufferSourceNode | null = null;
  #volume = 1;

  constructor(options: AudioEngineOptions = {}) {
    const contextFactory =
      options.createAudioContext ??
      (() => {
        if (typeof AudioContext === 'undefined')
          throw new Error('Web Audio is unavailable in this browser.');
        return new AudioContext();
      });
    this.#context = contextFactory();
    this.#gain = this.#context.createGain();
    this.#gain.connect(this.#context.destination);
    this.#waveformBins = options.waveformBins ?? DEFAULT_WAVEFORM_BINS;
    this.#maximumBytes = options.maximumBytes ?? MAX_AUDIO_BYTES;
    this.clock = new ApplicationAudioClock({
      now: () => this.#context.currentTime,
    });
  }

  get asset(): ImmutableAudioAsset | null {
    return this.#asset;
  }
  get waveform(): Waveform | null {
    return this.#waveform;
  }
  get volume(): number {
    return this.#volume;
  }

  async importFile(file: File): Promise<AudioImportResult> {
    if (file.size === 0)
      throw new AudioImportError(
        'EMPTY_FILE',
        'Choose a non-empty audio file.',
      );
    if (file.size > this.#maximumBytes)
      throw new AudioImportError(
        'FILE_TOO_LARGE',
        'Audio files must be 200 MiB or smaller.',
      );
    const format = audioFormatFromFilename(file.name);
    if (!format)
      throw new AudioImportError(
        'UNSUPPORTED_FORMAT',
        'Choose an MP3, WAV, M4A, AAC, OGG, or WEBM audio file.',
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    let decoded: AudioBuffer;
    try {
      decoded = await this.#context.decodeAudioData(bytes.slice().buffer);
    } catch {
      throw new AudioImportError(
        'CORRUPT_AUDIO',
        'This audio file could not be decoded by the current browser.',
      );
    }
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0)
      throw new AudioImportError(
        'CORRUPT_AUDIO',
        'The audio file has no playable duration.',
      );
    if (decoded.duration > MAX_AUDIO_DURATION_SECONDS)
      throw new AudioImportError(
        'AUDIO_TOO_LONG',
        'Audio duration cannot exceed two hours.',
      );
    const sha256 = await digestSha256(bytes);
    const id = `audio-${sha256.slice(0, 20)}`;
    const timebase: AudioTimebase = Object.freeze({
      id: `audio:${id}` as AudioTimebase['id'],
      unit: 'seconds',
    });
    const metadata: AudioAssetMetadata = Object.freeze({
      id,
      filename: file.name,
      format,
      mediaType: file.type || mediaTypeFor(format),
      sizeBytes: bytes.byteLength,
      sha256,
      durationSeconds: decoded.duration,
      sampleRateHz: decoded.sampleRate,
      channelCount: decoded.numberOfChannels,
      frameCount: decoded.length,
      timebase,
    });
    this.stopSource();
    this.#asset = new ImmutableAudioAsset(metadata, bytes);
    this.#buffer = decoded;
    this.#waveform = createWaveform(decoded, this.#waveformBins);
    this.clock.setDuration(decoded.duration);
    return Object.freeze({ asset: this.#asset, waveform: this.#waveform });
  }

  async play(): Promise<void> {
    if (!this.#buffer) return;
    await this.#context.resume();
    this.stopSource();
    this.clock.play();
    const source = this.#context.createBufferSource();
    source.buffer = this.#buffer;
    source.playbackRate.value = this.clock.getSnapshot().playbackRate;
    source.connect(this.#gain);
    source.onended = () => {
      if (this.clock.getSnapshot().status === 'playing') this.clock.pause();
    };
    this.#source = source;
    source.start(0, this.clock.getSnapshot().positionSeconds);
  }

  pause(): void {
    this.clock.pause();
    this.stopSource();
  }

  seek(positionSeconds: number): void {
    if (!Number.isFinite(positionSeconds))
      throw new RangeError('Seek position must be finite.');
    const wasPlaying = this.clock.getSnapshot().status === 'playing';
    this.stopSource();
    this.clock.seek(positionSeconds);
    if (wasPlaying && this.clock.getSnapshot().status === 'playing')
      void this.play();
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1)
      throw new RangeError('Volume must be between 0 and 1.');
    this.#volume = volume;
    this.#gain.gain.setTargetAtTime(volume, this.#context.currentTime, 0.01);
  }

  setPlaybackRate(rate: number): void {
    const wasPlaying = this.clock.getSnapshot().status === 'playing';
    this.clock.setPlaybackRate(rate);
    if (wasPlaying) void this.play();
  }

  async dispose(): Promise<void> {
    this.pause();
    this.clock.dispose();
    await this.#context.close();
  }

  private stopSource(): void {
    if (!this.#source) return;
    this.#source.onended = null;
    try {
      this.#source.stop();
    } catch {
      /* Already stopped. */
    }
    this.#source.disconnect();
    this.#source = null;
  }
}

export function audioFormatFromFilename(filename: string): AudioFormat | null {
  const extension = filename.toLowerCase().split('.').at(-1);
  return SUPPORTED_AUDIO_FORMATS.find((format) => format === extension) ?? null;
}

function mediaTypeFor(format: AudioFormat): string {
  const mediaTypes: Record<AudioFormat, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
  };
  return mediaTypes[format];
}

async function digestSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function assertTimeValue(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative finite number.`);
}

function assertSampleRate(sampleRateHz: number): void {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0)
    throw new RangeError('Sample rate must be positive and finite.');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
