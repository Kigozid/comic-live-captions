import type {
  TranscriptionInput,
  TranscriptionProvider,
  ProviderTranscriptOutput,
} from '@comic-captioner/audio-engine';

/**
 * Local faster-whisper ASR via `scripts/faster-whisper-service.py`.
 *
 * Audio inference stays in Python (CTranslate2); the Node API only posts
 * PCM/file bytes and maps the typed response into the existing
 * `ProviderTranscriptOutput` contract (word text + start/end seconds).
 *
 * Transcription is distinct from forced alignment: a user-edited comic
 * transcript is aligned separately (WhisperX / wav2vec2 via `/api/align-words`).
 */

export interface FasterWhisperWord {
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly probability?: number;
}

export interface FasterWhisperSessionResult {
  readonly text: string;
  readonly language: string | null;
  readonly languageProbability: number;
  readonly durationSeconds: number;
  readonly words: readonly FasterWhisperWord[];
  readonly segments: readonly {
    readonly text: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly avgLogprob?: number;
    readonly compressionRatio?: number;
    readonly noSpeechProb?: number;
  }[];
  readonly model: string;
  readonly computeType: string;
}

export interface FasterWhisperSession {
  readonly name: string;
  transcribe(input: {
    readonly pcm: Float32Array;
    readonly sampleRateHz: number;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<FasterWhisperSessionResult>;
}

export class FasterWhisperError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'MODEL_MISSING'
      | 'EMPTY_AUDIO'
      | 'INVALID_INPUT'
      | 'TRANSCRIBE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'FasterWhisperError';
  }
}

export interface FasterWhisperHttpSessionOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly modelName?: string;
}

/** HTTP session against the local faster-whisper service. */
export class FasterWhisperHttpSession implements FasterWhisperSession {
  readonly name: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: FasterWhisperHttpSessionOptions = {}) {
    const model = options.modelName ?? 'small';
    this.name = `faster-whisper:${model}`;
    this.#baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3041').replace(
      /\/+$/,
      '',
    );
    this.#timeoutMs = options.timeoutMs ?? 600_000;
    Object.freeze(this);
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(this.#timeoutMs, 3_000)),
      });
      // Service up is enough; weights may still be lazy-loaded on first job.
      return response.ok;
    } catch {
      return false;
    }
  }

  async transcribe(input: {
    pcm: Float32Array;
    sampleRateHz: number;
    language?: string;
    signal?: AbortSignal;
  }): Promise<FasterWhisperSessionResult> {
    const bytes = new Uint8Array(
      input.pcm.buffer,
      input.pcm.byteOffset,
      input.pcm.byteLength,
    );
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audio: bytesToBase64(bytes),
          sampleRateHz: input.sampleRateHz,
          encoding: 'pcm-s16le',
          wordTimestamps: true,
          ...(input.language ? { language: input.language } : {}),
        }),
        signal: input.signal ?? AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      if (input.signal?.aborted) {
        throw new FasterWhisperError('TRANSCRIBE_FAILED', 'Transcription cancelled.');
      }
      throw new FasterWhisperError(
        'UNAVAILABLE',
        `faster-whisper service unreachable at ${this.#baseUrl}: ${
          cause instanceof Error ? cause.message : 'unknown error'
        }`,
      );
    }
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      code?: string;
      text?: string;
      language?: string | null;
      languageProbability?: number;
      durationSeconds?: number;
      words?: FasterWhisperWord[];
      segments?: FasterWhisperSessionResult['segments'];
      model?: string;
      computeType?: string;
    };
    if (!response.ok || body.ok !== true) {
      const code =
        body.code === 'EMPTY_AUDIO'
          ? 'EMPTY_AUDIO'
          : body.code === 'MODEL_MISSING'
            ? 'MODEL_MISSING'
            : 'TRANSCRIBE_FAILED';
      throw new FasterWhisperError(
        code,
        body.error ?? `faster-whisper returned HTTP ${response.status}.`,
      );
    }
    return {
      text: String(body.text ?? ''),
      language: body.language ?? null,
      languageProbability: Number(body.languageProbability ?? 0),
      durationSeconds: Number(body.durationSeconds ?? 0),
      words: Array.isArray(body.words) ? body.words : [],
      segments: Array.isArray(body.segments) ? body.segments : [],
      model: String(body.model ?? 'small'),
      computeType: String(body.computeType ?? 'int8'),
    };
  }
}

export interface FasterWhisperProviderOptions {
  readonly session?: FasterWhisperSession;
  readonly baseUrl?: string;
  readonly modelName?: string;
  readonly language?: string;
  /** PCM sample rate sent to the service. Default 16000. */
  readonly sampleRateHz?: number;
}

/**
 * Transcription provider that speaks the existing
 * `ProviderTranscriptOutput` schema (words with start/end seconds).
 */
export class FasterWhisperTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = 'faster-whisper';
  readonly providerVersion: string;
  readonly #options: FasterWhisperProviderOptions;
  #sessionPromise: Promise<FasterWhisperSession> | null = null;

  constructor(options: FasterWhisperProviderOptions = {}) {
    this.#options = options;
    const model = options.modelName ?? 'small';
    this.providerVersion = `${model}-int8`;
  }

  async transcribe(input: TranscriptionInput): Promise<unknown> {
    const session = await this.#loadSession();
    const sampleRateHz = this.#options.sampleRateHz ?? 16_000;
    // Re-decode to 16 kHz mono float32 when ffmpeg is available; otherwise
    // treat the payload as already-decoded PCM if the caller prepared it.
    const { pcm, sampleRateHz: rate } = await decodeToPcm(
      input.bytes,
      sampleRateHz,
    );
    if (pcm.length === 0) {
      throw new FasterWhisperError('EMPTY_AUDIO', 'Decoded audio is empty.');
    }

    const result = await session.transcribe({
      pcm,
      sampleRateHz: rate,
      ...(this.#options.language ? { language: this.#options.language } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const duration = input.asset.durationSeconds;
    const words = normalizeWords(result.words, result.text, duration);
    return {
      text: result.text.trim() || words.map((w) => w.text).join(' '),
      words,
      speakers: [{ id: 'spk_1', label: 'Speaker 1' }],
      inputHash: input.asset.sha256,
    } satisfies ProviderTranscriptOutput;
  }

  async #loadSession(): Promise<FasterWhisperSession> {
    if (this.#options.session) return this.#options.session;
    this.#sessionPromise ??= Promise.resolve(
      new FasterWhisperHttpSession({
        ...(this.#options.baseUrl ? { baseUrl: this.#options.baseUrl } : {}),
        ...(this.#options.modelName
          ? { modelName: this.#options.modelName }
          : {}),
      }),
    );
    return this.#sessionPromise;
  }
}

function normalizeWords(
  words: readonly FasterWhisperWord[],
  text: string,
  durationSeconds: number,
): {
  text: string;
  startSeconds: number;
  endSeconds: number;
  speakerId: string;
}[] {
  const duration = Math.max(durationSeconds, 0.01);
  const out: {
    text: string;
    startSeconds: number;
    endSeconds: number;
    speakerId: string;
  }[] = [];
  let previousEnd = 0;
  words.forEach((word, index) => {
    const token = String(word.text ?? '').trim();
    if (!token) return;
    let start = Number(word.startSeconds);
    let end = Number(word.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    // Clamp into the asset duration and keep monotonic non-overlapping words.
    start = Math.max(0, Math.min(start, duration));
    end = Math.max(start + 0.01, Math.min(end, duration));
    if (start < previousEnd) start = previousEnd;
    if (end <= start) end = Math.min(duration, start + 0.01);
    previousEnd = end;
    out.push({
      text: token,
      startSeconds: start,
      endSeconds: end,
      speakerId: 'spk_1',
    });
    void index;
  });
  if (out.length === 0) {
    out.push({
      text: text.trim() || '…',
      startSeconds: 0,
      endSeconds: Math.min(duration, 0.5),
      speakerId: 'spk_1',
    });
  }
  return out;
}

async function decodeToPcm(
  bytes: Uint8Array,
  targetRateHz: number,
): Promise<{ pcm: Float32Array; sampleRateHz: number }> {
  try {
    const { decodeAudioToPcm } = await import('./audio-pcm.js');
    const decoded = await decodeAudioToPcm(bytes, {
      sampleRateHz: targetRateHz,
    });
    return decoded;
  } catch {
    // ffmpeg unavailable: pass through as if already s16le PCM.
    const pcm = new Float32Array(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < pcm.length; i += 1) {
      pcm[i] = view.getInt16(i * 2, true) / 32768;
    }
    return { pcm, sampleRateHz: targetRateHz };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}

/** Build a provider from env (`COMIC_ASR=faster-whisper`, `COMIC_WHISPER_*`). */
export function createFasterWhisperProviderFromEnv(): FasterWhisperTranscriptionProvider {
  return new FasterWhisperTranscriptionProvider({
    ...(process.env.COMIC_WHISPER_URL
      ? { baseUrl: process.env.COMIC_WHISPER_URL }
      : {}),
    ...(process.env.COMIC_WHISPER_MODEL
      ? { modelName: process.env.COMIC_WHISPER_MODEL }
      : {}),
    ...(process.env.COMIC_WHISPER_LANGUAGE
      ? { language: process.env.COMIC_WHISPER_LANGUAGE }
      : {}),
  });
}
