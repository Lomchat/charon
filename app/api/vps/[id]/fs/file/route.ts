import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps, type Vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { previewMimeFor } from '@/lib/server/hub/attachmentNames';
import {
  FILE_STREAM_AGENT_VERSION, openRemoteFileStream, openRemoteZipStream,
} from '@/lib/server/hub/fsByteStream';
import { compareVersions } from '@/lib/version';
import { parseByteRange } from '@/lib/fileRange';
import type { FsLinkInfo, FsListResponse, FsReadResponse, FsStatResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ZIP_STREAM_AGENT_VERSION = '0.78.0';

type RouteContext = { params: Promise<{ id: string }> };

/** Symlink half of the agent's answer, snake_case on the wire (§14.77). */
type AgentLinkInfo = { symlink?: boolean; link_target?: string; link_resolved?: string };

function linkInfo(r: AgentLinkInfo): FsLinkInfo {
  if (!r.symlink) return {};
  return { symlink: true, linkTarget: r.link_target ?? null, linkResolved: r.link_resolved ?? null };
}

function byteHeaders(base: string, inline: boolean): Record<string, string> {
  const previewMime = inline ? previewMimeFor(base) : null;
  // Quoted-string fallback must contain no controls or separators;
  // filename*= carries the exact UTF-8 name.
  const safe = base.replace(/["\\\r\n]/g, '_');
  return {
    'content-type': previewMime ?? 'application/octet-stream',
    'content-disposition': `${previewMime ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(base)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; img-src data: blob: 'self'; media-src 'self'; style-src 'unsafe-inline'",
    'cache-control': 'private, no-store',
    'accept-ranges': 'bytes',
  };
}

function zipHeaders(base: string): Record<string, string> {
  const name = `${base}.zip`;
  const safe = name.replace(/["\\\r\n]/g, '_');
  return {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'cache-control': 'private, no-store',
    // A ZIP's central directory is generated at EOF, so it has no stable byte
    // ranges without first materialising the entire archive.
    'accept-ranges': 'none',
  };
}

// GET /api/vps/[id]/fs/file?root=<cwd>&path=<rel>[&inline=1|&raw=1|&archive=zip]
//
// JSON previews stay on bounded fs_read. Byte responses use a separate SSH
// stdout channel (agent >=0.77): no JSON/base64, no hub-sized Buffer, and HTTP
// Range makes interrupted multi-GB downloads resumable. Both paths repeat
// containment agent-side; fs_stat is metadata, never authorization. Directory
// ZIPs (>=0.78) are also generated directly onto SSH stdout, with no temp file.
async function handle(req: Request, { params }: RouteContext, headOnly: boolean) {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  const url = new URL(req.url);
  const root = url.searchParams.get('root') ?? '';
  const path = url.searchParams.get('path') ?? '';
  const inline = url.searchParams.get('inline') === '1';
  const raw = url.searchParams.get('raw') === '1';
  const archive = url.searchParams.get('archive');
  const stat = url.searchParams.get('stat') === '1';
  if (!root || !path || root.length > 4096 || path.length > 4096) {
    return NextResponse.json({ ok: false, error: 'root and path are required' }, { status: 400 });
  }
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const client = getAgentClientForVpsId(id);
  if (!client || client.status !== 'connected') {
    if (stat) return NextResponse.json<FsStatResponse>({ ok: false, reason: 'offline', error: 'the agent is not connected' });
    return NextResponse.json({ ok: false, error: 'the agent is not connected' });
  }

  if (archive != null && archive !== 'zip') {
    return NextResponse.json({ ok: false, error: 'unsupported archive format' }, { status: 400 });
  }
  if (archive === 'zip') {
    if (compareVersions(v.agentVersion, ZIP_STREAM_AGENT_VERSION) < 0) {
      return NextResponse.json({
        ok: false,
        error: `update this VPS agent to ${ZIP_STREAM_AGENT_VERSION} to download folders`,
      }, { status: 409 });
    }
    let listed: FsListResponse;
    try {
      // Metadata preflight: fail as HTTP before the ZIP's first local header
      // commits the response. The streaming CLI repeats containment and type.
      listed = await client.call<FsListResponse>('fs_list', { root, path, with_git: false });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 502 });
    }
    if (!listed.ok) {
      return NextResponse.json({ ok: false, error: listed.error ?? 'directory not found' }, { status: 404 });
    }
    const base = path === '.'
      ? (root.split('/').filter(Boolean).pop() || 'folder')
      : (path.split('/').filter(Boolean).pop() || 'folder');
    const headers = zipHeaders(base);
    if (headOnly) return new Response(null, { status: 200, headers });
    const opened = await openRemoteZipStream(req, v, root, path);
    if (!opened.ok) {
      return NextResponse.json({ ok: false, error: opened.error }, { status: 502 });
    }
    return new Response(opened.body, { status: 200, headers });
  }

  // New agents stream downloads and inline media. Old agents retain the
  // bounded fs_read fallback below while the fleet rolls forward.
  if ((inline || raw) && compareVersions(v.agentVersion, FILE_STREAM_AGENT_VERSION) >= 0) {
    let sr: FsStatResponse & { mtime_ns?: number };
    try {
      sr = await client.call('fs_stat', { root, path });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 502 });
    }
    if (!sr.ok || sr.exists === false || !Number.isSafeInteger(sr.size) || (sr.size ?? -1) < 0) {
      return NextResponse.json({ ok: false, error: sr.error ?? 'file not found' }, { status: 404 });
    }
    const size = sr.size!;
    const parsed = parseByteRange(req.headers.get('range'), size);
    const base = path.split('/').pop() || 'file';
    if (!parsed.ok) {
      return new Response(null, {
        status: 416,
        headers: { ...byteHeaders(base, inline), 'content-range': `bytes */${size}` },
      });
    }
    const start = parsed.range?.start ?? 0;
    const end = parsed.range?.end ?? Math.max(0, size - 1);
    const length = parsed.range?.length ?? size;
    const status = parsed.range ? 206 : 200;
    const headers: Record<string, string> = {
      ...byteHeaders(base, inline),
      'content-length': String(length),
      ...(parsed.range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    };
    if (headOnly || length === 0) return new Response(null, { status, headers });

    const opened = await openRemoteFileStream(req, v, {
      root, path, offset: start, length, expectedVersion: sr.version ?? null,
    });
    if (!opened.ok) {
      return NextResponse.json({ ok: false, error: opened.error }, { status: 502 });
    }
    return new Response(opened.body, { status, headers });
  }

  let r: FsReadResponse;
  try {
    if (stat) {
      const sr = await client.call<FsStatResponse & AgentLinkInfo & { mtime_ns?: number }>(
        'fs_stat', { root, path });
      return NextResponse.json<FsStatResponse>({ ...sr, mtimeNs: sr.mtime_ns, ...linkInfo(sr) });
    }
    r = await client.call<FsReadResponse>('fs_read', { root, path });
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      if (stat) {
        return NextResponse.json<FsStatResponse>({
          ok: false, reason: 'unsupported', error: 'this VPS runs an agent older than 0.28.0',
        });
      }
      return NextResponse.json({ ok: false, error: 'this VPS runs an agent older than 0.25.0 — update it to view files' });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) });
  }

  if (!(inline || raw)) {
    const raw2 = r as FsReadResponse & AgentLinkInfo & { too_large?: boolean };
    return NextResponse.json<FsReadResponse>({
      ...r, tooLarge: raw2.too_large === true, ...linkInfo(raw2),
    });
  }
  if (!r.ok || r.content == null || r.encoding == null) {
    const tooLarge = (r as FsReadResponse & { too_large?: boolean }).too_large;
    return NextResponse.json({
      ok: false,
      error: tooLarge
        ? `update this VPS agent to ${FILE_STREAM_AGENT_VERSION} to download large files`
        : (r.error ?? 'not readable'),
    }, { status: tooLarge ? 409 : 404 });
  }
  const bytes = r.encoding === 'base64'
    ? Buffer.from(r.content, 'base64')
    : Buffer.from(r.content, 'utf8');
  return new NextResponse(headOnly ? null : new Uint8Array(bytes), {
    headers: { ...byteHeaders(path.split('/').pop() || 'file', inline), 'content-length': String(bytes.length) },
  });
}

export async function GET(req: Request, context: RouteContext) {
  return handle(req, context, false);
}

export async function HEAD(req: Request, context: RouteContext) {
  return handle(req, context, true);
}
