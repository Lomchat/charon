import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { refreshClaudeLoginStatus } from '@/lib/server/agent/claudeLoginCheck';

export const runtime = 'nodejs';

// POST /api/vps/[id]/claude/check-login
// Re-checks via SSH whether the user has a valid `claude login` on this VPS.
// Persists the result in `vps.claude_logged_in` (1=yes, 0=no). Used by
// the sidebar (hides the "claude login" button when unnecessary) and triggered
// automatically when the user closes LoginConsole.
//
// The SSH+DB logic lives in `lib/server/agent/claudeLoginCheck.ts` to be
// shared with the auto-check performed by `autoConnect` on agent connection.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const r = await refreshClaudeLoginStatus(v);
  if (!r.ok) {
    return NextResponse.json({
      ok: false,
      error: r.error,
      loggedIn: r.loggedIn,
      checkedAt: r.checkedAt,
    });
  }
  return NextResponse.json({ ok: true, loggedIn: r.loggedIn, checkedAt: r.checkedAt });
}
