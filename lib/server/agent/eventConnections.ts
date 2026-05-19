import 'server-only';
import { subscribeGlobalSessionEvents, type GlobalSessionEvent } from './sessionOps';

// eventConnections
// ─────────────────────────────────────────────────────────────────────────────
// Registry des connexions SSE multiplexées (/api/claude/events). Chaque client
// browser ouvre UNE seule SSE persistante au mount, identifiée par un connId
// (UUID généré côté client). Le focus (sessionId actuellement regardé) est
// mutable via POST /api/claude/focus — pas de close/reopen sur switch.
//
// Règles de fan-out :
//   - Events "low-volume" (status, mode_changed, ready, session_id,
//     permission_request, user_question, exit_plan_request,
//     interaction_resolved, error) → forwardés à TOUTES les connexions
//     (pour les badges sidebar + popup permissions cross-session).
//   - Events "high-volume" (assistant_text, thinking, tool_use, tool_result,
//     edit_snapshot, todo_update, user_echo, stop, prefill_input,
//     reconnecting) → forwardés UNIQUEMENT à la connexion qui a la session
//     en focus. Le client charge l'historique par GET en parallèle.
//
// Quand un client switch de focus :
//   1. Client POST /focus { conn, sessionId } → maj du focus
//   2. Client GET /api/claude/sessions/[id] → recharge l'historique persisté
//   3. SSE continue de couler — désormais les high-volume de la nouvelle
//      session arrivent

const LOW_VOLUME_EVENTS = new Set<string>([
  'status', 'mode_changed', 'ready', 'session_id',
  'permission_request', 'user_question', 'exit_plan_request',
  'interaction_resolved', 'error',
]);

function isLowVolume(type: string): boolean {
  return LOW_VOLUME_EVENTS.has(type);
}

type ConnState = {
  send: (ev: GlobalSessionEvent) => void;
  focus: string | null;
  unsubBus: (() => void) | null;
};

const gReg = globalThis as unknown as { _eventConnections?: Map<string, ConnState> };
if (!gReg._eventConnections) gReg._eventConnections = new Map();
const connections: Map<string, ConnState> = gReg._eventConnections;

/**
 * Enregistre une connexion SSE. Branche la connexion au bus global et
 * applique le filtre par focus. Retourne une fonction unregister à appeler
 * à la fermeture de la SSE (req abort).
 */
export function registerConnection(opts: {
  connId: string;
  send: (ev: GlobalSessionEvent) => void;
  initialFocus?: string | null;
}): () => void {
  // Si un connId existe déjà (ex: client a reconnecté avant qu'on détecte le
  // close), on remplace proprement.
  const existing = connections.get(opts.connId);
  if (existing?.unsubBus) existing.unsubBus();

  const conn: ConnState = {
    send: opts.send,
    focus: opts.initialFocus ?? null,
    unsubBus: null,
  };
  conn.unsubBus = subscribeGlobalSessionEvents((ev) => {
    if (isLowVolume(ev.type) || ev.sessionId === conn.focus) {
      try { conn.send(ev); } catch {}
    }
  });
  connections.set(opts.connId, conn);

  return () => {
    const c = connections.get(opts.connId);
    if (!c) return;
    if (c.unsubBus) c.unsubBus();
    connections.delete(opts.connId);
  };
}

/**
 * Change le focus d'une connexion. Retourne true si trouvée, false sinon.
 * Le SSE continue de couler ; à partir du prochain event, le filtre
 * utilise le nouveau focus.
 */
export function setConnectionFocus(connId: string, sessionId: string | null): boolean {
  const conn = connections.get(connId);
  if (!conn) return false;
  conn.focus = sessionId;
  return true;
}

/**
 * Compte les connexions qui ont cette session en focus. Sert au badge
 * "×N clients connectés" affiché dans la sidebar/header.
 */
export function focusCountFor(sessionId: string): number {
  let n = 0;
  for (const c of connections.values()) if (c.focus === sessionId) n++;
  return n;
}
