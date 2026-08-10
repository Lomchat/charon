import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { gitPush } from '@/lib/server/claude/git';

// POST /api/vps/[id]/git/push  { cwd }
// `git push` (or `push -u <remote> HEAD` on a branch with no upstream).
// Never forced: a rejected push comes back as reason='rejected' and the UI
// offers pull --rebase.
//
// The agent allows a push up to 170s but AgentClient's RPC timeout is 60s, so
// a slow push loses the ANSWER, not the push — it keeps running on the VPS.
// `op()` says exactly that instead of "timeout", and the next status poll
// (ahead → 0) is what confirms it landed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let cwd = '';
  try { cwd = String((await req.json())?.cwd ?? ''); } catch { /* empty */ }
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });

  return NextResponse.json(await gitPush(id, cwd));
}
