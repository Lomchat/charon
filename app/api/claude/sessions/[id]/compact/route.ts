import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import {
  PROVIDERS, asSessionProvider, supportsSessionCapability,
} from '@/lib/sessionCapabilities';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  // The capability, not the status: a backend with no compaction primitive had
  // `/compact` delivered to its model as a literal prompt (§14.103).
  const kind = asSessionProvider(row.kind);
  if (!supportsSessionCapability(kind, 'compact')) {
    return NextResponse.json(
      { error: `${PROVIDERS[kind].label} sessions cannot be compacted` },
      { status: 400 },
    );
  }
  try {
    await getAgentClientForVpsId(row.vpsId).call('compact_session', { session_id: id });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
