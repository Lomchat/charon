import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getGitBranches } from '@/lib/server/claude/git';

// GET /api/vps/[id]/git/branches?cwd=&repo=
//
// Not cached, unlike the status poll: this is read when the user deliberately
// opens the branch modal, and a stale list is worse than 200ms — they are
// about to switch onto one of these. §14.85
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd') ?? '';
  const repo = url.searchParams.get('repo');
  if (!cwd) {
    return NextResponse.json({ ok: false, error: 'cwd required', branches: [] }, { status: 400 });
  }
  return NextResponse.json(await getGitBranches(id, cwd, repo));
}
