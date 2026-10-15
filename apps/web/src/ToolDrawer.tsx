import type { ReactNode } from 'react';

export interface ToolDrawerProps {
  readonly tool: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

const TOOL_LABELS: Record<string, string> = {
  pages: 'Pages',
  layers: 'Layers',
  import: 'Import pages',
  audio: 'Narration',
  media: 'Media',
  video: 'Composition',
  captions: 'Captions',
  bubbles: 'Bubbles',
  ocr: 'OCR · Detect',
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

export function ToolDrawerSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="tool-drawer-section">
      <h3>{title}</h3>
      {children}
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
