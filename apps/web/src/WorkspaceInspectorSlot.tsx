import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Mount point in the shell inspector for workspace-owned review tools.
 * EditingWorkspace portals selection review UI here so the canvas stage
 * stays free of nested inspector chrome.
 */
export function WorkspaceInspectorSlot() {
  return <div id="workspace-inspector-slot" />;
}

export function WorkspaceInspectorPortal({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const findHost = () => document.getElementById('workspace-inspector-slot');
    const existing = findHost();
    if (existing) {
      setHost(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = findHost();
      if (!el) return;
      setHost(el);
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!host) return null;
  return createPortal(children, host);
}
