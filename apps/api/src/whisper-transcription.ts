import type {
  TranscriptionInput,
  TranscriptionProvider,
  ProviderTranscriptOutput,
} from '@comic-captioner/audio-engine';
import { decodeAudioToPcm } from './audio-pcm.js';

/**
 * Whisper ASR port. Injectable so tests can run without model weights and
 * production can use transformers.js / whisper.cpp / a remote worker.
 */
export interface WhisperAsrSession {
  readonly name: string;
  /** 16 kHz mono PCM → text + word timings in seconds. */
  transcribe(audio: {
    readonly pcm: Float32Array;
    readonly sampleRateHz: number;
    readonly language?: string;
  }): Promise<{
    readonly text: string;
    readonly words: readonly {
      readonly text: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
    }[];
  }>;
}

export class WhisperTranscriptionError extends Error {
  constructor(
    readonly code: 'MODEL_MISSING' | 'MODEL_LOAD_FAILED' | 'TRANSCRIBE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'WhisperTranscriptionError';
  }
}

export interface WhisperTranscriptionProviderOptions {
  /** Injected session (tests / custom backend). When omitted, load transformers.js Whisper. */
  readonly session?: WhisperAsrSession;
  readonly modelName?: string;
  readonly language?: string;
}

/**
 * Local Whisper speech-to-text. Preferred over the offline stub when model
 * weights can load; Gemini remains available as an alternate provider.
 */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = 'whisper';
  readonly providerVersion: string;
  readonly #options: WhisperTranscriptionProviderOptions;
  #sessionPromise: Promise<WhisperAsrSession> | null = null;

  constructor(options: WhisperTranscriptionProviderOptions = {}) {
    this.#options = options;
    this.providerVersion = options.modelName ?? 'Xenova/whisper-tiny.en';
  }

  async transcribe(input: TranscriptionInput): Promise<unknown> {
    const session = await this.#loadSession();
    // Whisper expects 16 kHz mono float32.
    let pcm: Float32Array;
    let sampleRateHz = 16_000;
    try {
      const decoded = await decodeAudioToPcm(
        new Uint8Array(
          input.bytes.buffer,
          input.bytes.byteOffset,
          input.bytes.byteLength,
        ),
        { sampleRateHz: 16_000 },
      );
      pcm = decoded.pcm;
      sampleRateHz = decoded.sampleRateHz;
    } catch (cause) {
      throw new WhisperTranscriptionError(
        'TRANSCRIBE_FAILED',
        `Audio decode failed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
      );
    }
    if (pcm.length === 0) {
      throw new WhisperTranscriptionError(
        'TRANSCRIBE_FAILED',
        'Decoded audio is empty.',
      );
    }

    const result = await session.transcribe({
      pcm,
      sampleRateHz,
      ...(this.#options.language ? { language: this.#options.language } : {}),
    });

    const duration = input.asset.durationSeconds;
    const words = result.words.map((word, index) => {
      const start = clamp(word.startSeconds, 0, duration);
      const end = clamp(
        Math.max(start + 0.01, word.endSeconds),
        start + 0.01,
        duration,
      );
      return {
        text: word.text.trim() || `w${index + 1}`,
        startSeconds: start,
        endSeconds: end,
        speakerId: 'spk_1',
      };
    });
    if (words.length === 0) {
      // Whisper can return empty text on silence; emit one placeholder so the
      // transcript contract still holds for mapping/export demos.
      words.push({
        text: result.text.trim() || '…',
        startSeconds: 0,
        endSeconds: Math.min(duration, 0.5),
        speakerId: 'spk_1',
      });
    }

    return {
      text: result.text.trim() || words.map((w) => w.text).join(' '),
      words,
      speakers: [{ id: 'spk_1', label: 'Speaker 1' }],
      inputHash: input.asset.sha256,
    } satisfies ProviderTranscriptOutput;
  }

  async #loadSession(): Promise<WhisperAsrSession> {
    if (this.#options.session) return this.#options.session;
    this.#sessionPromise ??= createTransformersWhisperSession(
      this.#options.modelName ?? 'Xenova/whisper-tiny.en',
    );
    try {
      return await this.#sessionPromise;
    } catch (cause) {
      this.#sessionPromise = null;
      throw cause;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * transformers.js Whisper session. Loaded lazily so environments without the
 * dependency or model cache still start (offline stub / Gemini remain).
 */
export async function createTransformersWhisperSession(
  modelName: string,
): Promise<WhisperAsrSession> {
  let pipeline: typeof import('@xenova/transformers').pipeline;
  try {
    ({ pipeline } = await import('@xenova/transformers'));
  } catch (cause) {
    throw new WhisperTranscriptionError(
      'MODEL_MISSING',
      `@xenova/transformers is not available: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }
  let asr: Awaited<ReturnType<typeof pipeline>>;
  try {
    asr = await pipeline('automatic-speech-recognition', modelName, {
      quantized: true,
    });
  } catch (cause) {
    throw new WhisperTranscriptionError(
      'MODEL_LOAD_FAILED',
      `Failed to load Whisper model ${modelName}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  return {
    name: `whisper:${modelName}`,
    async transcribe(audio) {
      try {
        const output = await asr(audio.pcm, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: 'word',
        }) as {
          text?: string;
          chunks?: { text?: string; timestamp?: [number, number | null] }[];
        };
        const text = String(output.text ?? '');
        const words = (output.chunks ?? []).flatMap((chunk) => {
          const token = String(chunk.text ?? '').trim();
          if (!token) return [];
          const start = chunk.timestamp?.[0] ?? 0;
          const end = chunk.timestamp?.[1] ?? start + 0.2;
          return [{ text: token, startSeconds: start, endSeconds: end }];
        });
        return { text, words };
      } catch (cause) {
        throw new WhisperTranscriptionError(
          'TRANSCRIBE_FAILED',
          `Whisper inference failed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
        );
      }
    },
  };
}
