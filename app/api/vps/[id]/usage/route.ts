import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  PROVIDER_USAGE, USAGE_STALE_MS,
  getAccountProfileUsage, pollAccountProfileUsage,
} from '@/lib/server/agent/usagePoll';
import type { AccountUsage } from '@/lib/server/hub/types';
import type { VpsUsageResponse } from '@/lib/types/api';
import {
  PROVIDERS, SESSION_PROVIDERS, providerBackendState, type SessionProvider,
} from '@/lib/sessionCapabilities';
import { isSessionProvider } from '@/lib/sessionCapabilities';
import { requireAccountProfile, readProfileStatus } from '@/lib/server/agent/accountProfiles';
import { profileStatuses, statusKey } from '@/lib/server/agent/accountProfileState';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { DEFAULT_ACCOUNT_PROFILE } from '@/lib/accountProfiles';

// GET /api/vps/[id]/usage
// Cached account-usage snapshot (the `/usage` gauges) for the header widget.
// SSE is live-only (§14.14), so a freshly-mounted tab hydrates via this GET.
// When a snapshot is missing or stale, force a poll and await it briefly so the
// widget shows real numbers rather than a dash. Every poll self-gates on
// connected + login and never throws.
//
// Loops over the provider registry (§14.102): a new backend's gauges hydrate
// here as soon as it declares a usage adapter. `usage`/`codexUsage` stay in the
// response as the historical Claude/Codex fields; `byProvider` is the neutral
// map new clients read. cf. CLAUDE.md §14.58.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const query = new URL(_req.url).searchParams;
  const provider = query.get('provider');
  const profile = query.get('profile') ?? 'default';
  if (provider != null || profile !== 'default') {
    if (!isSessionProvider(provider)) return NextResponse.json({ error: 'Provider required' }, { status: 400 });
    try {
      requireAccountProfile(id, provider, profile);
      const refresh = query.get('refresh') === '1';
      // `cached=1` (the header account buttons hydrating every login at
      // once): the snapshot only, never an awaited poll or profile RPC — the
      // `account_usage` SSE carries the next reading.
      const cachedOnly = query.get('cached') === '1' && !refresh;
      // A disconnected agent never holds this response: the cached snapshot
      // is the answer then, and the SSE delivers the next one (§14.72).
      const connected = !cachedOnly && getAgentClientForVpsId(id).status === 'connected';
      if (profile === DEFAULT_ACCOUNT_PROFILE) {
        // The default account keeps its adapter's pacing; verifying its
        // identity is the account-profile watch's job, never this GET's.
        const adapter = PROVIDER_USAGE[provider];
        const cached = adapter.snapshot(id);
        if (connected && (refresh || adapter.needsForce(cached) || adapter.ageMs(id) > USAGE_STALE_MS)) {
          await adapter.poll(id, { force: refresh || adapter.needsForce(cached) });
        }
      } else {
        // An extra profile has no bucket until something verified who it is.
        if (connected && provider !== 'cursor' && !profileStatuses.has(statusKey(id, provider, profile))) {
          await readProfileStatus(id, provider, profile).catch(() => {});
        }
        const cached = getAccountProfileUsage(id, provider, profile);
        if (connected && (refresh || !cached?.ok || Date.now() - cached.fetchedAt > USAGE_STALE_MS)) {
          await pollAccountProfileUsage(id, provider, profile, { force: refresh || !cached?.ok });
        }
      }
      const usage = getAccountProfileUsage(id, provider, profile);
      return NextResponse.json({ usage: provider === 'claude' ? usage : null,
        codexUsage: provider === 'codex' ? usage : undefined, byProvider: { [provider]: usage } });
    } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  }

  const byProvider: Partial<Record<SessionProvider, AccountUsage | null>> = {};
  for (const p of SESSION_PROVIDERS) {
    // Only poll a backend this box actually runs — the same rule as the
    // launcher (§14.102): a runtime whose absence cannot block (Claude, whose
    // version is merely unreported on old agents) is always polled; one with a
    // definite availability flag is polled only when it reports installed,
    // avoiding a pointless RPC on a box that does not run it.
    const backend = PROVIDERS[p].backend;
    if (backend.availability.blocksLaunch
        && providerBackendState(v as any, p).available !== 1) continue;
    const adapter = PROVIDER_USAGE[p];
    let usage = adapter.snapshot(id);
    if (adapter.needsForce(usage) || adapter.ageMs(id) > USAGE_STALE_MS) {
      // Forcing skips only our own guessed cool-down — never the server's
      // Retry-After nor the per-account floor (§14.72).
      const fresh = await adapter.poll(id, { force: adapter.needsForce(usage) });
      if (fresh) usage = fresh;
    }
    byProvider[p] = usage ?? null;
  }

  const body: VpsUsageResponse = {
    usage: byProvider.claude ?? null,
    byProvider,
  };
  if ('codex' in byProvider) body.codexUsage = byProvider.codex ?? null;
  return NextResponse.json(body);
}
