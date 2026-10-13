import { describe, expect, it } from 'vitest';
import {
  checkFfmpegAvailability,
  exportMp4WithFfmpeg,
  exportVideoWithRenderedFrames,
  FfmpegExportError,
} from '../../apps/api/src/export.js';

function fakePng(byte = 0): Uint8Array {
  // Minimal buffer; encoder tests that need real PNG content run only when
  // FFmpeg is installed. Validation tests use these as opaque frame bytes.
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, byte]);
}

describe('FFmpeg export validation', () => {
  it('rejects empty frames and invalid fps', async () => {
    await expect(
      exportMp4WithFfmpeg({
        frames: [],
        fps: 30,
        width: 1280,
        height: 720,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(
      exportMp4WithFfmpeg({
        frames: [fakePng()],
        fps: 0,
        width: 1280,
        height: 720,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects invalid dimensions', async () => {
    await expect(
      exportMp4WithFfmpeg({
        frames: [fakePng()],
        fps: 24,
        width: 4,
        height: 720,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reports typed FFMPEG_MISSING when the binary is absent', async () => {
    const availability = await checkFfmpegAvailability();
    if (availability.available) {
      // Environment has FFmpeg; the missing-binary path cannot be forced
      // without PATH isolation. The typed error is still asserted when
      // export is attempted after a failed probe below.
      expect(availability.path).toBeTruthy();
      return;
    }
    expect(availability.available).toBe(false);
    expect(availability.installHint).toContain('ffmpeg');
    await expect(
      exportMp4WithFfmpeg({
        frames: [fakePng()],
        fps: 24,
        width: 64,
        height: 64,
      }),
    ).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });
  });

  it('rejects invalid frameCount in the render-then-encode helper', async () => {
    await expect(
      exportVideoWithRenderedFrames({
        frameCount: 0,
        fps: 24,
        width: 64,
        height: 64,
        renderFrame: async () => fakePng(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('honors abort before encoding', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportMp4WithFfmpeg({
        frames: [fakePng()],
        fps: 24,
        width: 64,
        height: 64,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('exportVideoWithRenderedFrames', () => {
  it('collects frames and reports progress before encode', async () => {
    const availability = await checkFfmpegAvailability();
    if (!availability.available) {
      // Without FFmpeg the helper still validates then fails typed at encode.
      await expect(
        exportVideoWithRenderedFrames({
          frameCount: 2,
          fps: 24,
          width: 64,
          height: 64,
          renderFrame: async (index) => fakePng(index),
        }),
      ).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });
      return;
    }
    const progress: number[] = [];
    const result = await exportVideoWithRenderedFrames({
      frameCount: 2,
      fps: 24,
      width: 64,
      height: 64,
      renderFrame: async (index) => {
        // Real tiny black frames so FFmpeg can encode.
        const { default: sharp } = await import('sharp');
        return new Uint8Array(
          await sharp({
            create: {
              width: 64,
              height: 64,
              channels: 3,
              background: { r: index * 80, g: 20, b: 40 },
            },
          })
            .png()
            .toBuffer(),
        );
      },
      onProgress: (done) => progress.push(done),
    });
    expect(result.frameCount).toBe(2);
    expect(result.codec).toBe('h264');
    expect(result.bytes.length).toBeGreaterThan(100);
    expect(progress).toEqual([1, 2]);
  });
});

describe('real FFmpeg encode verification', () => {
  it('encodes an actual H.264 MP4 when ffmpeg is on PATH', async () => {
    const availability = await checkFfmpegAvailability();
    expect(
      availability.available,
      `FFmpeg must be installed for encode verification. ${availability.installHint}`,
    ).toBe(true);
    expect(availability.path).toBeTruthy();
    expect(availability.version).toMatch(/ffmpeg/i);

    const { default: sharp } = await import('sharp');
    const frames: Uint8Array[] = [];
    for (let index = 0; index < 4; index += 1) {
      frames.push(
        new Uint8Array(
          await sharp({
            create: {
              width: 128,
              height: 72,
              channels: 3,
              background: { r: 30 + index * 40, g: 60, b: 120 },
            },
          })
            .png()
            .toBuffer(),
        ),
      );
    }
    const result = await exportMp4WithFfmpeg({
      frames,
      fps: 2,
      width: 128,
      height: 72,
    });
    expect(result.codec).toBe('h264');
    expect(result.frameCount).toBe(4);
    expect(result.bytes.byteLength).toBeGreaterThan(200);
    // ISO BMFF: bytes 4-8 are the 'ftyp' brand.
    expect(String.fromCharCode(...result.bytes.subarray(4, 8))).toBe('ftyp');
    // A valid MP4 also contains an mdat media-data box.
    const ascii = result.bytes.toString('latin1');
    expect(ascii).toContain('ftyp');
    expect(ascii).toContain('mdat');
  });
});

describe('FfmpegExportError', () => {
  it('carries a typed code and install hint on missing binary', () => {
    const error = new FfmpegExportError(
      'FFMPEG_MISSING',
      'FFmpeg is not installed or not on PATH. Install FFmpeg',
    );
    expect(error.code).toBe('FFMPEG_MISSING');
    expect(error.message).toContain('Install FFmpeg');
  });
});
