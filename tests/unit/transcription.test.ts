import { describe, expect, it } from 'vitest';
import {
  MockTranscriptionProvider,
  TranscriptionError,
  TranscriptionService,
  type AudioAssetMetadata,
  type ProviderTranscriptOutput,
  type TranscriptionInput,
} from '@comic-captioner/audio-engine';
import { GeminiTranscriptionProvider } from '@comic-captioner/ai';

const bytes = Uint8Array.from([1, 2, 3, 4, 5]);

async function fixtureInput(): Promise<TranscriptionInput> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  const sha256 = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const asset: AudioAssetMetadata = {
    id: `audio-${sha256.slice(0, 20)}`,
    filename: 'dialogue.wav',
    format: 'wav',
    mediaType: 'audio/wav',
    sizeBytes: bytes.byteLength,
    sha256,
    durationSeconds: 4,
    sampleRateHz: 48_000,
    channelCount: 1,
    frameCount: 192_000,
    timebase: {
      id: `audio:audio-${sha256.slice(0, 20)}` as AudioAssetMetadata['timebase']['id'],
      unit: 'seconds',
    },
  };
  return { asset, bytes: Uint8Array.from(bytes) };
}

function providerOutput(input: TranscriptionInput): ProviderTranscriptOutput {
  return {
    text: 'Hello there. Goodbye!',
    words: [
      { text: 'Hello', startSeconds: 0.1, endSeconds: 0.4, speakerId: 'spk_1' },
      {
        text: 'there.',
        startSeconds: 0.42,
        endSeconds: 0.8,
        speakerId: 'spk_1',
      },
      {
        text: 'Goodbye!',
        startSeconds: 1.5,
        endSeconds: 2,
        speakerId: 'spk_2',
      },
    ],
    speakers: [
      { id: 'spk_1', label: 'Speaker 1' },
      { id: 'spk_2', label: 'Speaker 2' },
    ],
    inputHash: input.asset.sha256,
  };
}

describe('TranscriptionService', () => {
  it('validates structured mock output and creates a reviewable transcript in the asset timebase', async () => {
    const input = await fixtureInput();
    const mock = new MockTranscriptionProvider({
      output: providerOutput(input),
    });
    const transcript = await new TranscriptionService(mock).transcribe(input);
    expect(transcript).toMatchObject({
      audioAssetId: input.asset.id,
      durationSeconds: 4,
      timebase: input.asset.timebase,
      reviewStatus: 'pending-review',
      provenance: {
        provider: 'mock-transcription',
        inputHashes: [input.asset.sha256],
      },
    });
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments[0]).toMatchObject({
      text: 'Hello there.',
      interval: {
        start: {
          value: 0.1,
          timebase: input.asset.timebase.id,
          unit: 'seconds',
        },
        end: {
          value: 0.8,
          timebase: input.asset.timebase.id,
          unit: 'seconds',
        },
      },
      speakerId: 'spk_1',
    });
    expect(transcript.segments[0]?.words).toHaveLength(2);
    expect(Object.isFrozen(transcript.segments)).toBe(true);
  });

  it.each([
    [
      'missing text',
      (output: ProviderTranscriptOutput) => ({ ...output, text: '  ' }),
    ],
    [
      'invalid start timestamp',
      (output: ProviderTranscriptOutput) => ({
        ...output,
        words: [
          {
            ...(output.words as Array<Record<string, unknown>>)[0],
            startSeconds: Number.NaN,
          },
        ],
      }),
    ],
    [
      'out-of-order timestamps',
      (output: ProviderTranscriptOutput) => ({
        ...output,
        words: [
          { ...(output.words as Array<Record<string, unknown>>)[1] },
          { ...(output.words as Array<Record<string, unknown>>)[0] },
        ],
      }),
    ],
    [
      'duration overrun',
      (output: ProviderTranscriptOutput) => ({
        ...output,
        words: [
          {
            ...(output.words as Array<Record<string, unknown>>)[0],
            endSeconds: 4.1,
          },
        ],
      }),
    ],
    [
      'unknown speaker ID',
      (output: ProviderTranscriptOutput) => ({
        ...output,
        words: [
          {
            ...(output.words as Array<Record<string, unknown>>)[0],
            speakerId: 'spk_unknown',
          },
        ],
      }),
    ],
    [
      'duplicate speaker IDs',
      (output: ProviderTranscriptOutput) => ({
        ...output,
        speakers: [{ id: 'spk_1' }, { id: 'spk_1' }],
      }),
    ],
    [
      'malformed speaker IDs',
      (output: ProviderTranscriptOutput) => ({
        ...output,
        speakers: [{ id: '../speaker' }],
      }),
    ],
  ])('rejects malformed provider data safely: %s', async (_label, mutate) => {
    const input = await fixtureInput();
    const provider = new MockTranscriptionProvider({
      output: mutate(providerOutput(input)),
    });
    await expect(
      new TranscriptionService(provider).transcribe(input),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects transcripts tied to mismatched source bytes instead of assigning them to an asset', async () => {
    const input = await fixtureInput();
    const badInput = { ...input, bytes: Uint8Array.from([9, 9, 9, 9, 9]) };
    const provider = new MockTranscriptionProvider({
      output: providerOutput(input),
    });
    await expect(
      new TranscriptionService(provider).transcribe(badInput),
    ).rejects.toThrow(/imported asset hash/);
    expect(provider.calls).toHaveLength(0);
  });

  it('times out providers and reports the failure with a stable application error code', async () => {
    const input = await fixtureInput();
    const provider = new MockTranscriptionProvider({
      delayMs: 50,
      output: providerOutput(input),
    });
    await expect(
      new TranscriptionService(provider, { timeoutMs: 5 }).transcribe(input),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('supports an offline mock provider path and reports provider errors without returning partial data', async () => {
    const input = await fixtureInput();
    await expect(
      new TranscriptionService(new MockTranscriptionProvider()).transcribe(
        input,
      ),
    ).resolves.toMatchObject({ text: 'Hello there.' });
    await expect(
      new TranscriptionService(
        new MockTranscriptionProvider({ error: new Error('offline') }),
      ).transcribe(input),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(new TranscriptionError('INVALID_OUTPUT', 'bad').code).toBe(
      'INVALID_OUTPUT',
    );
  });
});

describe('GeminiTranscriptionProvider', () => {
  it('uploads audio server-side and returns structured word timestamp data', async () => {
    const input = await fixtureInput();
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (inputUrl, init) => {
      const url = String(inputUrl);
      urls.push(url);
      if (url.includes('/upload/v1beta/files'))
        return new Response(null, {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload.test/audio' },
        });
      if (url === 'https://upload.test/audio')
        return Response.json({
          file: { name: 'files/one', uri: 'https://files.test/audio' },
        });
      if (url.endsWith('/v1beta/interactions'))
        return Response.json({
          status: 'completed',
          output_text: 'Hello there.',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  annotations: [
                    {
                      type: 'word_info',
                      text: 'Hello',
                      start_offset: '0.2s',
                      end_offset: '0.6s',
                      speaker: 'Speaker 1',
                    },
                    {
                      type: 'word_info',
                      text: 'there.',
                      start_offset: '0.65s',
                      end_offset: '1.1s',
                      speaker: 'Speaker 1',
                    },
                  ],
                },
              ],
            },
          ],
        });
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    };
    const transcript = await new TranscriptionService(
      new GeminiTranscriptionProvider({
        apiKey: 'server-test-key',
        fetch: fakeFetch,
      }),
    ).transcribe(input);

    expect(transcript.provenance.provider).toBe('gemini');
    expect(transcript.segments[0]).toMatchObject({
      text: 'Hello there.',
      interval: { start: { value: 0.2 }, end: { value: 1.1 } },
      speakerId: 'Speaker_1',
    });
    expect(transcript.speakers).toEqual([
      { id: 'Speaker_1', label: 'Speaker 1' },
    ]);
    expect(urls).toHaveLength(4);
  });
});
