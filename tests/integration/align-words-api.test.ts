import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApiServer } from '../../apps/api/src/server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Tiny mono WAV (0.3s of a 440 Hz sine) for PCM/ffmpeg paths. */
function tinyWav(): Uint8Array {
  const sampleRate = 16_000;
  const seconds = 0.3;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return new Uint8Array(buffer);
}

describe('acoustic word alignment API', () => {
  it('reports wav2vec2 availability on /api/models', async () => {
    const response = await fetch(`${baseUrl}/api/models`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      models: {
        wav2vec2?: { available: boolean; name?: string; message?: string };
        yolo?: { available: boolean };
      };
    };
    expect(payload.models).toHaveProperty('wav2vec2');
    expect(payload.models.wav2vec2).toHaveProperty('available');
  });

  it('rejects incomplete align-words requests', async () => {
    const response = await fetch(`${baseUrl}/api/align-words`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string };
    };
    expect(payload.error.code).toBe('INVALID_ALIGN_REQUEST');
  });

  it('refines word timings via wav2vec2 when weights are present', async () => {
    const wav = tinyWav();
    const audioBase64 = Buffer.from(wav).toString('base64');
    const response = await fetch(`${baseUrl}/api/align-words`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audio: audioBase64,
        sampleRateHz: 16_000,
        timebaseId: 'audio:align-test',
        segments: [
          {
            id: 'seg-a',
            text: 'hello world',
            start: 0,
            end: 0.3,
          },
        ],
      }),
    });

    if (response.status === 503) {
      // wav2vec2 weights or ffmpeg missing — typed configuration error.
      const payload = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(['MODEL_MISSING', 'FFMPEG_MISSING']).toContain(payload.error.code);
      return;
    }

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      words: {
        text: string;
        start: { value: number };
        end: { value: number };
      }[];
      confidence: number;
      algorithm: string;
      provider: string;
    };
    expect(payload.algorithm).toBe('ctc-viterbi');
    expect(payload.provider).toContain('wav2vec2');
    expect(payload.words.length).toBeGreaterThanOrEqual(1);
    expect(payload.words[0]!.start.value).toBeLessThan(payload.words[0]!.end.value);
    expect(payload.confidence).toBeGreaterThan(0);
  }, 60_000);

  it('accepts pre-decoded PCM Float32LE base64', async () => {
    const sampleRateHz = 16_000;
    const pcm = new Float32Array(Math.floor(sampleRateHz * 0.25)).fill(0.05);
    const pcmBase64 = Buffer.from(pcm.buffer).toString('base64');
    const response = await fetch(`${baseUrl}/api/align-words`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pcm: pcmBase64,
        sampleRateHz,
        timebaseId: 'audio:pcm-test',
        segments: [{ id: 's1', text: 'hi', start: 0, end: 0.25 }],
      }),
    });
    if (response.status === 503) {
      const payload = (await response.json()) as {
        error: { code: string };
      };
      expect(payload.error.code).toBe('MODEL_MISSING');
      return;
    }
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      words: unknown[];
      provider: string;
    };
    expect(payload.provider).toContain('wav2vec2');
    expect(payload.words).toHaveLength(1);
  }, 60_000);
});
