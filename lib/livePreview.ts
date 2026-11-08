// ── Live view: an HTML file rendered as a browser would (§14.110) ──────────
// PLAIN module, zero imports: the browser (FileEditor's toggle, the iframe's
// sandbox attribute) and the server (the preview route's allow-list and CSP)
// read the SAME constants, and vitest loads it without a Next runtime.

/**
 * The sandbox the page runs in, verbatim in BOTH the iframe's `sandbox`
 * attribute and the route's `Content-Security-Policy: sandbox` header (the
 * header is what still holds when the URL is opened in a tab of its own).
 *
 * ⚠ Never `allow-same-origin`: the page is served from the hub's own origin,
 * and that token would hand its scripts the hub's cookies and API — a stored
 * XSS with root SSH on the fleet behind it. Never `allow-top-navigation`: a
 * page must not be able to take Charon itself away. What remains is a normal
 * browser tab minus its origin: scripts, forms, dialogs, popups (external
 * links open for real), downloads.
 */
export const LIVE_PREVIEW_SANDBOX = [
  'allow-scripts',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-downloads',
  'allow-pointer-lock',
].join(' ');

/** What a framed live page posts to its parent on an Esc it did not use. */
export const LIVE_PREVIEW_ESCAPE = 'charon:escape';

/**
 * Injected with the scrollbar into every whole HTML page the route serves:
 * keys inside the sandbox never reach the hub, so an Esc the page did not
 * take (`defaultPrevented`, read once the dispatch is over) is posted to the
 * parent — the full-screen pane closes on it. Framed only: a page opened in a
 * tab of its own has no parent to tell. The parent trusts only its own
 * frame's window, and all a message can do is close that pane.
 */
export const LIVE_PREVIEW_ESCAPE_RELAY = '<script data-charon-escape>(function(){'
  + 'if(window.parent===window)return;'
  + 'addEventListener("keydown",function(e){'
  + 'if(e.key!=="Escape"||e.isComposing)return;'
  + `setTimeout(function(){if(!e.defaultPrevented)parent.postMessage("${LIVE_PREVIEW_ESCAPE}","*")},0)`
  + '},true)})()</script>';

/** Files the explorer offers a Live view for. */
export function isLiveHtmlName(name: string): boolean {
  return /\.x?html?$/i.test(name);
}

const UTF8 = '; charset=utf-8';

// ⚠ A SECURITY boundary as much as a mime table. The preview route serves
// these extensions and NOTHING else: what a web page loads (markup, styles,
// scripts, media, fonts, data). Configuration, keys and source in other
// languages stay unreachable even to a page that knows their path — the
// page's scripts can fetch anything the table lists under the scope root.
// Text types declare utf-8: the agent's fs_read hands back utf-8 text, and an
// HTML file without a <meta charset> would otherwise render as windows-1252.
const LIVE_MIME: Record<string, string> = {
  html: `text/html${UTF8}`, htm: `text/html${UTF8}`, xhtml: `application/xhtml+xml${UTF8}`,
  css: `text/css${UTF8}`,
  js: `text/javascript${UTF8}`, mjs: `text/javascript${UTF8}`, cjs: `text/javascript${UTF8}`,
  json: `application/json${UTF8}`, map: `application/json${UTF8}`,
  geojson: `application/geo+json${UTF8}`, webmanifest: `application/manifest+json${UTF8}`,
  txt: `text/plain${UTF8}`, md: `text/plain${UTF8}`, csv: `text/csv${UTF8}`,
  tsv: `text/tab-separated-values${UTF8}`, xml: `application/xml${UTF8}`, vtt: `text/vtt${UTF8}`,
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', oga: 'audio/ogg', ogg: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};

/** Extension of the LAST segment, lower-cased, or '' (no dot, or a dotfile). */
export function livePreviewExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/** Content-type the preview serves this file with, or null: not served. */
export function livePreviewMimeFor(relPath: string): string | null {
  return LIVE_MIME[livePreviewExt(relPath)] ?? null;
}

const MAX_PATH = 4096;

/**
 * The URL tail after the token → a path relative to the token's root, or
 * null when it must not be served.
 *
 * Takes the RAW (still percent-encoded) segments: decoding is ours, so an
 * encoded `%2F` or `%2e%2e` cannot smuggle a separator or a parent past the
 * split. Refused: empty segments in the middle, `.`/`..`, any DOT-segment
 * (`.env`, `.git/`, `.ssh/` — hidden is private), separators and controls.
 * A trailing slash names the folder's `index.html`, like a web server.
 */
export function parseLivePreviewPath(rawSegments: string[]): string | null {
  const segs = [...rawSegments];
  if (segs.length === 0 || segs[segs.length - 1] === '') {
    if (segs.length) segs.pop();
    segs.push('index.html');
  }
  const out: string[] = [];
  for (const raw of segs) {
    let s: string;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (!s || s.startsWith('.')) return null;
    // eslint-disable-next-line no-control-regex
    if (/[/\\\x00-\x1f\x7f]/.test(s)) return null;
    out.push(s);
  }
  const rel = out.join('/');
  return rel.length > MAX_PATH ? null : rel;
}

/**
 * Where a page may be served from: the tab's root, unless the file sits under
 * a hidden folder of it — the route refuses dot-segments, so the scope moves
 * down to the deepest hidden folder on the way and the page keeps its
 * neighbours (`.cache/report/index.html` → root `.cache`, path `report/…`).
 */
export function livePreviewScope(root: string, relPath: string): { root: string; path: string } {
  const parts = relPath.split('/').filter((p) => p && p !== '.');
  let cut = 0;
  for (let i = 0; i < parts.length - 1; i++) if (parts[i].startsWith('.')) cut = i + 1;
  if (!cut) return { root, path: parts.join('/') };
  return {
    root: `${root.replace(/\/+$/, '')}/${parts.slice(0, cut).join('/')}`,
    path: parts.slice(cut).join('/'),
  };
}

/**
 * Does a write to `absPath` plausibly change a page served from `dir`? Its
 * subtree, a type the preview serves, nothing hidden — the page's own assets,
 * not every file an agent touches in the repo.
 */
export function livePreviewWatches(dir: string, absPath: string): boolean {
  const base = dir.replace(/\/+$/, '');
  if (!absPath.startsWith(`${base}/`)) return false;
  const rel = absPath.slice(base.length + 1);
  if (rel.split('/').some((s) => !s || s.startsWith('.'))) return false;
  return livePreviewMimeFor(rel) != null;
}

/** `/api/preview/<token>/<path>` with every segment encoded on its own. */
export function livePreviewUrl(token: string, relPath: string): string {
  return `/api/preview/${token}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}
