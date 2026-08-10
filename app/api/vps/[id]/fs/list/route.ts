import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import type { FsListResponse } from '@/lib/types/api';

// GET /api/vps/[id]/fs/list?root=<session cwd>&path=<rel>[&git=1]
//
// One directory of the read-only file tree. Distinct from the sibling
// `/fs?path=` route, which lists DIRECTORIES ONLY for the new-session wizard's
// autocomplete and is on the hot path of every keystroke there — widening that
// contract would make a bug in the tree break session creation.
//
// `root` is the session's cwd and the containment boundary; the agent refuses
// anything resolving outside it (fsnav `_contained`, realpath on both sides).
// That isn't a privilege boundary — the hub hands out shells on the same box —
// it just stops a stray `..` turning a project browser into a tour of /etc.
//
// `git=1` adds the gitignored flag, and is opt-in because it costs a
// `check-ignore` subprocess and only the client knows whether this is a repo.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const root = url.searchParams.get('root') ?? '';
  const path = url.searchParams.get('path') ?? '';
  const withGit = url.searchParams.get('git') === '1';
  if (!root || root.length > 4096 || path.length > 4096) {
    return NextResponse.json<FsListResponse>({ ok: false, error: 'root required', entries: [] });
  }
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  try {
    const client = getAgentClientForVpsId(id);
    // Checked BEFORE calling: `call` waits up to 30s for a connection and a
    // tree node must never hang that long on a dead VPS.
    if (!client || client.status !== 'connected') {
      return NextResponse.json<FsListResponse>({ ok: false, error: 'the agent is not connected', entries: [] });
    }
    const r = await client.call<FsListResponse>('fs_list', { root, path, with_git: withGit });
    return NextResponse.json(r);
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      return NextResponse.json<FsListResponse>({
        ok: false, entries: [],
        error: 'this VPS runs an agent older than 0.25.0 — update it to browse files',
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json<FsListResponse>({ ok: false, error: msg.slice(0, 200), entries: [] });
  }
}
