import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  PROVIDER_USAGE, USAGE_STALE_MS,
} from '@/lib/server/agent/usagePoll';
import type { AccountUsage } from '@/lib/server/claude/types';
import type { VpsUsageResponse } from '@/lib/types/api';
import {
  PROVIDERS, SESSION_PROVIDERS, providerBackendState, type SessionProvider,
} from '@/lib/sessionCapabilities';

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
