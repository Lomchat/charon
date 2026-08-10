import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { gitPull } from '@/lib/server/claude/git';

// POST /api/vps/[id]/git/pull  { cwd }
// `git pull --rebase --autostash` — the recovery path offered when a push is
// rejected or the branch is behind. --autostash because the working tree here
// is essentially always dirty (an agent is writing in it), so requiring a
// clean tree would make the button useless exactly when it's needed.
// A real conflict returns reason='conflict' and stays the user's to resolve:
// auto-resolving in a repo an agent is editing is not something a panel
// should attempt.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let cwd = '';
  try { cwd = String((await req.json())?.cwd ?? ''); } catch { /* empty */ }
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });

  return NextResponse.json(await gitPull(id, cwd));
}
