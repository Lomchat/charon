import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { invalidateGitStatus } from '@/lib/server/claude/git';
import type { FsWriteBody, FsWriteResponse } from '@/lib/types/api';

// POST /api/vps/[id]/fs/write  { root, path, content, expectedSha256? }
//
// The editor's save. `expectedSha256` is a PRECONDITION, not a hint: a coding
// agent may be writing this very file, and a save that checks nothing silently
// discards whichever side was slower. The agent refuses on mismatch with
// `reason: 'stale'` and hands back the current sha so the client can offer a
// reload — omit the field only for a deliberate overwrite.
//
// A successful write invalidates the repo's cached git status: the file just
// became dirty (or clean again) and the chip must not wait for the next poll
// to say so.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: FsWriteBody;
  try { body = await req.json(); } catch {
    return NextResponse.json<FsWriteResponse>({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const root = String(body?.root ?? '');
  const path = String(body?.path ?? '');
  const content = typeof body?.content === 'string' ? body.content : null;
  if (!root || !path || content === null) {
    return NextResponse.json<FsWriteResponse>({ ok: false, error: 'root, path and content are required' }, { status: 400 });
  }

  try {
    const client = getAgentClientForVpsId(id);
    if (!client || client.status !== 'connected') {
      return NextResponse.json<FsWriteResponse>({ ok: false, reason: 'offline', error: 'the agent is not connected' });
    }
    const r = await client.call<FsWriteResponse & { sha256?: string | null }>('fs_write', {
      root, path, content,
      // undefined ⇒ the key is absent from the JSON ⇒ the agent forces.
      ...(body.expectedSha256 === undefined ? {} : { expected_sha256: body.expectedSha256 }),
    });
    if (r?.ok) invalidateGitStatus(id, root);
    return NextResponse.json<FsWriteResponse>(r);
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      return NextResponse.json<FsWriteResponse>({
        ok: false, reason: 'unsupported',
        error: 'this VPS runs an agent older than 0.26.0 — update it to save files',
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json<FsWriteResponse>({ ok: false, reason: 'error', error: msg.slice(0, 200) });
  }
}
