import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FasterWhisperHttpSession } from '../../apps/api/src/faster-whisper.js';

/**
 * Regression: the faster-whisper service contract is signed 16-bit LE PCM.
 * The session used to forward the Float32Array's raw bytes labeled
 * `pcm-s16le`, so the worker re-interpreted float bit patterns as int16
 * samples — whisper transcribed noise (random auto-detected languages,
 * hallucinated text). Assert the bytes on the wire really are s16le.
 */
describe('FasterWhisperHttpSession PCM encoding', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = null;
  });

  it('posts float PCM as real s16le bytes', async () => {
    let captured: {
      encoding?: string;
      sampleRateHz?: number;
      audio?: string;
    } | null = null;
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            text: 'hello',
            language: 'en',
            languageProbability: 0.99,
            durationSeconds: 1,
            words: [{ text: 'hello', startSeconds: 0, endSeconds: 0.4 }],
            segments: [],
            model: 'small',
            computeType: 'int8',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server!.address() as AddressInfo).port;

    const session = new FasterWhisperHttpSession({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    // Distinct float values that would look like garbage if their IEEE-754
    // bytes were re-read as int16 samples.
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    await session.transcribe({ pcm, sampleRateHz: 16_000 });

    expect(captured).not.toBeNull();
    expect(captured!.encoding).toBe('pcm-s16le');
    expect(captured!.sampleRateHz).toBe(16_000);
    const bytes = Buffer.from(captured!.audio!, 'base64');
    expect(bytes.byteLength).toBe(pcm.length * 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoded = Array.from({ length: pcm.length }, (_, i) =>
      view.getInt16(i * 2, true),
    );
    expect(decoded[0]).toBe(0);
    expect(decoded[1]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(decoded[2]).toBe(Math.round(-0.5 * 0x8000));
    expect(decoded[3]).toBe(0x7fff);
    expect(decoded[4]).toBe(-0x8000);
  });
});
