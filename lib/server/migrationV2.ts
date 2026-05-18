import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionLogs, claudeSettings } from '@/lib/db';

const MARKER_KEY = 'migration.v2_agent_done';

/**
 * Migration "v2 agent" :  une fois, au premier boot après le refactor charon-agent.
 * Toutes les sessions qui étaient `status='active'` du temps de l'ancien
 * SessionWorker pointent vers des bridges morts (ils étaient enfants de la SSH
 * de Charon, donc tués quand on a redémarré). On les bascule en 'sleeping' pour
 * que l'utilisateur les voie et puisse les relancer via le nouveau pool, qui
 * recréera la session côté agent en passant le claude_session_id.
 *
 * Idempotent : un setting marker sert de drapeau "déjà fait".
 */
export function migrationV2IfNeeded(): void {
  const [marker] = db.select().from(claudeSettings)
    .where(eq(claudeSettings.key, MARKER_KEY)).all();
  if (marker) return;

  let affected = 0;
  try {
    const r = db.update(claudeSessions)
      .set({ status: 'sleeping' })
      .where(eq(claudeSessions.status, 'active'))
      .run();
    affected = (r as { changes?: number }).changes ?? 0;
  } catch (e: any) {
    db.insert(claudeSessionLogs).values({
      sessionId: null, level: 'warn', event: 'migration_v2',
      detail: JSON.stringify({ err: String(e?.message ?? e) }),
    }).run();
    return;
  }

  db.insert(claudeSettings).values({
    key: MARKER_KEY,
    value: String(Math.floor(Date.now() / 1000)),
  }).run();
  db.insert(claudeSessionLogs).values({
    sessionId: null, level: 'info', event: 'migration_v2',
    detail: JSON.stringify({ moved_to_sleeping: affected }),
  }).run();
}
