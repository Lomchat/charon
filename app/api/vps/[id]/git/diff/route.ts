import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getGitDiff } from '@/lib/server/claude/git';

// GET /api/vps/[id]/git/diff?cwd=<path>&path=<repo-relative file>
//
// Unified patch for ONE file (worktree vs HEAD, or vs /dev/null when
// untracked). One file per call on purpose: the panel is an index and the
// reader opens a single file at a time. Shipping a whole-changeset patch with
// the listing is exactly the egress trap that made `edit_snapshot` content
// stripped from the session GET (§14.41), and here the listing is POLLED.
//
// The agent validates that `path` stays inside the repo; this route does not
// second-guess it (one owner for the rule, cf. git.py `_safe_rel`).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd') ?? '';
  const path = url.searchParams.get('path') ?? '';
  if (!cwd || !path || cwd.length > 4096 || path.length > 4096) {
    return NextResponse.json({ ok: false, error: 'cwd and path are required' });
  }
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  return NextResponse.json(await getGitDiff(id, cwd, path));
}
