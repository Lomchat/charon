import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable, claudeSessionLogs } from '@/lib/db';
import { getAgentClient } from './AgentClientPool';
import { resumeSession, getStream } from './sessionOps';

const g = globalThis as unknown as { _agentBooted?: boolean };

/**
 * Au boot de Charon : pour chaque VPS en DB, lance la connexion à son agent
 * en arrière-plan. Puis pour chaque session 'active' restée, déclenche un
 * resumeSession() — qui tentera l'opération côté agent dès qu'il est joignable.
 *
 * Idempotent (guard `_agentBooted`).
 */
export function autoConnectAgentsIfNeeded(): void {
  if (g._agentBooted) return;
  g._agentBooted = true;
  setImmediate(() => {
    // 1. Spawn les AgentClients (connexion en arrière-plan, n'attend pas)
    let vpses: any[] = [];
    try {
      vpses = db.select().from(vpsTable).all();
    } catch {
      return;
    }
    for (const v of vpses) {
      try { getAgentClient(v); } catch {}
    }

    // 2. Pour les sessions 'active' : attache un stream et tente le resume
    let active: { id: string }[] = [];
    try {
      active = db.select({ id: claudeSessions.id })
        .from(claudeSessions)
        .where(eq(claudeSessions.status, 'active'))
        .all();
    } catch {
      return;
    }
    for (const s of active) {
      resumeSession(s.id)
        .then(() => {
          try {
            db.insert(claudeSessionLogs).values({
              sessionId: s.id, level: 'info', event: 'auto_resume', detail: null,
            }).run();
          } catch {}
        })
        .catch((e) => {
          try {
            db.insert(claudeSessionLogs).values({
              sessionId: s.id, level: 'warn', event: 'auto_resume',
              detail: JSON.stringify({ err: e?.message ?? String(e) }),
            }).run();
            // Si l'agent est down, on dégrade en 'sleeping' pour que l'UI
            // affiche un bouton resume manuel.
            db.update(claudeSessions).set({ status: 'sleeping' })
              .where(eq(claudeSessions.id, s.id)).run();
          } catch {}
        });
    }
  });
}
