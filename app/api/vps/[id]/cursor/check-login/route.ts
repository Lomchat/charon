import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { refreshCursorLoginStatus } from '@/lib/server/agent/cursorLoginCheck';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Is this VPS signed in to Cursor? The verdict is the SDK's own
// `Cursor.auth.status()` — never the mere existence of ~/.cursor/sdk/auth.json,
// which says nothing about the key being unexpired or minted for this backend
// (the same reason §14.64 refuses to scrape stdout for Claude).
//
// The probe, the persist and the `vps_status` broadcast all live in
// `cursorLoginCheck` — the same function the 24h stale-login sweep calls. This
// route re-inlined all three, which is two copies of a rule that has to stay
// identical: a probe that could not run must NOT clobber the flag ("unknown"
// is not "signed out", §14.53).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const r = await refreshCursorLoginStatus(v);
  if (!r.ok) {
    const tooOld = r.tooOld === true;
    return NextResponse.json({
      ok: false, loggedIn: false,
      error: tooOld ? 'agent too old to probe Cursor — update the agent' : (r.error ?? 'probe failed'),
    }, { status: tooOld ? 409 : 502 });
  }
  return NextResponse.json({
    ok: true, loggedIn: !!r.loggedIn, email: r.email ?? null, checkedAt: r.checkedAt ?? null,
  });
}
