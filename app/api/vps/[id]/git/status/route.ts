import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getGitWorkspace } from '@/lib/server/claude/git';

// GET /api/vps/[id]/git/status?cwd=<path>[&force=1]
//
// Working-tree summary for the repo containing `cwd` — backs BOTH the dirty
// chip next to a session's cwd and the git tab, which is why it is keyed on
// (vpsId, cwd) and not on a session id: two sessions in the same repo share
// one poll and must show the same number (cf. lib/server/claude/git.ts).
//
// Always 200. `isRepo:false` is the normal answer for a non-git cwd (the UI
// renders nothing), and an agent-level failure carries a `reason` the panel
// turns into an actionable line — a 4xx/5xx here would just make the chip
// flicker into an error state on every transient hiccup.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd') ?? '';
  const force = url.searchParams.get('force') === '1';
  if (!cwd || cwd.length > 4096) {
    return NextResponse.json({ ok: false, error: 'cwd required', isRepo: false, files: [] });
  }
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  return NextResponse.json(await getGitWorkspace(id, cwd, { force }));
}
