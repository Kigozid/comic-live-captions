import { describe, expect, it } from 'vitest';
import {
  ProjectService,
  migrateProject,
  type ProjectAssetRef,
  type ProjectRepository,
  type ProjectSnapshot,
} from '../../apps/web/src/project-persistence.js';

class MemoryProjects implements ProjectRepository {
  readonly projects = new Map<string, ProjectSnapshot>();
  readonly assets = new Map<string, { blob: Blob; mediaType: string }>();
  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }
  async listProjects() {
    return [...this.projects.values()].map(
      ({ id, name, updatedAt, revision }) => ({
        id,
        name,
        updatedAt,
        revision,
      }),
    );
  }
  async putProject(project: ProjectSnapshot) {
    this.projects.set(project.id, project);
  }
  async deleteProject(id: string) {
    this.projects.delete(id);
  }
  async getAsset(hash: string) {
    return this.assets.get(hash) ?? null;
  }
  async putAsset(hash: string, blob: Blob, mediaType: string) {
    if (!this.assets.has(hash)) this.assets.set(hash, { blob, mediaType });
  }
}

describe('local project persistence', () => {
  it('saves, opens, duplicates, and exports assets once by content hash', async () => {
    const repository = new MemoryProjects();
    const service = new ProjectService(
      repository,
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const blob = new Blob(['one comic page'], { type: 'image/png' });
    const { hashBlob } =
      await import('../../apps/web/src/project-persistence.js');
    const hash = await hashBlob(blob);
    const asset: ProjectAssetRef = {
      hash,
      role: 'original',
      filename: 'page.png',
      mediaType: 'image/png',
      sizeBytes: blob.size,
      metadata: { dimensions: { width: 2, height: 2 } },
    };
    const draft = {
      ...service.newProject('Test'),
      assets: [asset],
      alignment: { scale: 1 },
      bubbles: [{ id: 'b1' }],
      textRegions: [{ id: 'r1' }],
      ocr: [{ text: 'hi' }],
      transcript: { id: 't1' },
      mappings: [{ bubbleId: 'b1' }],
      captionLayouts: [{ id: 'l1' }],
      timeline: [{ start: 1, end: 2 }],
      styles: { fontSize: 24 },
      renderSettings: { frameRate: 24 },
      editor: { selection: null },
    } satisfies ProjectSnapshot;
    const saved = await service.save(draft, [
      { hash, blob, mediaType: 'image/png' },
    ]);
    const duplicated = await service.duplicate(saved.id);
    expect(duplicated.id).not.toBe(saved.id);
    expect(duplicated.assets[0]?.hash).toBe(hash);
    expect(repository.assets.size).toBe(1);
    const archive = await service.exportArchive(saved);
    expect(archive.assets).toHaveLength(1);
    expect((await service.open(saved.id)).timeline).toEqual([
      { start: 1, end: 2 },
    ]);
    const imported = await service.importArchive(archive);
    expect(imported.id).not.toBe(saved.id);
    expect(repository.assets.size).toBe(1);
  });

  it('migrates schema v1 defaults and rejects unknown future schemas', () => {
    const migrated = migrateProject({
      format: 'comic-captioner-project',
      schemaVersion: 1,
      id: 'legacy',
      name: 'Legacy',
      revision: 0,
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
      assets: [],
      alignment: null,
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated).toMatchObject({
      bubbles: [],
      textRegions: [],
      ocr: [],
      transcript: null,
      mappings: [],
      captionLayouts: [],
      timeline: [],
      styles: {},
      renderSettings: {},
      editor: null,
    });
    expect(() =>
      migrateProject({ format: 'comic-captioner-project', schemaVersion: 99 }),
    ).toThrow(/Unsupported project schema/);
  });
});
