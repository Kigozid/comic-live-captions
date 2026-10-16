/** Browser stand-in for Node `node:path` (only the surface image-engine uses). */
function basename(p: string, ext?: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  let base = idx === -1 ? normalized : normalized.slice(idx + 1);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
  return base;
}

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '.' : normalized.slice(0, idx) || '/';
}

function join(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

export { basename, dirname, join, extname };
export default { basename, dirname, join, extname };
