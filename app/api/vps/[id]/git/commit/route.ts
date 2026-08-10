import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { gitCommit } from '@/lib/server/claude/git';
import type { GitCommitBody } from '@/lib/types/api';

// POST /api/vps/[id]/git/commit  { cwd, message, paths[] | all, push? }
//
// Stages exactly the selected paths and commits them (`add -A -- paths` then
// `commit -- paths` — a partial commit). The panel has checkboxes, not a
// staging area, and the reason it must stay path-scoped is concurrency: on
// these VPSes several coding agents write into the same working tree, so a
// repo-wide `add -A` would sweep a neighbour's in-flight file into the commit.
//
// A push that fails AFTER a successful commit keeps ok:true and reports
// `pushed:false` + `pushReason` — telling the user the whole thing failed
// would get the commit made twice.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: GitCommitBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const cwd = String(body?.cwd ?? '');
  const message = String(body?.message ?? '');
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });
  if (!message.trim()) return NextResponse.json({ ok: false, error: 'empty commit message', reason: 'no_message' });

  const paths = Array.isArray(body?.paths) ? body.paths.map(String) : undefined;
  return NextResponse.json(await gitCommit(id, cwd, {
    message, paths, all: !!body?.all, push: !!body?.push,
  }));
}
