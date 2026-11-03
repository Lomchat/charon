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

// ── Paths written as plain text ─────────────────────────────────────────────
// An agent reporting "the doc is ready: /srv/app/docs/report.html." rarely
// writes a Markdown link. Prose is NOT a link target, so this side is strict
// where `messageFileTarget` is lenient: a path needs a separator (a bare
// `Next.js` is a word) and a file-like leaf (`TCP/IP`, `and/or` and
// `/v1/models` are not files). Every hit still goes through
// `messageFileTarget`, which owns the VPS/root identity and its refusals.

// One segment: path characters, plus Next-style `[id]`/`[[...slug]]` folders.
const SEG = String.raw`(?:[\p{L}\p{N}_@%+~.-]|\[\[?(?:\.\.\.)?[\p{L}\p{N}_-]+\]\]?)+`;
const PATH_IN_TEXT = new RegExp(
  String.raw`(^|[\s(\[{<>"'«“‘,;=|])((?:~|\.{1,2})(?:\/${SEG})+|\/?${SEG}(?:\/${SEG})+)(:\d+(?::\d+)?)?`,
  'gu',
);
const EXTENSIONLESS = new Set([
  'Makefile', 'Dockerfile', 'LICENSE', 'README', 'CHANGELOG', 'Procfile', 'Gemfile',
  'Rakefile', 'Jenkinsfile', 'Caddyfile', 'Vagrantfile', 'Containerfile',
]);

function fileLike(path: string): boolean {
  const segs = path.split('/');
  const leaf = segs[segs.length - 1];
  if (!leaf || leaf === '.' || leaf === '..') return false;
  if (path.startsWith('/')) {
    // `/x.md` alone is more often a route than a file at the filesystem root.
    if (segs.length < 3) return false;
  } else if (!/^(?:~|\.{1,2})\//.test(path)) {
    // `github.com/org/x.md`, `Node.js/Deno`: a dotted FIRST word is a name.
    if (/^[^.]+\.[^.]/.test(segs[0])) return false;
  }
  return /^.+\.\p{L}[\p{L}\p{N}]{0,9}$/u.test(leaf)
    || EXTENSIONLESS.has(leaf)
    || /^\.[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(leaf);
}

export type TextPath = { start: number; end: number; href: string };

/** File paths in prose, with an optional `:line[:col]` citation. */
export function findTextPaths(text: string): TextPath[] {
  const out: TextPath[] = [];
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    const cite = m[3] ?? '';
    // The sentence's own full stop is not part of the file name.
    const path = cite ? m[2] : m[2].replace(/\.+$/, '');
    if (!fileLike(path)) continue;
    const start = (m.index ?? 0) + m[1].length;
    out.push({ start, end: start + path.length + cite.length, href: path + cite });
  }
  return out;
}

// ── Web URLs written as plain text ──────────────────────────────────────────
// Markdown bubbles get these from remark-gfm; plain bubbles (yours, a peer's,
// an agent's question) need their own. Only http(s): no other scheme in prose
// may become an href.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`«»“”‘’]+/giu;
const CLOSER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/** http(s) URLs in prose, minus the sentence's punctuation around them. */
export function findTextUrls(text: string): TextPath[] {
  const out: TextPath[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const start = m.index ?? 0;
    // `xhttps://…` is one word, not a link.
    if (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1])) continue;
    let url = m[0];
    for (;;) {
      const last = url[url.length - 1];
      const open = CLOSER_OF[last];
      // A closing bracket the URL never opened belongs to the prose: `(see https://x.y/a)`.
      if (/[.,;:!?…]/u.test(last) || (open && count(url, last) > count(url, open))) url = url.slice(0, -1);
      else break;
    }
    try { if (!new URL(url).hostname) continue; } catch { continue; }
    out.push({ start, end: start + url.length, href: url });
  }
  return out;
}

export type TextLink = TextPath & { kind: 'url' | 'path' };

/** URLs and accepted file paths, in text order; a path inside a URL is the URL's. */
export function findTextLinks(text: string, acceptPath?: (href: string) => boolean): TextLink[] {
  const urls: TextLink[] = findTextUrls(text).map((u) => ({ ...u, kind: 'url' }));
  const paths: TextLink[] = acceptPath
    ? findTextPaths(text)
      .filter((p) => acceptPath(p.href) && !urls.some((u) => p.start < u.end && u.start < p.end))
      .map((p) => ({ ...p, kind: 'path' }))
    : [];
  return [...urls, ...paths].sort((a, b) => a.start - b.start);
}

/** The whole string is one path (an inline `code` span, say). */
export function wholeTextPath(text: string): string | null {
  const t = text.trim();
  const hits = findTextPaths(t);
  return hits.length === 1 && hits[0].start === 0 && hits[0].end === t.length ? hits[0].href : null;
}

/** The whole string is one http(s) URL (an inline `code` span, say). */
export function wholeTextUrl(text: string): string | null {
  const t = text.trim();
  const hits = findTextUrls(t);
  return hits.length === 1 && hits[0].start === 0 && hits[0].end === t.length ? hits[0].href : null;
}

// Minimal mdast: the plugin only reads types, values and children.
type MdNode = {
  type: string; value?: string; url?: string; title?: string | null;
  children?: MdNode[]; data?: Record<string, unknown>;
};
// Never inside an existing link, a code block, raw HTML or an image.
const SKIP = new Set(['link', 'linkReference', 'code', 'html', 'definition', 'image', 'imageReference', 'inlineMath', 'math']);

function linkNode(href: string, children: MdNode[]): MdNode {
  return { type: 'link', url: href, title: null, children, data: { hProperties: { className: ['file-path-link'] } } };
}

function linkify(node: MdNode, accept: (href: string) => boolean): void {
  if (!node.children) return;
  const out: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      const hits = findTextPaths(child.value).filter((h) => accept(h.href));
      if (hits.length) {
        let at = 0;
        for (const h of hits) {
          if (h.start > at) out.push({ type: 'text', value: child.value.slice(at, h.start) });
          out.push(linkNode(h.href, [{ type: 'text', value: child.value.slice(h.start, h.end) }]));
          at = h.end;
        }
        if (at < child.value.length) out.push({ type: 'text', value: child.value.slice(at) });
        changed = true;
        continue;
      }
    } else if (child.type === 'inlineCode' && child.value) {
      const href = wholeTextPath(child.value);
      if (href && accept(href)) { out.push(linkNode(href, [child])); changed = true; continue; }
    } else if (!SKIP.has(child.type)) {
      linkify(child, accept);
    }
    out.push(child);
  }
  if (changed) node.children = out;
}

/**
 * remark plugin: bare paths and `code` paths become links, which the
 * message's `a` (MessageLink) opens as explorer tabs. `accept` is the caller's
 * `messageFileTarget` check — no VPS, no link.
 */
export function remarkFilePaths(options: { accept: (href: string) => boolean }) {
  return (tree: MdNode) => { linkify(tree, options.accept); };
}

function linkCodeUrls(node: MdNode): void {
  const children = node.children ?? [];
  children.forEach((child, i) => {
    if (child.type === 'inlineCode' && child.value) {
      const href = wholeTextUrl(child.value);
      if (href) children[i] = { type: 'link', url: href, title: null, children: [child] };
    } else if (!SKIP.has(child.type)) {
      linkCodeUrls(child);
    }
  });
}

/**
 * remark plugin: a `code` span that is exactly one web URL is a link too —
 * remark-gfm autolinks prose only. Needs no VPS, so it rides every Markdown view.
 */
export function remarkCodeUrls() {
  return (tree: MdNode) => { linkCodeUrls(tree); };
}
