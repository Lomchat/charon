'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Vps, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerEvent, WorkerStatus } from '@/lib/server/claude/types';
import Sidebar, { type SessionListItem, type ShellListItem } from './Sidebar';
import ShellTerminal from './ShellTerminal';
import NewSessionDialog from './NewSessionDialog';
import DataModal from './DataModal';
import ResumeModal from './ResumeModal';
import Message, { type Msg, summarizeToolInput } from './Message';
import ToolPanel, { type ToolCallEntry, type Todo, type EditSnapshot } from './ToolPanel';
import PermissionPopup, { type PermissionRequest } from './PermissionPopup';
import QuestionCard from './QuestionCard';
import ExitPlanCard from './ExitPlanCard';
import SearchModal from './SearchModal';
import SettingsModal from './SettingsModal';
import SessionContextMenu from './SessionContextMenu';
import BootstrapBanner from './BootstrapBanner';
import LoginConsole from './LoginConsole';
import { pushCurrentEndpoint, pushSubscribe, pushUnsubscribe, pushSupported } from './pushClient';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  initialSessions: ClaudeSession[];
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

type SessionState = {
  messages: Msg[];
  currentAssistant: string;
  status: WorkerStatus | null;
  permissionMode: 'normal' | 'acceptEdits' | 'bypass' | 'plan' | null;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
};

function emptyState(): SessionState {
  return {
    messages: [], currentAssistant: '', status: null, permissionMode: null,
    toolCalls: [], todos: [], edits: new Map(), files: new Set(),
  };
}

export default function ClaudePanel({ vpsList: initialVpsList, vpsPaths: initialPaths, initialSessions }: Props) {
  // Copies mutables — DataModal peut add/delete VPS et paths sans reload.
  const [vpsList, setVpsList] = useState<Vps[]>(initialVpsList);
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
  const [error, setError] = useState<{ msg: string; canResume?: boolean } | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);
  async function copyError() {
    if (!error?.msg) return;
    try {
      await navigator.clipboard.writeText(error.msg);
      setErrorCopied(true);
      setTimeout(() => setErrorCopied(false), 1500);
    } catch {}
  }
  const [input, setInput] = useState('');
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; session: SessionListItem; x: number; y: number }
    | { kind: 'shell'; shell: ShellListItem; x: number; y: number }
    | null
  >(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Bootstrap auto en cours pour un VPS donné (déclenché par un import error)
  const [bootstrapping, setBootstrapping] = useState<{ vps: Vps; resumeSessionId: string | null } | null>(null);
  // Console claude login interactive
  const [loginVps, setLoginVps] = useState<Vps | null>(null);
  // Shells SSH ephémères. Liste live (pollée au mount, mise à jour locale).
  const [shells, setShells] = useState<ShellListItem[]>([]);
  // Si non-null, c'est un shell qui est affiché dans le main panel (au lieu du chat)
  const [selectedShellId, setSelectedShellId] = useState<string | null>(null);

  // Charge la liste des shells au mount + refresh quand un sélecteur change
  useEffect(() => {
    let cancelled = false;
    api.listShells().then((r: any) => {
      if (!cancelled) setShells(r?.shells ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function startShell(opts: { vpsId: string; cwd?: string | null }) {
    try {
      const sh: any = await api.startShell(opts.vpsId, opts.cwd ?? null);
      setShells((prev) => [...prev.filter((s) => s.id !== sh.id), sh]);
      setSelectedShellId(sh.id);
      setSelectedId(null);  // mutuellement exclusif avec une session claude
    } catch (e: any) {
      setError({ msg: 'shell: ' + (e?.message ?? e) });
    }
  }
  function selectShell(id: string) {
    setSelectedShellId(id);
    setSelectedId(null);
  }
  function shellKilled(id: string) {
    setShells((prev) => prev.filter((s) => s.id !== id));
    if (selectedShellId === id) setSelectedShellId(null);
  }
  // Quand on sélectionne une session Claude, on désélectionne le shell
  function selectClaude(id: string) {
    setSelectedId(id);
    setSelectedShellId(null);
  }
  const [newDialog, setNewDialog] = useState<null | { vpsId?: string; cwd?: string }>(null);
  const [resumeOpen, setResumeOpen] = useState<null | { vpsId?: string }>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  // Etat par session (preserve quand on switch)
  const [stateById, setStateById] = useState<Map<string, SessionState>>(new Map());
  // File d'attente permissions (cross-session)
  const [permQueue, setPermQueue] = useState<PermissionRequest[]>([]);
  // Questions AskUserQuestion en attente (par session)
  type PendingQuestion = {
    sessionId: string;
    id: string;
    createdAt: number;
    questions: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
  };
  const [questionQueue, setQuestionQueue] = useState<PendingQuestion[]>([]);
  // ExitPlanMode en attente
  type PendingExitPlan = {
    sessionId: string;
    id: string;
    createdAt: number;
    plan: string;
  };
  const [exitPlanQueue, setExitPlanQueue] = useState<PendingExitPlan[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const cur = selectedId ? (stateById.get(selectedId) ?? emptyState()) : emptyState();
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const selectedVps = useMemo(() => selected ? vpsList.find((v) => v.id === selected.vpsId) : null, [selected, vpsList]);

  // Pair tool_use ↔ tool_result for inline rendering (terminal-style ⎿)
  const renderable = useMemo(() => {
    const resultByToolUseId = new Map<string, Msg>();
    for (const m of cur.messages) {
      if (m.role !== 'tool_result') continue;
      try {
        const parsed = JSON.parse(m.content);
        if (parsed?.tool_use_id) resultByToolUseId.set(String(parsed.tool_use_id), m);
      } catch {}
    }
    const out: { msg: Msg; attached?: Msg }[] = [];
    const consumedResults = new Set<string>();
    for (const m of cur.messages) {
      if (m.role === 'tool_result') {
        // Skip si déjà rattaché à un tool_use
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.tool_use_id && resultByToolUseId.has(String(parsed.tool_use_id))) {
            if (consumedResults.has(m.id)) continue;
            // Le tool_use a-t-il été rendu ? Si oui, skip ; sinon (orphelin), render
            continue;
          }
        } catch {}
        out.push({ msg: m });
        continue;
      }
      if (m.role === 'tool_use') {
        let attached: Msg | undefined;
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.id) {
            attached = resultByToolUseId.get(String(parsed.id));
            if (attached) consumedResults.add(attached.id);
          }
        } catch {}
        out.push({ msg: m, attached });
        continue;
      }
      out.push({ msg: m });
    }
    return out;
  }, [cur.messages]);

  // Étape courante : nb de tool_use depuis le dernier message user
  const stepCount = useMemo(() => {
    let count = 0;
    for (let i = cur.messages.length - 1; i >= 0; i--) {
      const m = cur.messages[i];
      if (m.role === 'user') break;
      if (m.role === 'tool_use') count++;
    }
    return count;
  }, [cur.messages]);

  // Interaction la plus ancienne en attente pour la session active (FIFO).
  // Tant qu'une interaction est pending, la zone d'input est remplacée.
  type PendingInteraction =
    | { kind: 'permission'; createdAt: number; perm: PermissionRequest }
    | { kind: 'question'; createdAt: number; q: PendingQuestion }
    | { kind: 'exit_plan'; createdAt: number; ep: PendingExitPlan };
  const oldestPending = useMemo<PendingInteraction | null>(() => {
    if (!selectedId) return null;
    const items: PendingInteraction[] = [];
    for (const p of permQueue) if (p.sessionId === selectedId) {
      items.push({ kind: 'permission', createdAt: p.createdAt, perm: p });
    }
    for (const q of questionQueue) if (q.sessionId === selectedId) {
      items.push({ kind: 'question', createdAt: q.createdAt, q });
    }
    for (const ep of exitPlanQueue) if (ep.sessionId === selectedId) {
      items.push({ kind: 'exit_plan', createdAt: ep.createdAt, ep });
    }
    if (!items.length) return null;
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items[0];
  }, [permQueue, questionQueue, exitPlanQueue, selectedId]);

  // Fallback du plan : si ExitPlanMode a un plan vide, on cherche le dernier
  // Write/Edit sous /root/.claude/plans/ dans les messages.
  const fallbackPlanFromMessages = useMemo(() => {
    if (!oldestPending || oldestPending.kind !== 'exit_plan' || oldestPending.ep.plan) return '';
    for (let i = cur.messages.length - 1; i >= 0; i--) {
      const m = cur.messages[i];
      if (m.role !== 'tool_use') continue;
      try {
        const parsed = JSON.parse(m.content);
        if ((parsed.name === 'Write' || parsed.name === 'Edit') &&
            typeof parsed.input?.file_path === 'string' &&
            parsed.input.file_path.startsWith('/root/.claude/plans/')) {
          if (parsed.name === 'Write' && typeof parsed.input.content === 'string') {
            return String(parsed.input.content);
          }
          // Edit : on n'a que le diff — chercher dans les edits snapshots
          const snap = cur.edits.get(parsed.input.file_path);
          if (snap?.after) return snap.after;
        }
      } catch {}
    }
    return '';
  }, [oldestPending, cur.messages, cur.edits]);

  // Outil en cours d'exécution (dernier tool_use sans result)
  const currentTool = useMemo(() => {
    for (let i = cur.toolCalls.length - 1; i >= 0; i--) {
      if (!cur.toolCalls[i].result) return cur.toolCalls[i];
    }
    return null;
  }, [cur.toolCalls]);

  // Timestamp de démarrage du "tour" en cours (dernier user message)
  const turnStartedAt = useMemo(() => {
    for (let i = cur.messages.length - 1; i >= 0; i--) {
      const m = cur.messages[i];
      if (m.role === 'user') return m.createdAt;
    }
    return null;
  }, [cur.messages]);

  // ── helpers d'etat ────────────────────────────────────────────────────────
  function updateSession(sid: string, updater: (s: SessionState) => SessionState) {
    setStateById((prev) => {
      const next = new Map(prev);
      next.set(sid, updater(prev.get(sid) ?? emptyState()));
      return next;
    });
  }

  // ── Liste des sessions (poll 4s) ──
  const refreshSessions = useCallback(async () => {
    try {
      const r = (await api.listClaudeSessions()) as { sessions: SessionListItem[] };
      setSessions(r.sessions);
    } catch {}
  }, []);
  useEffect(() => {
    refreshSessions();
    const t = setInterval(refreshSessions, 4000);
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

  // ── Charger historique persiste + ouvrir SSE pour la session selectionnee ──
  useEffect(() => {
    if (!selectedId) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r: any = await api.getClaudeSession(selectedId);
        if (cancelled) return;
        const rebuilt = rebuildStateFromMessages(r.messages, r.liveStatus ?? r.session.status);
        rebuilt.permissionMode = (['normal', 'acceptEdits', 'bypass', 'plan'] as const).includes(
          r.session?.permissionMode,
        )
          ? r.session.permissionMode
          : 'normal';
        setStateById((prev) => {
          const next = new Map(prev);
          next.set(selectedId, rebuilt);
          return next;
        });
      } catch (e: any) {
        setError({ msg: String(e?.message ?? e) });
      }
    })();

    esRef.current?.close();
    const es = new EventSource(`/api/claude/sessions/${selectedId}/stream`);
    esRef.current = es;
    let assistantBuf = '';

    es.onmessage = (e) => {
      let ev: WorkerEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.type) {
        case 'status':
          updateSession(selectedId, (s) => ({ ...s, status: ev.status }));
          break;
        case 'user_echo':
          updateSession(selectedId, (s) => ({
            ...s,
            messages: [...s.messages, {
              id: 'u' + Date.now() + Math.random(), role: 'user',
              content: ev.content, createdAt: ev.createdAt,
            }],
          }));
          break;
        case 'assistant_text':
          assistantBuf += ev.delta;
          updateSession(selectedId, (s) => ({ ...s, currentAssistant: assistantBuf }));
          break;
        case 'tool_use':
          updateSession(selectedId, (s) => {
            const filePath = (ev.input && ev.input.file_path) ? String(ev.input.file_path) : null;
            const nextFiles = new Set(s.files);
            if (filePath) nextFiles.add(filePath);
            return {
              ...s,
              messages: [...s.messages, {
                id: 'tu' + ev.id + Math.random(), role: 'tool_use',
                // On stocke le wrapper complet (type/id/name/input) pour que le
                // pairing tool_use ↔ tool_result (qui matche parsed.id avec
                // parsed.tool_use_id) fonctionne sur les messages live aussi.
                content: JSON.stringify({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input }),
                createdAt: Math.floor(Date.now() / 1000),
              }],
              toolCalls: [...s.toolCalls, {
                id: ev.id, name: ev.name, input: ev.input,
                startedAt: Math.floor(Date.now() / 1000),
              }],
              files: nextFiles,
            };
          });
          break;
        case 'tool_result':
          updateSession(selectedId, (s) => ({
            ...s,
            messages: [...s.messages, {
              id: 'tr' + ev.tool_use_id + Math.random(), role: 'tool_result',
              // Idem : on garde tool_use_id dans le JSON pour le pairing.
              content: JSON.stringify({
                type: 'tool_result',
                tool_use_id: ev.tool_use_id,
                content: ev.content,
                is_error: !!ev.is_error,
              }),
              createdAt: Math.floor(Date.now() / 1000),
            }],
            toolCalls: s.toolCalls.map((c) => c.id === ev.tool_use_id
              ? { ...c, result: { content: ev.content, isError: !!ev.is_error } } : c),
          }));
          break;
        case 'stop':
          if (assistantBuf) {
            const finalContent = assistantBuf;
            updateSession(selectedId, (s) => ({
              ...s,
              messages: [...s.messages, {
                id: 'a' + Date.now() + Math.random(), role: 'assistant',
                content: finalContent, createdAt: Math.floor(Date.now() / 1000),
              }],
              currentAssistant: '',
            }));
            assistantBuf = '';
          }
          break;
        case 'error': {
          setError({ msg: ev.msg, canResume: !!ev.fatal });
          // Détection import error → déclenche bootstrap auto
          const needsBootstrap =
            /No module named ['"]?claude_agent_sdk['"]?/i.test(ev.msg) ||
            /claude-agent-sdk indisponible/i.test(ev.msg) ||
            /ModuleNotFoundError/i.test(ev.msg);
          if (needsBootstrap && selected && !bootstrapping) {
            const vpsRow = vpsList.find((v) => v.id === selected.vpsId);
            if (vpsRow) {
              setError(null); // remplacé par le banner
              setBootstrapping({ vps: vpsRow, resumeSessionId: selected.id });
            }
          }
          break;
        }
        case 'permission_request':
          setPermQueue((q) => {
            if (q.some((p) => p.id === ev.id)) return q;
            return [...q, {
              id: ev.id, sessionId: selectedId, tool: ev.tool, input: ev.input,
              createdAt: Math.floor(Date.now() / 1000),
            }];
          });
          break;
        case 'user_question':
          setQuestionQueue((q) => {
            if (q.some((p) => p.id === ev.id)) return q;
            return [...q, { sessionId: selectedId, id: ev.id, questions: ev.questions, createdAt: Math.floor(Date.now() / 1000) }];
          });
          break;
        case 'exit_plan_request':
          setExitPlanQueue((q) => {
            if (q.some((p) => p.id === ev.id)) return q;
            return [...q, { sessionId: selectedId, id: ev.id, plan: ev.plan ?? '', createdAt: Math.floor(Date.now() / 1000) }];
          });
          break;
        case 'interaction_resolved':
          if (ev.kind === 'permission') setPermQueue((q) => q.filter((p) => p.id !== ev.id));
          else if (ev.kind === 'question') setQuestionQueue((q) => q.filter((p) => p.id !== ev.id));
          else if (ev.kind === 'exit_plan') setExitPlanQueue((q) => q.filter((p) => p.id !== ev.id));
          break;
        case 'prefill_input':
          // Une interaction a été annulée pendant que la session dormait :
          // on pré-remplit "continue" (ou autre) pour aider l'utilisateur à relancer Claude.
          setInput(ev.content || 'continue');
          break;
        case 'reconnecting':
          // Le worker retry tout seul — on affiche juste un message d'info,
          // pas une erreur dismissable. La bannière "reconnexion" est pilotée
          // par cur.status === 'reconnecting'.
          setError(null);
          break;
        case 'todo_update':
          updateSession(selectedId, (s) => ({ ...s, todos: (ev.todos ?? []) as Todo[] }));
          break;
        case 'edit_snapshot': {
          const key = ev.file_path;
          updateSession(selectedId, (s) => {
            const cur = s.edits.get(key) ?? { toolUseId: ev.tool_use_id, filePath: key, before: null, after: null, truncated: false };
            const next = new Map(s.edits);
            if (ev.phase === 'before') {
              next.set(key, { ...cur, before: ev.content, truncated: cur.truncated || ev.truncated });
            } else {
              next.set(key, { ...cur, after: ev.content, truncated: cur.truncated || ev.truncated });
            }
            const nextFiles = new Set(s.files);
            nextFiles.add(key);
            return { ...s, edits: next, files: nextFiles };
          });
          break;
        }
        case 'thinking':
          updateSession(selectedId, (s) => ({
            ...s,
            messages: [...s.messages, {
              id: 'th' + Date.now() + Math.random(), role: 'thinking',
              content: ev.text, createdAt: Math.floor(Date.now() / 1000),
            }],
          }));
          break;
        case 'mode_changed':
          updateSession(selectedId, (s) => ({ ...s, permissionMode: ev.mode }));
          break;
        case 'history_begin':
          assistantBuf = '';
          break;
        case 'history_end':
        case 'ready':
        case 'session_id':
          break;
      }
    };
    es.onerror = () => {
      // Pas besoin de set un error explicite — la bannière "session inactive"
      // s'affiche déjà via cur.status === 'sleeping' | 'error' (polling 4s + SSE status events).
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [selectedId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [cur.messages.length, cur.currentAssistant]);

  async function send() {
    const content = input.trim();
    if (!content || !selectedId) return;
    setInput('');
    try { await api.sendClaudeInput(selectedId, content); }
    catch (e: any) { setError({ msg: String(e?.message ?? e) }); }
  }

  async function interrupt() {
    if (!selectedId) return;
    try { await api.interruptClaude(selectedId); } catch {}
  }

  async function setMode(mode: 'normal' | 'acceptEdits' | 'bypass' | 'plan') {
    if (!selectedId || cur.permissionMode === mode) return;
    try {
      await api.setClaudeMode(selectedId, mode);
      // L'echo mode_changed du bridge mettra a jour le state.
    } catch (e: any) {
      setError({ msg: String(e?.message ?? e) });
    }
  }

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
      if (id === selectedId && cur.status !== 'killed') {
        // L'utilisateur peut toujours regarder l'historique
      }
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

  async function patchSession(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const res = await fetch(`/api/claude/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH session: HTTP ${res.status}`);
      // Update locale dans la liste sessions
      const updated = await res.json();
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) {
      setError({ msg: 'patch session: ' + (e?.message ?? e) });
    }
  }

  async function patchShell(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const updated: any = await api.updateShell(id, body);
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

  async function doSleep() {
    if (!selectedId) return;
    await api.sleepClaudeSession(selectedId);
    updateSession(selectedId, (s) => ({ ...s, status: 'sleeping' }));
    refreshSessions();
  }

  async function doResume(id?: string) {
    const target = id ?? selectedId;
    if (!target) return;
    setError(null);
    try {
      await api.resumeClaudeSession(target);
      setSelectedId(null);
      setTimeout(() => setSelectedId(target), 30);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: String(e?.message ?? e) });
    }
  }

  async function doKill() {
    if (!selectedId) return;
    if (!confirm('Tuer cette session ? Les messages restent en historique.')) return;
    await api.killClaudeSession(selectedId);
    setSelectedId(null);
    refreshSessions();
  }

  async function respondPermission(sessionId: string, permId: string, allow: boolean, always: boolean) {
    setPermQueue((q) => q.filter((p) => p.id !== permId));
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
              3) Idle/done → "actif" green */}
          {cur.status === 'thinking' ? (
            <span className="status-pill status-amber-pulse">
              <span className="dot" /> claude réfléchit
            </span>
          ) : oldestPending ? (
            <span className="status-pill status-orange-pulse">
              <span className="dot" /> attend votre réponse
            </span>
          ) : cur.status ? (
            <span className={`status-pill status-${STATUS_DOT[cur.status]}`}>
              <span className="dot" /> {STATUS_LABEL[cur.status]}
            </span>
          ) : null}
          <button className="head-btn" onClick={() => setSearchOpen(true)} title="recherche dans tous les messages">🔍</button>
          <button className="head-btn" onClick={togglePush} disabled={pushBusy} title={pushOn ? 'notifications activées' : 'activer notifications'}>
            {pushOn ? '🔔' : '🔕'}
          </button>
          <button className="head-btn" onClick={toggleNotifSound} title={notifSoundEnabled ? 'son activé' : 'son coupé'}>
            {notifSoundEnabled ? '🔊' : '🔇'}
          </button>
          <button className="head-btn" onClick={() => setDataOpen(true)} title="données (VPS, projets, paths)">🗂</button>
          <button className="head-btn" onClick={() => setSettingsOpen(true)} title="settings">⚙</button>
        </div>
      </header>

      <Sidebar
        vpsList={vpsList}
        vpsPaths={vpsPaths}
        sessions={sessions}
        shells={shells}
        selectedId={selectedId}
        selectedShellId={selectedShellId}
        onSelect={selectClaude}
        onSelectShell={selectShell}
        onNew={(opts) => setNewDialog(opts)}
        onNewShell={startShell}
        onScan={(vpsId) => setResumeOpen({ vpsId })}
        onOpenResumeModal={() => setResumeOpen({ vpsId: selected?.vpsId })}
        onContext={(s, x, y) => setCtxMenu({ kind: 'session', session: s, x, y })}
        onContextShell={(sh, x, y) => setCtxMenu({ kind: 'shell', shell: sh, x, y })}
        editingId={editingId}
        onRenameSubmit={renameSession}
        onRenameCancel={() => setEditingId(null)}
        onInstallAgent={(v) => setBootstrapping({ vps: v, resumeSessionId: null })}
        onLoginAgent={(v) => setLoginVps(v)}
      />

      {/* Si un shell est sélectionné : main panel = terminal plein écran.
          Sinon : le panneau Claude habituel (chat, tools, etc.). */}
      {selectedShellId ? (() => {
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
      })() : (
      <main className="claude-main">
        <div className="claude-bar">
          {selected ? (
            <>
              <span className="bar-name">{selected.name || '(sans nom)'}</span>
              {cur.status === 'sleeping' || cur.status === 'killed' || cur.status === 'error' ? (
                <button onClick={() => doResume()} disabled={selected.status === 'killed'}>resume</button>
              ) : (
                <button onClick={doSleep}>sleep</button>
              )}
              <button className="kill" onClick={doKill}>kill</button>
              <button onClick={interrupt} disabled={cur.status !== 'thinking'}>interrupt</button>
            </>
          ) : (
            <span className="bar-empty">— choisis ou crée une session dans la sidebar —</span>
          )}
        </div>

        {/* Bandeau "reconnexion auto en cours" — informatif, pas d'action user */}
        {!bootstrapping && cur.status === 'reconnecting' && selectedId && (
          <div className="claude-reconnect-banner">
            <span className="msg">
              <span className="spin">↻</span> reconnexion auto en cours…
            </span>
          </div>
        )}

        {/* Bandeau "session déconnectée" piloté par le statut (sleeping/error) */}
        {!bootstrapping && (cur.status === 'sleeping' || cur.status === 'error') && selectedId && (
          <div className="claude-disconnect-banner-wrap">
            <div
              className="claude-disconnect-banner"
              onClick={() => doResume()}
              role="button"
            >
              <span className="msg">
                session inactive — cliquez pour reconnecter
                {cur.status === 'error' && error?.msg ? (
                  <em className="why"> · {error.msg.split('\n')[0].slice(0, 160)}</em>
                ) : null}
              </span>
              <span className="resume-chip">↺ resume</span>
            </div>
            {cur.status === 'error' && error?.msg && (
              <div className="claude-error-details">
                <div className="err-tools">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setErrorOpen((v) => !v); }}>
                    {errorOpen ? '▾ masquer détails' : '▸ voir détails'}
                  </button>
                  <button type="button" className="copy-btn" onClick={(e) => { e.stopPropagation(); copyError(); }} title="copier l'erreur">
                    {errorCopied ? '✓ copié' : '📋 copier'}
                  </button>
                </div>
                {errorOpen && <pre className="err-pre">{error.msg}</pre>}
              </div>
            )}
          </div>
        )}

        {/* Erreur transitoire (rename failed, etc.) — dismissable */}
        {!bootstrapping && cur.status !== 'sleeping' && cur.status !== 'error' && error && (
          <div className="claude-error">
            <span className="msg">{error.msg.split('\n')[0].slice(0, 200)}</span>
            <button type="button" className="copy-btn" onClick={copyError} title="copier l'erreur">
              {errorCopied ? '✓' : '📋'}
            </button>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {bootstrapping && (
          <BootstrapBanner
            vps={bootstrapping.vps}
            onCancel={() => setBootstrapping(null)}
            onDone={(success) => {
              const sid = bootstrapping.resumeSessionId;
              const installedVpsId = bootstrapping.vps.id;
              setBootstrapping(null);
              // Refresh le agentStatus dans la state locale (le badge sidebar bascule)
              if (success) {
                setVpsList((prev) => prev.map((v) =>
                  v.id === installedVpsId
                    ? ({ ...v, agentStatus: 'ok' } as Vps)
                    : v
                ));
              }
              if (success && sid) {
                doResume(sid);
              }
            }}
          />
        )}

        {loginVps && (
          <LoginConsole vps={loginVps} onClose={() => setLoginVps(null)} />
        )}

        <div className="claude-chat">
          {renderable.map(({ msg, attached }) => (
            <Message key={msg.id} m={msg} attachedResult={attached} />
          ))}
          {cur.currentAssistant && (
            <Message m={{ id: '__streaming', role: 'assistant', content: cur.currentAssistant, createdAt: 0 }} streaming />
          )}
          <div ref={bottomRef} />
        </div>

        {cur.status === 'thinking' && (
          <ThinkingBar
            currentTool={currentTool}
            stepCount={stepCount}
            startedAt={turnStartedAt}
          />
        )}

        {/* Zone d'input — remplacée par un gros bouton resume si session déconnectée */}
        {selectedId && (cur.status === 'sleeping' || cur.status === 'error') ? (
          <div className="claude-disconnect-cta">
            <button onClick={() => doResume()}>↺ RESUME CETTE SESSION</button>
          </div>
        ) : selectedId && cur.status === 'killed' ? (
          <div className="claude-killed-cta">
            session tuée — historique consultable, mais pas reprenable
          </div>
        ) : oldestPending ? (
          /* Une interaction est en attente — remplace l'input zone */
          <div className="claude-pending-zone">
            {oldestPending.kind === 'question' && (
              <QuestionCard
                questions={oldestPending.q.questions}
                onAnswer={(answers) => {
                  api.respondClaudeQuestion(oldestPending.q.sessionId, oldestPending.q.id, answers).catch(() => {});
                }}
                onCancel={() => {
                  api.respondClaudeQuestion(oldestPending.q.sessionId, oldestPending.q.id, null).catch(() => {});
                }}
              />
            )}
            {oldestPending.kind === 'exit_plan' && (
              <ExitPlanCard
                plan={oldestPending.ep.plan || fallbackPlanFromMessages}
                onApprove={() => {
                  api.respondClaudeExitPlan(oldestPending.ep.sessionId, oldestPending.ep.id, 'approve').catch(() => {});
                }}
                onReject={(feedback) => {
                  api.respondClaudeExitPlan(oldestPending.ep.sessionId, oldestPending.ep.id, 'reject', feedback).catch(() => {});
                }}
              />
            )}
            {oldestPending.kind === 'permission' && (
              <InlinePermissionCard
                perm={oldestPending.perm}
                onRespond={(allow, always) => {
                  api.respondClaudePermission(oldestPending.perm.sessionId, oldestPending.perm.id, allow, always).catch(() => {});
                }}
              />
            )}
          </div>
        ) : (
          <footer className="claude-input-bar">
            <div className="mode-switch" role="radiogroup" aria-label="mode permissions">
              <button
                type="button"
                role="radio"
                aria-checked={cur.permissionMode === 'normal'}
                className={`m-btn normal${cur.permissionMode === 'normal' ? ' on' : ''}`}
                onClick={() => setMode('normal')}
                disabled={!selectedId}
                title="normal — demande la permission à chaque outil"
              >
                <span className="m-glyph">▷</span>
                <span className="m-label">normal</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={cur.permissionMode === 'acceptEdits'}
                className={`m-btn acceptEdits${cur.permissionMode === 'acceptEdits' ? ' on' : ''}`}
                onClick={() => setMode('acceptEdits')}
                disabled={!selectedId}
                title="accept edits — auto-accepte les éditions de fichier, demande pour le reste"
              >
                <span className="m-glyph">⏵⏵</span>
                <span className="m-label">accept edits</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={cur.permissionMode === 'bypass'}
                className={`m-btn bypass${cur.permissionMode === 'bypass' ? ' on' : ''}`}
                onClick={() => setMode('bypass')}
                disabled={!selectedId}
                title="auto mode — accepte tout sans demander (DANGER)"
              >
                <span className="m-glyph">⏵⏵</span>
                <span className="m-label">auto mode</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={cur.permissionMode === 'plan'}
                className={`m-btn plan${cur.permissionMode === 'plan' ? ' on' : ''}`}
                onClick={() => setMode('plan')}
                disabled={!selectedId}
                title="plan mode — propose un plan sans exécuter d'outils"
              >
                <span className="m-glyph">⏸</span>
                <span className="m-label">plan mode</span>
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={selectedId ? 'message à Claude (Entrée envoie, Shift/Ctrl+Entrée saut de ligne)' : 'sélectionne une session'}
              disabled={!selectedId}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // saut de ligne natif
                e.preventDefault();
                send();
              }}
              rows={3}
            />
            <button className="send" onClick={send} disabled={!selectedId || !input.trim()}>envoyer</button>
          </footer>
        )}
      </main>
      )}

      {!selectedShellId && (
        <ToolPanel
          sessionId={selectedId}
          toolCalls={cur.toolCalls}
          todos={cur.todos}
          edits={cur.edits}
          files={cur.files}
          onRevert={() => refreshSessions()}
        />
      )}

      <PermissionPopup
        queue={permQueue}
        currentSessionId={selectedId}
        onRespond={respondPermission}
        onSwitchSession={(id) => setSelectedId(id)}
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
          onResumed={(id) => { setResumeOpen(null); doResume(id); refreshSessions(); }}
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
          initialPaths={vpsPaths}
          onChange={({ vps, paths }) => {
            setVpsList(vps);
            setVpsPaths(paths);
          }}
        />
      )}

      {ctxMenu && ctxMenu.kind === 'session' && (
        <SessionContextMenu
          title={ctxMenu.session.name || ctxMenu.session.cwd.split('/').slice(-2).join('/')}
          x={ctxMenu.x}
          y={ctxMenu.y}
          currentColor={(ctxMenu.session as any).color}
          canKill={ctxMenu.session.status !== 'killed'}
          killDisabledReason={ctxMenu.session.status === 'killed' ? 'déjà tuée' : undefined}
          onRename={() => setEditingId(ctxMenu.session.id)}
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
    </div>
  );
}

// Carte permission affichée dans la zone d'input (remplace l'écriture
// tant qu'elle n'est pas répondue). Reprend la même UX que la popup
// top-right mais plus large et avec le sumamry de l'outil.
function InlinePermissionCard({ perm, onRespond }: {
  perm: PermissionRequest;
  onRespond: (allow: boolean, always: boolean) => void;
}) {
  const summary = summarizeToolInput(perm.tool, perm.input);
  return (
    <div className="inline-perm-card">
      <header className="ip-head">
        <span className="ip-tag">🔒 permission</span>
        <span className="ip-tool">{perm.tool}</span>
        {summary && <span className="ip-summary">{summary}</span>}
      </header>
      <pre className="ip-input">{JSON.stringify(perm.input, null, 2).slice(0, 1200)}</pre>
      <footer className="ip-actions">
        <button type="button" className="allow" onClick={() => onRespond(true, false)}>allow once</button>
        <button type="button" className="always" onClick={() => onRespond(true, true)}>allow always (session)</button>
        <button type="button" className="deny" onClick={() => onRespond(false, false)}>deny</button>
      </footer>
    </div>
  );
}

// Barre d'état affichée sous le chat quand status === 'thinking'
function ThinkingBar({
  currentTool, stepCount, startedAt,
}: {
  currentTool: ToolCallEntry | null;
  stepCount: number;
  startedAt: number | null;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // tick keeps elapsed display fresh
  void tick;
  const elapsed = startedAt ? Math.max(0, Math.floor(Date.now() / 1000 - startedAt)) : null;
  return (
    <div className="thinking-bar">
      <span className="t-dot" />
      <span className="t-label">Claude réfléchit</span>
      {currentTool && (
        <span className="t-tool">
          <span className="sep">·</span>
          <span className="glyph">⚒</span>
          <span className="name">{currentTool.name}</span>
          <span className="sum">{summarizeToolInput(currentTool.name, currentTool.input)}</span>
        </span>
      )}
      <span className="t-meta">
        {stepCount > 0 && <><span className="sep">·</span> étape {stepCount}</>}
        {elapsed != null && <><span className="sep">·</span> {fmtElapsed(elapsed)}</>}
      </span>
    </div>
  );
}

// Petit bip de notification — Web Audio (pas de fichier à charger).
// Singleton AudioContext pour éviter le warning Chrome (max 6 contextes).
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

function fmtElapsed(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

// Rebuild SessionState from persisted messages (utilisé sur switch de session)
function rebuildStateFromMessages(messages: any[], status: WorkerStatus): SessionState {
  const s: SessionState = emptyState();
  s.status = status;
  for (const m of messages) {
    if (m.role === 'edit_snapshot') {
      try {
        const ev = JSON.parse(m.content);
        const key = ev.file_path;
        const cur = s.edits.get(key) ?? { toolUseId: ev.tool_use_id, filePath: key, before: null, after: null, truncated: !!ev.truncated };
        if (ev.phase === 'before') s.edits.set(key, { ...cur, before: ev.content, truncated: cur.truncated || !!ev.truncated });
        else s.edits.set(key, { ...cur, after: ev.content, truncated: cur.truncated || !!ev.truncated });
        s.files.add(key);
      } catch {}
      continue;
    }
    if (m.role === 'event') {
      try {
        const ev = JSON.parse(m.content);
        if (ev.type === 'todo_update') s.todos = (ev.todos ?? []);
        if (ev.type === 'thinking') {
          s.messages.push({ id: 'm' + m.id, role: 'thinking', content: String(ev.text ?? ''), createdAt: m.createdAt });
        }
      } catch {}
      continue;
    }
    if (m.role === 'thinking') {
      s.messages.push({ id: 'm' + m.id, role: 'thinking', content: m.content, createdAt: m.createdAt });
      continue;
    }
    if (m.role === 'tool_use') {
      let parsed: any = null;
      try { parsed = JSON.parse(m.content); } catch {}
      if (parsed) {
        s.toolCalls.push({
          id: 'h' + m.id, name: parsed.name, input: parsed.input,
          startedAt: m.createdAt,
        });
        const fp = parsed.input?.file_path;
        if (fp) s.files.add(String(fp));
      }
      s.messages.push({ id: 'm' + m.id, role: m.role, content: m.content, createdAt: m.createdAt });
      continue;
    }
    if (m.role === 'tool_result') {
      // Try to link to a previous tool_use (we don't have tool_use_id in DB rows by default — skip linking)
      s.messages.push({ id: 'm' + m.id, role: m.role, content: m.content, createdAt: m.createdAt });
      continue;
    }
    // user / assistant / system
    s.messages.push({ id: 'm' + m.id, role: m.role, content: m.content, createdAt: m.createdAt });
  }
  return s;
}
