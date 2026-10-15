import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  SyntheticCtcPosteriorsProvider,
  type CtcFramePosteriorsProvider,
  type CtcFramePosteriors,
} from '@comic-captioner/audio-engine';
import { createApiServer } from '../../apps/api/src/server.js';

let server: Server;
let baseUrl: string;

const synthetic = new SyntheticCtcPosteriorsProvider({ frameShiftSeconds: 0.02 });

beforeAll(async () => {
  server = createApiServer({ ctcProvider: synthetic });
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

function pcmBase64(seconds = 1, sampleRateHz = 16_000, amplitude = 0.1): string {
  const pcm = new Float32Array(Math.floor(seconds * sampleRateHz));
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRateHz);
  }
  return Buffer.from(pcm.buffer).toString('base64');
}

async function align(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/align-words`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    words?: {
      id: string;
      text: string;
      start: { value: number };
      end: { value: number };
      speakerId: string | null;
      confidence: number | null;
    }[];
    confidence?: number;
    algorithm?: string;
    provider?: string;
    error?: { code: string; message: string };
  };
  return { status: response.status, payload };
}

describe('POST /api/align-words (mocked CTC provider)', () => {
  it('returns word timestamps in the declared timebase seconds', async () => {
    const { status, payload } = await align({
      pcm: pcmBase64(1),
      sampleRateHz: 16_000,
      timebaseId: 'audio:mock-align',
      segments: [
        { id: 'seg-a', text: 'hello world', start: 0, end: 1 },
      ],
    });
    expect(status).toBe(200);
    expect(payload.algorithm).toBe('ctc-viterbi');
    expect(payload.provider).toContain('synthetic-ctc');
    expect(payload.words!.length).toBeGreaterThanOrEqual(2);
    expect(payload.words!.map((w) => w.text.toLowerCase()).join(' ')).toContain(
      'hello',
    );
    for (const word of payload.words!) {
      expect(word.start.value).toBeGreaterThanOrEqual(0);
      expect(word.end.value).toBeGreaterThan(word.start.value);
      expect(word.end.value).toBeLessThanOrEqual(1.001);
    }
    expect(payload.confidence).toBeGreaterThan(0);
  });

  it('supports explicit words[] and multiple segments with a pause gap', async () => {
    const { status, payload } = await align({
      pcm: pcmBase64(3),
      sampleRateHz: 16_000,
      timebaseId: 'audio:mock-multi',
      segments: [
        {
          id: 'seg-1',
          words: ['one', 'two'],
          start: 0,
          end: 1.2,
          speakerId: 'spk_1',
        },
        {
          id: 'seg-2',
          words: ['three'],
          start: 1.8,
          end: 2.6,
          speakerId: 'spk_1',
        },
      ],
    });
    expect(status).toBe(200);
    expect(payload.words!.length).toBe(3);
    const texts = payload.words!.map((w) => w.text);
    expect(texts).toEqual(['one', 'two', 'three']);
    // Monotonic across the pause.
    for (let i = 1; i < payload.words!.length; i += 1) {
      expect(payload.words![i]!.start.value).toBeGreaterThanOrEqual(
        payload.words![i - 1]!.start.value,
      );
    }
    // Segment 2 words stay inside their interval window.
    const three = payload.words!.find((w) => w.text === 'three')!;
    expect(three.start.value).toBeGreaterThanOrEqual(1.7);
    expect(three.end.value).toBeLessThanOrEqual(2.7);
  });

  it('assigns acoustic word ids and speaker ids', async () => {
    const { payload } = await align({
      pcm: pcmBase64(0.8),
      sampleRateHz: 16_000,
      timebaseId: 'audio:mock-ids',
      segments: [
        {
          id: 'seg-x',
          text: 'hi there',
          start: 0,
          end: 0.8,
          speakerId: 'spk_9',
        },
      ],
    });
    expect(payload.words![0]!.id).toMatch(/^acoustic:seg-x:word-1$/);
    expect(payload.words![0]!.speakerId).toBe('spk_9');
  });

  it('rejects empty request bodies', async () => {
    const { status, payload } = await align({});
    expect(status).toBe(400);
    expect(payload.error!.code).toBe('INVALID_ALIGN_REQUEST');
  });

  it('rejects missing audio payload', async () => {
    const { status, payload } = await align({
      segments: [{ id: 's', text: 'hi', start: 0, end: 1 }],
    });
    expect(status).toBe(400);
    expect(payload.error!.code).toBe('INVALID_ALIGN_REQUEST');
  });

  it('rejects empty PCM', async () => {
    const empty = Buffer.from(new Float32Array(0).buffer).toString('base64');
    const { status, payload } = await align({
      pcm: empty,
      sampleRateHz: 16_000,
      segments: [{ id: 's', text: 'hi', start: 0, end: 1 }],
    });
    expect(status).toBe(400);
    expect(payload.error!.code).toBe('INVALID_ALIGN_REQUEST');
  });

  it('rejects invalid sample rates', async () => {
    const { status, payload } = await align({
      pcm: pcmBase64(0.5),
      sampleRateHz: 10,
      segments: [{ id: 's', text: 'hi', start: 0, end: 0.5 }],
    });
    expect(status).toBe(400);
    expect(payload.error!.code).toBe('INVALID_ALIGN_REQUEST');
  });

  it('rejects segments with inverted or non-finite intervals', async () => {
    const { status, payload } = await align({
      pcm: pcmBase64(1),
      sampleRateHz: 16_000,
      segments: [{ id: 'bad', text: 'hi', start: 1, end: 0.2 }],
    });
    expect(status).toBe(400);
    expect(payload.error!.code).toBe('INVALID_ALIGN_REQUEST');
    expect(payload.error!.message).toMatch(/start < end/i);
  });

  it('rejects segments with empty text and no words[]', async () => {
    const { status, payload } = await align({
      pcm: pcmBase64(1),
      sampleRateHz: 16_000,
      segments: [{ id: 'blank', text: '   ', start: 0, end: 1 }],
    });
    expect(status).toBe(400);
    expect(payload.error!.code).toBe('INVALID_ALIGN_REQUEST');
    expect(payload.error!.message).toMatch(/non-empty text/i);
  });

  it('returns ALIGNMENT_INVALID when the acoustic model fails', async () => {
    const failing: CtcFramePosteriorsProvider = {
      name: 'failing-ctc',
      async encode(): Promise<CtcFramePosteriors> {
        throw new Error('encoder exploded');
      },
    };
    const failServer = createApiServer({ ctcProvider: failing });
    await new Promise<void>((resolve) => {
      failServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = failServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/align-words`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pcm: pcmBase64(0.5),
          sampleRateHz: 16_000,
          segments: [{ id: 's', text: 'hi', start: 0, end: 0.5 }],
        }),
      });
      expect(response.status).toBe(422);
      const payload = (await response.json()) as {
        error: { code: string };
      };
      expect(payload.error.code).toBe('ALIGNMENT_INVALID');
    } finally {
      await new Promise<void>((resolve) => failServer.close(() => resolve()));
    }
  });
});
