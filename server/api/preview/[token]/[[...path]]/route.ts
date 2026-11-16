import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { FILE_STREAM_AGENT_VERSION, openRemoteFileStream } from '@/lib/server/hub/fsByteStream';
import { verifyLivePreviewToken } from '@/lib/server/hub/livePreviewToken';
import { livePreviewKey, livePreviewSessionValid } from '@/lib/server/hub/livePreviewAuth';
import {
  LIVE_PREVIEW_ESCAPE_RELAY, LIVE_PREVIEW_SANDBOX, livePreviewExt, livePreviewMimeFor, parseLivePreviewPath,
} from '@/lib/livePreview';
import { parseByteRange } from '@/lib/fileRange';
import { withScrollbar } from '@/lib/scrollbarCss';
import { getSetting } from '@/lib/server/hub/settings';
import { resolveTheme } from '@/app/themes';
import { compareVersions } from '@/lib/version';
import type { FsReadResponse, FsStatResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/preview/<token>/<path…> — one file of a live view (§14.110).
//
// The page this serves is somebody's HTML with its scripts running, on the
// hub's own origin. What keeps that from being a stored XSS:
//   1. `CSP: sandbox` WITHOUT allow-same-origin on every response: the document
//      lives in an opaque origin — no hub cookie, no hub API, no hub storage —
//      even when the URL is opened in a tab of its own.
//   2. Authorization is the URL (middleware lets /api/preview through): an
//      HMAC capability for ONE VPS and ONE root, dead with its login session.
//   3. Only the extension allow-list is served, never a dot-segment, never
//      outside the root (the agent re-checks containment on every read).
// The opaque origin also makes every module script, font and fetch() a CORS
// request: `ACAO: *` is what lets the page load itself, and it grants nothing
// a cookie could — there is no cookie on these requests.
//
// Small files ride the agent's persistent RPC channel (fs_read) rather than a
// fresh SSH channel each: a page is dozens of requests at once, and a burst of
// channels on one ControlMaster hits sshd's MaxSessions. Big media streams.

/** The agent's own text cap: under it, one fs_read returns the whole file. */
const INLINE_READ_MAX = 2 * 1024 * 1024;

function baseHeaders(): Record<string, string> {
  return {
    'content-security-policy': `sandbox ${LIVE_PREVIEW_SANDBOX}`,
    'x-content-type-options': 'nosniff',
    // The token is in the URL: it never leaves in a Referer.
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges',
  };
}

function text(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8', ...extra },
  });
}

function bytesResponse(req: Request, bytes: Buffer, mime: string, headOnly: boolean): Response {
  const size = bytes.length;
  const parsed = parseByteRange(req.headers.get('range'), size);
  const headers: Record<string, string> = {
    ...baseHeaders(), 'content-type': mime, 'accept-ranges': 'bytes',
  };
  if (!parsed.ok) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  const r = parsed.range;
  const body = r ? bytes.subarray(r.start, r.end + 1) : bytes;
  headers['content-length'] = String(body.length);
  if (r) headers['content-range'] = `bytes ${r.start}-${r.end}/${size}`;
  return new Response(headOnly || body.length === 0 ? null : new Uint8Array(body), {
    status: r ? 206 : 200, headers,
  });
}

/** The hub's theme, as the page around the frame renders it (layout.tsx). */
function hubTheme() {
  try { return resolveTheme(getSetting('app.theme')); } catch { return resolveTheme(null); }
}

type Located =
  | { kind: 'file'; size: number; version: string | null }
  | { kind: 'missing' }
  | { kind: 'error'; response: Response };

async function locate(
  client: NonNullable<ReturnType<typeof getAgentClientForVpsId>>, root: string, path: string,
): Promise<Located> {
  try {
    const st = await client.call<FsStatResponse>('fs_stat', { root, path });
    if (!st.ok || st.exists === false || !Number.isSafeInteger(st.size) || (st.size ?? -1) < 0) {
      return { kind: 'missing' };
    }
    return { kind: 'file', size: st.size!, version: st.version ?? null };
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      return { kind: 'error', response: text(501, 'Update the Charon agent on this VPS to use the live view.') };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'error', response: text(502, `The VPS did not answer: ${msg.slice(0, 200)}`) };
  }
}

async function handle(req: Request, headOnly: boolean): Promise<Response> {
  // The raw, still-encoded path: parseLivePreviewPath does the decoding, so
  // an encoded separator or parent can never survive the split.
  const parts = new URL(req.url).pathname.split('/');
  if (parts[1] !== 'api' || parts[2] !== 'preview' || !parts[3]) return text(404, 'Not found.');
  const claims = verifyLivePreviewToken(parts[3], livePreviewKey());
  if (!claims || !livePreviewSessionValid(claims.sid)) {
    return text(403, 'This live view has expired. Reopen it from Charon.');
  }
  const rel = parseLivePreviewPath(parts.slice(4));
  if (rel == null) return text(404, 'Not found.');

  const [v] = db.select().from(vps).where(eq(vps.id, claims.vpsId)).all();
  if (!v) return text(404, 'This VPS no longer exists.');
  const client = getAgentClientForVpsId(v.id);
  if (!client || client.status !== 'connected') {
    return text(503, 'The Charon agent of this VPS is not connected.');
  }

  // `href="docs/"` reaches us as `docs` (Next drops the trailing slash):
  // a folder answers with its index, the way a web server would.
  if (!livePreviewExt(rel)) {
    const index = await locate(client, claims.root, `${rel}/index.html`);
    if (index.kind === 'error') return index.response;
    if (index.kind === 'file') {
      const leaf = encodeURIComponent(rel.split('/').pop()!);
      return new Response(null, { status: 302, headers: { ...baseHeaders(), location: `${leaf}/index.html` } });
    }
    return text(404, 'Not found.');
  }
  const mime = livePreviewMimeFor(rel);
  if (!mime) return text(404, 'The live view does not serve this type of file.');

  const found = await locate(client, claims.root, rel);
  if (found.kind === 'error') return found.response;
  if (found.kind === 'missing') return text(404, 'Not found.');

  if (found.size <= INLINE_READ_MAX) {
    let r: FsReadResponse & { too_large?: boolean };
    try {
      r = await client.call('fs_read', { root: claims.root, path: rel });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return text(502, `The VPS did not answer: ${msg.slice(0, 200)}`);
    }
    if (!r.ok) return text(404, 'Not found.');
    // Grown past the cap since the stat: fall through to the stream.
    if (!r.too_large && !r.truncated && r.content != null && r.encoding != null) {
      const bytes = r.encoding === 'base64'
        ? Buffer.from(r.content, 'base64')
        : Buffer.from(r.content, 'utf8');
      // The hub's scrollbar in the page (lib/scrollbarCss.ts), and its Esc
      // relay to the full-screen pane. A whole document only: a byte range
      // of it must stay the file's own bytes.
      const themed = mime.startsWith('text/html') && !req.headers.get('range')
        ? withScrollbar(bytes, hubTheme().scrollbar, LIVE_PREVIEW_ESCAPE_RELAY) : bytes;
      return bytesResponse(req, themed, mime, headOnly);
    }
  }

  if (compareVersions(v.agentVersion, FILE_STREAM_AGENT_VERSION) < 0) {
    return text(413, `Too large for this agent: update it to ${FILE_STREAM_AGENT_VERSION} or newer.`);
  }
  const size = found.size;
  const parsed = parseByteRange(req.headers.get('range'), size);
  const headers: Record<string, string> = {
    ...baseHeaders(), 'content-type': mime, 'accept-ranges': 'bytes',
  };
  if (!parsed.ok) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  const start = parsed.range?.start ?? 0;
  const end = parsed.range?.end ?? Math.max(0, size - 1);
  const length = parsed.range?.length ?? size;
  const status = parsed.range ? 206 : 200;
  headers['content-length'] = String(length);
  if (parsed.range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  if (headOnly || length === 0) return new Response(null, { status, headers });
  const opened = await openRemoteFileStream(req, v, {
    root: claims.root, path: rel, offset: start, length, expectedVersion: found.version,
  });
  if (!opened.ok) return text(502, opened.error);
  return new Response(opened.body, { status, headers });
}

export async function GET(req: Request) {
  return handle(req, false);
}

export async function HEAD(req: Request) {
  return handle(req, true);
}

/** CORS preflight of the page's own fetch() calls (custom headers, Range…). */
export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...baseHeaders(),
      'access-control-allow-methods': 'GET, HEAD',
      'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? '*',
      'access-control-max-age': '600',
    },
  });
}
