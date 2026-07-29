// ── Attachment filename hygiene (§14.11 defence in depth) ───────────────────
// PLAIN module, zero imports on purpose — same rationale as verifyParse.ts:
// `attachments.ts` pulls in `lib/db` (`server-only` + native better-sqlite3),
// which cannot be loaded under vitest. The naming rules are the part worth
// unit-testing, so they live here on their own.

/** Last path segment of a name, handling both POSIX and Windows separators. */
function baseName(raw: string): string {
  return String(raw ?? '').split(/[/\\]/).pop() ?? '';
}

/** Extension including the dot, or '' — a local `path.extname` without the import. */
function extName(name: string): string {
  const i = name.lastIndexOf('.');
  // A leading dot is not an extension (`.gitignore`), and neither is a
  // trailing one.
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i);
}

/**
 * Reduce a browser-supplied filename to ONE safe, usable path segment.
 *
 * The result is interpolated into a remote shell command (quoted — every call
 * site goes through shQuote, verified) and joined onto a hub-side directory, so
 * it must not be able to escape either: no separators, no `..`, no leading
 * dash, no control characters, never empty.
 *
 * Unicode is preserved. A French or Japanese filename is not a security
 * problem, and mangling it makes the path unreadable in the prompt — which
 * defeats the point of putting the path in the prompt at all.
 */
export function sanitizeAttachmentName(raw: string): string {
  let name = baseName(raw)
    // Control characters: a newline or NUL in a filename is either a bug or an
    // attack, never a legitimate name. Replaced by a SPACE rather than
    // deleted, so `a\nb.png` stays two words instead of silently becoming
    // `ab.png` — the name is what the user will look for in the Files tab.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    // Shell metacharacters. NOT the security boundary — shQuote is, and it is
    // tested to hold. This is about the path staying USABLE downstream: it is
    // pasted into the prompt, read back by the agent, copied into a terminal
    // from the Files tab, and re-quoted by whatever the agent runs on it. A
    // backtick or `$` is a papercut at every one of those steps, and nobody
    // names a screenshot that way on purpose. Spaces, unicode, parens, commas
    // and dashes all survive.
    .replace(/[`$"'\\|;&<>*?!\[\]{}()\n\r]/g, '_')
    // `$(cmd)` would otherwise become `__cmd_`. Collapsing keeps the result
    // legible instead of a wall of underscores.
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '')          // no leading dots → no `..`, no hidden file
    .replace(/^-+/, '')           // never argv-ambiguous
    .replace(/\s+/g, ' ')         // collapse whitespace runs
    .trim();
  if (!name) name = 'file';
  // Keep paths readable in the prompt and inside filesystem name limits (255
  // bytes on ext4 — 120 chars is safe even in 2-byte-per-char scripts).
  if (name.length > 120) {
    const ext = extName(name).slice(0, 16);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

// ── Inline preview ──────────────────────────────────────────────────────────
// Which uploads may be served INLINE (opened in a browser tab) rather than
// forced as a download.
//
// ⚠ This table is a SECURITY boundary, not a convenience. Serving user-supplied
// bytes inline from our own origin is the classic stored-XSS setup: an uploaded
// .html (or a .txt the browser sniffs as HTML) would execute in Charon's origin
// and could drive the API as the logged-in user. Three rules make it safe, and
// all three must stay:
//   1. The content-type comes from THIS table, keyed on the EXTENSION — never
//      from the browser-declared mime, which is attacker-controlled. Anything
//      not listed is not previewable, full stop.
//   2. The route sends `X-Content-Type-Options: nosniff`, so a text file can't
//      be re-interpreted as HTML.
//   3. The route sends `Content-Security-Policy: sandbox`, which drops the
//      response into a unique opaque origin with scripting disabled — that is
//      what makes SVG (which can carry <script>) safe to render.
// text/* entries are deliberately served as `text/plain`: previewing a .md or
// .json must never mean "render as a document".
const PREVIEW_MIME: Record<string, string> = {
  // images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml',
  // documents
  pdf: 'application/pdf',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', oga: 'audio/ogg',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  // video
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  // text — always text/plain, never a renderable document type
  txt: 'text/plain', md: 'text/plain', log: 'text/plain', csv: 'text/plain',
  json: 'text/plain', xml: 'text/plain', yml: 'text/plain', yaml: 'text/plain',
  ts: 'text/plain', js: 'text/plain', py: 'text/plain', sh: 'text/plain',
  css: 'text/plain', sql: 'text/plain', toml: 'text/plain', ini: 'text/plain',
};

/**
 * Content-type to serve this file with when opened in a browser tab, or null
 * when it must stay a download.
 *
 * Extension-driven on purpose — see the table's comment. Deliberately NOT
 * derived from the stored mime: that value came from the uploading browser and
 * is attacker-controlled.
 */
export function previewMimeFor(name: string): string | null {
  const ext = extName(name).slice(1).toLowerCase();
  if (!ext) return null;
  return PREVIEW_MIME[ext] ?? null;
}

/**
 * Pick a remote basename that is free for this session.
 *
 * Re-uploading `screenshot.png` three times must NOT make the first two
 * unreadable: earlier messages still reference those paths, and an agent
 * re-reading one would silently get the newest file — a wrong answer with no
 * error anywhere. Collisions therefore get a `-2`, `-3`… suffix.
 */
export function uniqueRemoteName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  const ext = extName(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
