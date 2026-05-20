'use client';
import type { WorkerEvent } from '@/lib/server/claude/types';
import type { InstallStatus } from '@/lib/types/api';

// globalEventStream
// ─────────────────────────────────────────────────────────────────────────────
// Singleton client : UNE seule EventSource sur /api/claude/events pour tout
// le browser. Les hooks (`useClaudeSessionStream`, `useCrossSessionInteractionFeed`,
// `useInstallNotifications`) s'abonnent à ce module au lieu d'ouvrir leur
// propre SSE.
//
// Pourquoi un singleton :
//   - Évite la saturation HTTP/1.1 (6 connexions max par origine côté
//     Apache front, cf. CLAUDE.md §14 piège 15).
//   - Zero latence de switch de session : un POST /focus suffit, la SSE
//     reste ouverte.
//   - Une seule connexion à gérer pour le reconnect/health.
//
// Le SSE serveur multiplexe 2 sources :
//   - Bus session (`sessionOps.ts § subscribeGlobalSessionEvents`)
//   - Bus install (`installSession.ts § subscribeInstallBus`) — pour les
//     notifs install_started / install_finished
// Les install events n'ont PAS de `sessionId` ; ils sont distingués par leur
// `type` (`install_started` / `install_finished`).

export type InstallBusClientEvent =
  | { type: 'install_started'; installId: string; vpsId: string; vpsName: string; status: InstallStatus }
  | { type: 'install_finished'; installId: string; vpsId: string; vpsName: string; status: InstallStatus };

export type SessionBusClientEvent = WorkerEvent & { sessionId: string };

export type GlobalEvent = SessionBusClientEvent | InstallBusClientEvent;

function hasSessionId(ev: GlobalEvent): ev is SessionBusClientEvent {
  return 'sessionId' in ev && typeof (ev as any).sessionId === 'string';
}

// Deux saveurs de listener : `SessionListener` pour les abonnements par
// sessionId (qui ne reçoivent que des events tagués sessionId), et
// `GlobalListener` pour les catch-all qui reçoivent aussi les install
// events. On les sépare pour que les callers par-session (typiquement
// `useClaudeSessionStream`) puissent s'écrire avec un callback typé
// `(ev: WorkerEvent & {sessionId: string}) => void` sans cast.
type SessionListener = (ev: SessionBusClientEvent) => void;
type GlobalListener = (ev: GlobalEvent) => void;

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
// les sessions, ex: useCrossSessionInteractionFeed). On stocke en Set d'une
// fonction au type le plus large possible (GlobalListener) ; pour les
// abonnements par-sessionId, les callbacks sont contravariament compatibles
// car ils ne recevront jamais que des SessionBusClientEvent.
const listeners = new Map<string | null, Set<GlobalListener>>();
let pendingFocusPost: Promise<void> | null = null;

// Détection de reconnect EventSource : `openCount` part à 0, devient 1 sur
// la 1re connexion (boot), puis ≥2 à chaque auto-reconnect du browser après
// un drop (ex: backend redémarré). On notifie les consumers pour qu'ils
// refetch l'historique manqué pendant le gap — la SSE elle-même ne replay
// que les events live + un snapshot status, pas les messages persistés.
let openCount = 0;
const reconnectListeners = new Set<() => void>();

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
    // Fan-out aux listeners de cette session (sauf install events qui n'en ont
    // pas) + aux catch-all (qui reçoivent tout, y compris les installs).
    if (hasSessionId(ev)) {
      const perSession = listeners.get(ev.sessionId);
      if (perSession) for (const cb of perSession) {
        try { cb(ev); } catch {}
      }
    }
    const all = listeners.get(null);
    if (all) for (const cb of all) {
      try { cb(ev); } catch {}
    }
  };
  es.onopen = () => {
    openCount++;
    if (openCount <= 1) return;  // 1re ouverture (boot) : pas un reconnect
    // À chaque reconnect (≥ 2e open), deux choses à faire :
    //
    // 1) Re-POST le focus côté serveur. La reconnexion auto-browser réouvre
    //    l'URL d'ORIGINE — donc le ?focus= dans l'URL est celui au moment
    //    de la création de l'EventSource. Si l'user a changé de session
    //    entretemps (via setFocus), le serveur recale sur le mauvais focus
    //    sans ce re-POST, et les events high-volume de la session courante
    //    ne sont pas streamés.
    //
    // 2) Notifier les consumers (ex: useClaudeSessionStream) pour qu'ils
    //    refetch l'historique : pendant le gap SSE, Charon a pu persister
    //    des messages que la SSE n'a pas relayés (elle est live-only côté
    //    Charon — pas de ring buffer, cf. CLAUDE.md §14 piège 14). Sans
    //    ce refetch, l'UI reste figée sur le dernier état pré-drop.
    const id = getConnId();
    if (currentFocus) {
      fetch('/api/claude/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conn: id, sessionId: currentFocus }),
      }).catch(() => {});
    }
    for (const cb of reconnectListeners) {
      try { cb(); } catch {}
    }
  };

  // onerror : EventSource gère lui-même la reconnexion. On ne log pas pour
  // éviter le bruit en console à chaque heartbeat manqué.
}

/**
 * Abonne un listener qui fire à chaque reconnect SSE (PAS au 1er open).
 * Utile pour refetcher l'historique manqué pendant le drop. Retourne un
 * unsubscribe.
 */
export function subscribeReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb);
  return () => { reconnectListeners.delete(cb); };
}

/**
 * Abonne un listener à TOUS les events d'une session donnée. Retourne un
 * unsubscribe. Ouvre la SSE lazy si pas encore faite.
 */
export function subscribeSession(sessionId: string, cb: SessionListener): () => void {
  ensureStream();
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  // Le store est typé `GlobalListener` mais on ne dispatch que des
  // SessionBusClientEvent dans ce bucket (cf. `hasSessionId(ev)` plus haut),
  // donc le cast est safe.
  set.add(cb as GlobalListener);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(cb as GlobalListener);
    if (s.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Abonne un listener à TOUS les events de TOUTES les sessions. Utilisé par
 * useCrossSessionInteractionFeed pour les popups cross-session.
 */
export function subscribeAll(cb: GlobalListener): () => void {
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
