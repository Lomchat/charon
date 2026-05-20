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
// Hook that encapsulates all the SSE + state + actions logic for a Claude
// session viewed from the browser. Used by MobileChat (single-session)
// and ClaudePanel/ClaudeSessionView (multi-session, the parent component
// creates one instance per sessionId via `key={selectedId}`).
//
// What this hook does:
//   - Subscribes to events for this session via `globalEventStream` (single
//     multiplexed SSE — no close/reopen on session switch)
//   - POST /api/claude/focus at mount/session change so that the
//     server streams high-volume events (assistant_text, tool_*) for
//     THIS session
//   - Maintains messages/currentAssistant/status/permissionMode/toolCalls/
//     todos/edits/files/permQueue/questionQueue/exitPlanQueue
//   - GET /api/claude/sessions/[id] at mount and when the tab returns to
//     foreground — the DB is the source of truth for history
//   - Batches `assistant_text` deltas via requestAnimationFrame (60Hz max)
//     to avoid re-rendering the subtree on every token
//   - Exposes actions (send/interrupt/forceStop/setMode/doSleep/doResume/
//     doDelete/respondPermission/respondQuestion/respondExitPlan) with
//     pessimistic confirmation (queue empties after server ack, not before)
//
// What this hook does NOT do:
//   - Layout / rendering (consumed by components which style)
//   - Post-kill navigation (the caller does `router.push('...')` in onKilled)
//   - Multi-session state (the caller composes several instances if needed)
//   - Scroll mechanics (chatBodyRef/isAtBottom remain on the caller side)

export type StreamCache = {
  get(id: string): ClaudeSessionDetailResponse | undefined;
  fetch(id: string, force?: boolean): Promise<ClaudeSessionDetailResponse>;
  invalidate?(id: string): void;
  /**
   * Extends the cache entry with a window of older messages (loadMore).
   * Allows loaded pages to be preserved across session switch/remount.
   * No-op if the implementation does not support it.
   */
  extendWithOlder?(id: string, older: ClaudeSessionMessageWindow): void;
};

export type UseClaudeSessionStreamOptions = {
  /**
   * Module-level cache (instant load on mount). Mobile passes the existing
   * chatCache, desktop will pass the shared sessionCache once extracted.
   * If absent: direct refetch on each mount.
   */
  cache?: StreamCache;

  /**
   * Callback called when the user kills the session. The hook doesn't
   * navigate by itself; the caller decides (mobile → router.push, desktop →
   * deselect + refresh).
   */
  onKilled?: () => void;
};

export type ClaudeSessionStreamState = {
  // Session metadata
  sessionMeta: ClaudeSessionDetailResponse['session'] | null;
  // Conversation state
  messages: Msg[];
  currentAssistant: string;
  status: WorkerStatus | null;
  permissionMode: PermissionMode;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
  // Pending interaction queues
  permQueue: PermissionRequest[];
  questionQueue: PendingQuestion[];
  exitPlanQueue: PendingExitPlan[];
  // Text the agent wants to prefill in the textarea (prefill_input event)
  prefillInput: string | null;
  // Last error displayable to the user
  error: { msg: string } | null;
  // true as long as we've NEVER applied data for this session
  // (neither from the cache, nor from the fetch). Lets the UI differentiate
  // "empty session" from "history loading".
  isLoadingHistory: boolean;
  // Scroll-up pagination: true if there are chat messages older than
  // `oldestChatId` on the server side. False when we've reached the start.
  hasMore: boolean;
  // true while a loadMoreHistory is in flight. The caller can display
  // a spinner at the top of the chat (visual: column-reverse → "at the top").
  isLoadingMore: boolean;
};

export type ClaudeSessionStreamActions = {
  send(content: string): Promise<void>;
  interrupt(): Promise<void>;
  forceStop(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  doSleep(): Promise<void>;
  doResume(): Promise<void>;
  /** Permanent deletion. The caller MUST have confirmed on the UI side. */
  doDelete(): Promise<void>;
  respondPermission(permId: string, allow: boolean, always?: boolean): Promise<void>;
  respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void>;
  respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback?: string): Promise<void>;
  /** Resets prefillInput after the caller has consumed it. */
  clearPrefillInput(): void;
  /** Forces a refetch from the DB (cache bypass). */
  refetchHistory(): Promise<void>;
  /**
   * Loads a window of older chat messages and prepends them to history.
   * No-op if `hasMore=false`, if `oldestChatId=null`, or if a loadMore
   * is already in progress. The caller triggers it when the user scrolls
   * toward the top of the chat (near the visual limit).
   */
  loadMoreHistory(): Promise<void>;
  /** Resets the displayed error. */
  clearError(): void;
};

export function useClaudeSessionStream(
  sessionId: string,
  options: UseClaudeSessionStreamOptions = {},
): ClaudeSessionStreamState & ClaudeSessionStreamActions {
  const { cache, onKilled } = options;
  // Ref for onKilled: callers typically pass an inline arrow (cf.
  // ClaudePanel + MobileChat), so the `options.onKilled` ref changes on each
  // render. The SSE handler is created in a useEffect with eslint-disable
  // exhaustive-deps — without this pinning, the callback embedded in the
  // `status==='killed'` switch would become stale right after the 1st render.
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
  // Pagination state. `oldestChatIdRef` is also kept as a ref so it can
  // be read without re-render in the scroll handler (which may spam) and in
  // loadMoreHistory (which must read the latest value before sending the POST).
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const oldestChatIdRef = useRef<number | null>(null);
  const loadMoreInflightRef = useRef(false);

  // streamKey: bump to force re-creation of the SSE (used after
  // doResume — the session restarted and we want a fresh SSE).
  const [streamKey, setStreamKey] = useState(0);

  const assistantBufRef = useRef('');
  // RAF batch for assistant_text deltas. Without it, each token =
  // setCurrentAssistant = subtree re-render. At 100 tokens/sec, it lags.
  // With RAF, we cap at 60Hz, the browser rate-limits on its own.
  const assistantFlushRafRef = useRef<number | null>(null);

  // ── Apply an API payload to local state ────────────────────────────────
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
    // Interaction queues — we inject the sessionId required by the shared
    // type (the API doesn't return it by default).
    const sid = r.session.id;
    setPermQueue(((r.pendingPermissions ?? []) as Omit<PermissionRequest, 'sessionId'>[])
      .map((p) => ({ ...p, sessionId: sid })));
    setQuestionQueue(((r.pendingQuestions ?? []) as Omit<PendingQuestion, 'sessionId'>[])
      .map((q) => ({ ...q, sessionId: sid })));
    setExitPlanQueue(((r.pendingExitPlans ?? []) as Omit<PendingExitPlan, 'sessionId'>[])
      .map((e) => ({ ...e, sessionId: sid })));
    // We have data, whether from cache or fresh fetch → we can hide the
    // loader. True-zero-messages = we'll know via messages.length.
    setIsLoadingHistory(false);
    // Reset pagination cursor from the fresh window. `r.hasMore` and
    // `r.oldestChatId` come from the backend (cf. loadMessageWindow). If the
    // response doesn't have them (response cached from an earlier version),
    // we fall back to false/null → pagination simply disabled for this
    // session until the next fresh fetch.
    setHasMore(!!r.hasMore);
    oldestChatIdRef.current = r.oldestChatId ?? null;
  }, []);

  // refetchHistory: used at mount, on every SSE reconnect and on tab
  // foreground return. Cache strategy:
  //   1. If a cache entry exists → apply immediately (instant)
  //   2. Launch a fresh fetch in the background, re-apply
  // Without cache: a single direct fetch.
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
          setIsLoadingHistory(false); // we drop the loader, the error is displayed
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

  // loadMoreHistory: loads a page of older history, prepends to local
  // state. Triggered by the caller on scroll-up. Idempotent and
  // protected against concurrent calls by loadMoreInflightRef.
  const loadMoreHistory = useCallback(async () => {
    if (loadMoreInflightRef.current) return;
    const cursor = oldestChatIdRef.current;
    if (cursor == null) return;
    if (!hasMore) return;
    loadMoreInflightRef.current = true;
    setIsLoadingMore(true);
    try {
      const older = await api.loadOlderClaudeMessages(sessionId, cursor, 200);
      // Server may return hasMore=false even if the page is non-empty:
      // the old cursor was already the limit. We update anyway.
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
          // For edits: recent snapshots (live or already loaded) take
          // priority — we don't overwrite an existing entry with an older
          // one for the same file_path. Otherwise we'd lose the recent diff.
          const next = new Map(cur);
          for (const [k, v] of olderRebuilt.edits) {
            if (!next.has(k)) next.set(k, v);
          }
          return next;
        });
        // Todos: NEVER overwrite the current list with old snapshots —
        // todos are by definition state-driven, the latest version is the
        // real one (cf. rebuild which does latest-wins anyway).
      }
      // Advance the cursor + hasMore status based on the new limit.
      oldestChatIdRef.current = older.oldestChatId ?? cursor;
      setHasMore(!!older.hasMore);
      // Persist into the cache to preserve pages across switch/remount.
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

  // ── Subscription to the global event stream ────────────────────────────
  useEffect(() => {
    // Load history from the DB. Independent of the SSE.
    refetchHistory();
    // Signal to the server to stream high-volume events for THIS session
    // on the multiplexed SSE. The SSE doesn't close / doesn't reopen —
    // it's just a POST that changes the filter on the server side. The
    // streamKey (bumped after doResume) triggers refetch + re-focus.
    setFocus(sessionId);

    // Flush assistant buffer: creates a full 'assistant' message and resets.
    // Called before any event that interrupts the text (tool_use, thinking,
    // permission_request, user_question, exit_plan_request, stop).
    const flushAssistantBuf = () => {
      // Cancel a pending RAF — we flush immediately.
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

    // Schedule a flush of the streaming preview via RAF. Coalesces deltas
    // arrived in the same frame into a single setState.
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
          // `'killed'` is no longer a persistent DB state (cf. CLAUDE.md §10):
          // it's a **transient signal** emitted by the server when the session
          // has just been deleted (DB cascade done). The caller wants a
          // redirect (navigation out of the session). We trigger `onKilled`
          // and don't touch the local status to avoid re-rendering a UI
          // that will be unmounted right after.
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

    // Wire the handler to the global stream for this sessionId. The singleton
    // module guarantees we only pay for ONE EventSource for the whole browser.
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

  // Refetch when the tab comes back to the foreground (case: backend restart
  // while we were in the background → empty SSE ring, DB = source).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetchHistory();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refetchHistory]);

  // Refetch on SSE reconnect (= the EventSource connection was
  // re-established after a drop, typically after a `systemctl restart
  // charon`). The SSE itself is live-only on the Charon side — messages
  // persisted in the DB during the gap are never relayed. Without this
  // refetch, the UI stays frozen on the last pre-drop state, the user
  // had to refresh by hand (cf. CLAUDE.md §14 gotcha 24).
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
      // Bump streamKey → useEffect closes the old SSE, reloads history,
      // re-attaches handlers. Avoids the UI being stuck on the post-sleep
      // state while the session has restarted on the agent side.
      setStreamKey((k) => k + 1);
    } catch (e) {
      setStatus('sleeping');
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // Permanent deletion (DB cascade on the server side). The `onKilled` callback
  // is kept as-is for post-deletion navigation (mobile: back to /m/select).
  // No confirm() here — it's up to the caller to ask for confirmation before
  // calling the action.
  const doDelete = useCallback(async () => {
    try {
      await api.deleteClaudeSession(sessionId);
      onKilledRef.current?.();
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // Pessimistic acks: we wait for the POST OK before removing the card from
  // the queue. Before, it was optimistic — if the POST failed, the card
  // disappeared but the backend had recorded nothing; on reload it would
  // reappear and the user thought history was broken. Now: POST OK → the
  // queue empties via the `interaction_resolved` event that comes back in
  // SSE (or at worst at the next refetch). POST KO → the card stays, error
  // shown.
  const respondPermission = useCallback(async (permId: string, allow: boolean, always = false) => {
    try {
      await api.respondClaudePermission(sessionId, permId, allow, always);
      // Removal arrives via `interaction_resolved` SSE. Fallback in case the
      // SSE is down: we remove locally (and the server won't send back anything
      // we don't already treat as a no-op via the filter by id).
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
