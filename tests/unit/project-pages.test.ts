import { describe, expect, it } from 'vitest';
import {
  buildMultiPageExportPlan,
  createPageWorkspace,
  movePage,
  pageExportImage,
  proposePagePacingSlices,
  replacePage,
} from '../../apps/web/src/project-pages.js';
import {
  migrateProject,
  PROJECT_SCHEMA_VERSION,
} from '../../apps/web/src/project-persistence.js';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

function pageWithImage(
  id: string,
  label: string,
  dialogues: { start: number; end: number }[] = [],
) {
  const workspace = {
    ...createPageWorkspace(label, id),
    original: {
      id: `${id}-meta`,
      role: 'original' as const,
      filename: `${label}.png`,
      format: 'PNG' as const,
      mediaType: 'image/png' as const,
      dimensions: { width: 100, height: 150 },
      sizeBytes: 4,
      sha256: 'x',
    },
    originalBlob: blobOf(id),
    editor: {
      imageSpace: {
        id: `space-${id}`,
        kind: 'image' as const,
        dimensions: { width: 100, height: 150 },
      },
      bubbles: {
        [`b-${id}`]: {
          id: `b-${id}`,
          kind: 'speech' as const,
          boundingBox: {
            x: 10,
            y: 10,
            width: 40,
            height: 30,
            coordinateSpace: {
              id: `space-${id}`,
              kind: 'image' as const,
              dimensions: { width: 100, height: 150 },
            },
          },
          polygon: {
            points: [
              {
                x: 10,
                y: 10,
                coordinateSpace: {
                  id: `space-${id}`,
                  kind: 'image' as const,
                  dimensions: { width: 100, height: 150 },
                },
              },
              {
                x: 50,
                y: 10,
                coordinateSpace: {
                  id: `space-${id}`,
                  kind: 'image' as const,
                  dimensions: { width: 100, height: 150 },
                },
              },
              {
                x: 50,
                y: 40,
                coordinateSpace: {
                  id: `space-${id}`,
                  kind: 'image' as const,
                  dimensions: { width: 100, height: 150 },
                },
              },
              {
                x: 10,
                y: 40,
                coordinateSpace: {
                  id: `space-${id}`,
                  kind: 'image' as const,
                  dimensions: { width: 100, height: 150 },
                },
              },
            ],
            coordinateSpace: {
              id: `space-${id}`,
              kind: 'image' as const,
              dimensions: { width: 100, height: 150 },
            },
          },
          confidence: 1,
        },
      },
      observations: {},
      dialogues: Object.fromEntries(
        dialogues.map((dialogue, index) => [
          `d-${id}-${index}`,
          {
            id: `d-${id}-${index}`,
            bubbleId: `b-${id}`,
            caption: `Line ${index}`,
            start: dialogue.start,
            end: dialogue.end,
            fontFamily: 'Arial',
            fontSizePx: 12,
            lineSpacingPx: 2,
            paddingPx: 4,
            position: {
              x: 0,
              y: 0,
              coordinateSpace: {
                id: `space-${id}`,
                kind: 'image' as const,
                dimensions: { width: 100, height: 150 },
              },
            },
            speakerId: 's',
            contextNote: '',
          },
        ]),
      ),
      order: dialogues.map((_, index) => `d-${id}-${index}`),
    },
  };
  return workspace;
}

describe('multi-page pacing', () => {
  it('tiles 12 pages across the narration without gaps or overlaps', () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index}`,
      dialogues:
        index % 2 === 0
          ? [{ startSeconds: index * 2, endSeconds: index * 2 + 1.5 }]
          : [],
    }));
    const slices = proposePagePacingSlices({
      pages,
      durationSeconds: 24,
    });
    expect(slices).toHaveLength(12);
    expect(slices[0]!.startSeconds).toBeCloseTo(0);
    expect(slices[slices.length - 1]!.endSeconds).toBeCloseTo(24);
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index]!.startSeconds).toBeCloseTo(
        slices[index - 1]!.endSeconds,
      );
      expect(slices[index]!.endSeconds).toBeGreaterThan(
        slices[index]!.startSeconds,
      );
    }
  });

  it('honors pacing overrides', () => {
    const slices = proposePagePacingSlices({
      pages: [
        {
          id: 'a',
          dialogues: [],
          pacingOverride: { startSeconds: 0, endSeconds: 5 },
        },
        { id: 'b', dialogues: [] },
      ],
      durationSeconds: 10,
    });
    expect(slices[0]!.endSeconds).toBeCloseTo(5);
    expect(slices[0]!.source).toBe('override');
    expect(slices[1]!.startSeconds).toBeCloseTo(5);
    expect(slices[1]!.endSeconds).toBeCloseTo(10);
  });
});

describe('multi-page export plan', () => {
  it('emits one source page per image and paces 12 pages', () => {
    const pages = Array.from({ length: 12 }, (_, index) =>
      pageWithImage(`p${index}`, `Page ${index + 1}`, [
        { start: index * 2, end: index * 2 + 1 },
      ]),
    );
    const plan = buildMultiPageExportPlan({
      pages,
      durationSeconds: 24,
      dialoguesByPageId: Object.fromEntries(
        pages.map((page) => [
          page.id,
          Object.values(page.editor?.dialogues ?? {}).map((dialogue) => ({
            id: dialogue.id,
            bubbleId: dialogue.bubbleId,
            caption: dialogue.caption,
            start: dialogue.start,
            end: dialogue.end,
          })),
        ]),
      ),
    });
    expect(plan.sourcePages).toHaveLength(12);
    expect(plan.captions.length).toBeGreaterThanOrEqual(12);
    expect(plan.pacing).toHaveLength(12);
    expect(plan.warnings.join(' ')).toContain('12 pages');
    for (const source of plan.sourcePages) {
      expect(
        pageExportImage(pages.find((page) => page.id === source.id)!),
      ).not.toBeNull();
      expect(source.endSeconds).toBeGreaterThan(source.startSeconds);
    }
  });

  it('reorders pages and replaces workspace entries', () => {
    const a = createPageWorkspace('A', 'a');
    const b = createPageWorkspace('B', 'b');
    const c = createPageWorkspace('C', 'c');
    let pages = [a, b, c];
    pages = movePage(pages, 'c', -2);
    expect(pages.map((page) => page.id)).toEqual(['c', 'a', 'b']);
    pages = replacePage(pages, { ...a, label: 'A2' });
    expect(pages.find((page) => page.id === 'a')?.label).toBe('A2');
  });
});

describe('project schema migration', () => {
  it('migrates schema v2 single-page projects to v3 pages', () => {
    const migrated = migrateProject({
      format: 'comic-captioner-project',
      schemaVersion: 2,
      id: 'proj',
      name: 'Test',
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      assets: [
        {
          hash: 'a'.repeat(64),
          role: 'original',
          filename: 'page.png',
          mediaType: 'image/png',
          sizeBytes: 10,
          metadata: {},
        },
        {
          hash: 'b'.repeat(64),
          role: 'audio',
          filename: 'voice.wav',
          mediaType: 'audio/wav',
          sizeBytes: 20,
          metadata: {},
        },
      ],
      alignment: null,
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
    expect(migrated.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(migrated.pages).toHaveLength(1);
    expect(migrated.pages[0]?.originalHash).toBe('a'.repeat(64));
    expect(
      migrated.assets.find((asset) => asset.role === 'original')?.pageId,
    ).toBe(migrated.pages[0]?.id);
    expect(
      migrated.assets.find((asset) => asset.role === 'audio')?.pageId,
    ).toBeUndefined();
  });
});
