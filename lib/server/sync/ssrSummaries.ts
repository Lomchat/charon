// THE page seed of the summary store (§14.108, §9), shared by every page that
// mounts it (`/` and `/desk`): the list GET's builder, stamped with the bus
// revision read in the SAME synchronous section (I2) — the client's first SSE
// connect resumes from that stamp (`initSyncPosition`).
import 'server-only';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { SyncStamp } from '@/lib/sync/protocol';
import { sweepExpiredInteractions } from '@/lib/server/agent/sessionOps';
import { reconcileAllSummaries } from './sessionSummaries';
import { currentRev, flushSummaries } from './syncBus';
import { buildId } from './buildId';

export type SsrSummaries = {
  summaries: SessionSummary[];
  sync: SyncStamp & { buildId: string };
};

export function ssrSummaries(): SsrSummaries {
  // Expired gates are swept first, as the list route does (the sweep
  // publishes each removal).
  try { sweepExpiredInteractions(); } catch {}
  flushSummaries();
  const summaries = reconcileAllSummaries();
  // No await between the read above and this stamp (I2).
  return { summaries, sync: { ...currentRev(), buildId: buildId() } };
}
