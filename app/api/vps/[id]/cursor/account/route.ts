import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';
import { providerLoginPatch } from '@/lib/sessionCapabilities';
import { invalidateCursorModels } from '@/lib/server/claude/cursorModels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE = forget the stored Cursor credential on this VPS.
//
// Local-only, exactly like the SDK's own logout: the minted key stays valid
// until it expires or a human revokes it in the Cursor dashboard. The modal
// says so rather than implying the credential is dead.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  try {
    const client = getAgentClient(v);
    const r = await client.call<{ ok: boolean; error?: string }>('cursor_logout', {});
    if (!r?.ok) return NextResponse.json({ ok: false, error: r?.error ?? 'sign-out failed' });
    invalidateCursorModels(v.id);
    try {
      db.update(vpsTable).set(providerLoginPatch('cursor', 0))
        .where(eq(vpsTable.id, v.id)).run();
    } catch {}
    if (v.agentStatus === 'ok') emitGlobalVpsStatus(v.id, 'ok', { cursorLoggedIn: 0 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 502 });
  }
}
