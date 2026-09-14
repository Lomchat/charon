import { db, claudeSessions } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { connectionConfig } from '@/lib/server/customEndpoints';
import { supportsCustomEndpoint } from '@/lib/customEndpoints';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { recordedSessionUsage } from '@/lib/server/agent/sessionUsage';
import { normalizeCodexContextUsage } from '@/lib/server/claude/sessionInsightCompat';
import { readSessionInsightSnapshot } from '@/lib/server/claude/sessionInsightSnapshot';

/** GET /api/claude/sessions/[id]/context — how full the context window is.
 *
 *  Charon had a live token counter (§14.50) but no notion of the WINDOW, so
 *  "why did my session suddenly forget things" had no answer until the
 *  compaction marker, which arrives after the fact. This answers it before. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const force = new URL(req.url).searchParams.get('force') === '1';
  // Never hold a browser connection on provider telemetry. A cold request
  // starts one shared background job and returns `reason:loading`; all tabs
  // then consume the same snapshot. Identity rides in the same snapshot so
  // it cannot add another focus-time request.
  const usage = readSessionInsightSnapshot(id, 'context', async () => {
    const raw = await callSessionRpc(id, 'get_context_usage');
    const identity = await callSessionRpc(id, 'session_identity');
    return { ...normalizeCodexContextUsage(raw), identity };
  }, { force, maxAgeMs: 15_000 });
  const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
  const endpoint = connectionConfig(row?.codexConfig).customEndpoint;
  const check = row && supportsCustomEndpoint(row.kind) ? endpoint?.checks?.[row.kind] : undefined;
  const window = check?.model === row?.model ? check?.contextWindow : undefined;
  const context = endpoint ? { ...usage, max_tokens: window ?? null,
    percentage: window && Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) * 100 / window : null } : usage;
  const recorded = recordedSessionUsage(id);
  return NextResponse.json({
    ...context,
    recorded_usage: endpoint ? { ...recorded, cost_usd: null } : recorded,
  });
}
