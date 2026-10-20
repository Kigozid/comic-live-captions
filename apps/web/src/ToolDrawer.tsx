import type { ReactNode } from 'react';
import { useId, useState } from 'react';

export interface ToolDrawerProps {
  readonly tool: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const TOOL_LABELS: Record<string, string> = {
  pages: 'Pages',
  layers: 'Layers',
  import: 'Import',
  audio: 'Narration',
  media: 'Media',
  video: 'Composition',
  captions: 'Captions',
  bubbles: 'Bubbles',
  ocr: 'Draft',
  draft: 'Draft',
  export: 'Export',
  settings: 'Settings',
};

/**
 * Left tool drawer — IMG.LY dock panel equivalent. Compact, non-floating
 * column beside the canvas for the selected rail tool.
 */
export function ToolDrawer({ tool, onClose, children }: ToolDrawerProps) {
  return (
    <aside className="tool-drawer" aria-label={TOOL_LABELS[tool] ?? 'Tools'}>
      <header className="tool-drawer-header">
        <h2>{TOOL_LABELS[tool] ?? 'Tools'}</h2>
        <button
          className="ui-btn icon ghost"
          type="button"
          aria-label="Close tool panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="tool-drawer-body">{children}</div>
    </aside>
  );
}

/**
 * Collapsible drawer section. Use `defaultOpen` for the primary workflow
 * actions; leave advanced options closed so the panel stays minimal.
 */
export function ToolDrawerSection({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className={`tool-drawer-section ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="tool-drawer-section-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <h3>{title}</h3>
        {badge ? <span className="badge">{badge}</span> : null}
      </button>
      <div id={bodyId} hidden={!open} className="tool-drawer-section-body">
        {children}
      </div>
    </section>
  );
}

export function ToolDrawerRow({
  children,
  stacked = false,
}: {
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? 'tool-drawer-row stacked' : 'tool-drawer-row'}>
      {children}
    </div>
  );
}
