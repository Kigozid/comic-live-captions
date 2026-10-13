import type { AudioTime, AudioTimebase } from '@comic-captioner/shared';
import type { Transcript, TranscriptSegment } from '@comic-captioner/core';
export type {
  Transcript,
  TranscriptSegment,
  WordTimestamp,
} from '@comic-captioner/core';
import type { AudioAssetMetadata } from './index.js';

interface ValidatedWord {
  readonly id: string;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly speakerId: string | null;
}

export interface TranscriptionInput {
  readonly asset: AudioAssetMetadata;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface ProviderWordTimestamp {
  readonly text: unknown;
  readonly startSeconds: unknown;
  readonly endSeconds: unknown;
  readonly speakerId: unknown;
}

/** Provider boundary output uses only normalized words; no vendor response types cross it. */
export interface ProviderTranscriptOutput {
  readonly text: unknown;
  readonly words: unknown;
  readonly speakers: unknown;
  readonly inputHash: unknown;
}

export interface TranscriptionProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  transcribe(input: TranscriptionInput): Promise<unknown>;
}

export interface TranscriptionServiceOptions {
  readonly timeoutMs?: number;
}

export class TranscriptionError extends Error {
  constructor(
    readonly code: 'PROVIDER_FAILED' | 'TIMEOUT' | 'ABORTED' | 'INVALID_OUTPUT',
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/** Validates provider output before constructing any application domain object. */
export class TranscriptionService {
  readonly #provider: TranscriptionProvider;
  readonly #timeoutMs: number;

  constructor(
    provider: TranscriptionProvider,
    options: TranscriptionServiceOptions = {},
  ) {
    this.#provider = provider;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0)
      throw new RangeError(
        'Transcription timeout must be a positive finite duration.',
      );
  }

  async transcribe(input: TranscriptionInput): Promise<Transcript> {
    await validateInput(input);
    if (input.signal?.aborted)
      throw new TranscriptionError('ABORTED', 'Transcription was cancelled.');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const providerWork = this.#provider.transcribe({
        ...input,
        signal: controller.signal,
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new TranscriptionError(
              'TIMEOUT',
              'Transcription provider exceeded its time limit.',
            ),
          );
        }, this.#timeoutMs);
      });
      const raw = await Promise.race([providerWork, timeout]);
      return validateAndBuildTranscript(raw, input.asset, this.#provider);
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      if (input.signal?.aborted)
        throw new TranscriptionError('ABORTED', 'Transcription was cancelled.');
      throw new TranscriptionError(
        'PROVIDER_FAILED',
        error instanceof Error
          ? error.message
          : 'Transcription provider failed.',
        isProviderDiagnostic(error) ? error.code : undefined,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function isProviderDiagnostic(
  value: unknown,
): value is Error & { readonly code: string } {
  return (
    value instanceof Error &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code.startsWith('GEMINI_')
  );
}

export interface MockTranscriptionProviderOptions {
  readonly output?: unknown;
  readonly error?: Error;
  readonly delayMs?: number;
}

/** Deterministic provider used for service and application tests. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = 'mock-transcription';
  readonly providerVersion = '1';
  readonly calls: TranscriptionInput[] = [];

  constructor(
    private readonly options: MockTranscriptionProviderOptions = {},
  ) {}

  async transcribe(input: TranscriptionInput): Promise<unknown> {
    this.calls.push(input);
    if (this.options.delayMs)
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    if (this.options.error) throw this.options.error;
    return (
      this.options.output ??
      ({
        text: 'Hello there.',
        words: [
          {
            text: 'Hello',
            startSeconds: 0.2,
            endSeconds: 0.6,
            speakerId: 'spk_1',
          },
          {
            text: 'there.',
            startSeconds: 0.65,
            endSeconds: 1.1,
            speakerId: 'spk_1',
          },
        ],
        speakers: [{ id: 'spk_1', label: 'Speaker 1' }],
        inputHash: input.asset.sha256,
      } satisfies ProviderTranscriptOutput)
    );
  }
}

function validateAndBuildTranscript(
  value: unknown,
  asset: AudioAssetMetadata,
  provider: TranscriptionProvider,
): Transcript {
  const record = asRecord(value);
  const text = nonEmptyString(record?.text, 'Transcript text');
  const inputHash = record?.inputHash;
  if (inputHash !== asset.sha256)
    invalid('Provider result does not refer to the imported audio asset.');
  const rawSpeakers = record?.speakers;
  if (!Array.isArray(rawSpeakers))
    invalid('Speaker list must be a structured array.');
  const speakerIds = new Set<string>();
  const speakers = rawSpeakers.map((entry) => {
    const speaker = asRecord(entry);
    const id = validateSpeakerId(speaker?.id);
    if (speakerIds.has(id)) invalid('Speaker IDs must be unique.');
    speakerIds.add(id);
    if (
      speaker?.label !== undefined &&
      (typeof speaker.label !== 'string' || speaker.label.trim().length === 0)
    )
      invalid('Speaker labels must be non-empty strings when supplied.');
    return Object.freeze({
      id,
      ...(speaker?.label === undefined ? {} : { label: speaker.label.trim() }),
    });
  });

  const rawWords = record?.words;
  if (!Array.isArray(rawWords) || rawWords.length === 0)
    invalid('Transcription must include at least one timestamped word.');
  if (rawWords.length > 100_000)
    invalid('Transcription exceeds the maximum word count.');
  let previousStart = -1;
  const previousEndBySpeaker = new Map<string, number>();
  const words = rawWords.map((entry, index): ValidatedWord => {
    const word = asRecord(entry);
    const wordText = nonEmptyString(word?.text, `Word ${index + 1} text`);
    const start = finiteNumber(word?.startSeconds, `Word ${index + 1} start`);
    const end = finiteNumber(word?.endSeconds, `Word ${index + 1} end`);
    const speakerId =
      word?.speakerId === null ? null : validateSpeakerId(word?.speakerId);
    if (speakerId !== null && !speakerIds.has(speakerId))
      invalid(`Word ${index + 1} refers to an unknown speaker ID.`);
    if (start < 0 || end <= start || end > asset.durationSeconds)
      invalid(`Word ${index + 1} timestamps fall outside the audio duration.`);
    if (start < previousStart)
      invalid('Word timestamps must be ordered by start time.');
    if (
      speakerId !== null &&
      start < (previousEndBySpeaker.get(speakerId) ?? 0)
    )
      invalid('Timestamps for a speaker cannot overlap or move backward.');
    previousStart = start;
    if (speakerId !== null) previousEndBySpeaker.set(speakerId, end);
    return Object.freeze({
      id: `transcript:${asset.id}:word:${index + 1}`,
      text: wordText,
      startSeconds: start,
      endSeconds: end,
      speakerId,
    });
  });

  const segments = groupWords(words, asset.id, asset.timebase);
  if (segments.length === 0)
    invalid('Transcription did not produce any dialogue segments.');
  return Object.freeze({
    id: `transcript:${asset.id}:${asset.sha256.slice(0, 12)}`,
    audioAssetId: asset.id,
    text,
    durationSeconds: asset.durationSeconds,
    timebase: Object.freeze({ ...asset.timebase }),
    speakers: Object.freeze(speakers),
    segments: Object.freeze(segments),
    confidence: null,
    reviewStatus: 'pending-review',
    revision: 1,
    provenance: Object.freeze({
      provider: provider.providerId,
      version: provider.providerVersion,
      inputHashes: Object.freeze([asset.sha256]),
    }),
  });
}

function groupWords(
  words: readonly ValidatedWord[],
  assetId: string,
  timebase: AudioTimebase,
): TranscriptSegment[] {
  const groups: ValidatedWord[][] = [];
  for (const word of words) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const sentenceEnds = previous
      ? /[.!?…]["'”’)]*$/.test(previous.text)
      : false;
    const shouldSplit =
      !current ||
      current[0]?.speakerId !== word.speakerId ||
      (!!previous && word.startSeconds - previous.endSeconds > 1.25) ||
      sentenceEnds;
    if (shouldSplit) groups.push([word]);
    else current!.push(word);
  }
  return groups.map((group, index) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    return Object.freeze({
      id: `transcript:${assetId}:segment:${index + 1}`,
      text: group.map((word) => word.text).join(' '),
      interval: Object.freeze({
        start: audioTime(first.startSeconds, timebase),
        end: audioTime(last.endSeconds, timebase),
      }),
      speakerId: first.speakerId,
      confidence: null,
      words: Object.freeze(
        group.map((word) =>
          Object.freeze({
            id: word.id,
            text: word.text,
            start: audioTime(word.startSeconds, timebase),
            end: audioTime(word.endSeconds, timebase),
            speakerId: word.speakerId,
            confidence: null,
          }),
        ),
      ),
    });
  });
}

function audioTime(value: number, timebase: AudioTimebase): AudioTime {
  return Object.freeze({ value, timebase: timebase.id, unit: 'seconds' });
}

async function validateInput(input: TranscriptionInput): Promise<void> {
  if (!input.asset.id || !/^[a-f\d]{64}$/i.test(input.asset.sha256))
    invalid('Audio asset identity and SHA-256 hash are required.');
  if (
    !Number.isFinite(input.asset.durationSeconds) ||
    input.asset.durationSeconds <= 0
  )
    invalid('Audio duration must be positive and finite.');
  if (
    !Number.isSafeInteger(input.asset.sizeBytes) ||
    input.asset.sizeBytes > 200 * 1024 * 1024
  )
    invalid(
      'Audio asset size must be a positive safe integer within the upload limit.',
    );
  if (
    !Number.isFinite(input.asset.sampleRateHz) ||
    input.asset.sampleRateHz <= 0 ||
    !Number.isSafeInteger(input.asset.channelCount) ||
    input.asset.channelCount < 1
  )
    invalid('Audio sample rate and channel count must be valid.');
  if (
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength !== input.asset.sizeBytes
  )
    invalid('Audio bytes do not match the imported asset metadata.');
  const actualHash = await hashBytes(input.bytes);
  if (actualHash !== input.asset.sha256.toLowerCase())
    invalid('Audio bytes do not match the imported asset hash.');
  if (input.asset.timebase.unit !== 'seconds' || !input.asset.timebase.id)
    invalid('Audio asset must use its named seconds timebase.');
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function validateSpeakerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    invalid(
      'Speaker IDs must be 1–64 characters using letters, digits, underscores, or hyphens.',
    );
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    invalid(`${label} must be a finite number.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 1_000_000
  )
    invalid(`${label} must be a non-empty string.`);
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(message: string): never {
  throw new TranscriptionError('INVALID_OUTPUT', message);
}
