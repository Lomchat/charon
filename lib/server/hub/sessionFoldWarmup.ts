import 'server-only';
import { eq } from 'drizzle-orm';
import { agentSessions, db } from '@/lib/db';
import { warmBgRegistry } from '@/lib/server/hub/bgTaskState';
import { warmSessionTokenUsage } from '@/lib/server/agent/sessionTokenUsage';
import { warmRecordedSessionUsage } from '@/lib/server/agent/sessionUsage';

/**
 * Boot warm-up of the session folds (sessionRowCache.ts). A restarted hub
 * starts with every fold cold; the first resync of every reconnecting tab
 * reads every non-archived session's bg registry, and each opened session its
 * token/recorded totals. Queued here, they warm through the row cache's ONE
 * paced pump (a few ms per event-loop turn) instead of inside those requests.
 */
export function warmSessionFoldsAtBoot(): number {
  const ids = db.select({ id: agentSessions.id }).from(agentSessions)
    .where(eq(agentSessions.archived, 0)).all().map((r) => r.id);
  for (const id of ids) {
    // The registry first: every summary (list, resync) reads it.
    warmBgRegistry(id);
  }
  for (const id of ids) {
    warmSessionTokenUsage(id);
    warmRecordedSessionUsage(id);
  }
  return ids.length;
}
