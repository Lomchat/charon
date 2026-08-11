import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getGitShow } from '@/lib/server/claude/git';

// GET /api/vps/[id]/git/show?cwd=&repo=&sha=&path=
// One commit: metadata, the files it touched, and its patch (capped, §14.41).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd') ?? '';
  const sha = url.searchParams.get('sha') ?? '';
  if (!cwd || !sha) {
    return NextResponse.json({ ok: false, error: 'cwd and sha required', files: [] }, { status: 400 });
  }
  return NextResponse.json(await getGitShow(id, cwd, sha, {
    repo: url.searchParams.get('repo'),
    path: url.searchParams.get('path'),
  }));
}
