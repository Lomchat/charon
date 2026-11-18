import { db, agentSessions } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { connectionConfig } from '@/lib/server/customEndpoints';
import { supportsCustomEndpoint } from '@/lib/customEndpoints';
import { asSessionProvider, showsTurnCost } from '@/lib/sessionCapabilities';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/hub/sessionRpc';
import { recordedSessionUsage } from '@/lib/server/agent/sessionUsage';
import { peekStream } from '@/lib/server/agent/sessionOps';
import { normalizeCodexContextUsage } from '@/lib/server/hub/sessionInsightCompat';
import { readSessionInsightSnapshot } from '@/lib/server/hub/sessionInsightSnapshot';
import {
  contextReadingChanged, contextReadingOf, lastKnownContext, parseContextReading,
} from '@/lib/contextReading';
import { parsePromptCache } from '@/lib/promptCache';

/** No CLI to ask: the stored reading is the answer, without an RPC. */
const ASLEEP = new Set(['sleeping', 'error', 'killed']);
/** An offline agent right after a hub restart reconnects within seconds: a
 *  failed reading is retried sooner than the inspector default. */
const CONTEXT_FAILURE_RETRY_MS = 3_000;

/** GET /api/sessions/[id]/context — how full the context window is.
 *
 *  Charon had a live token counter (§14.50) but no notion of the WINDOW, so
 *  "why did my session suddenly forget things" had no answer until the
 *  compaction marker, which arrives after the fact. This answers it before.
 *  Without a live reading (cold, failed, asleep) the last known one answers,
 *  `lastKnown: true` (lib/contextReading.ts). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const force = new URL(req.url).searchParams.get('force') === '1';
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!row) return Response.json({ ok: false, error: 'session not found', reason: 'missing' });
  const stored = parseContextReading(row.contextReadingJson);
  const lastKnown = lastKnownContext(stored, parsePromptCache(row.promptCacheJson));
  const status = peekStream(id)?.status ?? row.status;
  const asleep = !!row.archived || ASLEEP.has(status);
  // Never hold a browser connection on provider telemetry. A cold request
  // starts one shared background job and returns `reason:loading`; all tabs
  // then consume the same snapshot. Identity rides in the same snapshot so
  // it cannot add another focus-time request.
  const usage: Record<string, any> = asleep
    ? { ok: false, reason: 'asleep', error: 'session not running', _snapshot: { state: 'fresh' } }
    : readSessionInsightSnapshot(id, 'context', async () => {
      const raw = await callSessionRpc(id, 'get_context_usage');
      const identity = await callSessionRpc(id, 'session_identity');
      return { ...normalizeCodexContextUsage(raw), identity };
    }, { force, maxAgeMs: 15_000, failureRetryMs: CONTEXT_FAILURE_RETRY_MS });
  const endpoint = connectionConfig(row.providerConfig).customEndpoint;
  const check = supportsCustomEndpoint(row.kind) ? endpoint?.checks?.[row.kind] : undefined;
  const window = check?.model === row.model ? check?.contextWindow : undefined;
  const live = endpoint ? { ...usage, max_tokens: window ?? null,
    percentage: window && Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) * 100 / window : null } : usage;
  const reading = contextReadingOf(live, Date.now());
  if (reading && contextReadingChanged(stored, reading)) {
    db.update(agentSessions).set({ contextReadingJson: JSON.stringify(reading) })
      .where(eq(agentSessions.id, id)).run();
  }
  // No live figures: the last known reading, under the live answer's
  // `_snapshot` (a `loading` one keeps the client asking) — its error stays
  // readable as `_snapshot.last_error`.
  const context = !reading && lastKnown
    ? {
      ...lastKnown,
      ...(live.identity ? { identity: live.identity } : {}),
      _snapshot: { ...(live._snapshot ?? {}), ...(live.error && !asleep ? { last_error: String(live.error) } : {}) },
      ...(asleep ? { asleep: true } : {}),
    }
    : asleep ? { ...live, asleep: true } : live;
  // An incremental fold (it was an O(session) scan on every mount, status
  // edge and window focus). A cold fold of a huge session warms in slices:
  // `recordedPending` until then — never a partial sum — and the client asks
  // once more shortly (useSessionContext).
  const { usage: recorded, pending: recordedPending } = recordedSessionUsage(id);
  // Token totals always; a PRICE only where one is really charged and Charon
  // knows the rate — so not for a provider whose `cost_usd` is an API-list
  // valuation of quota-metered tokens (§14.102 `turnCost`), and not behind a
  // custom endpoint, whose operator sets its own. The `turn_usage` rows keep
  // the figure either way; this only decides whether the panel prices it.
  const priced = !endpoint && showsTurnCost(asSessionProvider(row.kind));
  return Response.json({
    ...context,
    recorded_usage: recorded && !priced ? { ...recorded, cost_usd: null } : recorded,
    ...(recordedPending ? { recordedPending: true } : {}),
  });
}
