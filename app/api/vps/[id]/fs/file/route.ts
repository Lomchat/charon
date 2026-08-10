import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { previewMimeFor } from '@/lib/server/claude/attachmentNames';
import type { FsReadResponse, FsStatResponse } from '@/lib/types/api';

// GET /api/vps/[id]/fs/file?root=<cwd>&path=<rel>[&inline=1][&raw=1]
//
// Reads ONE file for the tree's viewer. Three answer shapes on purpose:
//
//  - default → JSON (`FsReadResponse`), which is what the text viewer wants:
//    it needs `truncated` / `tooLarge` / `binary` alongside the content, and a
//    bare body couldn't carry them.
//  - `inline=1` → the BYTES, for an <img>/<audio>/<video>/<iframe> src.
//  - `raw=1` → the bytes as a download.
//
// The byte paths are a stored-XSS surface — the content is whatever is on
// someone's VPS — so they carry the same three locks as the attachment preview
// route (§14.73), for the same reasons: the content-type comes from an
// EXTENSION-keyed allow-list and never from sniffing, `nosniff`, and a
// `Content-Security-Policy: sandbox` with no `allow-scripts` that drops the
// response into an opaque origin. That last one is what makes serving an SVG
// from a repo safe; it goes, the svg entry goes with it.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const root = url.searchParams.get('root') ?? '';
  const path = url.searchParams.get('path') ?? '';
  const inline = url.searchParams.get('inline') === '1';
  const raw = url.searchParams.get('raw') === '1';
  const stat = url.searchParams.get('stat') === '1';
  if (!root || !path || root.length > 4096 || path.length > 4096) {
    return NextResponse.json({ ok: false, error: 'root and path are required' }, { status: 400 });
  }
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let r: FsReadResponse;
  try {
    const client = getAgentClientForVpsId(id);
    if (!client || client.status !== 'connected') {
      if (stat) return NextResponse.json<FsStatResponse>({ ok: false, reason: 'offline', error: 'the agent is not connected' });
      return NextResponse.json({ ok: false, error: 'the agent is not connected' });
    }
    if (stat) {
      const sr = await client.call<FsStatResponse & { mtime_ns?: number }>('fs_stat', { root, path });
      return NextResponse.json<FsStatResponse>({ ...sr, mtimeNs: sr.mtime_ns });
    }
    r = await client.call<FsReadResponse>('fs_read', { root, path });
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      if (stat) {
        return NextResponse.json<FsStatResponse>({
          ok: false, reason: 'unsupported',
          error: 'this VPS runs an agent older than 0.28.0',
        });
      }
      return NextResponse.json({ ok: false, error: 'this VPS runs an agent older than 0.25.0 — update it to view files' });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) });
  }

  // `too_large` is the one field the agent spells in snake_case that the
  // viewer actually branches on — pass the rest through, re-case that.
  if (!(inline || raw)) {
    const raw2 = r as FsReadResponse & { too_large?: boolean };
    return NextResponse.json<FsReadResponse>({ ...r, tooLarge: raw2.too_large === true });
  }

  if (!r.ok || r.content == null || r.encoding == null) {
    return NextResponse.json({ ok: false, error: r.error ?? 'not readable' }, { status: 404 });
  }
  const bytes = r.encoding === 'base64'
    ? Buffer.from(r.content, 'base64')
    : Buffer.from(r.content, 'utf8');

  const base = path.split('/').pop() || 'file';
  const previewMime = inline ? previewMimeFor(base) : null;
  const safe = base.replace(/"/g, '');
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': previewMime ?? 'application/octet-stream',
      'content-disposition': `${previewMime ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(base)}`,
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src data: blob: 'self'; media-src 'self'; style-src 'unsafe-inline'",
      // No caching: unlike an attachment, a repo file changes under the user
      // and a stale preview after an agent edit would be a lie.
      'cache-control': 'private, no-store',
    },
  });
}
