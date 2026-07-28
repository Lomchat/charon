import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  getUsageSnapshot, usageSnapshotAge, pollUsageForVps, USAGE_STALE_MS,
  getCodexUsageSnapshot, codexUsageSnapshotAge, pollCodexUsageForVps,
} from '@/lib/server/agent/usagePoll';
import type { AccountUsage } from '@/lib/server/claude/types';
import type { VpsUsageResponse } from '@/lib/types/api';

// GET /api/vps/[id]/usage
// Cached account-usage snapshot (the `/usage` gauges) for the header widget.
// SSE is live-only (§14.14), so a freshly-mounted tab hydrates via this GET.
// When the snapshot is missing or stale, force a poll and await it briefly so
// the widget shows real numbers rather than a dash. The poll self-gates on
// connected + login and never throws. Returns BOTH the Claude account gauges
// (`usage`) and — when the VPS runs Codex — the Codex account gauges
// (`codexUsage`). cf. CLAUDE.md §14.58.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let usage = getUsageSnapshot(id);
  if (!usage || usage.degraded || usageSnapshotAge(id) > USAGE_STALE_MS) {
    // Force when there is nothing good to show — no snapshot at all, a cached
    // FAILURE, or good-but-stale gauges. A cached failure used to count as
    // "present" here, so `force:false` let the backoff swallow the call and the
    // ↻ button could not recover the widget at all (§14.72). Forcing is safe:
    // it skips our own guessed cool-down, never the server's Retry-After nor
    // the 2-minute per-account floor.
    const fresh = await pollUsageForVps(id, { force: !usage || !usage.ok || !!usage.degraded });
    if (fresh) usage = fresh;
  }

  const body: VpsUsageResponse = { usage: usage ?? null };
  // Codex gauges only for VPSes that run Codex (avoids a pointless RPC on a
  // Claude-only box). The poll self-gates on the agent's live availability too.
  if (v.codexAvailable === 1) {
    let codexUsage: AccountUsage | null = getCodexUsageSnapshot(id);
    if (!codexUsage || codexUsageSnapshotAge(id) > USAGE_STALE_MS) {
      const fresh = await pollCodexUsageForVps(id, { force: !codexUsage });
      if (fresh) codexUsage = fresh;
    }
    body.codexUsage = codexUsage ?? null;
  }
  return NextResponse.json(body);
}
