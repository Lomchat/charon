import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

// Files of the client build (dist/client): `/assets/*` (hashed, immutable)
// and the public files copied from public/ (sw.js, notif.wav, icon.svg,
// agents/…). Served WITHOUT the auth gate: the login page needs its own
// scripts, and none of these files holds anything private.
//
// A deploy replaces dist/client/assets, but a tab opened before it still
// lazy-loads chunks of ITS build: the build script keeps the previous builds'
// assets in dist/assets-archive, served as a fallback (§14.57).

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
};

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'public, max-age=0, must-revalidate';

/** The file `rel` (URL path below the root, still encoded) under one of
 *  `roots`, or null. Never escapes a root. */
export function fileResponse(req: Request, roots: string[], rel: string, cacheControl: string): Response | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (!decoded || decoded.includes('\0') || decoded.split('/').some((s) => s === '..')) return null;
  for (const root of roots) {
    const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
    if (!full.startsWith(path.resolve(root) + path.sep)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
    };
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    headers['Content-Length'] = String(st.size);
    const body = req.method === 'HEAD' ? null : (Readable.toWeb(fs.createReadStream(full)) as ReadableStream);
    return new Response(body, { status: 200, headers });
  }
  return null;
}

/** First path segments served from the client build's root (public/ copies). */
export function publicEntries(clientDir: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const e of fs.readdirSync(clientDir)) {
      if (e !== 'web' && e !== 'assets' && e !== 'BUILD_ID' && !e.endsWith('.html')) names.add(e);
    }
  } catch { /* no build yet */ }
  return names;
}
