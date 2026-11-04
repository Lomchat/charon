import 'server-only';
import { eq } from 'drizzle-orm';
import { db, agentSessions, sessionLogs, appSettings } from '@/lib/db';

const MARKER_KEY = 'migration.v2_agent_done';

/**
 * "v2 agent" migration: once, on the first boot after the charon-agent refactor.
 * All sessions that were `status='active'` from the days of the old
 * SessionWorker point to dead bridges (they were children of Charon's SSH,
 * so killed when we restarted). We switch them to 'sleeping' so the user
 * sees them and can relaunch them via the new pool, which will recreate the
 * session on the agent side by passing the claude_session_id.
 *
 * Idempotent: a setting marker acts as the "already done" flag.
 */
export function migrationV2IfNeeded(): void {
  const [marker] = db.select().from(appSettings)
    .where(eq(appSettings.key, MARKER_KEY)).all();
  if (marker) return;

  let affected = 0;
  try {
    const r = db.update(agentSessions)
      .set({ status: 'sleeping' })
      .where(eq(agentSessions.status, 'active'))
      .run();
    affected = (r as { changes?: number }).changes ?? 0;
  } catch (e: any) {
    db.insert(sessionLogs).values({
      sessionId: null, level: 'warn', event: 'migration_v2',
      detail: JSON.stringify({ err: String(e?.message ?? e) }),
    }).run();
    return;
  }

  db.insert(appSettings).values({
    key: MARKER_KEY,
    value: String(Math.floor(Date.now() / 1000)),
  }).run();
  db.insert(sessionLogs).values({
    sessionId: null, level: 'info', event: 'migration_v2',
    detail: JSON.stringify({ moved_to_sleeping: affected }),
  }).run();
}
