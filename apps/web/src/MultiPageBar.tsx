import type { PageWorkspace } from './project-pages.js';

export interface MultiPageBarProps {
  readonly pages: readonly PageWorkspace[];
  readonly activePageId: string | null;
  readonly disabled?: boolean;
  readonly onAddPage: () => void;
  readonly onImportPages: (files: readonly File[]) => void;
  readonly onSelectPage: (pageId: string) => void;
  readonly onMovePage: (pageId: string, delta: number) => void;
  readonly onRenamePage: (pageId: string, label: string) => void;
  readonly onRemovePage: (pageId: string) => void;
}

/**
 * Reading-order page stack for multi-page projects (10–15 comic pages).
 * The editor workspace edits the active page; export walks the full stack.
 */
export function MultiPageBar({
  pages,
  activePageId,
  disabled = false,
  onAddPage,
  onImportPages,
  onSelectPage,
  onMovePage,
  onRenamePage,
  onRemovePage,
}: MultiPageBarProps) {
  return (
    <section
      className="rounded-xl border border-slate-200 p-3 text-sm shadow-sm"
      style={{
        background: 'var(--ui-surface, #ffffff)',
        color: 'var(--ui-text, #1c1c22)',
        borderColor: 'var(--ui-border, #e2e2e8)',
      }}
      aria-label="Comic pages"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          Pages ({pages.length})
        </h3>
        <span className="text-xs text-slate-500">
          Multi-page issue export · target 10–15 pages
        </span>
        <button
          className="editor-button"
          type="button"
          disabled={disabled}
          onClick={onAddPage}
        >
          Add page
        </button>
        <label className="editor-button cursor-pointer">
          Import pages…
          <input
            className="sr-only"
            type="file"
            accept="image/*"
            multiple
            disabled={disabled}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              if (files.length > 0) onImportPages(files);
              event.currentTarget.value = '';
            }}
          />
        </label>
      </div>
      {pages.length === 0 ? (
        <p className="text-xs text-slate-600">
          No pages yet. Import one or more comic page images to build a
          multi-page sequence.
        </p>
      ) : (
        <ol className="flex flex-wrap gap-2">
          {pages.map((page, index) => {
            const active = page.id === activePageId;
            const hasImage = Boolean(page.cleanedBlob ?? page.originalBlob);
            return (
              <li
                key={page.id}
                className={`flex min-w-36 items-center gap-1 rounded-lg border px-2 py-1 text-xs ${
                  active
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-900'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
                }`}
              >
                <button
                  type="button"
                  className="font-semibold"
                  disabled={disabled}
                  onClick={() => onSelectPage(page.id)}
                >
                  {index + 1}. {page.label}
                </button>
                <span
                  className={hasImage ? 'text-emerald-700' : 'text-amber-700'}
                  title={hasImage ? 'Has image' : 'Missing image'}
                >
                  {hasImage ? '●' : '○'}
                </span>
                <button
                  type="button"
                  aria-label={`Move ${page.label} earlier`}
                  disabled={disabled || index === 0}
                  onClick={() => onMovePage(page.id, -1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  aria-label={`Move ${page.label} later`}
                  disabled={disabled || index === pages.length - 1}
                  onClick={() => onMovePage(page.id, 1)}
                >
                  →
                </button>
                <button
                  type="button"
                  aria-label={`Rename ${page.label}`}
                  disabled={disabled}
                  onClick={() => {
                    const label = window.prompt('Page label', page.label);
                    if (label?.trim()) onRenamePage(page.id, label.trim());
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${page.label}`}
                  disabled={disabled || pages.length <= 1}
                  onClick={() => onRemovePage(page.id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
