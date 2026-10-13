import { describe, expect, it } from 'vitest';
import type { AudioAssetRef, Page, Project } from '@comic-captioner/core';
import type {
  AssetId,
  AudioTimebaseId,
  ProjectId,
} from '@comic-captioner/shared';
import { createImageSpace } from '@comic-captioner/shared';

describe('core domain contracts', () => {
  it('represent page geometry with an explicit coordinate space', () => {
    const page: Page = {
      id: 'page-1' as Page['id'],
      geometryRevision: 0,
      originalImage: {
        id: 'asset-1' as AssetId,
        mediaType: 'image/png',
        contentHash: 'sha256:abc',
        dimensions: { width: 1200, height: 1800 },
        coordinateSpace: createImageSpace('asset:asset-1', 1200, 1800),
      },
      canonicalSpace: createImageSpace('page:page-1:0', 1200, 1800),
    };

    expect(page.originalImage?.coordinateSpace.kind).toBe('image');
    expect(page.canonicalSpace?.id).toBe('page:page-1:0');
  });

  it('represent audio timing in a named audio timebase', () => {
    const audio: AudioAssetRef = {
      id: 'audio-1' as AudioAssetRef['id'],
      filename: 'track.wav',
      mediaType: 'audio/wav',
      contentHash: 'sha256:def',
      sizeBytes: 128,
      durationSeconds: 12,
      sampleRateHz: 48_000,
      channelCount: 2,
      timebase: {
        id: 'audio:audio-1' as AudioTimebaseId,
        unit: 'seconds',
      },
    };

    expect(audio.timebase.id).toBe('audio:audio-1');
    expect(audio.timebase.unit).toBe('seconds');
  });

  it('gives projects explicit schema and optimistic revision fields', () => {
    const project: Project = {
      id: 'project-1' as ProjectId,
      schemaVersion: 1,
      revision: 0,
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      pages: [],
      audioAssets: [],
      proposals: [],
    };

    expect(project.revision).toBe(0);
    expect(project.pages).toHaveLength(0);
  });
});
