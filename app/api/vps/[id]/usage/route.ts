import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  getUsageSnapshot, usageSnapshotAge, pollUsageForVps, USAGE_STALE_MS,
} from '@/lib/server/agent/usagePoll';

// GET /api/vps/[id]/usage
// Cached account-usage snapshot (the `/usage` gauges) for the header widget.
// SSE is live-only (§14.14), so a freshly-mounted tab hydrates via this GET.
// When the snapshot is missing or stale, force a poll and await it briefly so
// the widget shows real numbers rather than a dash. The poll self-gates on
// connected + claudeLoggedIn and never throws. cf. CLAUDE.md §14.58.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let usage = getUsageSnapshot(id);
  if (!usage || usageSnapshotAge(id) > USAGE_STALE_MS) {
    // force only when we have nothing to show — a stale-but-present snapshot
    // does a gap-respecting poll so re-opening the widget can't hammer the
    // (rate-limited) endpoint.
    const fresh = await pollUsageForVps(id, { force: !usage });
    if (fresh) usage = fresh;
  }
  return NextResponse.json({ usage: usage ?? null });
}
