import 'server-only';
import { seedInitialData } from '@/lib/server/seed';
import { startLoopLagMonitor } from '@/lib/server/perf/loopLag';
import { warmSessionFoldsAtBoot } from '@/lib/server/hub/sessionFoldWarmup';

// Process boot, BEFORE the first request (§14.45): the agents connect and
// reconcile now, not when a browser first loads a page — a tab that survives
// a restart only reconnects its SSE, and push/Telegram must work with no tab.
// seedInitialData is idempotent; GET /api/events calls it too.
export function bootHub(): void {
  try {
    seedInitialData();
    console.log('[charon] agents armed at boot (seedInitialData)');
  } catch (e) {
    console.error('[charon] boot: seed failed', e);
  }
  // `[eventloop]` journal lines, GET /api/perf. Its own try: a failed seed
  // still gets it.
  try {
    startLoopLagMonitor();
  } catch (e) {
    console.error('[charon] boot: loop lag monitor failed', e);
  }
  // Cold folds paced in the background, not inside the first requests.
  try {
    warmSessionFoldsAtBoot();
  } catch (e) {
    console.error('[charon] boot: fold warm-up failed', e);
  }
}
