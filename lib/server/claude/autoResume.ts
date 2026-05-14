import 'server-only';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionLogs } from '@/lib/db';
import { resume } from './SessionWorkerPool';
import { getSettingNumber } from './settings';

const g = globalThis as unknown as { _claudeBooted?: boolean };

function purgeKilledIfNeeded(): void {
  const days = getSettingNumber('retention.killed_days', 0);
  if (days <= 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  try {
    const purged = db.delete(claudeSessions)
      .where(and(
        eq(claudeSessions.status, 'killed'),
        lt(claudeSessions.lastUsedAt, cutoff),
      ))
      .run();
    if (purged.changes > 0) {
      db.insert(claudeSessionLogs).values({
        sessionId: null, level: 'info', event: 'purge',
        detail: JSON.stringify({ count: purged.changes, days }),
      }).run();
    }
  } catch {}
}

// Reprise idempotente au boot : appelé depuis seedInitialData(). Lance les
// resume en arrière-plan, sans bloquer la requête courante.
export function autoResumeIfNeeded(): void {
  if (g._claudeBooted) return;
  g._claudeBooted = true;
  setImmediate(() => {
    purgeKilledIfNeeded();
    let toResume: { id: string }[] = [];
    try {
      toResume = db.select({ id: claudeSessions.id })
        .from(claudeSessions)
        .where(eq(claudeSessions.status, 'active'))
        .all();
    } catch (e: any) {
      // tables pas encore migrees ?
      return;
    }
    for (const s of toResume) {
      resume(s.id)
        .then(() => {
          try {
            db.insert(claudeSessionLogs).values({
              sessionId: s.id, level: 'info', event: 'auto_resume',
              detail: null,
            }).run();
          } catch {}
        })
        .catch((e) => {
          try {
            db.insert(claudeSessionLogs).values({
              sessionId: s.id, level: 'warn', event: 'auto_resume',
              detail: JSON.stringify({ err: e?.message ?? String(e) }),
            }).run();
            // Forcer le statut a sleeping si on n'a pas pu reprendre
            db.update(claudeSessions).set({ status: 'sleeping' }).where(eq(claudeSessions.id, s.id)).run();
          } catch {}
        });
    }
  });
}
