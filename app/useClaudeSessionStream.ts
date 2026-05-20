'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type {
  Msg, ToolCallEntry, Todo, EditSnapshot,
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { rebuildStateFromMessages } from './sessionRebuild';
import type {
  WorkerEvent, WorkerStatus, PermissionMode,
} from '@/lib/server/claude/types';
import type { ClaudeSessionDetailResponse, ClaudeSessionMessageWindow } from '@/lib/types/api';
import { subscribeSession, setFocus, subscribeReconnect } from './globalEventStream';

// useClaudeSessionStream
// ─────────────────────────────────────────────────────────────────────────────
// Hook qui encapsule toute la logique SSE + state + actions d'une session
// Claude vue depuis le navigateur. Utilisé par MobileChat (single-session)
// et ClaudePanel/ClaudeSessionView (multi-session, le composant parent crée
// une instance par sessionId via `key={selectedId}`).
//
// Ce que ce hook fait :
//   - S'abonne aux events de cette session via `globalEventStream` (SSE
//     multiplexée unique — pas de close/reopen sur switch de session)
//   - POST /api/claude/focus au mount/changement de session pour que le
//     serveur stream les events high-volume (assistant_text, tool_*) de
//     CETTE session
//   - Maintient messages/currentAssistant/status/permissionMode/toolCalls/
//     todos/edits/files/permQueue/questionQueue/exitPlanQueue
//   - GET /api/claude/sessions/[id] au mount et au retour de l'onglet en
//     foreground — la DB est la source de vérité pour l'historique
//   - Batch les deltas `assistant_text` via requestAnimationFrame (60Hz max)
//     pour ne pas re-render le sous-arbre à chaque token
//   - Expose les actions (send/interrupt/forceStop/setMode/doSleep/doResume/
//     doDelete/respondPermission/respondQuestion/respondExitPlan) avec
//     confirmation pessimiste (la queue se vide après ack serveur, pas avant)
//
// Ce que ce hook NE fait PAS :
//   - Layout / rendu (les composants l'utilisent et stylent)
//   - Navigation post-kill (le caller fait `router.push('...')` dans onKilled)
//   - Multi-session state (le caller compose plusieurs instances si besoin)
//   - Scroll mechanics (chatBodyRef/isAtBottom restent côté caller)

export type StreamCache = {
  get(id: string): ClaudeSessionDetailResponse | undefined;
  fetch(id: string, force?: boolean): Promise<ClaudeSessionDetailResponse>;
  invalidate?(id: string): void;
  /**
   * Étend l'entrée cache avec une fenêtre de messages plus anciens (loadMore).
   * Permet de préserver les pages chargées au switch de session/remount.
   * No-op si l'implémentation ne le supporte pas.
   */
  extendWithOlder?(id: string, older: ClaudeSessionMessageWindow): void;
};

export type UseClaudeSessionStreamOptions = {
  /**
   * Cache module-level (instant load au mount). Mobile passe le chatCache
   * existant, desktop passera le sessionCache partagé une fois extrait.
   * Si absent : refetch direct à chaque mount.
   */
  cache?: StreamCache;

  /**
   * Callback appelé quand l'utilisateur kill la session. Le hook ne navigue
   * pas tout seul ; le caller décide (mobile → router.push, desktop →
   * deselect + refresh).
   */
  onKilled?: () => void;
};

export type ClaudeSessionStreamState = {
  // Métadonnées session
  sessionMeta: ClaudeSessionDetailResponse['session'] | null;
  // État conversation
  messages: Msg[];
  currentAssistant: string;
  status: WorkerStatus | null;
  permissionMode: PermissionMode;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
  // Queues d'interaction en attente
  permQueue: PermissionRequest[];
  questionQueue: PendingQuestion[];
  exitPlanQueue: PendingExitPlan[];
  // Texte que l'agent veut pré-remplir dans la textarea (event prefill_input)
  prefillInput: string | null;
  // Dernière erreur affichable à l'utilisateur
  error: { msg: string } | null;
  // true tant qu'on n'a JAMAIS appliqué de données pour cette session
  // (ni depuis le cache, ni depuis le fetch). Permet à l'UI de différencier
  // « session vide » de « historique en cours de chargement ».
  isLoadingHistory: boolean;
  // Pagination scroll-up : true s'il existe des messages chat plus anciens
  // que `oldestChatId` côté serveur. False quand on a atteint le début.
  hasMore: boolean;
  // true pendant qu'un loadMoreHistory est en vol. Le caller peut afficher
  // un spinner en haut du chat (visuel : column-reverse → "en haut").
  isLoadingMore: boolean;
};

export type ClaudeSessionStreamActions = {
  send(content: string): Promise<void>;
  interrupt(): Promise<void>;
  forceStop(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  doSleep(): Promise<void>;
  doResume(): Promise<void>;
  /** Suppression définitive. Le caller DOIT avoir confirmé côté UI. */
  doDelete(): Promise<void>;
  respondPermission(permId: string, allow: boolean, always?: boolean): Promise<void>;
  respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void>;
  respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback?: string): Promise<void>;
  /** Reset le prefillInput après que le caller l'a consommé. */
  clearPrefillInput(): void;
  /** Force un refetch depuis la DB (cache bypass). */
  refetchHistory(): Promise<void>;
  /**
   * Charge une fenêtre de messages chat plus anciens et les préprend à
   * l'historique. No-op si `hasMore=false`, si `oldestChatId=null`, ou si
   * un loadMore est déjà en cours. Le caller le déclenche quand l'user
   * scrolle vers le haut du chat (proche de la limite visuelle).
   */
  loadMoreHistory(): Promise<void>;
  /** Reset l'erreur affichée. */
  clearError(): void;
};

export function useClaudeSessionStream(
  sessionId: string,
  options: UseClaudeSessionStreamOptions = {},
): ClaudeSessionStreamState & ClaudeSessionStreamActions {
  const { cache, onKilled } = options;
  // Ref pour onKilled : les callers passent typiquement un inline arrow (cf.
  // ClaudePanel + MobileChat), donc la ref `options.onKilled` change à chaque
  // render. Le handler SSE est créé dans un useEffect avec eslint-disable
  // exhaustive-deps — sans cette pinning, le callback embarqué dans le
  // switch `status==='killed'` deviendrait stale dès le 1er render après mount.
  const onKilledRef = useRef(onKilled);
  useEffect(() => { onKilledRef.current = onKilled; }, [onKilled]);

  // ── State ──────────────────────────────────────────────────────────────
  const [sessionMeta, setSessionMeta] = useState<ClaudeSessionDetailResponse['session'] | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [currentAssistant, setCurrentAssistant] = useState('');
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('normal');
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [edits, setEdits] = useState<Map<string, EditSnapshot>>(new Map());
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [permQueue, setPermQueue] = useState<PermissionRequest[]>([]);
  const [questionQueue, setQuestionQueue] = useState<PendingQuestion[]>([]);
  const [exitPlanQueue, setExitPlanQueue] = useState<PendingExitPlan[]>([]);
  const [prefillInput, setPrefillInput] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string } | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  // Pagination state. `oldestChatIdRef` est aussi tenu en ref pour pouvoir
  // être lu sans re-render dans le handler scroll (qui peut spam) et dans
  // loadMoreHistory (qui doit lire la dernière valeur avant d'envoyer le POST).
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const oldestChatIdRef = useRef<number | null>(null);
  const loadMoreInflightRef = useRef(false);

  // streamKey : bump pour forcer la re-création de la SSE (utilisé après
  // doResume — la session est repartie et on veut une SSE fraîche).
  const [streamKey, setStreamKey] = useState(0);

  const assistantBufRef = useRef('');
  // RAF batch pour les deltas assistant_text. Sans ça, chaque token =
  // setCurrentAssistant = re-render du sous-arbre. À 100 tokens/sec, ça lag.
  // Avec RAF, on plafonne à 60Hz, le browser fait le rate-limiting tout seul.
  const assistantFlushRafRef = useRef<number | null>(null);

  // ── Application d'un payload API au state local ─────────────────────────
  const applyApiData = useCallback((r: ClaudeSessionDetailResponse) => {
    if (!r?.session) return;
    const rebuilt = rebuildStateFromMessages(r.messages, (r.liveStatus ?? r.session.status) as WorkerStatus);
    const streamingText = String(r.streamingText ?? '');
    assistantBufRef.current = streamingText;
    setMessages(rebuilt.messages);
    setCurrentAssistant(streamingText);
    setStatus(rebuilt.status);
    setToolCalls(rebuilt.toolCalls);
    setTodos(rebuilt.todos);
    setEdits(rebuilt.edits);
    setFiles(rebuilt.files);
    setPermissionMode(
      (['normal', 'acceptEdits', 'auto', 'plan'] as const).includes(
        r.session?.permissionMode as PermissionMode,
      ) ? (r.session.permissionMode as PermissionMode) : 'normal',
    );
    setSessionMeta(r.session);
    // Queues d'interactions — on injecte le sessionId requis par le type
    // partagé (l'API ne le renvoie pas par défaut).
    const sid = r.session.id;
    setPermQueue(((r.pendingPermissions ?? []) as Omit<PermissionRequest, 'sessionId'>[])
      .map((p) => ({ ...p, sessionId: sid })));
    setQuestionQueue(((r.pendingQuestions ?? []) as Omit<PendingQuestion, 'sessionId'>[])
      .map((q) => ({ ...q, sessionId: sid })));
    setExitPlanQueue(((r.pendingExitPlans ?? []) as Omit<PendingExitPlan, 'sessionId'>[])
      .map((e) => ({ ...e, sessionId: sid })));
    // On a des données, qu'elles viennent du cache ou du fetch fresh → on
    // peut masquer le loader. Vrai-zéro-message = on saura par messages.length.
    setIsLoadingHistory(false);
    // Reset pagination cursor depuis la fenêtre fraîche. `r.hasMore` et
    // `r.oldestChatId` viennent du backend (cf. loadMessageWindow). Si la
    // réponse ne les a pas (response cachée d'une version antérieure), on
    // tombe sur false/null → pagination simplement désactivée pour cette
    // session jusqu'au prochain fetch fresh.
    setHasMore(!!r.hasMore);
    oldestChatIdRef.current = r.oldestChatId ?? null;
  }, []);

  // refetchHistory : utilisé au mount, à chaque reconnexion SSE et au retour
  // foreground. Stratégie cache :
  //   1. Si entrée cache existe → applique immédiatement (instant)
  //   2. Lance un fetch fresh en arrière-plan, re-applique
  // Sans cache : un seul fetch direct.
  const refetchHistory = useCallback(async () => {
    if (cache) {
      const cached = cache.get(sessionId);
      if (cached) applyApiData(cached);
      try {
        const fresh = await cache.fetch(sessionId, true);
        applyApiData(fresh);
      } catch (e) {
        if (!cached) {
          setError({ msg: String((e as Error)?.message ?? e) });
          setIsLoadingHistory(false); // on abandonne le loader, l'erreur s'affiche
        }
      }
    } else {
      try {
        const r = (await api.getClaudeSession(sessionId)) as ClaudeSessionDetailResponse;
        applyApiData(r);
      } catch (e) {
        setError({ msg: String((e as Error)?.message ?? e) });
        setIsLoadingHistory(false);
      }
    }
  }, [sessionId, cache, applyApiData]);

  // loadMoreHistory : charge une page d'historique plus ancien, prépend à
  // l'état local. Déclenché par le caller au scroll-up. Idempotent et
  // protégé contre les appels concurrents par loadMoreInflightRef.
  const loadMoreHistory = useCallback(async () => {
    if (loadMoreInflightRef.current) return;
    const cursor = oldestChatIdRef.current;
    if (cursor == null) return;
    if (!hasMore) return;
    loadMoreInflightRef.current = true;
    setIsLoadingMore(true);
    try {
      const older = await api.loadOlderClaudeMessages(sessionId, cursor, 200);
      // Server peut renvoyer hasMore=false même si la page est non vide :
      // l'ancien curseur était déjà la limite. On met à jour quand même.
      const olderRebuilt = rebuildStateFromMessages(
        older.messages,
        (status ?? 'sleeping') as WorkerStatus,
      );
      if (olderRebuilt.messages.length > 0) {
        setMessages((cur) => [...olderRebuilt.messages, ...cur]);
        setToolCalls((cur) => [...olderRebuilt.toolCalls, ...cur]);
        setFiles((cur) => {
          const next = new Set(cur);
          for (const f of olderRebuilt.files) next.add(f);
          return next;
        });
        setEdits((cur) => {
          // Pour edits : les snapshots récents (live ou déjà chargés) ont
          // priorité — on n'écrase pas une entrée existante avec une plus
          // ancienne du même file_path. Sinon on perdrait le diff récent.
          const next = new Map(cur);
          for (const [k, v] of olderRebuilt.edits) {
            if (!next.has(k)) next.set(k, v);
          }
          return next;
        });
        // Todos : on n'écrase JAMAIS la liste actuelle avec d'anciens snapshots —
        // les todos sont par-définition state-driven, la dernière version
        // est la vraie (cf. rebuild qui fait latest-wins de toute façon).
      }
      // Avance le cursor + statut hasMore selon la nouvelle limite.
      oldestChatIdRef.current = older.oldestChatId ?? cursor;
      setHasMore(!!older.hasMore);
      // Persist dans le cache pour préserver les pages au switch/remount.
      if (cache?.extendWithOlder && older.messages.length > 0) {
        try { cache.extendWithOlder(sessionId, older); } catch {}
      }
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    } finally {
      setIsLoadingMore(false);
      loadMoreInflightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hasMore, cache, status]);

  // ── Subscription au global event stream ───────────────────────────────
  useEffect(() => {
    // Charge l'historique depuis la DB. Indépendant de la SSE.
    refetchHistory();
    // Signale au serveur de streamer les events high-volume de CETTE session
    // sur la SSE multiplexée. La SSE ne se ferme pas / ne se réouvre pas —
    // c'est juste un POST qui change le filtre côté serveur. Le streamKey
    // (bumpé après doResume) déclenche le refetch + re-focus.
    setFocus(sessionId);

    // Flush du buffer assistant : crée un message 'assistant' complet et reset.
    // Appelé avant tout event qui interrompt le texte (tool_use, thinking,
    // permission_request, user_question, exit_plan_request, stop).
    const flushAssistantBuf = () => {
      // Annule un RAF en attente — on flush immédiatement.
      if (assistantFlushRafRef.current != null) {
        cancelAnimationFrame(assistantFlushRafRef.current);
        assistantFlushRafRef.current = null;
      }
      if (!assistantBufRef.current) return;
      const finalContent = assistantBufRef.current;
      assistantBufRef.current = '';
      setMessages((prev) => [...prev, {
        id: 'a' + Date.now() + Math.random(), role: 'assistant',
        content: finalContent, createdAt: Math.floor(Date.now() / 1000),
      }]);
      setCurrentAssistant('');
    };

    // Schedule un flush de l'aperçu streaming via RAF. Coalesce les deltas
    // arrivés dans la même frame en un seul setState.
    const scheduleAssistantFlush = () => {
      if (assistantFlushRafRef.current != null) return;
      assistantFlushRafRef.current = requestAnimationFrame(() => {
        assistantFlushRafRef.current = null;
        setCurrentAssistant(assistantBufRef.current);
      });
    };

    const handleEvent = (ev: WorkerEvent & { sessionId: string }) => {
      switch (ev.type) {
        case 'status':
          // `'killed'` n'est plus un état DB persistant (cf. CLAUDE.md §10) :
          // c'est un **signal transient** émis par le serveur quand la session
          // vient d'être supprimée (cascade DB faite). Le caller veut un
          // redirect (navigation hors de la session). On déclenche `onKilled`
          // et on ne touche pas le local status pour éviter un re-render
          // d'une UI qui sera unmount juste après.
          if (ev.status === 'killed') {
            onKilledRef.current?.();
            break;
          }
          setStatus(ev.status);
          break;
        case 'user_echo':
          setMessages((prev) => [...prev, {
            id: 'u' + Date.now() + Math.random(), role: 'user',
            content: ev.content, createdAt: ev.createdAt,
          }]);
          break;
        case 'assistant_text':
          assistantBufRef.current += ev.delta;
          scheduleAssistantFlush();
          break;
        case 'tool_use': {
          flushAssistantBuf();
          const filePath = (ev.input && ev.input.file_path) ? String(ev.input.file_path) : null;
          setMessages((prev) => [...prev, {
            id: 'tu' + ev.id + Math.random(), role: 'tool_use',
            content: JSON.stringify({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input }),
            createdAt: Math.floor(Date.now() / 1000),
          }]);
          setToolCalls((prev) => [...prev, {
            id: ev.id, name: ev.name, input: ev.input,
            startedAt: Math.floor(Date.now() / 1000),
          }]);
          if (filePath) {
            setFiles((prev) => new Set(prev).add(filePath));
          }
          break;
        }
        case 'tool_result':
          setMessages((prev) => [...prev, {
            id: 'tr' + ev.tool_use_id + Math.random(), role: 'tool_result',
            content: JSON.stringify({
              type: 'tool_result',
              tool_use_id: ev.tool_use_id,
              content: ev.content,
              is_error: !!ev.is_error,
            }),
            createdAt: Math.floor(Date.now() / 1000),
          }]);
          setToolCalls((prev) => prev.map((c) => c.id === ev.tool_use_id
            ? { ...c, result: { content: ev.content, isError: !!ev.is_error } } : c));
          break;
        case 'stop':
          flushAssistantBuf();
          break;
        case 'error':
          setError({ msg: ev.msg });
          break;
        case 'permission_request':
          flushAssistantBuf();
          setPermQueue((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
            id: ev.id, sessionId, tool: ev.tool, input: ev.input,
            createdAt: Math.floor(Date.now() / 1000),
          }]);
          break;
        case 'user_question':
          flushAssistantBuf();
          setQuestionQueue((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
            id: ev.id, sessionId, questions: ev.questions,
            createdAt: Math.floor(Date.now() / 1000),
          }]);
          break;
        case 'exit_plan_request':
          flushAssistantBuf();
          setExitPlanQueue((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
            id: ev.id, sessionId, plan: ev.plan ?? '',
            createdAt: Math.floor(Date.now() / 1000),
          }]);
          break;
        case 'interaction_resolved':
          if (ev.kind === 'permission') setPermQueue((q) => q.filter((p) => p.id !== ev.id));
          else if (ev.kind === 'question') setQuestionQueue((q) => q.filter((p) => p.id !== ev.id));
          else if (ev.kind === 'exit_plan') setExitPlanQueue((q) => q.filter((p) => p.id !== ev.id));
          break;
        case 'prefill_input':
          setPrefillInput(ev.content || 'continue');
          break;
        case 'reconnecting':
          setError(null);
          break;
        case 'todo_update':
          setTodos((ev.todos ?? []) as Todo[]);
          break;
        case 'edit_snapshot': {
          const key = ev.file_path;
          setEdits((prev) => {
            const next = new Map(prev);
            const cur = prev.get(key) ?? { toolUseId: ev.tool_use_id, filePath: key, before: null, after: null, truncated: false };
            if (ev.phase === 'before') {
              next.set(key, { ...cur, before: ev.content, truncated: cur.truncated || ev.truncated });
            } else {
              next.set(key, { ...cur, after: ev.content, truncated: cur.truncated || ev.truncated });
            }
            return next;
          });
          setFiles((prev) => new Set(prev).add(key));
          break;
        }
        case 'thinking':
          flushAssistantBuf();
          setMessages((prev) => [...prev, {
            id: 'th' + Date.now() + Math.random(), role: 'thinking',
            content: ev.text, createdAt: Math.floor(Date.now() / 1000),
          }]);
          break;
        case 'mode_changed':
          setPermissionMode(ev.mode);
          break;
        default: break;
      }
    };

    // Branche le handler au flux global pour cette sessionId. Le module
    // singleton garantit qu'on ne paie qu'UNE EventSource pour tout le browser.
    const unsubscribe = subscribeSession(sessionId, handleEvent);

    return () => {
      if (assistantFlushRafRef.current != null) {
        cancelAnimationFrame(assistantFlushRafRef.current);
        assistantFlushRafRef.current = null;
      }
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, streamKey, refetchHistory]);

  // Refetch quand l'onglet revient au premier plan (cas restart backend
  // pendant qu'on était en background → ring SSE vide, DB = source).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetchHistory();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refetchHistory]);

  // Refetch sur reconnect SSE (= la connexion EventSource a été
  // ré-établie après un drop, typiquement après un `systemctl restart
  // charon`). La SSE elle-même est live-only côté Charon — les messages
  // persistés en DB pendant le gap ne sont jamais relayés. Sans ce
  // refetch, l'UI reste figée sur le dernier état pré-drop, l'user
  // devait refresh à la main (cf. CLAUDE.md §14 piège 24).
  useEffect(() => {
    const unsub = subscribeReconnect(() => {
      refetchHistory();
    });
    return () => unsub();
  }, [refetchHistory]);

  // ── Actions ────────────────────────────────────────────────────────────
  const send = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    try { await api.sendClaudeInput(sessionId, trimmed); }
    catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const interrupt = useCallback(async () => {
    try { await api.interruptClaude(sessionId); }
    catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const forceStop = useCallback(async () => {
    try { await api.forceStopClaude(sessionId); }
    catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const setMode = useCallback(async (mode: PermissionMode) => {
    if (permissionMode === mode) return;
    try { await api.setClaudeMode(sessionId, mode); }
    catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId, permissionMode]);

  const doSleep = useCallback(async () => {
    try {
      await api.sleepClaudeSession(sessionId);
      setStatus('sleeping');
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  const doResume = useCallback(async () => {
    setError(null);
    setStatus('starting');
    try {
      await api.resumeClaudeSession(sessionId);
      // Bump streamKey → useEffect ferme l'ancienne SSE, recharge l'historique,
      // ré-attache les handlers. Évite que l'UI reste collée sur l'état post-
      // sleep alors que la session a redémarré côté agent.
      setStreamKey((k) => k + 1);
    } catch (e) {
      setStatus('sleeping');
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // Suppression définitive (cascade DB côté serveur). Le callback `onKilled`
  // est gardé tel quel pour la navigation post-suppression (mobile : retour
  // vers /m/select). Pas de confirm() ici — c'est au caller de demander
  // confirmation avant d'appeler l'action.
  const doDelete = useCallback(async () => {
    try {
      await api.deleteClaudeSession(sessionId);
      onKilledRef.current?.();
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // Acks pessimistes : on attend l'OK du POST avant de retirer la card de la
  // queue. Avant, c'était optimiste — si le POST échouait, la card disparaissait
  // mais le backend n'avait rien enregistré ; au reload, elle réapparaissait et
  // l'user pensait que l'historique était cassé. Maintenant : POST OK → la
  // queue se vide via l'event `interaction_resolved` qui revient en SSE (ou
  // au pire au prochain refetch). POST KO → la card reste, error affiché.
  const respondPermission = useCallback(async (permId: string, allow: boolean, always = false) => {
    try {
      await api.respondClaudePermission(sessionId, permId, allow, always);
      // Removal arrive via `interaction_resolved` SSE. Fallback en cas de
      // SSE down : on retire localement (et le serveur ne renverra rien
      // qu'on traite déjà comme no-op via le filter par id).
      setPermQueue((q) => q.filter((p) => p.id !== permId));
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const respondQuestion = useCallback(async (qid: string, answers: Record<string, string> | null) => {
    try {
      await api.respondClaudeQuestion(sessionId, qid, answers);
      setQuestionQueue((q) => q.filter((p) => p.id !== qid));
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const respondExitPlan = useCallback(async (qid: string, decision: 'approve' | 'reject', feedback?: string) => {
    try {
      await api.respondClaudeExitPlan(sessionId, qid, decision, feedback);
      setExitPlanQueue((q) => q.filter((p) => p.id !== qid));
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const clearPrefillInput = useCallback(() => setPrefillInput(null), []);
  const clearError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    sessionMeta, messages, currentAssistant, status, permissionMode,
    toolCalls, todos, edits, files,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    send, interrupt, forceStop, setMode,
    doSleep, doResume, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, loadMoreHistory, clearError,
  }), [
    sessionMeta, messages, currentAssistant, status, permissionMode,
    toolCalls, todos, edits, files,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    send, interrupt, forceStop, setMode,
    doSleep, doResume, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, loadMoreHistory, clearError,
  ]);
}
