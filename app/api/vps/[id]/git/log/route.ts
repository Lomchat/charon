import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getGitLog } from '@/lib/server/claude/git';

// GET /api/vps/[id]/git/log?cwd=&repo=&path=&limit=&skip=
//
// Paged on purpose: a repo with 40k commits would otherwise ship megabytes
// into a modal nobody scrolls to the end of. `path` is the file-history case.
// §14.87
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd') ?? '';
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required', commits: [] }, { status: 400 });
  const n = Number(url.searchParams.get('limit'));
  return NextResponse.json(await getGitLog(id, cwd, {
    repo: url.searchParams.get('repo'),
    path: url.searchParams.get('path'),
    limit: Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 60,
    skip: Math.max(0, Number(url.searchParams.get('skip')) || 0),
  }));
}
