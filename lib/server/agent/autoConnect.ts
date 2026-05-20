import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable, claudeSessionLogs } from '@/lib/db';
import { getAgentClient } from './AgentClientPool';
import { reconcileVpsAgentState, resumeSession } from './sessionOps';
import type { Vps } from '@/lib/db/schema';

const g = globalThis as unknown as { _agentBooted?: boolean };

/**
 * Au boot de Charon : pour chaque VPS en DB, lance la connexion à son agent
 * en arrière-plan et branche un hook qui re-réconcilie l'état dès que la SSH
 * est établie (à chaque (re)connexion, pas seulement au boot).
 *
 * Le hook `onStatus('connected')` est ce qui rend le système auto-réparable
 * après un `systemctl restart charon` : on lit `hello.sessions` (sessions
 * VRAIMENT vivantes côté agent) et on (ré)attache les SessionStream + on
 * resync le status DB. Cf. `reconcileVpsAgentState` pour le détail.
 *
 * En parallèle on tente un resume opportuniste pour les sessions DB en
 * 'active'/'thinking'/'starting' — utile quand l'agent est joignable
 * immédiatement (cas commun), ou comme fallback si le hook onStatus a déjà
 * fired avant qu'on s'y abonne (HMR dev).
 *
 * Idempotent (guard `_agentBooted`).
 */
export function autoConnectAgentsIfNeeded(): void {
  if (g._agentBooted) return;
  g._agentBooted = true;
  setImmediate(() => {
    let vpses: Vps[] = [];
    try {
      vpses = db.select().from(vpsTable).all();
    } catch {
      return;
    }
    for (const v of vpses) {
      try {
        const client = getAgentClient(v);
        // Hook self-healing : à chaque (re)connexion du SSH, on reconcile.
        client.onStatus((status) => {
          if (status !== 'connected') return;
          const hello = client.hello;
          if (!hello) return;
          reconcileVpsAgentState(v.id, hello.sessions).catch(() => {});
        });
        // Cas où le client est déjà connecté quand on enregistre le hook
        // (peut arriver en dev HMR — sinon improbable au cold boot).
        if (client.status === 'connected' && client.hello) {
          reconcileVpsAgentState(v.id, client.hello.sessions).catch(() => {});
        }
      } catch {}
    }

    // Best-effort : tente un resume direct pour les sessions DB en cours
    // d'exécution. Le reconcile-on-hello qui suit gérera proprement le cas
    // où l'agent met du temps à connecter ; mais ce premier coup direct rend
    // les chats utilisables dès que la connexion réussit, sans attendre un
    // event status. Étendu de 'active' uniquement à 'active'/'thinking'/
    // 'starting' (bug constaté : après SIGTERM pendant une query, la session
    // restait 'thinking' en DB et était ignorée ici).
    let active: { id: string }[] = [];
    try {
      active = db.select({ id: claudeSessions.id })
        .from(claudeSessions)
        .where(inArray(claudeSessions.status, ['active', 'thinking', 'starting']))
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
