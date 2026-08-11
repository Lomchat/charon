import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { gitCheckout, gitDeleteBranch } from '@/lib/server/claude/git';
import type { GitCheckoutBody } from '@/lib/types/api';

// POST   /api/vps/[id]/git/checkout  { cwd, repo?, branch, create?, startPoint?, push? }
// DELETE /api/vps/[id]/git/checkout?cwd=&repo=&branch=   → `git branch -d`
//
// `git switch`, never --force and never autostash: the working tree may be one
// an agent is writing to right now, so a move that would overwrite local
// changes comes back as reason='dirty' with the paths and the user decides.
// Creating is allowed dirty — it carries the tree over and loses nothing.
// §14.85
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: GitCheckoutBody;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const cwd = String(body?.cwd ?? '');
  const branch = String(body?.branch ?? '').trim();
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });
  if (!branch) return NextResponse.json({ ok: false, error: 'branch required', reason: 'bad_branch' });

  return NextResponse.json(await gitCheckout(id, cwd, {
    branch,
    repo: body?.repo ? String(body.repo) : null,
    create: !!body?.create,
    startPoint: body?.startPoint ? String(body.startPoint) : null,
    push: !!body?.push,
  }));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd') ?? '';
  const branch = url.searchParams.get('branch') ?? '';
  const repo = url.searchParams.get('repo');
  if (!cwd || !branch) {
    return NextResponse.json({ ok: false, error: 'cwd and branch required' }, { status: 400 });
  }
  return NextResponse.json(await gitDeleteBranch(id, cwd, branch, repo));
}
