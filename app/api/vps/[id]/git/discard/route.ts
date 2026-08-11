import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { gitDiscard } from '@/lib/server/claude/git';

// POST /api/vps/[id]/git/discard  { cwd, paths[] }
//
// Throw away local changes for the listed paths — tracked files go back to
// HEAD, untracked ones are unlinked. Explicit selection only: there is no
// "discard everything", by design. In an editor a discard is local and
// reversible-ish; here the working tree may be mid-write by a coding agent,
// which makes a one-click repo-wide discard the most destructive thing this
// panel could offer. The UI confirms per invocation.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let cwd = '';
  let paths: string[] = [];
  // Which checkout, when the cwd holds several (§14.83). Validated in git.ts.
  let repo: string | null = null;
  try {
    const body = await req.json();
    cwd = String(body?.cwd ?? '');
    paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
    repo = body?.repo ? String(body.repo) : null;
  } catch { /* empty */ }
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });
  if (paths.length === 0) {
    return NextResponse.json({ ok: false, error: 'no files selected', reason: 'bad_paths' });
  }

  return NextResponse.json(await gitDiscard(id, cwd, paths, repo));
}
