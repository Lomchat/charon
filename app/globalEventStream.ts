'use client';
import type { WorkerEvent } from '@/lib/server/claude/types';

// globalEventStream
// ─────────────────────────────────────────────────────────────────────────────
// Singleton client : UNE seule EventSource sur /api/claude/events pour tout
// le browser. Les hooks (`useClaudeSessionStream`, `useCrossSessionInteractionFeed`)
// s'abonnent à ce module au lieu d'ouvrir leur propre SSE.
//
// Pourquoi un singleton :
//   - Évite la saturation HTTP/1.1 (6 connexions max par origine côté
//     Apache front, cf. CLAUDE.md §14 piège 15).
//   - Zero latence de switch de session : un POST /focus suffit, la SSE
//     reste ouverte.
//   - Une seule connexion à gérer pour le reconnect/health.

export type GlobalEvent = WorkerEvent & { sessionId: string };
type Listener = (ev: GlobalEvent) => void;

// connId stable sur la durée du tab. Si on perd la connexion et qu'on
// reconnecte avec le même connId, le serveur remplace proprement la conn
// existante (cf. eventConnections.ts § registerConnection).
function genConnId(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID();
  }
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let connId: string | null = null;
let es: EventSource | null = null;
let currentFocus: string | null = null;
// `null` key = catch-all listeners (qui veulent tous les events de toutes
// les sessions, ex: useCrossSessionInteractionFeed).
const listeners = new Map<string | null, Set<Listener>>();
let pendingFocusPost: Promise<void> | null = null;

function getConnId(): string {
  if (!connId) connId = genConnId();
  return connId;
}

function ensureStream(): void {
  if (es) return;
  if (typeof window === 'undefined') return; // SSR guard
  const id = getConnId();
  const url = `/api/claude/events?conn=${encodeURIComponent(id)}`
    + (currentFocus ? `&focus=${encodeURIComponent(currentFocus)}` : '');
  es = new EventSource(url);
  es.onmessage = (e) => {
    let ev: GlobalEvent;
    try { ev = JSON.parse(e.data); } catch { return; }
    // Fan-out aux listeners de cette session + aux catch-all
    const perSession = listeners.get(ev.sessionId);
    if (perSession) for (const cb of perSession) {
      try { cb(ev); } catch {}
    }
    const all = listeners.get(null);
    if (all) for (const cb of all) {
      try { cb(ev); } catch {}
    }
  };
  // onopen : si on était focus avant le drop, l'URL initiale a déjà passé
  // ?focus= donc la conn s'enregistre directement avec le bon focus.
  // Le navigateur reconnecte automatiquement EventSource après un drop ; on
  // ne fait rien de spécial ici. Les consumers font leur propre refetch
  // via leur useEffect au mount.

  // onerror : EventSource gère lui-même la reconnexion. On ne log pas pour
  // éviter le bruit en console à chaque heartbeat manqué.
}

/**
 * Abonne un listener à TOUS les events d'une session donnée. Retourne un
 * unsubscribe. Ouvre la SSE lazy si pas encore faite.
 */
export function subscribeSession(sessionId: string, cb: Listener): () => void {
  ensureStream();
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  set.add(cb);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Abonne un listener à TOUS les events de TOUTES les sessions. Utilisé par
 * useCrossSessionInteractionFeed pour les popups cross-session.
 */
export function subscribeAll(cb: Listener): () => void {
  ensureStream();
  let set = listeners.get(null);
  if (!set) { set = new Set(); listeners.set(null, set); }
  set.add(cb);
  return () => {
    const s = listeners.get(null);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(null);
  };
}

/**
 * Change la session focus côté serveur. Le serveur commencera à streamer les
 * events high-volume (assistant_text, tool_use, etc.) de cette session sans
 * close/reopen de la SSE.
 *
 * Si `sessionId` est identique au focus courant, no-op.
 *
 * Idempotent : si plusieurs setFocus partent en même temps (rapide navigation),
 * la dernière gagne ; on coalesce via `pendingFocusPost`.
 */
export async function setFocus(sessionId: string | null): Promise<void> {
  ensureStream();
  if (currentFocus === sessionId) return;
  currentFocus = sessionId;
  // POST /focus — on coalesce mais on tente quand même en cas de retry.
  const id = getConnId();
  const post = fetch('/api/claude/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conn: id, sessionId }),
  }).then(() => {}).catch(() => {});
  pendingFocusPost = post;
  await post;
  if (pendingFocusPost === post) pendingFocusPost = null;
}

/**
 * Pour debug / introspection.
 */
export function getCurrentFocus(): string | null {
  return currentFocus;
}
