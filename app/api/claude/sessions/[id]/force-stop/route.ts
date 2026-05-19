import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { forceStopSession } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/force-stop
// Annulation brutale d'une session bloquée (le SDK ne rend pas la main sur
// `interrupt` soft). La session passe en 'sleeping' immédiatement.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    await forceStopSession(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
