import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { invalidateGitStatus } from '@/lib/server/claude/git';
import type { FsOpBody, FsOpResponse } from '@/lib/types/api';

// POST /api/vps/[id]/fs/op  { root, op: 'mkdir'|'rename'|'delete', path, to?, recursive? }
//
// The explorer's context menu, behind ONE route rather than three: they share
// the VPS lookup, the agent gating, the git invalidation and the failure
// shape, and three near-identical files would drift apart the first time one
// of those changed.
//
// Containment and the refuse-to-clobber rules live agent-side (fsnav) so there
// is exactly one implementation of them.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: FsOpBody;
  try { body = await req.json(); } catch {
    return NextResponse.json<FsOpResponse>({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const root = String(body?.root ?? '');
  const path = String(body?.path ?? '');
  const op = String(body?.op ?? '');
  if (!root || !path || !['mkdir', 'rename', 'delete'].includes(op)) {
    return NextResponse.json<FsOpResponse>({ ok: false, error: 'root, path and a valid op are required' }, { status: 400 });
  }

  const method = op === 'mkdir' ? 'fs_mkdir' : op === 'rename' ? 'fs_rename' : 'fs_delete';
  const rpcParams: Record<string, unknown> = { root, path };
  if (op === 'rename') rpcParams.to = String(body?.to ?? '');
  if (op === 'delete') rpcParams.recursive = !!body?.recursive;

  try {
    const client = getAgentClientForVpsId(id);
    if (!client || client.status !== 'connected') {
      return NextResponse.json<FsOpResponse>({ ok: false, reason: 'offline', error: 'the agent is not connected' });
    }
    const r = await client.call<FsOpResponse>(method, rpcParams);
    // The tree just changed shape, so the repo's dirty set did too.
    if (r?.ok) invalidateGitStatus(id, root);
    return NextResponse.json<FsOpResponse>(r);
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      return NextResponse.json<FsOpResponse>({
        ok: false, reason: 'unsupported',
        error: 'this VPS runs an agent older than 0.27.0 — update it to manage files',
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json<FsOpResponse>({ ok: false, reason: 'error', error: msg.slice(0, 200) });
  }
}
