// Rendered views of a file (§14.111): which files have one, how a Markdown
// document's links and images resolve, and which file panes stay mounted.
// PLAIN module, zero imports — the pane, the panel and vitest share it.

/** Markdown — kept for its callers; `viewerFor` is the general question. */
export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/**
 * GitHub-style heading anchor: `## Getting started!` → `getting-started`,
 * repeats get `-1`, `-2`. `seen` is per document render.
 */
export function markdownSlug(text: string, seen: Map<string, number>): string {
  const base = text.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** Collapse `.`/`..` without touching the filesystem. */
function normalizeAbs(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * A Markdown document's link/image reference → an absolute path on the VPS,
 * or null when it is not a local file (a URL, `mailto:`, an in-page `#`).
 * Relative references resolve against the DOCUMENT's folder, the way GitHub
 * and every editor preview read them; `?query` is dropped, `#fragment` kept.
 */
export function resolveDocPath(docDir: string, ref: string): string | null {
  if (!ref || ref.startsWith('#') || ref.startsWith('//')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(ref)) return null;
  const hashAt = ref.indexOf('#');
  const hash = hashAt >= 0 ? ref.slice(hashAt) : '';
  let path = (hashAt >= 0 ? ref.slice(0, hashAt) : ref).split('?', 1)[0];
  try { path = decodeURIComponent(path); } catch { return null; }
  if (!path) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return null;
  const abs = path.startsWith('/') ? path : `${docDir.replace(/\/+$/, '')}/${path}`;
  return normalizeAbs(abs) + hash;
}

/** A path relative to `root` as an absolute one; a root of `/` gives `/x`, not `//x`. */
export function absUnderRoot(root: string | null, path: string): string {
  return `${(root ?? '').replace(/\/+$/, '')}/${path}`;
}

/**
 * The (root, path) pair the file routes take for an absolute path: inside the
 * tab's root when it is, else its own folder — containment is per request.
 */
export function rootedPath(root: string, abs: string): { root: string; path: string } {
  const base = root.replace(/\/+$/, '');
  if (abs.startsWith(`${base}/`)) return { root, path: abs.slice(base.length + 1) };
  const slash = abs.lastIndexOf('/');
  return { root: abs.slice(0, slash) || '/', path: abs.slice(slash + 1) };
}

/**
 * The file panes kept MOUNTED, oldest first (§14.111): the newest `max` that
 * were shown, plus every one holding unsaved edits — eviction would throw
 * the buffer away. `open` is the set of keys that still have a tab; a closed
 * tab's pane goes, dirty or not (closing already asked).
 */
export function nextMountedFiles(
  prev: readonly string[], shown: string | null, open: ReadonlySet<string>,
  dirty: ReadonlySet<string>, max: number,
): string[] {
  const keys = prev.filter((k) => open.has(k) && k !== shown);
  if (shown && open.has(shown)) keys.push(shown);
  let excess = keys.length - max;
  const out: string[] = [];
  for (const k of keys) {
    if (excess > 0 && k !== shown && !dirty.has(k)) { excess--; continue; }
    out.push(k);
  }
  return out;
}

/**
 * Zoom factor of one Ctrl+wheel event. A trackpad pinch sends many small
 * deltas and wants them proportional; a mouse notch sends ~100 at once and
 * must not leap 7×. Capped to ±60 px-equivalent (≈1.6× a notch).
 */
export function wheelFactor(e: { deltaY: number; deltaMode: number }): number {
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  return Math.exp(-Math.max(-60, Math.min(60, px)) * 0.008);
}

// ── Viewer contract (§14.112) ───────────────────────────────────────────────
// Every rendered view of a file is a default-exported component taking one of
// these, loaded lazily by FileEditor. `active` = the pane is on screen
// (§14.111): a hidden viewer keeps its state but stops animating/polling.

/** A viewer that reads the file's BYTES itself (binary formats). */
export type ByteViewerProps = {
  vpsId: string;
  /** The tab's root; `path` is relative to it. */
  root: string;
  path: string;
  /** Leaf file name. */
  name: string;
  /** Same-origin URL of the raw bytes (cookie-authenticated, Range-capable). */
  url: string;
  /** Bumped when the file changed on the VPS: fetch again, keep the view state. */
  rev: number;
  active: boolean;
  /** A viewer that edits (a workbook) reports unsaved changes: the tab's dot,
   *  the close guard, and the pane is never evicted (§14.111). */
  onDirtyChange?: (dirty: boolean) => void;
};

/** A rendered view of a TEXT file: the pane's buffer, unsaved edits included. */
export type TextViewerProps = {
  vpsId: string;
  root: string;
  path: string;
  name: string;
  text: string;
  active: boolean;
};

// ── Which viewer opens a file (§14.112) ─────────────────────────────────────
// ONE table from extension to viewer. `text` viewers render the pane's buffer
// and sit next to the editor behind a View/Code toggle; `bytes` viewers read
// the file themselves and have no editor. A file the table does not know
// opens in the editor when it is text, in the hex view when it is binary.

export type ViewerKind =
  // text: a rendered view of the editable source
  | 'live' | 'markdown' | 'svg' | 'mermaid' | 'graphviz' | 'json' | 'notebook' | 'geo' | 'log'
  // bytes: the file as something to look at, not to type into
  | 'pdf' | 'image' | 'audio' | 'video' | 'convert-image' | 'office' | 'docx' | 'spreadsheet'
  | 'sqlite' | 'archive' | 'font' | 'model3d';

export type ViewerSpec = {
  kind: ViewerKind;
  source: 'text' | 'bytes';
  /** text viewers: the toggle's label (Live, View, Tree, Map, Tail). */
  label?: string;
  /** text viewers: open on the rendered view (formats nobody reads as source). */
  startInView?: boolean;
};

const T = (kind: ViewerKind, label: string, startInView = false): ViewerSpec =>
  ({ kind, source: 'text', label, startInView });
const B = (kind: ViewerKind): ViewerSpec => ({ kind, source: 'bytes' });

const VIEWERS: Record<string, ViewerSpec> = {
  html: T('live', 'Live'), htm: T('live', 'Live'), xhtml: T('live', 'Live'),
  // A document is read rendered; Code is one click away. HTML keeps its source.
  md: T('markdown', 'View', true), markdown: T('markdown', 'View', true),
  svg: T('svg', 'View', true),
  mmd: T('mermaid', 'View', true), mermaid: T('mermaid', 'View', true),
  dot: T('graphviz', 'View', true), gv: T('graphviz', 'View', true),
  json: T('json', 'Tree'), jsonc: T('json', 'Tree'), json5: T('json', 'Tree'),
  jsonl: T('json', 'Tree'), ndjson: T('json', 'Tree'), har: T('json', 'Tree'),
  ipynb: T('notebook', 'View', true),
  geojson: T('geo', 'Map', true), gpx: T('geo', 'Map', true), kml: T('geo', 'Map', true),
  log: T('log', 'Tail', true),
  pdf: B('pdf'),
  png: B('image'), jpg: B('image'), jpeg: B('image'), gif: B('image'), webp: B('image'),
  avif: B('image'), bmp: B('image'), ico: B('image'),
  tif: B('convert-image'), tiff: B('convert-image'), heic: B('convert-image'), heif: B('convert-image'),
  mp3: B('audio'), wav: B('audio'), ogg: B('audio'), oga: B('audio'), flac: B('audio'),
  m4a: B('audio'), aac: B('audio'), opus: B('audio'),
  mp4: B('video'), m4v: B('video'), webm: B('video'), ogv: B('video'), mov: B('video'),
  mkv: B('video'), avi: B('video'), wmv: B('video'), flv: B('video'),
  pptx: B('office'), ppt: B('office'), ppsx: B('office'), pps: B('office'), odp: B('office'),
  odt: B('office'), doc: B('office'), rtf: B('office'), odg: B('office'),
  docx: B('docx'), docm: B('docx'),
  xlsx: B('spreadsheet'), xlsm: B('spreadsheet'), xls: B('spreadsheet'), ods: B('spreadsheet'),
  xlsb: B('spreadsheet'),
  db: B('sqlite'), sqlite: B('sqlite'), sqlite3: B('sqlite'), db3: B('sqlite'),
  zip: B('archive'), jar: B('archive'), whl: B('archive'), tar: B('archive'), tgz: B('archive'),
  gz: B('archive'), tbz2: B('archive'), txz: B('archive'), epub: B('archive'),
  ttf: B('font'), otf: B('font'), woff: B('font'), woff2: B('font'),
  glb: B('model3d'), gltf: B('model3d'), stl: B('model3d'), obj: B('model3d'), ply: B('model3d'),
};

/** The viewer of a file name, or null: the editor (text) or hex (binary). */
export function viewerFor(name: string): ViewerSpec | null {
  const lower = name.toLowerCase();
  // A bare `.bz2`/`.xz` is no archive the agent opens; a tarball in one is.
  if (/\.tar\.(bz2|xz)$/.test(lower)) return VIEWERS.tar;
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return null;
  return VIEWERS[lower.slice(dot + 1)] ?? null;
}

// ── The document alone, in a browser tab of its own ────────────────────────
// `/view` (app/view/page.tsx): an HTML file redirects to its live page
// (§14.110), any other viewer renders full window. Source code has none.

/** Files `/view` can show: a rendered viewer, or a CSV/TSV table. */
export function hasStandaloneView(name: string): boolean {
  return viewerFor(name) != null || /\.(csv|tsv)$/i.test(name);
}

/** The `/view` URL of a file: `path` is relative to `root`, like the fs routes. */
export function standaloneViewUrl(vpsId: string, root: string, path: string): string {
  const q = new URLSearchParams({ vps: vpsId, root, path });
  return `/view?${q.toString()}`;
}
