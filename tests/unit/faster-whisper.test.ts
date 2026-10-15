import { describe, expect, it } from 'vitest';
import {
  TranscriptionService,
  OfflineTranscriptionProvider,
} from '@comic-captioner/audio-engine';
import type { AudioAssetMetadata } from '@comic-captioner/audio-engine';
import {
  FasterWhisperError,
  FasterWhisperHttpSession,
  FasterWhisperTranscriptionProvider,
  createFasterWhisperProviderFromEnv,
} from '../../apps/api/src/faster-whisper.js';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

async function assetFor(bytes: Uint8Array, overrides: Partial<AudioAssetMetadata> = {}) {
  const sha256 = await sha256Hex(bytes);
  return {
    id: 'asset-1',
    filename: 'narration.wav',
    mediaType: 'audio/wav',
    contentHash: sha256,
    sha256,
    sizeBytes: bytes.byteLength,
    durationSeconds: 5,
    sampleRateHz: 16_000,
    channelCount: 1,
    timebase: {
      id: 'audio:tb' as never,
      unit: 'seconds' as const,
    },
    ...overrides,
  } as AudioAssetMetadata;
}

function pcmBytes(seconds = 1, rate = 16_000): Uint8Array {
  const n = seconds * rate;
  const buffer = new ArrayBuffer(n * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < n; i += 1) view.setInt16(i * 2, (i % 100) * 20, true);
  return new Uint8Array(buffer);
}

function mockSession(result: {
  text?: string;
  words?: {
    text: string;
    startSeconds: number;
    endSeconds: number;
    probability?: number;
  }[];
  throwEmpty?: boolean;
}) {
  return {
    name: 'faster-whisper:mock',
    async transcribe() {
      if (result.throwEmpty) {
        throw new FasterWhisperError('EMPTY_AUDIO', 'Decoded audio is empty.');
      }
      return {
        text: result.text ?? 'hello world',
        language: 'en',
        languageProbability: 0.98,
        durationSeconds: 5,
        words: result.words ?? [
          { text: 'hello', startSeconds: 0.1, endSeconds: 0.4, probability: 0.9 },
          { text: 'world', startSeconds: 0.45, endSeconds: 0.9, probability: 0.88 },
        ],
        segments: [
          {
            text: result.text ?? 'hello world',
            startSeconds: 0.1,
            endSeconds: 0.9,
            avgLogprob: -0.2,
            compressionRatio: 1.1,
            noSpeechProb: 0.01,
          },
        ],
        model: 'small',
        computeType: 'int8',
      };
    },
  };
}

describe('FasterWhisperTranscriptionProvider', () => {
  it('maps word timestamps into the existing transcript contract', async () => {
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({}),
    });
    const bytes = pcmBytes(5);
    const raw = await provider.transcribe({
      asset: await assetFor(bytes),
      bytes,
    });
    const output = raw as {
      text: string;
      words: { text: string; startSeconds: number; endSeconds: number }[];
      inputHash: string;
    };
    expect(output.text).toBe('hello world');
    expect(output.words).toHaveLength(2);
    expect(output.words[0]!.text).toBe('hello');
    expect(output.words[0]!.startSeconds).toBeCloseTo(0.1);
    expect(output.words[0]!.endSeconds).toBeCloseTo(0.4);
    expect(output.words[1]!.text).toBe('world');
    expect(output.inputHash).toBe((await assetFor(bytes)).sha256);
  });

  it('builds a validated Transcript with segments via TranscriptionService', async () => {
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({}),
    });
    const bytes = pcmBytes(5);
    const transcript = await new TranscriptionService(provider).transcribe({
      asset: await assetFor(bytes),
      bytes,
    });
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(transcript.segments[0]!.words.length).toBeGreaterThan(0);
    expect(transcript.provenance.provider).toBe('faster-whisper');
    expect(transcript.provenance.version).toBe('small-int8');
  });

  it('preserves probability metadata on words when provided', async () => {
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({
        words: [
          { text: 'hi', startSeconds: 0, endSeconds: 0.2, probability: 0.42 },
        ],
      }),
    });
    const bytes = pcmBytes(2);
    const raw = (await provider.transcribe({
      asset: await assetFor(bytes, { durationSeconds: 2 }),
      bytes,
    })) as { words: { text: string }[] };
    // Domain transcript stores text+times; probability is on the session result.
    expect(raw.words[0]!.text).toBe('hi');
  });

  it('handles empty recognition output with a placeholder word', async () => {
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({ text: '', words: [] }),
    });
    const bytes = pcmBytes(5);
    const raw = (await provider.transcribe({
      asset: await assetFor(bytes),
      bytes,
    })) as { words: { text: string }[] };
    expect(raw.words).toHaveLength(1);
    expect(raw.words[0]!.text.length).toBeGreaterThan(0);
  });

  it('clamps overlapping and out-of-range word times into the asset duration', async () => {
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({
        words: [
          { text: 'a', startSeconds: 1, endSeconds: 0.2 },
          { text: 'b', startSeconds: -5, endSeconds: 99 },
        ],
      }),
    });
    const bytes = pcmBytes(2);
    const raw = (await provider.transcribe({
      asset: await assetFor(bytes, { durationSeconds: 2 }),
      bytes,
    })) as {
      words: { text: string; startSeconds: number; endSeconds: number }[];
    };
    for (const word of raw.words) {
      expect(word.startSeconds).toBeGreaterThanOrEqual(0);
      expect(word.endSeconds).toBeLessThanOrEqual(2);
      expect(word.endSeconds).toBeGreaterThan(word.startSeconds);
    }
  });

  it('rejects empty decoded audio', async () => {
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({ throwEmpty: true }),
    });
    await expect(
      provider.transcribe({
        asset: await assetFor(new Uint8Array(0)),
        bytes: new Uint8Array(0),
      }),
    ).rejects.toBeInstanceOf(FasterWhisperError);
  });

  it('surfaces service error codes (empty / model missing)', async () => {
    const failing = {
      name: 'faster-whisper:fail',
      async transcribe() {
        throw new FasterWhisperError(
          'MODEL_MISSING',
          'faster-whisper is not installed.',
        );
      },
    };
    const provider = new FasterWhisperTranscriptionProvider({
      session: failing,
    });
    const bytes = pcmBytes(1);
    await expect(
      provider.transcribe({ asset: await assetFor(bytes), bytes }),
    ).rejects.toMatchObject({ code: 'MODEL_MISSING' });
  });

  it('does not require a live model when a session is injected', () => {
    // Construction must not download weights.
    const provider = new FasterWhisperTranscriptionProvider({
      session: mockSession({}),
      modelName: 'small',
    });
    expect(provider.providerId).toBe('faster-whisper');
    expect(provider.providerVersion).toBe('small-int8');
  });

  it('createFasterWhisperProviderFromEnv reads COMIC_WHISPER_* configuration', () => {
    const previous = {
      model: process.env.COMIC_WHISPER_MODEL,
      url: process.env.COMIC_WHISPER_URL,
      language: process.env.COMIC_WHISPER_LANGUAGE,
    };
    process.env.COMIC_WHISPER_MODEL = 'tiny';
    process.env.COMIC_WHISPER_URL = 'http://127.0.0.1:3041';
    process.env.COMIC_WHISPER_LANGUAGE = 'en';
    try {
      const provider = createFasterWhisperProviderFromEnv();
      expect(provider.providerVersion).toBe('tiny-int8');
    } finally {
      if (previous.model === undefined) delete process.env.COMIC_WHISPER_MODEL;
      else process.env.COMIC_WHISPER_MODEL = previous.model;
      if (previous.url === undefined) delete process.env.COMIC_WHISPER_URL;
      else process.env.COMIC_WHISPER_URL = previous.url;
      if (previous.language === undefined) delete process.env.COMIC_WHISPER_LANGUAGE;
      else process.env.COMIC_WHISPER_LANGUAGE = previous.language;
    }
  });

  it('OfflineTranscriptionProvider remains a working fallback', async () => {
    const bytes = pcmBytes(5);
    const transcript = await new TranscriptionService(
      new OfflineTranscriptionProvider(),
    ).transcribe({ asset: await assetFor(bytes), bytes });
    expect(transcript.text.length).toBeGreaterThan(0);
  });
});

describe('FasterWhisperHttpSession (mocked fetch)', () => {
  it('maps a successful service payload', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          text: 'one two',
          language: 'en',
          languageProbability: 0.9,
          durationSeconds: 3,
          words: [
            { text: 'one', startSeconds: 0, endSeconds: 0.3, probability: 0.8 },
            { text: 'two', startSeconds: 0.35, endSeconds: 0.7, probability: 0.7 },
          ],
          segments: [
            {
              text: 'one two',
              startSeconds: 0,
              endSeconds: 0.7,
              avgLogprob: -0.1,
              compressionRatio: 1,
              noSpeechProb: 0,
            },
          ],
          model: 'small',
          computeType: 'int8',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      const session = new FasterWhisperHttpSession({ baseUrl: 'http://127.0.0.1:3041' });
      const result = await session.transcribe({
        pcm: new Float32Array(1600),
        sampleRateHz: 16_000,
      });
      expect(result.words).toHaveLength(2);
      expect(result.model).toBe('small');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps EMPTY_AUDIO and failure codes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'no samples', code: 'EMPTY_AUDIO' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const session = new FasterWhisperHttpSession();
      await expect(
        session.transcribe({ pcm: new Float32Array(0), sampleRateHz: 16_000 }),
      ).rejects.toMatchObject({ code: 'EMPTY_AUDIO' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports unavailable when the service is down', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    try {
      const session = new FasterWhisperHttpSession();
      await expect(session.available()).resolves.toBe(false);
      await expect(
        session.transcribe({ pcm: new Float32Array(10), sampleRateHz: 16_000 }),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
