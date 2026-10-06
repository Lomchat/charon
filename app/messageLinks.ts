export type MessageFileTarget = { vpsId: string; root: string; path: string; line?: number };

/** Collapse spelling-only dot segments without resolving VPS symlinks. */
function normalizePath(path: string): string {
  if (path === '~') return '~';
  const prefix = path.startsWith('~/') ? '~' : '';
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${prefix}/${parts.join('/')}`;
}

/** File links use the same VPS/root/relative identity as explorer file tabs. */
export function messageFileTarget(href: string, vpsId?: string, cwd?: string | null): MessageFileTarget | null {
  if (!vpsId || !href || href.startsWith('//') || href.startsWith('#')) return null;

  let local = href;
  if (/^file:/i.test(local)) {
    try {
      const url = new URL(local);
      if (url.hostname && url.hostname !== 'localhost') return null;
      local = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(local)) {
    return null;
  }

  // Keep Charon navigation and endpoint links as URLs. Bare relative web
  // links are ambiguous; recognise explicit paths and filenames instead.
  if (/^\/(?:api(?:\/|$)|login(?:[/?#]|$)|desk(?:[/?#]|$))/.test(local)) return null;
  const pathPart = local.split(/[?#]/, 1)[0];
  const absolute = pathPart.startsWith('/');
  if (!absolute && !/^(?:\.\.?\/|~\/)/.test(pathPart) && !/\.[a-z\d]+(?::\d+(?::\d+)?)?$/i.test(pathPart)) return null;

  let path: string;
  try { path = decodeURIComponent(pathPart); } catch { return null; }
  const citation = /:(\d+)(?::\d+)?$/.exec(path);
  const hashLine = /#L(\d+)/.exec(local);
  const parsedLine = Number(citation?.[1] ?? hashLine?.[1]);
  const line = Number.isSafeInteger(parsedLine) && parsedLine > 0 ? parsedLine : undefined;
  path = path.replace(/:\d+(?::\d+)?$/, '');
  if (!path || /[\x00-\x1f\x7f]/.test(path) || path.endsWith('/')) return null;
  const leaf = path.split('/').pop();
  if (leaf === '.' || leaf === '..') return null;
  if (!absolute && !path.startsWith('~/')) {
    if (!cwd) return null;
    path = `${cwd.replace(/\/$/, '')}/${path}`;
  }
  path = normalizePath(path);
  const workspace = cwd ? normalizePath(cwd) : null;
  // Files inside the session workspace reuse the explorer's exact tab key,
  // so clicking a citation focuses an existing tab instead of duplicating it.
  const prefix = workspace === '/' ? '/' : `${workspace}/`;
  if (workspace && path.startsWith(prefix) && path !== workspace) {
    return { vpsId, root: cwd!, path: path.slice(prefix.length), line };
  }
  const slash = path.lastIndexOf('/');
  const root = path.slice(0, slash) || '/';
  const name = path.slice(slash + 1);
  if (!name || name === '.' || name === '..') return null;
  return { vpsId, root, path: name, line };
}
