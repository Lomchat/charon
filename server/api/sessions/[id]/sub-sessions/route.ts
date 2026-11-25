import { eq } from 'drizzle-orm';
import { requireApiSession } from '@/lib/server/session';
import { db, agentSessions } from '@/lib/db';
import { markSummaryDirty } from '@/lib/server/sync/syncBus';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { recordedSessionUsage } from '@/lib/server/agent/sessionUsage';
import { subtreeDeepestFirst } from '@/lib/server/hub/subSessions';
import { asSessionProvider, showsTurnCost } from '@/lib/sessionCapabilities';
import type { SubSessionUsage } from '@/lib/types/api';

// GET /api/sessions/[id]/sub-sessions → { usage: { [id]: SubSessionUsage } }
// What its sub-sessions (any depth) have used so far: their recorded tokens
// and turns, and their cost where the provider bills per turn (§14.102). A
// cold fold says `pending` (asked again). The parent's background-work modal.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const kinds = new Map<string, string>();
  const ids = subtreeDeepestFirst(id, (pid) => db.select({ id: agentSessions.id, kind: agentSessions.kind })
    .from(agentSessions).where(eq(agentSessions.parentSessionId, pid)).all()
    .map((r) => { kinds.set(r.id, r.kind); return r.id; }));
  const usage: Record<string, SubSessionUsage> = {};
  for (const sid of ids) {
    if (sid === id) continue;
    const { usage: u, pending } = recordedSessionUsage(sid);
    const billed = showsTurnCost(asSessionProvider(kinds.get(sid) ?? 'claude'));
    usage[sid] = {
      tokens: u ? u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens : null,
      turns: u?.turns ?? 0,
      costUsd: u && billed ? u.cost_usd : null,
      ...(pending ? { pending: true } : {}),
    };
  }
  return Response.json({ ok: true, usage });
}

// POST /api/sessions/[id]/sub-sessions  { open: boolean }
// Its sub-sessions shown or folded in the sidebar: a hub fact (a summary
// field), so every tab and device follows. Folded by default (§14.93).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (typeof body?.open !== 'boolean') return Response.json({ error: 'open must be true or false' }, { status: 400 });
  const res = db.update(agentSessions).set({ subSessionsOpen: body.open ? 1 : 0 })
    .where(eq(agentSessions.id, id)).run();
  if (!((res as { changes?: number }).changes ?? 0)) return Response.json({ error: 'session not found' }, { status: 404 });
  markSummaryDirty(id);
  return Response.json({ ok: true, open: body.open, sync: syncAfter([id]) });
}
