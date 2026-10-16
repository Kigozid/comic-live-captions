export const PROJECT_SCHEMA_VERSION = 3;
const DATABASE_NAME = 'comic-captioner-projects';
const DATABASE_VERSION = 1;

export interface ProjectAssetRef {
  readonly hash: string;
  readonly role: 'original' | 'cleaned' | 'audio';
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Set for page assets; omitted for project-global audio. */
  readonly pageId?: string;
}

/** One comic page in a multi-page project (schema v3). */
export interface ProjectPageRecord {
  readonly id: string;
  readonly label: string;
  readonly originalHash?: string;
  readonly cleanedHash?: string;
  readonly editor?: unknown;
  readonly panels?: readonly {
    readonly id: string;
    readonly bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly label?: string;
  }[];
  readonly pacingOverride?: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  };
}

export interface ProjectSnapshot {
  readonly format: 'comic-captioner-project';
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly assets: readonly ProjectAssetRef[];
  /** Reading-order page list. Empty on legacy projects until migrated. */
  readonly pages: readonly ProjectPageRecord[];
  readonly alignment: unknown | null;
  readonly bubbles: readonly unknown[];
  readonly textRegions: readonly unknown[];
  readonly ocr: readonly unknown[];
  readonly transcript: unknown | null;
  readonly mappings: readonly unknown[];
  readonly captionLayouts: readonly unknown[];
  readonly timeline: readonly unknown[];
  readonly styles: Readonly<Record<string, unknown>>;
  readonly renderSettings: Readonly<Record<string, unknown>>;
  readonly editor: unknown | null;
}

export interface ArchiveAsset {
  readonly hash: string;
  readonly mediaType: string;
  readonly base64: string;
}

export interface ProjectArchive {
  readonly format: 'comic-captioner-archive';
  readonly schemaVersion: number;
  readonly project: ProjectSnapshot;
  readonly assets: readonly ArchiveAsset[];
}

export interface ProjectRepository {
  getProject(id: string): Promise<ProjectSnapshot | null>;
  listProjects(): Promise<
    readonly Pick<ProjectSnapshot, 'id' | 'name' | 'updatedAt' | 'revision'>[]
  >;
  putProject(project: ProjectSnapshot): Promise<void>;
  deleteProject(id: string): Promise<void>;
  getAsset(
    hash: string,
  ): Promise<{ readonly blob: Blob; readonly mediaType: string } | null>;
  putAsset(hash: string, blob: Blob, mediaType: string): Promise<void>;
}

export class IndexedDbProjectRepository implements ProjectRepository {
  readonly #factory: IDBFactory;
  #database: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory = indexedDB) {
    this.#factory = factory;
  }

  async getProject(id: string): Promise<ProjectSnapshot | null> {
    return (
      (await this.#request<ProjectSnapshot | undefined>(
        'projects',
        'readonly',
        (store) => store.get(id),
      )) ?? null
    );
  }

  async listProjects(): Promise<
    readonly Pick<ProjectSnapshot, 'id' | 'name' | 'updatedAt' | 'revision'>[]
  > {
    const values = await this.#request<ProjectSnapshot[]>(
      'projects',
      'readonly',
      (store) => store.getAll(),
    );
    return values
      .map(({ id, name, updatedAt, revision }) => ({
        id,
        name,
        updatedAt,
        revision,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async putProject(project: ProjectSnapshot): Promise<void> {
    await this.#request('projects', 'readwrite', (store) => store.put(project));
  }
  async deleteProject(id: string): Promise<void> {
    await this.#request('projects', 'readwrite', (store) => store.delete(id));
  }

  async getAsset(
    hash: string,
  ): Promise<{ readonly blob: Blob; readonly mediaType: string } | null> {
    const asset = await this.#request<
      { blob: Blob; mediaType: string } | undefined
    >('assets', 'readonly', (store) => store.get(hash));
    return asset ?? null;
  }

  async putAsset(hash: string, blob: Blob, mediaType: string): Promise<void> {
    const current = await this.getAsset(hash);
    if (!current)
      await this.#request('assets', 'readwrite', (store) =>
        store.put({ hash, blob, mediaType }),
      );
  }

  async #request<T = IDBValidKey>(
    storeName: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const database = await (this.#database ??= this.#open());
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () =>
        reject(request.error ?? new Error('Project storage request failed.'));
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error('Project storage transaction aborted.'),
        );
    });
  }

  #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects'))
          db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets'))
          db.createObjectStore('assets', { keyPath: 'hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          request.error ?? new Error('Could not open local project storage.'),
        );
    });
  }
}

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAsset(hash: string): Promise<Blob | null> {
    return (await this.repository.getAsset(hash))?.blob ?? null;
  }

  newProject(name = 'Untitled comic'): ProjectSnapshot {
    const now = this.now().toISOString();
    return Object.freeze({
      format: 'comic-captioner-project',
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      name,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      assets: [],
      pages: [],
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
  }

  async open(id: string): Promise<ProjectSnapshot> {
    const project = await this.repository.getProject(id);
    if (!project) throw new Error('Project was not found in local storage.');
    return migrateProject(project);
  }

  async save(
    project: ProjectSnapshot,
    assets: readonly {
      readonly hash: string;
      readonly blob: Blob;
      readonly mediaType: string;
    }[] = [],
  ): Promise<ProjectSnapshot> {
    validateProject(project);
    for (const asset of assets) {
      if ((await hashBlob(asset.blob)) !== asset.hash)
        throw new Error('An asset hash did not match its content.');
      await this.repository.putAsset(asset.hash, asset.blob, asset.mediaType);
    }
    const saved = Object.freeze({
      ...project,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      revision: project.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    await this.repository.putProject(saved);
    return saved;
  }

  async saveAs(
    project: ProjectSnapshot,
    name: string,
    assets: readonly {
      readonly hash: string;
      readonly blob: Blob;
      readonly mediaType: string;
    }[] = [],
  ): Promise<ProjectSnapshot> {
    if (!name.trim()) throw new Error('Project name cannot be empty.');
    const copy = Object.freeze({
      ...project,
      id: crypto.randomUUID(),
      name: name.trim(),
      revision: 0,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });
    return this.save(copy, assets);
  }

  async duplicate(id: string, name?: string): Promise<ProjectSnapshot> {
    const source = await this.open(id);
    return this.saveAs(source, name ?? `${source.name} copy`);
  }

  async exportArchive(project: ProjectSnapshot): Promise<ProjectArchive> {
    const hashes = [...new Set(project.assets.map((asset) => asset.hash))];
    const assets: ArchiveAsset[] = [];
    for (const hash of hashes) {
      const stored = await this.repository.getAsset(hash);
      if (!stored)
        throw new Error(`Project asset ${hash} is missing from local storage.`);
      assets.push({
        hash,
        mediaType: stored.mediaType,
        base64: await blobToBase64(stored.blob),
      });
    }
    return Object.freeze({
      format: 'comic-captioner-archive',
      schemaVersion: PROJECT_SCHEMA_VERSION,
      project: migrateProject(project),
      assets: Object.freeze(assets),
    });
  }

  async importArchive(value: unknown): Promise<ProjectSnapshot> {
    const archive = migrateArchive(value);
    const decodedAssets: Array<{ ref: ArchiveAsset; blob: Blob }> = [];
    for (const asset of archive.assets) {
      const blob = base64ToBlob(asset.base64, asset.mediaType);
      if ((await hashBlob(blob)) !== asset.hash)
        throw new Error('Imported project asset failed its integrity check.');
      decodedAssets.push({ ref: asset, blob });
    }
    for (const { ref, blob } of decodedAssets)
      await this.repository.putAsset(ref.hash, blob, ref.mediaType);
    const imported = Object.freeze({
      ...archive.project,
      id: crypto.randomUUID(),
      revision: 0,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });
    await this.repository.putProject(imported);
    return imported;
  }

  async list(): Promise<
    readonly Pick<ProjectSnapshot, 'id' | 'name' | 'updatedAt' | 'revision'>[]
  > {
    return this.repository.listProjects();
  }
}

export async function hashBlob(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function migrateProject(value: unknown): ProjectSnapshot {
  if (
    !isObject(value) ||
    value.format !== 'comic-captioner-project' ||
    typeof value.schemaVersion !== 'number'
  )
    throw new Error('Unrecognized project document.');
  let project = value as unknown as Record<string, unknown>;
  if (project.schemaVersion === 1)
    project = {
      ...project,
      schemaVersion: 2,
      bubbles: project.bubbles ?? [],
      textRegions: project.textRegions ?? [],
      ocr: project.ocr ?? [],
      transcript: project.transcript ?? null,
      mappings: project.mappings ?? [],
      captionLayouts: project.captionLayouts ?? [],
      timeline: project.timeline ?? [],
      styles: project.styles ?? {},
      renderSettings: project.renderSettings ?? {},
      editor: project.editor ?? null,
    };
  if (project.schemaVersion === 2) {
    // v3 adds an explicit page list. Legacy single-page assets become page 1.
    const assets = Array.isArray(project.assets)
      ? (project.assets as ProjectAssetRef[])
      : [];
    const original = assets.find((asset) => asset.role === 'original');
    const cleaned = assets.find((asset) => asset.role === 'cleaned');
    const pageId = original?.pageId ?? cleaned?.pageId ?? crypto.randomUUID();
    project = {
      ...project,
      schemaVersion: 3,
      pages:
        original || cleaned
          ? [
              {
                id: pageId,
                label: 'Page 1',
                ...(original && typeof original.hash === 'string'
                  ? { originalHash: original.hash }
                  : {}),
                ...(cleaned && typeof cleaned.hash === 'string'
                  ? { cleanedHash: cleaned.hash }
                  : {}),
                editor: project.editor ?? null,
              },
            ]
          : [],
      assets: assets.map((asset) =>
        asset.role === 'audio'
          ? asset
          : { ...asset, pageId: asset.pageId ?? pageId },
      ),
    };
  }
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION)
    throw new Error(
      `Unsupported project schema version: ${String(project.schemaVersion)}.`,
    );
  validateProject(project as unknown as ProjectSnapshot);
  return project as unknown as ProjectSnapshot;
}

function migrateArchive(value: unknown): ProjectArchive {
  if (
    !isObject(value) ||
    value.format !== 'comic-captioner-archive' ||
    !Array.isArray(value.assets)
  )
    throw new Error('Invalid project archive.');
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== PROJECT_SCHEMA_VERSION)
    throw new Error(
      `Unsupported archive schema version: ${String(schemaVersion)}.`,
    );
  const project = migrateProject(value.project);
  const assets = value.assets.map((asset) => {
    if (
      !isObject(asset) ||
      typeof asset.hash !== 'string' ||
      typeof asset.mediaType !== 'string' ||
      typeof asset.base64 !== 'string'
    )
      throw new Error('Invalid archive asset.');
    return asset as unknown as ArchiveAsset;
  });
  const declared = new Set(project.assets.map((asset) => asset.hash));
  if (assets.some((asset) => !declared.has(asset.hash)))
    throw new Error('Archive contains an unreferenced asset.');
  const included = new Set(assets.map((asset) => asset.hash));
  if ([...declared].some((hash) => !included.has(hash)))
    throw new Error('Archive is missing a referenced asset.');
  return {
    format: 'comic-captioner-archive',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project,
    assets,
  };
}

function validateProject(value: ProjectSnapshot): void {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !Array.isArray(value.assets) ||
    !Array.isArray(value.pages)
  )
    throw new Error('Project metadata is invalid.');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new Error('Project revision is invalid.');
  for (const key of [
    'bubbles',
    'textRegions',
    'ocr',
    'mappings',
    'captionLayouts',
    'timeline',
  ] as const)
    if (!Array.isArray(value[key]))
      throw new Error(`Project ${key} must be an array.`);
  if (!isObject(value.styles) || !isObject(value.renderSettings))
    throw new Error('Project styles or render settings are invalid.');
  for (const asset of value.assets)
    if (
      !/^[a-f\d]{64}$/i.test(asset.hash) ||
      !['original', 'cleaned', 'audio'].includes(asset.role)
    )
      throw new Error('Project asset reference is invalid.');
  for (const page of value.pages) {
    if (!isObject(page) || typeof page.id !== 'string' || !page.id.trim())
      throw new Error('Project page id is invalid.');
    if (typeof page.label !== 'string' || !page.label.trim())
      throw new Error('Project page label is invalid.');
    const originalHash = (page as { originalHash?: unknown }).originalHash;
    const cleanedHash = (page as { cleanedHash?: unknown }).cleanedHash;
    if (
      originalHash != null &&
      (typeof originalHash !== 'string' || !/^[a-f\d]{64}$/i.test(originalHash))
    )
      throw new Error('Project page originalHash is invalid.');
    if (
      cleanedHash != null &&
      (typeof cleanedHash !== 'string' || !/^[a-f\d]{64}$/i.test(cleanedHash))
    )
      throw new Error('Project page cleanedHash is invalid.');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBlob(encoded: string, mediaType: string): Blob {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mediaType });
}
