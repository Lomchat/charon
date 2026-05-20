'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';
import Sidebar, { type SessionListItem, type ShellListItem, type InstallInfo } from './Sidebar';
import ShellTerminal from './ShellTerminal';
import InstallSessionView from './InstallSessionView';
import NewSessionDialog from './NewSessionDialog';
import DataModal from './DataModal';
import ResumeModal from './ResumeModal';
import PermissionPopup from './PermissionPopup';
import InstallNotificationPopup from './InstallNotificationPopup';
import { useCrossSessionInteractionFeed } from './useCrossSessionInteractionFeed';
import { useInstallNotifications } from './useInstallNotifications';
import { subscribeAll } from './globalEventStream';
import SearchModal from './SearchModal';
import SettingsModal from './SettingsModal';
import SessionContextMenu from './SessionContextMenu';
import LoginConsole from './LoginConsole';
import LocalAgentButton from './LocalAgentButton';
import ClaudeSessionView from './ClaudeSessionView';
import { prefetchAll as sessionCachePrefetchAll } from './sessionCache';
import { pushCurrentEndpoint, pushSubscribe, pushUnsubscribe, pushSupported } from './pushClient';
import {
  IconBellFill, IconBellSlash, IconGear, IconSearch,
  IconServers, IconVolumeMute, IconVolumeUp,
} from './icons';

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialSessions: ClaudeSession[];
  builtPyzSha: string | null;
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  starting: 'démarrage',
  active: 'actif',
  thinking: 'réfléchit',
  sleeping: 'endormi',
  killed: 'tué',
  error: 'erreur',
  reconnecting: 'reconnexion…',
};
const STATUS_DOT: Record<WorkerStatus, string> = {
  starting: 'amber',
  active: 'green',
  thinking: 'amber-pulse',
  sleeping: 'gray',
  killed: 'gray',
  error: 'red',
  reconnecting: 'amber-pulse',
};

// SessionState/emptyState supprimés au refactor : l'état per-session vit
// désormais dans `useClaudeSessionStream` (consommé par `<ClaudeSessionView>`).

export default function ClaudePanel({ vpsList: initialVpsList, vpsFolders: initialFolders, vpsPaths: initialPaths, initialSessions, builtPyzSha }: Props) {
  // Copies mutables — DataModal peut add/delete VPS, folders et paths sans reload.
  const [vpsList, setVpsList] = useState<Vps[]>(initialVpsList);
  const [vpsFolders, setVpsFolders] = useState<VpsFolder[]>(initialFolders);
  const [vpsPaths, setVpsPaths] = useState<VpsPath[]>(initialPaths);
  const searchParams = useSearchParams();
  const queryParamSession = searchParams?.get('session') ?? null;
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions as SessionListItem[]);
  const [selectedId, setSelectedId] = useState<string | null>(queryParamSession ?? initialSessions[0]?.id ?? null);

  // Si le param ?session= change (clic notif ou navigation), on switch
  useEffect(() => {
    if (queryParamSession && queryParamSession !== selectedId) {
      setSelectedId(queryParamSession);
    }
  }, [queryParamSession]); // eslint-disable-line

  // Sync selectedId → URL (?session=...) sans spammer l'historique
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (selectedId) {
      if (url.searchParams.get('session') !== selectedId) {
        url.searchParams.set('session', selectedId);
        window.history.replaceState(null, '', url);
      }
    } else if (url.searchParams.has('session')) {
      url.searchParams.delete('session');
      window.history.replaceState(null, '', url);
    }
  }, [selectedId]);
  // `error` reste au parent : il porte les erreurs de rename/kill/patch etc.
  // qui sont des actions cross-session (pas dans la vue active). Les erreurs
  // de la SESSION ACTIVE vivent dans `<ClaudeSessionView>` via le hook.
  const [error, setError] = useState<{ msg: string; canResume?: boolean } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; session: SessionListItem; x: number; y: number }
    | { kind: 'shell'; shell: ShellListItem; x: number; y: number }
    | { kind: 'install'; install: InstallInfo; x: number; y: number }
    | null
  >(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Console claude login interactive
  const [loginVps, setLoginVps] = useState<Vps | null>(null);

  // Quand l'user ferme la LoginConsole, on re-check l'état `claude login` du
  // VPS — il vient peut-être de se connecter (ou de déconnecter). Le résultat
  // est persisté côté serveur et patché localement pour que la sidebar masque
  // immédiatement le bouton "claude login" si plus nécessaire.
  const closeLoginConsole = useCallback(() => {
    const v = loginVps;
    setLoginVps(null);
    if (!v) return;
    // Best-effort, async. Si SSH plante, on garde l'ancienne valeur.
    api.checkVpsClaudeLogin(v.id)
      .then((r) => {
        if (!r.ok) return;
        setVpsList((prev) => prev.map((vp) =>
          vp.id === v.id
            ? ({
                ...vp,
                claudeLoggedIn: r.loggedIn ? 1 : 0,
                claudeLoggedInCheckedAt: r.checkedAt,
              } as Vps)
            : vp,
        ));
      })
      .catch(() => {});
  }, [loginVps]);
  // Shells SSH ephémères. Liste live (pollée au mount, mise à jour locale).
  const [shells, setShells] = useState<ShellListItem[]>([]);
  // Si non-null, c'est un shell qui est affiché dans le main panel (au lieu du chat)
  const [selectedShellId, setSelectedShellId] = useState<string | null>(null);
  // Sessions d'installation d'agent. Mémoire seulement (pattern shell). Une
  // install par VPS au max (cf. installSession.ts § startInstall).
  const [installs, setInstalls] = useState<InstallInfo[]>([]);
  // Si non-null, c'est une session install qui occupe le main panel.
  const [selectedInstallId, setSelectedInstallId] = useState<string | null>(null);

  // Charge la liste des shells au mount + refresh quand un sélecteur change
  useEffect(() => {
    let cancelled = false;
    api.listShells().then((r) => {
      if (!cancelled) setShells(r?.shells ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Charge la liste des installs au mount (pour récupérer les installs encore
  // en cours après un refresh d'onglet — le pool est mémoire serveur, survit).
  useEffect(() => {
    let cancelled = false;
    api.listInstalls().then((r) => {
      if (!cancelled) setInstalls(r?.installs ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Refresh live de la liste des installs sur events bus :
  //   - install_started → ajoute / met à jour la row sidebar
  //   - install_finished → mise à jour du status, on garde la row pour que
  //     l'user puisse rouvrir le log (close manuel via clic-droit)
  useEffect(() => {
    const refreshOne = async (installId: string) => {
      try {
        const info = await api.getInstall(installId);
        setInstalls((prev) => {
          const others = prev.filter((i) => i.id !== installId);
          return [...others, info];
        });
      } catch {}
    };
    const unsub = subscribeAll((ev) => {
      if (!('installId' in ev)) return;
      if (ev.type === 'install_started' || ev.type === 'install_finished') {
        refreshOne(ev.installId);
        // Met à jour vps.agentStatus + agentPyzSha localement quand l'install
        // réussit. Sans ça : le badge "outdated" reste affiché parce que le
        // local `agentPyzSha` (récupéré au SSR initial) est encore l'ancien,
        // alors que côté serveur le bootstrap a déjà persisté le nouveau sha
        // (cf. bootstrap.ts § ping_agent). Par construction, après un
        // bootstrap success, le sha déployé EST `builtPyzSha` — on peut donc
        // patcher localement sans refetch.
        if (ev.type === 'install_finished' && ev.status === 'success') {
          setVpsList((prev) => prev.map((v) =>
            v.id === ev.vpsId
              ? ({
                  ...v,
                  agentStatus: 'ok',
                  // builtPyzSha vient du prop ; null tolérable (fallback au
                  // prochain hello de l'AgentClient).
                  agentPyzSha: builtPyzSha ?? v.agentPyzSha,
                } as Vps)
              : v,
          ));
        }
      }
    });
    return () => unsub();
  }, [builtPyzSha]);

  // Notifs install (queue locale au tab, populée par le bus global)
  const {
    notifications: installNotifications,
    dismiss: dismissInstallNotif,
  } = useInstallNotifications();

  async function startShell(opts: { vpsId: string; cwd?: string | null }) {
    try {
      const sh = await api.startShell(opts.vpsId, opts.cwd ?? null);
      setShells((prev) => [...prev.filter((s) => s.id !== sh.id), sh]);
      setSelectedShellId(sh.id);
      setSelectedId(null);  // mutuellement exclusif avec une session claude
      setSelectedInstallId(null);
    } catch (e: any) {
      setError({ msg: 'shell: ' + (e?.message ?? e) });
    }
  }
  function selectShell(id: string) {
    setSelectedShellId(id);
    setSelectedId(null);
    setSelectedInstallId(null);
  }
  function shellKilled(id: string) {
    setShells((prev) => prev.filter((s) => s.id !== id));
    if (selectedShellId === id) setSelectedShellId(null);
  }
  // Quand on sélectionne une session Claude, on désélectionne shell + install
  function selectClaude(id: string) {
    setSelectedId(id);
    setSelectedShellId(null);
    setSelectedInstallId(null);
  }
  function selectInstall(id: string) {
    setSelectedInstallId(id);
    setSelectedId(null);
    setSelectedShellId(null);
  }
  function installClosed(id: string) {
    setInstalls((prev) => prev.filter((i) => i.id !== id));
    if (selectedInstallId === id) setSelectedInstallId(null);
  }

  /**
   * Ouvre (ou crée si pas existante) une session install pour ce VPS.
   * Sert à 3 cas :
   *   1. Bouton "install agent" dans la Sidebar (VPS sans agent)
   *   2. Erreur "import claude_agent_sdk" en pleine session (re-déclenche
   *      l'install automatiquement)
   *   3. Update agent out-of-date — déjà géré par `runUpdateAgent`, pas via
   *      session install (cf. choix design : update reste un appel direct).
   */
  async function openInstallSession(vps: Vps) {
    try {
      const info = await api.startInstall(vps.id);
      // Mise à jour optimiste — l'event install_started arrivera aussi via SSE.
      setInstalls((prev) => {
        const others = prev.filter((i) => i.id !== info.id);
        return [...others, info];
      });
      selectInstall(info.id);
    } catch (e: any) {
      setError({ msg: 'start install: ' + (e?.message ?? e) });
    }
  }

  async function killInstallOne(id: string) {
    try {
      await api.closeInstall(id);
      installClosed(id);
    } catch (e: any) {
      setError({ msg: 'close install: ' + (e?.message ?? e) });
    }
  }
  const [newDialog, setNewDialog] = useState<null | { vpsId?: string; cwd?: string }>(null);
  const [resumeOpen, setResumeOpen] = useState<null | { vpsId?: string }>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  // Set des VPS dont l'agent est en cours d'update (UI loading)
  const [updatingAgentVpsIds, setUpdatingAgentVpsIds] = useState<Set<string>>(new Set());

  async function runUpdateAgent(vps: Vps) {
    if (updatingAgentVpsIds.has(vps.id)) return;
    setUpdatingAgentVpsIds((prev) => new Set(prev).add(vps.id));
    try {
      const r = await api.updateVpsAgent(vps.id);
      // Patch la row locale pour refléter la nouvelle version/sha — évite que
      // le badge "outdated" reste affiché en attendant le prochain hello.
      setVpsList((prev) => prev.map((v) =>
        v.id === vps.id
          ? ({
              ...v,
              agentVersion: r?.newVersion ?? v.agentVersion,
              agentPyzSha: r?.newPyzSha ?? v.agentPyzSha,
              agentStatus: 'ok',
            } as Vps)
          : v
      ));
    } catch (e: any) {
      setError({ msg: `update agent: ${e?.message ?? e}` });
    } finally {
      setUpdatingAgentVpsIds((prev) => {
        const n = new Set(prev);
        n.delete(vps.id);
        return n;
      });
    }
  }

  // Queues d'interactions cross-session : alimentées par
  // useCrossSessionInteractionFeed (UNE seule SSE agrégée vers
  // /api/claude/interactions/stream qui multiplexe les events de toutes les
  // sessions). Avant : N SSE (une par session), ce qui saturait la limite
  // HTTP/1.1 (6 connexions/origine) dès 6+ sessions et bloquait tous les POST.
  const { perms: permQueue, questions: questionQueue, exitPlans: exitPlanQueue } =
    useCrossSessionInteractionFeed();

  // [esRef, chatBodyRef, assistantBufRef, scroll mechanics (isAtBottomRef,
  //  newCount, lastMessageCountRef, handleChatScroll, onPillClick) — tout
  //  ça vit dans `<ClaudeSessionView>` après le refactor.]

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const selectedVps = useMemo<Vps | null>(
    () => (selected ? vpsList.find((v) => v.id === selected.vpsId) ?? null : null),
    [selected, vpsList],
  );

  // Indicateur "la session active a une interaction en attente" — utilisé
  // par le status pill dans le header. Vient du feed cross-session, pas du
  // state per-session (qui n'existe plus dans ClaudePanel après le refactor).
  const selectedHasPending = useMemo(() => {
    if (!selectedId) return false;
    return (
      permQueue.some((p) => p.sessionId === selectedId) ||
      questionQueue.some((q) => q.sessionId === selectedId) ||
      exitPlanQueue.some((e) => e.sessionId === selectedId)
    );
  }, [permQueue, questionQueue, exitPlanQueue, selectedId]);

  // ── Liste des sessions (poll 15s) ──
  // Avant : 4s. Mais chaque tick faisait `setSessions(...)` (même contenu)
  // qui re-render Sidebar + main panel → CPU + flicker. Les changements de
  // statut intra-session arrivent déjà via la SSE par-session ; le poll ne
  // sert qu'à rafraîchir les badges count + détecter les sessions créées
  // sur un autre client. 15s est largement suffisant.
  const refreshSessions = useCallback(async () => {
    try {
      const r = (await api.listClaudeSessions()) as { sessions: SessionListItem[] };
      setSessions(r.sessions);
    } catch {}
  }, []);
  useEffect(() => {
    refreshSessions();
    const t = setInterval(refreshSessions, 15_000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  // ── Notification quand une session prend du pending alors qu'on est ailleurs
  // (autre session, autre onglet, autre fenêtre). Détecte les transitions
  // 0 → N entre 2 polls et fire une Notification native + un petit son.
  const prevPendingRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const prev = prevPendingRef.current;
    const newAttentions: SessionListItem[] = [];
    for (const s of sessions) {
      const before = prev.get(s.id) ?? 0;
      const now = s.pendingPermissions ?? 0;
      if (now > before && s.id !== selectedId) {
        newAttentions.push(s);
      }
      prev.set(s.id, now);
    }
    if (newAttentions.length === 0) return;
    // Title flash + native Notification si tab masqué OU autre session
    for (const s of newAttentions) {
      const title = `❓ ${s.name ?? s.id.slice(0, 6)} attend une réponse`;
      const body = s.cwd ?? '';
      try {
        if (typeof window !== 'undefined' && 'Notification' in window
            && Notification.permission === 'granted') {
          const n = new Notification(title, { body, tag: 'claude-' + s.id });
          n.onclick = () => {
            window.focus();
            setSelectedId(s.id);
            n.close();
          };
        }
      } catch {}
    }
    if (notifSoundEnabled) playBeep();
  }, [sessions, selectedId]);

  // Demande de permission Notification au mount (silencieux si déjà accordé/refusé)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      // Demande non-bloquante au prochain clic user (sinon Chrome bloque)
      const ask = () => {
        Notification.requestPermission().catch(() => {});
        document.removeEventListener('click', ask);
      };
      document.addEventListener('click', ask, { once: true });
    }
  }, []);

  // Toggle son local (localStorage)
  const [notifSoundEnabled, setNotifSoundEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('hub.claude.notif.sound') !== '0';
  });
  function toggleNotifSound() {
    setNotifSoundEnabled((v) => {
      const next = !v;
      try { localStorage.setItem('hub.claude.notif.sound', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // Titre d'onglet : (N) hub claude quand N sessions attendent
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const total = sessions.reduce((acc, s) => acc + (s.pendingPermissions ?? 0), 0);
    document.title = total > 0 ? `(${total}) hub claude` : 'hub claude';
  }, [sessions]);

  // Détection initiale de l'état push
  useEffect(() => {
    (async () => {
      if (!(await pushSupported())) return;
      const ep = await pushCurrentEndpoint();
      setPushOn(!!ep);
    })();
  }, []);

  // Écoute les messages du service worker (clic sur notif)
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open-session' && e.data.sessionId) {
        setSelectedId(e.data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  async function togglePush() {
    setPushBusy(true);
    try {
      if (pushOn) {
        await pushUnsubscribe();
        setPushOn(false);
      } else {
        const r = await pushSubscribe();
        if (!r.ok) alert('Push non activé: ' + (r.reason ?? '?'));
        setPushOn(r.ok);
      }
    } finally { setPushBusy(false); }
  }

  // Note : avant le refactor, applyApiPendings synchronisait permQueue/
  // questionQueue/exitPlanQueue depuis l'API à chaque refetch. Aujourd'hui
  // c'est useCrossSessionInteractionFeed qui maintient ces queues à jour
  // via une SSE par session (les pendings sont replay-és au subscribe).
  // Plus rien à faire ici.

  // Prefetch toutes les sessions au mount (et quand la liste change) → le
  // cache module-level `sessionCache.ts` est rempli ; quand l'user clique
  // une session, `<ClaudeSessionView>` re-monte avec son hook qui lit le
  // cache d'abord (render instant) puis fetch fresh en arrière-plan.
  useEffect(() => {
    sessionCachePrefetchAll(sessions.map((s) => s.id));
  }, [sessions.length, sessions]);

  // [SSE + state per-session + refetch + scroll = délégué à
  //   `<ClaudeSessionView>` qui utilise `useClaudeSessionStream`.
  //   Avant le refactor, ClaudePanel contenait ~250 lignes de SSE handler,
  //   `applyApiPendings`, `refetchHistory`, `prefetchSession`, visibilityChange,
  //   et le tracker de nouveau messages. Le tout vit maintenant dans le hook
  //   ou directement dans la vue.]

  // [send/interrupt/forceStop/setMode/doSleep/doResume/doKill/respondPermission
  //  pour la SESSION ACTIVE sont dans `<ClaudeSessionView>` via le hook
  //  `useClaudeSessionStream`. ClaudePanel garde uniquement les actions
  //  cross-session : kill d'une autre session via le menu (`killOne`), edit
  //  cwd (`editSessionCwd`), patch shell, etc.]

  async function renameSession(id: string, name: string) {
    setEditingId(null);
    try {
      await api.renameClaudeSession(id, name || null);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: 'rename: ' + (e?.message ?? e) });
    }
  }

  async function killOne(id: string) {
    try {
      await api.killClaudeSession(id);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: 'kill: ' + (e?.message ?? e) });
    }
  }

  async function hardDeleteOne(id: string) {
    if (!confirm('Supprimer définitivement cette session et tout son historique ?')) return;
    try {
      await api.hardDeleteClaudeSession(id);
      if (id === selectedId) setSelectedId(null);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: 'supprimer: ' + (e?.message ?? e) });
    }
  }

  async function patchSession(id: string, body: { name?: string | null; color?: string | null; cwd?: string }) {
    try {
      const res = await fetch(`/api/claude/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH session: HTTP ${res.status}`);
      const updated = await res.json();
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) {
      setError({ msg: 'patch session: ' + (e?.message ?? e) });
    }
  }

  /** Édite le cwd d'une session via prompt(). Le PATCH côté serveur kill
   *  automatiquement l'instance agent si elle existe, et reset le statut DB
   *  à 'sleeping' pour que l'utilisateur puisse cliquer resume avec le
   *  nouveau cwd. */
  async function editSessionCwd(sess: SessionListItem) {
    const newCwd = prompt('Nouveau dossier (cwd) pour cette session ?\n(la session sera recréée au prochain resume)', sess.cwd);
    if (newCwd == null || newCwd.trim() === '' || newCwd.trim() === sess.cwd) return;
    await patchSession(sess.id, { cwd: newCwd.trim() });
    refreshSessions();
  }

  async function patchShell(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const updated = await api.updateShell(id, body);
      setShells((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) {
      setError({ msg: 'patch shell: ' + (e?.message ?? e) });
    }
  }

  async function killShellOne(id: string) {
    try {
      await api.killShell(id);
      shellKilled(id);
    } catch (e: any) {
      setError({ msg: 'kill shell: ' + (e?.message ?? e) });
    }
  }

  // Cross-session permission popup → quand l'user clique allow/deny sur
  // une perm d'une AUTRE session que la sélectionnée. La session active a
  // sa propre popup gérée par le hook.
  async function respondPermissionCrossSession(sessionId: string, permId: string, allow: boolean, always: boolean) {
    try {
      await api.respondClaudePermission(sessionId, permId, allow, always);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: String(e?.message ?? e) });
    }
  }

  return (
    <div className={`claude-root${selectedShellId ? '' : ' has-tools'}`}>
      <header className="claude-head">
        <svg className="brand-logo" viewBox="12 32 236 196" aria-hidden>
          <path d="M 18 120 Q 32 114 46 120 T 74 120 T 100 120" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 22 140 Q 36 134 50 140 T 78 140 T 100 140" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 26 160 Q 40 154 54 160 T 82 160 T 100 160" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 120 Q 174 114 188 120 T 216 120 T 242 120" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 140 Q 174 134 188 140 T 216 140 T 238 140" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 160 Q 174 154 188 160 T 216 160 T 234 160" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 130 40 Q 100 75 96 140 Q 94 188 130 220 Q 166 188 164 140 Q 160 75 130 40 Z" fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round"/>
          <circle cx="130" cy="145" r="17" fill="none" stroke="currentColor" strokeWidth="7"/>
          <circle cx="130" cy="145" r="11" fill="currentColor"/>
          <line x1="108" y1="103" x2="152" y2="103" stroke="currentColor" strokeWidth="4.5" opacity="0.7"/>
          <line x1="106" y1="187" x2="154" y2="187" stroke="currentColor" strokeWidth="4.5" opacity="0.7"/>
        </svg>
        <h1>CHARON</h1>
        <div className="head-right">
          {selected && selectedVps && (
            <span className="ctx">{selectedVps.name}:{selected.cwd}</span>
          )}
          {!!selected?.subscribers && selected.subscribers > 1 && (
            <span className="multi-pill" title={`${selected.subscribers} clients connectés à cette session`}>
              ×{selected.subscribers}
            </span>
          )}
          {/* 3 états visuels :
              1) Claude travaille  → "réfléchit" amber-pulse
              2) Attend une réponse de toi → "attend votre réponse" orange-pulse
              3) Idle/done → "actif" green
              Source : `selected.liveStatus` (refresh poll 4s) + le feed
              cross-session pour le "pending". Lag max 4s vs SSE temps réel
              de la vue active, acceptable pour un indicateur de header. */}
          {selected?.liveStatus === 'thinking' ? (
            <span className="status-pill status-amber-pulse">
              <span className="dot" /> claude réfléchit
            </span>
          ) : selectedHasPending ? (
            <span className="status-pill status-orange-pulse">
              <span className="dot" /> attend votre réponse
            </span>
          ) : selected?.liveStatus ? (
            <span className={`status-pill status-${STATUS_DOT[selected.liveStatus as WorkerStatus]}`}>
              <span className="dot" /> {STATUS_LABEL[selected.liveStatus as WorkerStatus]}
            </span>
          ) : null}
          <button className="head-btn" onClick={() => setSearchOpen(true)} title="recherche dans tous les messages" aria-label="recherche">
            <IconSearch />
          </button>
          <button className="head-btn" onClick={togglePush} disabled={pushBusy} title={pushOn ? 'notifications activées' : 'activer notifications'} aria-label="notifications">
            {pushOn ? <IconBellFill /> : <IconBellSlash />}
          </button>
          <button className="head-btn" onClick={toggleNotifSound} title={notifSoundEnabled ? 'son activé' : 'son coupé'} aria-label="son">
            {notifSoundEnabled ? <IconVolumeUp /> : <IconVolumeMute />}
          </button>
          <button className="head-btn" onClick={() => setDataOpen(true)} title="VPS, projets, paths" aria-label="données VPS">
            <IconServers />
          </button>
          <LocalAgentButton />
          <button className="head-btn" onClick={() => setSettingsOpen(true)} title="settings" aria-label="settings">
            <IconGear />
          </button>
        </div>
      </header>

      <Sidebar
        vpsList={vpsList}
        vpsFolders={vpsFolders}
        vpsPaths={vpsPaths}
        sessions={sessions}
        shells={shells}
        installs={installs}
        selectedId={selectedId}
        selectedShellId={selectedShellId}
        selectedInstallId={selectedInstallId}
        onSelect={selectClaude}
        onSelectShell={selectShell}
        onSelectInstall={selectInstall}
        onNew={(opts) => setNewDialog(opts)}
        onNewShell={startShell}
        onScan={(vpsId) => setResumeOpen({ vpsId })}
        onOpenData={() => setDataOpen(true)}
        onContext={(s, x, y) => setCtxMenu({ kind: 'session', session: s, x, y })}
        onContextShell={(sh, x, y) => setCtxMenu({ kind: 'shell', shell: sh, x, y })}
        onContextInstall={(inst, x, y) => setCtxMenu({ kind: 'install', install: inst, x, y })}
        editingId={editingId}
        onRenameSubmit={renameSession}
        onRenameCancel={() => setEditingId(null)}
        onInstallAgent={openInstallSession}
        onLoginAgent={(v) => setLoginVps(v)}
        onUpdateAgent={(v) => { runUpdateAgent(v); }}
        onToggleFolderCollapsed={async (folderId, collapsed) => {
          // Optimiste : on update tout de suite, puis on POST. Rollback si échec.
          setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsed ? 1 : 0 } : f));
          try {
            await api.updateVpsFolder(folderId, { collapsed });
          } catch (e: any) {
            setError({ msg: String(e?.message ?? e) });
            setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsed ? 0 : 1 } : f));
          }
        }}
        builtPyzSha={builtPyzSha}
        updatingAgentVpsIds={updatingAgentVpsIds}
      />

      {/* Routing main panel : 3 vues mutuellement exclusives.
          - selectedInstallId → <InstallSessionView> (full-screen log d'install)
          - selectedShellId   → <ShellTerminal> (xterm SSH éphémère)
          - selectedId        → <ClaudeSessionView> (chat + tool panel)
          - sinon : placeholder. */}
      {selectedInstallId ? (() => {
        const inst = installs.find((i) => i.id === selectedInstallId);
        if (!inst) return <main className="claude-main"><div className="bar-empty">install introuvable</div></main>;
        const vps = vpsList.find((v) => v.id === inst.vpsId);
        return (
          <InstallSessionView
            key={inst.id}
            installId={inst.id}
            vpsId={inst.vpsId}
            vpsName={inst.vpsName}
            onClosed={() => installClosed(inst.id)}
            onSetupLogin={vps ? () => setLoginVps(vps) : undefined}
            onInstallSuccess={() => {
              // Patch local : l'agent est désormais OK ET à la version embarquée.
              // Sans le agentPyzSha, le badge "outdated" resterait affiché.
              // Le handler subscribeAll au-dessus fait la même chose en cas
              // de finished cross-session — c'est idempotent.
              setVpsList((prev) => prev.map((v) =>
                v.id === inst.vpsId
                  ? ({
                      ...v,
                      agentStatus: 'ok',
                      agentPyzSha: builtPyzSha ?? v.agentPyzSha,
                    } as Vps)
                  : v,
              ));
            }}
          />
        );
      })() : selectedShellId ? (() => {
        const sh = shells.find((s) => s.id === selectedShellId);
        if (!sh) return <main className="claude-main"><div className="bar-empty">shell introuvable</div></main>;
        return (
          <main className="claude-main shell-main">
            <ShellTerminal
              shellId={sh.id}
              vpsName={sh.vpsName}
              cwd={sh.cwd}
              onKilled={() => shellKilled(sh.id)}
            />
          </main>
        );
      })() : selected ? (
        <ClaudeSessionView
          key={selectedId}
          sessionId={selected.id}
          selected={selected}
          selectedVps={selectedVps}
          overlay={
            <>
              {loginVps && <LoginConsole vps={loginVps} onClose={closeLoginConsole} />}
            </>
          }
          onImportError={(vps) => {
            // L'agent VPS a planté un import claude_agent_sdk → on déclenche
            // l'install dans une nouvelle session install (au lieu de
            // l'overlay BootstrapBanner qui existait avant). L'user revient à
            // sa session Claude une fois l'install OK (via notif + clic).
            const existing = installs.find((i) => i.vpsId === vps.id && i.status === 'running');
            if (existing) {
              selectInstall(existing.id);
            } else {
              openInstallSession(vps);
            }
          }}
          onKilled={() => {
            setSelectedId(null);
            refreshSessions();
          }}
          onAfterRevert={() => refreshSessions()}
        />
      ) : (
      // Pas de session sélectionnée : placeholder. ToolPanel n'est pas rendu
      // dans ce cas (avant le refactor il l'était avec sessionId=null mais
      // affichait rien d'utile).
      <main className="claude-main">
        <div className="claude-bar">
          <span className="bar-empty">— choisis ou crée une session dans la sidebar —</span>
        </div>
      </main>
      )}

      {/* Aussi rendre la LoginConsole quand sélectionné AVEC un install/shell —
          loginVps est cross-panneau (déclenché depuis Sidebar ou
          InstallSessionView). On garde un montage global. */}
      {loginVps && (selectedShellId || selectedInstallId) && (
        <LoginConsole vps={loginVps} onClose={closeLoginConsole} />
      )}

      <PermissionPopup
        queue={permQueue}
        currentSessionId={selectedId}
        onRespond={respondPermissionCrossSession}
        onSwitchSession={(id) => setSelectedId(id)}
      />

      <InstallNotificationPopup
        notifications={installNotifications}
        onOpen={(installId) => selectInstall(installId)}
        onDismiss={dismissInstallNotif}
      />

      {newDialog && (
        <NewSessionDialog
          vpsList={vpsList}
          vpsPaths={vpsPaths}
          initial={newDialog}
          onClose={() => setNewDialog(null)}
          onCreated={(id) => { setNewDialog(null); setSelectedId(id); refreshSessions(); }}
        />
      )}

      {resumeOpen && (
        <ResumeModal
          vpsList={vpsList}
          dbSessions={sessions}
          initialVpsId={resumeOpen.vpsId}
          onClose={() => setResumeOpen(null)}
          onImported={(id) => { setResumeOpen(null); setSelectedId(id); refreshSessions(); }}
          onResumed={async (id) => {
            setResumeOpen(null);
            try { await api.resumeClaudeSession(id); }
            catch (e: any) { setError({ msg: String(e?.message ?? e) }); return; }
            setSelectedId(id);
            refreshSessions();
          }}
        />
      )}

      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onPick={(id) => { setSearchOpen(false); setSelectedId(id); }}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {dataOpen && (
        <DataModal
          onClose={() => setDataOpen(false)}
          initialVps={vpsList}
          initialFolders={vpsFolders}
          initialPaths={vpsPaths}
          onChange={({ vps, folders, paths }) => {
            setVpsList(vps);
            setVpsFolders(folders);
            setVpsPaths(paths);
          }}
          onInstallAgent={openInstallSession}
        />
      )}

      {ctxMenu && ctxMenu.kind === 'session' && (
        <SessionContextMenu
          title={ctxMenu.session.name || ctxMenu.session.cwd.split('/').slice(-2).join('/')}
          subtitle={ctxMenu.session.cwd}
          x={ctxMenu.x}
          y={ctxMenu.y}
          currentColor={(ctxMenu.session as any).color}
          canKill={ctxMenu.session.status !== 'killed'}
          killDisabledReason={ctxMenu.session.status === 'killed' ? 'déjà en pause' : undefined}
          onRename={() => setEditingId(ctxMenu.session.id)}
          onEditCwd={() => editSessionCwd(ctxMenu.session)}
          onColor={(color) => patchSession(ctxMenu.session.id, { color })}
          onKill={() => killOne(ctxMenu.session.id)}
          onDelete={() => hardDeleteOne(ctxMenu.session.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {ctxMenu && ctxMenu.kind === 'shell' && (
        <SessionContextMenu
          title={ctxMenu.shell.name || `⌨ ${ctxMenu.shell.cwd ?? '~'}`}
          x={ctxMenu.x}
          y={ctxMenu.y}
          currentColor={ctxMenu.shell.color}
          canKill={!ctxMenu.shell.exited}
          killLabel="Fermer"
          killDisabledReason={ctxMenu.shell.exited ? 'déjà terminé' : undefined}
          showDelete={false}
          onRename={() => {
            const name = prompt('Nom du shell ?', ctxMenu.shell.name ?? '');
            if (name != null) patchShell(ctxMenu.shell.id, { name: name.trim() || null });
          }}
          onColor={(color) => patchShell(ctxMenu.shell.id, { color })}
          onKill={() => killShellOne(ctxMenu.shell.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {ctxMenu && ctxMenu.kind === 'install' && (
        <SessionContextMenu
          title={`⚙ installation · ${ctxMenu.install.vpsName}`}
          subtitle={
            ctxMenu.install.status === 'running'
              ? `en cours — phase: ${ctxMenu.install.currentPhase ?? 'init'}`
              : ctxMenu.install.status === 'success'
                ? 'terminée avec succès'
                : 'échec'
          }
          x={ctxMenu.x}
          y={ctxMenu.y}
          showRename={false}
          showColor={false}
          showDelete={false}
          killLabel="Fermer"
          killDisabledReason={
            ctxMenu.install.status === 'running'
              ? "l'install est encore en cours — elle continue côté serveur"
              : undefined
          }
          onKill={() => killInstallOne(ctxMenu.install.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// Carte permission affichée dans la zone d'input (remplace l'écriture
// InlinePermissionCard, ThinkingBar, fmtElapsed : déplacés dans
// `./ClaudeSessionView.tsx` (utilisés uniquement par la vue session).
// rebuildStateFromMessages : dans `./sessionRebuild.ts`.

// Petit bip de notification — Web Audio (pas de fichier à charger).
// Singleton AudioContext pour éviter le warning Chrome (max 6 contextes).
// Reste ici parce que joué par ClaudePanel quand une autre session passe
// en pending (notification cross-session, pas dans la vue active).
let _audioCtx: AudioContext | null = null;
function playBeep() {
  if (typeof window === 'undefined') return;
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);
    osc.start();
    osc.stop(ctx.currentTime + 0.20);
  } catch {}
}
