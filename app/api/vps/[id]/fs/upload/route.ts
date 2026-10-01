import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { invalidateGitStatus } from '@/lib/server/claude/git';
import { beginUpload } from '@/lib/server/claude/fsUpload';
import { compareVersions } from '@/lib/version';
import {
  FS_UPLOAD_AGENT_VERSION, FS_UPLOAD_MAX_ITEMS, findExistingUploadTargets, uploadPathError,
} from '@/lib/fsUpload';
import type { FsListResponse, FsStatResponse, FsUploadBody, FsUploadResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/fs/upload
//   { op:'check', root, paths[] }            → which of them already exist
//   { op:'begin', root, path, size, overwrite? } → an uploadId for the chunks
//
// The explorer's drop (lib/fsUpload.ts). `check` lets the browser ask about
// every conflict ONCE, before anything moves; `begin` repeats that decision
// atomically agent-side, so a file created in between is still refused rather
// than clobbered. Chunks and cancel live in ./[uploadId].
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: FsUploadBody;
  try { body = await req.json(); } catch {
    return NextResponse.json<FsUploadResponse>({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const root = String(body?.root ?? '');
  if (!root || root.length > 4096) {
    return NextResponse.json<FsUploadResponse>({ ok: false, error: 'root is required' }, { status: 400 });
  }

  const client = getAgentClientForVpsId(id);
  if (!client || client.status !== 'connected') {
    return NextResponse.json<FsUploadResponse>({ ok: false, reason: 'offline', error: 'the agent is not connected' });
  }
  // Gated on the version rather than a -32601: the bytes use the agent's CLI,
  // not an RPC, and an old one would only answer with an argparse usage line.
  if (compareVersions(v.agentVersion, FS_UPLOAD_AGENT_VERSION) < 0) {
    return NextResponse.json<FsUploadResponse>({
      ok: false, reason: 'unsupported',
      error: `update this VPS agent to ${FS_UPLOAD_AGENT_VERSION} to upload files into folders`,
    });
  }

  if (body.op === 'check') {
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    if (!paths.length || paths.length > FS_UPLOAD_MAX_ITEMS) {
      return NextResponse.json<FsUploadResponse>({
        ok: false, reason: 'bad_path', error: `between 1 and ${FS_UPLOAD_MAX_ITEMS} paths per drop`,
      }, { status: 400 });
    }
    const bad = paths.map(uploadPathError).find(Boolean);
    if (bad) return NextResponse.json<FsUploadResponse>({ ok: false, reason: 'bad_path', error: bad }, { status: 400 });
    try {
      const existing = await findExistingUploadTargets(
        paths,
        (dir) => client.call<FsListResponse>('fs_list', { root, path: dir, with_git: false }),
        (path) => client.call<FsStatResponse>('fs_stat', { root, path }),
      );
      return NextResponse.json<FsUploadResponse>({ ok: true, existing });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json<FsUploadResponse>({ ok: false, reason: 'error', error: msg.slice(0, 200) });
    }
  }

  if (body.op === 'begin') {
    const path = String(body.path ?? '');
    const size = Number(body.size);
    const bad = uploadPathError(path);
    if (bad) return NextResponse.json<FsUploadResponse>({ ok: false, reason: 'bad_path', error: bad }, { status: 400 });
    if (!Number.isSafeInteger(size) || size < 0) {
      return NextResponse.json<FsUploadResponse>({ ok: false, error: 'invalid size' }, { status: 400 });
    }
    const r = await beginUpload(v, { root, path, size, overwrite: body.overwrite === true });
    if (!r.ok) return NextResponse.json<FsUploadResponse>({ ok: false, reason: r.reason, error: r.error });
    if (r.done) invalidateGitStatus(id, root);
    return NextResponse.json<FsUploadResponse>({ ok: true, uploadId: r.uploadId, done: r.done });
  }

  return NextResponse.json<FsUploadResponse>({ ok: false, error: 'unknown op' }, { status: 400 });
}
