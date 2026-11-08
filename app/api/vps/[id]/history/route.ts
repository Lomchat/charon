import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { PROVIDERS, SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import type { HistoryIndexResponse } from '@/lib/types/api';

// GET /api/vps/[id]/history — every Claude/Codex session on the VPS, from the
// agent's cached index (history.py). Read-only. The first build of a box is
// answered in time-budgeted parts: `pending` > 0 means "call again". An agent
// that predates history_index answers `reason: 'unsupported'`: the modal then
// falls back to the per-provider scans.
const BUDGET_MS = 2500;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select({ id: vps.id }).from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json<HistoryIndexResponse>({ ok: false, reason: 'error', error: 'vps not found' }, { status: 404 });
  try {
    const r = await getAgentClientForVpsId(id).call('history_index', {
      kinds: SESSION_PROVIDERS.filter((p) => PROVIDERS[p].deployment.historyIndex), budget_ms: BUDGET_MS,
    }) as HistoryIndexResponse;
    return NextResponse.json<HistoryIndexResponse>(r);
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === -32601) {
      return NextResponse.json<HistoryIndexResponse>({ ok: false, reason: 'unsupported' });
    }
    return NextResponse.json<HistoryIndexResponse>({
      ok: false, reason: 'offline', error: e instanceof Error ? e.message : String(e),
    }, { status: 502 });
  }
}
