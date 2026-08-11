import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { gitFetch } from '@/lib/server/claude/git';

// POST /api/vps/[id]/git/fetch  { cwd, repo? }
//
// The call that makes `behind` mean something: ahead/behind compare a local
// ref to its tracking ref, and that ref only moves on a fetch. Without it the
// pull button never appeared on a VPS nobody had fetched on. §14.85
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let cwd = '';
  let repo: string | null = null;
  try {
    const body = await req.json();
    cwd = String(body?.cwd ?? '');
    repo = body?.repo ? String(body.repo) : null;
  } catch { /* empty */ }
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });

  return NextResponse.json(await gitFetch(id, cwd, repo));
}
