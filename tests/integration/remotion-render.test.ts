import { afterAll, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VideoExportError,
  __testing__resetJobs,
  createVideoExportJob,
  getVideoExportJob,
  readVideoExportArtifact,
  type VideoExportRequest,
} from '../../apps/api/src/remotion-export.js';

/**
 * Minimal integration: render a short sample composition through Remotion and
 * verify the MP4 on disk. Requires Chrome Headless Shell (auto-downloaded).
 */
const RUN_RENDERS = process.env.COMIC_SKIP_RENDERS !== '1';

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Solid 64×64 PNG without external image libraries. */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.from(row);
    for (let x = 0; x < width; x += 1) {
      line[1 + x * 3] = 40;
      line[1 + x * 3 + 1] = 80;
      line[1 + x * 3 + 2] = 160;
    }
    rows.push(line);
  }
  const raw = Buffer.concat(rows);
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 0.4 s of 16 kHz mono PCM16 silence as a WAV. */
function makeWav(durationSeconds = 0.4, sampleRate = 16_000): Buffer {
  const samples = Math.floor(durationSeconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

afterAll(() => {
  __testing__resetJobs();
});

describe.runIf(RUN_RENDERS)('Remotion sample MP4 render', () => {
  it('renders a short sample composition and verifies the MP4', async () => {
    const page = makePng(64, 64);
    const audio = makeWav(0.4);
    const request: VideoExportRequest = {
      pageImage: page.toString('base64'),
      pageWidth: 64,
      pageHeight: 64,
      audio: audio.toString('base64'),
      audioFormat: 'wav',
      durationSeconds: 0.4,
      fps: 5,
      resolution: { resolution: 'custom', width: 128, height: 128 },
      captions: [
        {
          id: 'cue-1',
          bubbleId: 'bubble-1',
          caption: 'Hello comic',
          start: 0,
          end: 0.4,
          mapped: true,
          words: [
            { text: 'Hello', start: 0, end: 0.2 },
            { text: 'comic', start: 0.2, end: 0.4 },
          ],
        },
      ],
      bubbles: [
        {
          id: 'bubble-1',
          polygon: {
            points: [
              { x: 4, y: 4 },
              { x: 60, y: 4 },
              { x: 60, y: 40 },
              { x: 4, y: 40 },
            ],
          },
        },
      ],
      captionStyle: {
        revealMode: 'word-by-word',
        karaoke: true,
      },
    };

    const job = await createVideoExportJob(request);
    expect(job.id).toBeTruthy();

    // Poll until the job settles. First render also downloads Chrome.
    const deadline = Date.now() + 180_000;
    let current = getVideoExportJob(job.id);
    while (Date.now() < deadline) {
      current = getVideoExportJob(job.id);
      if (
        current.status === 'succeeded' ||
        current.status === 'failed' ||
        current.status === 'cancelled'
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (current.status !== 'succeeded') {
      throw new VideoExportError(
        'RENDER_FAILED',
        `Sample render did not succeed (status=${current.status}, error=${current.error?.message ?? 'none'})`,
      );
    }

    expect(current.output?.width).toBe(128);
    expect(current.output?.height).toBe(128);
    expect(current.output?.hasAudio).toBe(true);
    expect(current.output?.bytes ?? 0).toBeGreaterThan(500);
    expect(current.output?.durationSeconds ?? 0).toBeGreaterThan(0.2);

    const artifact = await readVideoExportArtifact(job.id);
    expect(artifact.bytes.byteLength).toBeGreaterThan(500);
    // ftyp box signature for MP4
    expect(String.fromCharCode(...artifact.bytes.subarray(4, 8))).toBe('ftyp');

    // Keep a copy under tmp for manual inspection when the test runs.
    const dir = await mkdtemp(join(tmpdir(), 'comic-video-verify-'));
    await writeFile(join(dir, 'sample.mp4'), artifact.bytes);
    const reread = await readFile(join(dir, 'sample.mp4'));
    expect(reread.byteLength).toBe(artifact.bytes.byteLength);
    await rm(dir, { recursive: true, force: true });
  }, 200_000);

  it(
    'renders a multi-shot panel sequence MP4',
    async () => {
      const page = makePng(128, 64);
      const audio = makeWav(0.6);
      const request: VideoExportRequest = {
        pageImage: page.toString('base64'),
        pageWidth: 128,
        pageHeight: 64,
        audio: audio.toString('base64'),
        audioFormat: 'wav',
        durationSeconds: 0.6,
        fps: 5,
        resolution: { resolution: 'custom', width: 128, height: 128 },
        panelSequence: [
          {
            id: 'shot-1',
            bounds: { x: 0, y: 0, width: 64, height: 64 },
            startSeconds: 0,
            endSeconds: 0.3,
            label: 'left panel',
          },
          {
            id: 'shot-2',
            bounds: { x: 64, y: 0, width: 64, height: 64 },
            startSeconds: 0.3,
            endSeconds: 0.6,
            label: 'right panel',
          },
        ],
        captions: [
          {
            id: 'cue-left',
            bubbleId: 'bubble-left',
            caption: 'Left',
            start: 0,
            end: 0.3,
            mapped: true,
          },
          {
            id: 'cue-right',
            bubbleId: 'bubble-right',
            caption: 'Right',
            start: 0.3,
            end: 0.6,
            mapped: true,
          },
        ],
        bubbles: [
          {
            id: 'bubble-left',
            polygon: {
              points: [
                { x: 4, y: 4 },
                { x: 50, y: 4 },
                { x: 50, y: 40 },
                { x: 4, y: 40 },
              ],
            },
          },
          {
            id: 'bubble-right',
            polygon: {
              points: [
                { x: 70, y: 4 },
                { x: 120, y: 4 },
                { x: 120, y: 40 },
                { x: 70, y: 40 },
              ],
            },
          },
        ],
      };

      const job = await createVideoExportJob(request);
      const deadline = Date.now() + 180_000;
      let current = getVideoExportJob(job.id);
      while (Date.now() < deadline) {
        current = getVideoExportJob(job.id);
        if (
          current.status === 'succeeded' ||
          current.status === 'failed' ||
          current.status === 'cancelled'
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (current.status !== 'succeeded') {
        throw new VideoExportError(
          'RENDER_FAILED',
          `Panel sequence render did not succeed (status=${current.status}, error=${current.error?.message ?? 'none'})`,
        );
      }
      expect(current.output?.width).toBe(128);
      expect(current.output?.hasAudio).toBe(true);
      expect(current.output?.durationSeconds ?? 0).toBeGreaterThan(0.4);
      const artifact = await readVideoExportArtifact(job.id);
      expect(String.fromCharCode(...artifact.bytes.subarray(4, 8))).toBe('ftyp');
      expect(artifact.bytes.byteLength).toBeGreaterThan(500);
    },
    200_000,
  );

  it(
    'renders a multi-page (3 source images) MP4 sequence',
    async () => {
      const pageA = makePng(64, 64);
      const pageB = makePng(64, 64);
      const pageC = makePng(64, 64);
      const audio = makeWav(0.9);
      const request: VideoExportRequest = {
        pageImage: pageA.toString('base64'),
        pageWidth: 64,
        pageHeight: 64,
        audio: audio.toString('base64'),
        audioFormat: 'wav',
        durationSeconds: 0.9,
        fps: 5,
        resolution: { resolution: 'custom', width: 128, height: 128 },
        sourcePages: [
          {
            id: 'page-a',
            image: pageA.toString('base64'),
            width: 64,
            height: 64,
            startSeconds: 0,
            endSeconds: 0.3,
            label: 'Page A',
            bubbles: [
              {
                id: 'b-a',
                polygon: {
                  points: [
                    { x: 4, y: 4 },
                    { x: 50, y: 4 },
                    { x: 50, y: 40 },
                    { x: 4, y: 40 },
                  ],
                },
              },
            ],
          },
          {
            id: 'page-b',
            image: pageB.toString('base64'),
            width: 64,
            height: 64,
            startSeconds: 0.3,
            endSeconds: 0.6,
            label: 'Page B',
            bubbles: [
              {
                id: 'b-b',
                polygon: {
                  points: [
                    { x: 4, y: 4 },
                    { x: 50, y: 4 },
                    { x: 50, y: 40 },
                    { x: 4, y: 40 },
                  ],
                },
              },
            ],
          },
          {
            id: 'page-c',
            image: pageC.toString('base64'),
            width: 64,
            height: 64,
            startSeconds: 0.6,
            endSeconds: 0.9,
            label: 'Page C',
            bubbles: [
              {
                id: 'b-c',
                polygon: {
                  points: [
                    { x: 4, y: 4 },
                    { x: 50, y: 4 },
                    { x: 50, y: 40 },
                    { x: 4, y: 40 },
                  ],
                },
              },
            ],
          },
        ],
        captions: [
          {
            id: 'cue-a',
            bubbleId: 'b-a',
            caption: 'A',
            start: 0,
            end: 0.3,
            mapped: true,
          },
          {
            id: 'cue-b',
            bubbleId: 'b-b',
            caption: 'B',
            start: 0.3,
            end: 0.6,
            mapped: true,
          },
          {
            id: 'cue-c',
            bubbleId: 'b-c',
            caption: 'C',
            start: 0.6,
            end: 0.9,
            mapped: true,
          },
        ],
        bubbles: [],
      };

      const job = await createVideoExportJob(request);
      const deadline = Date.now() + 180_000;
      let current = getVideoExportJob(job.id);
      while (Date.now() < deadline) {
        current = getVideoExportJob(job.id);
        if (
          current.status === 'succeeded' ||
          current.status === 'failed' ||
          current.status === 'cancelled'
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (current.status !== 'succeeded') {
        throw new VideoExportError(
          'RENDER_FAILED',
          `Multi-page render did not succeed (status=${current.status}, error=${current.error?.message ?? 'none'})`,
        );
      }
      expect(current.output?.hasAudio).toBe(true);
      expect(current.output?.durationSeconds ?? 0).toBeGreaterThan(0.6);
      const artifact = await readVideoExportArtifact(job.id);
      expect(String.fromCharCode(...artifact.bytes.subarray(4, 8))).toBe('ftyp');
    },
    200_000,
  );
});
