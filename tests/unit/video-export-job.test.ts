import { afterAll, describe, expect, it } from 'vitest';
import {
  VideoExportError,
  __testing__resetJobs,
  cancelVideoExportJob,
  checkVideoExportAvailability,
  createVideoExportJob,
  getVideoExportJob,
  readVideoExportArtifact,
  type VideoExportRequest,
} from '../../apps/api/src/remotion-export.js';

function tinyPngBase64(): string {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]).toString('base64');
}

function baseRequest(
  overrides: Partial<VideoExportRequest> = {},
): VideoExportRequest {
  return {
    pageImage: tinyPngBase64(),
    pageWidth: 64,
    pageHeight: 64,
    durationSeconds: 0.2,
    fps: 2,
    resolution: { resolution: 'custom', width: 64, height: 64 },
    captions: [],
    bubbles: [],
    ...overrides,
  };
}

afterAll(() => {
  __testing__resetJobs();
});

describe('Remotion video export job validation', () => {
  it('reports availability and licensing note without rendering', async () => {
    const availability = await checkVideoExportAvailability();
    expect(availability.maxConcurrentJobs).toBeGreaterThanOrEqual(1);
    expect(availability.renderConcurrency).toBeGreaterThanOrEqual(1);
    expect(availability.licenseNote.toLowerCase()).toContain('remotion');
  });

  it('rejects incomplete export requests with typed errors', async () => {
    await expect(
      createVideoExportJob({ durationSeconds: 0 } as VideoExportRequest),
    ).rejects.toBeInstanceOf(VideoExportError);
    await expect(
      createVideoExportJob(baseRequest({ pageImage: '' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      createVideoExportJob(
        baseRequest({
          captions: [
            {
              id: 'c1',
              bubbleId: 'missing',
              caption: 'Hello',
              start: 0,
              end: 5,
              layout: null,
              mapped: true,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns NOT_FOUND for unknown jobs and artifacts', async () => {
    expect(() => getVideoExportJob('missing-id')).toThrow(VideoExportError);
    await expect(readVideoExportArtifact('missing-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('creates a queued job and supports cancel', async () => {
    const job = await createVideoExportJob(
      baseRequest({
        durationSeconds: 1800,
        fps: 1,
        resolution: { resolution: 'custom', width: 16, height: 16 },
        pageWidth: 16,
        pageHeight: 16,
      }),
    );
    expect(job.id).toBeTruthy();
    expect([
      'queued',
      'preparing',
      'rendering',
      'failed',
      'cancelled',
    ]).toContain(job.status);
    const cancelled = cancelVideoExportJob(job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(getVideoExportJob(job.id).status).toBe('cancelled');
    await expect(readVideoExportArtifact(job.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
