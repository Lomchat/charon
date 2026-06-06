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
import type { ClaudeSessionDetailResponse, ClaudeSessionMessageWindow, ClaudeEffortLevel } from '@/lib/types/api';
import { subscribeSession, setFocus, subscribeReconnect } from './globalEventStream';

// Compare two interaction-queue snapshots by id sequence. Returns true if
// `a` and `b` reference the same set of items in the same order. Used to
// skip re-renders when the polling delta returns the same pendings list.
function sameQueueById<T extends { id: string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

// Merge a freshly-rebuilt edits Map (from a full reload) into the current one
// WITHOUT losing already-loaded diff content.
//
// Since the bandwidth fix (CLAUDE.md §14 gotcha 41) the session GET strips
// edit_snapshot content, so `rebuildStateFromMessages` produces edits whose
// before/after are null — a skeleton listing WHICH files changed, with no
// content. The actual content is fetched separately (loadEdits → /edits) or
// arrives live (edit_snapshot SSE, which DOES carry content). A full reload
// (poll clean-reload, reconnect, tab return) must therefore NOT clobber the
// content we already have with the reload's null skeleton.
//
// Rules:
//   - For each file in the rebuilt skeleton: if we already hold loaded content
//     (before or after non-null), keep it (refresh only the `truncated` flag);
//     otherwise take the skeleton entry (loadEdits will fill it).
//   - Preserve files we loaded earlier that fell outside the current window
//     (the window only carries snapshots near the last 200 chat messages).
//
// Trade-off: a file edited AGAIN while the SSE is down shows its PREVIOUS diff
// until the next mount (the reload skeleton can't tell us the content changed,
// and we keep the old content rather than blank it). Acceptable — the live SSE
// path keeps it current in the common case, and it self-heals on remount.
function mergeEdits(
  prev: Map<string, EditSnapshot>,
  rebuilt: Map<string, EditSnapshot>,
): Map<string, EditSnapshot> {
  const next = new Map<string, EditSnapshot>();
  for (const [k, v] of rebuilt) {
    const old = prev.get(k);
    if (old && (old.before != null || old.after != null)) {
      next.set(k, { ...old, truncated: old.truncated || v.truncated });
    } else {
      next.set(k, v);
    }
  }
  for (const [k, v] of prev) {
    if (!next.has(k)) next.set(k, v);
  }
  return next;
}

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
  // Per-session Claude model / fallback / effort. null = inherit the global
  // default (claudeSettings.claude.default_*). Updated by `model_changed` /
  // `effort_changed` SSE events; mirrored in DB. `pendingApply` flips to
  // true on a setModel/setEffort call against a live SDK client — the change
  // is queued and applies on next sleep+resume. UI should label it as deferred.
  model: string | null;
  fallbackModel: string | null;
  effort: ClaudeEffortLevel | null;
  modelPendingApply: boolean;
  effortPendingApply: boolean;
  // Model id Anthropic actually used on the last assistant turn. Updated by
  // `effective_model` SSE + by applyApiData on mount/refetch. Null when the
  // agent is < 0.6.0 (no event) or no turn has happened since attach.
  // Independent of the `model` field above which is the user's CONFIGURED
  // value. The two can legitimately differ (alias resolution, fallback).
  effectiveModel: string | null;
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
  /**
   * Change the model (and optionally the fallback) for this session.
   * Takes effect at NEXT SDK start — the SDK binds the model at construction
   * time and cannot swap mid-flight. The UI should announce this (badge
   * with "applies on resume"). Pass null to clear back to the global default.
   */
  setModel(model: string | null, fallbackModel?: string | null): Promise<void>;
  /** Change the effort level. Same deferred-apply semantics as setModel. */
  setEffort(effort: ClaudeEffortLevel | null): Promise<void>;
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
  // Per-session model / fallback / effort. Initialized from the DB row via
  // applyApiData; updated by `model_changed` / `effort_changed` SSE events.
  // null on either field means "inherit the global default".
  const [model, setModelState] = useState<string | null>(null);
  const [fallbackModel, setFallbackModelState] = useState<string | null>(null);
  const [effort, setEffortState] = useState<ClaudeEffortLevel | null>(null);
  // True while a setModel/setEffort change is queued but not yet applied
  // (live SDK client exists → takes effect at next sleep+resume). Reset on
  // the next start (status flips back to 'starting' → 'active'). The UI
  // uses this to render a "applies on resume" hint next to the badge.
  const [modelPendingApply, setModelPendingApply] = useState(false);
  const [effortPendingApply, setEffortPendingApply] = useState(false);
  // Effective model — what Anthropic actually billed for the last turn.
  // Initialized from r.effectiveModel via applyApiData; updated by the
  // effective_model SSE on every change. See ClaudeSessionStreamState.
  const [effectiveModel, setEffectiveModel] = useState<string | null>(null);
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

  // (banner-state work removed — replaced by auto-reload-on-recovery in
  // globalEventStream.ts. When the SSE silence > AUTO_RELOAD_THRESHOLD_MS
  // and then recovers, the page hard-reloads — exactly what the user does
  // manually with F5. cf. CLAUDE.md §14 gotcha 24.)

  // streamKey: bump to force re-creation of the SSE (used after
  // doResume — the session restarted and we want a fresh SSE).
  const [streamKey, setStreamKey] = useState(0);

  const assistantBufRef = useRef('');
  // RAF batch for assistant_text deltas. Without it, each token =
  // setCurrentAssistant = subtree re-render. At 100 tokens/sec, it lags.
  // With RAF, we cap at 60Hz, the browser rate-limits on its own.
  const assistantFlushRafRef = useRef<number | null>(null);

  // Tokens for optimistically-rendered user messages. `send` pushes the
  // trimmed content before the POST so the bubble + 'thinking' pill appear
  // instantly; the matching `user_echo` SSE event (which the server
  // broadcasts before the SSH round-trip) is then suppressed to avoid a
  // duplicate. FIFO-by-content (indexOf, not shift) so it stays correct
  // under out-of-order delivery and repeated identical messages.
  const pendingUserEchoRef = useRef<string[]>([]);

  // ── Polling delta state ────────────────────────────────────────────────
  // Highest DB message id we have ever seen for this session. Used as the
  // cursor for the `?since=<id>` delta poll. Updated by applyApiData
  // (initial / full refetch) and by applyDelta (incremental). Polling at
  // 5s is the safety net: even if the SSE silently dies, even if React 19
  // tears down our subscribers via hydration recovery, even if onerror is
  // never fired — the polling loop independently catches up. Together with
  // SSE we have defense in depth (SSE = fast, polling = guaranteed).
  // cf. CLAUDE.md §14 gotcha 24.
  const lastSeenServerIdRef = useRef<number>(0);
  // Whether the initial full load (applyApiData) has succeeded at least
  // once. Distinct from `lastSeenServerId !== 0` because an empty session
  // legitimately has cursor 0 yet must still be polled (so new messages
  // arrive). Until this is true, the safety loop does a full refetch
  // instead of a delta poll. cf. CLAUDE.md §14 gotcha 24.
  const initialLoadDoneRef = useRef<boolean>(false);
  // Guard against concurrent polls. The setInterval fires every 5s but a
  // very slow network could delay a fetch beyond 5s — we don't want to
  // stack pending polls.
  const inflightPollRef = useRef<boolean>(false);
  // AbortController of the in-flight poll, so wake-up handlers can cancel
  // a request that hung while the device was asleep and start fresh.
  const pollAbortRef = useRef<AbortController | null>(null);

  // ── Lazy edit-content loading state (CLAUDE.md §14 gotcha 41) ────────────
  // The session GET strips edit_snapshot content; the diff content is fetched
  // separately, on demand, by loadEdits → GET /edits. These guard that fetch.
  const editsLoadInflightRef = useRef(false);
  // file_paths we already attempted to load but couldn't fill (budget-dropped
  // server-side, or a genuinely empty snapshot) — so the auto-load effect
  // doesn't retry them forever.
  const editsLoadAttemptedRef = useRef<Set<string>>(new Set());

  // ── Apply an API payload to local state ────────────────────────────────
  // Full refresh path — used by refetchHistory (initial mount, switch,
  // explicit resync). Replaces local state entirely. For incremental
  // updates (polling), see applyDelta below.
  const applyApiData = useCallback((r: ClaudeSessionDetailResponse) => {
    if (!r?.session) return;
    const rebuilt = rebuildStateFromMessages(r.messages, (r.liveStatus ?? r.session.status) as WorkerStatus);
    // Streaming preview reconciliation. applyApiData runs on the initial
    // load AND on every poll-triggered clean reload (which can happen every
    // 5s during active SSE streaming). We must NOT rewind a smoothly-
    // streaming preview to an older server snapshot:
    //   - server text >= local buffer → adopt (caught up / ahead; the
    //     common case since the server processes deltas before forwarding
    //     them to us).
    //   - server text shorter (flushed to a persisted message, or briefly
    //     behind) → if the latest reloaded assistant message already
    //     contains our buffered text, the buffer was flushed: clear it to
    //     avoid showing the preview twice. Otherwise keep our buffer (SSE
    //     is mid-stream, server hasn't persisted yet) — don't rewind.
    const streamingText = String(r.streamingText ?? '');
    if (streamingText.length >= assistantBufRef.current.length) {
      assistantBufRef.current = streamingText;
      setCurrentAssistant(streamingText);
    } else {
      const buf = assistantBufRef.current;
      const lastAsst = [...rebuilt.messages].reverse().find((m) => m.role === 'assistant');
      if (lastAsst && (lastAsst.content === buf || lastAsst.content.startsWith(buf))) {
        assistantBufRef.current = '';
        setCurrentAssistant('');
      }
      // else: keep the local buffer, don't rewind.
    }
    setMessages(rebuilt.messages);
    setStatus(rebuilt.status);
    setToolCalls(rebuilt.toolCalls);
    setTodos(rebuilt.todos);
    // Merge (not replace): the rebuilt edits carry no content (the GET strips
    // edit_snapshot content — CLAUDE.md §14 gotcha 41). Keep already-loaded
    // diff content; the auto-load effect refills any stripped skeletons.
    setEdits((prev) => mergeEdits(prev, rebuilt.edits));
    setFiles(rebuilt.files);
    setPermissionMode(
      (['normal', 'acceptEdits', 'auto', 'plan'] as const).includes(
        r.session?.permissionMode as PermissionMode,
      ) ? (r.session.permissionMode as PermissionMode) : 'normal',
    );
    // Initialize model / fallback / effort from the DB row. The session row
    // schema includes these columns (cf. lib/db/schema.ts § claudeSessions);
    // ClaudeSession (= typeof claudeSessions.$inferSelect) carries them
    // transitively. Effort is validated to keep TS happy; the DB column is a
    // free TEXT but server-side writes already filter.
    const sess = r.session as typeof r.session & { model?: string | null; fallbackModel?: string | null; effort?: string | null };
    setModelState(sess.model ?? null);
    setFallbackModelState(sess.fallbackModel ?? null);
    const validEffortValues: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    setEffortState(
      (validEffortValues as readonly string[]).includes(sess.effort ?? '')
        ? (sess.effort as ClaudeEffortLevel) : null,
    );
    // Full refetch = the session was reloaded from DB → any pending-apply
    // marker from a previous resume cycle is now stale (either applied or
    // moot). Clear so the UI doesn't show "applies on resume" forever.
    setModelPendingApply(false);
    setEffortPendingApply(false);
    // Effective model is in the GET payload (from peekStream().effectiveModel
    // server-side). Null on first attach (no turn yet) or on old agents. The
    // SSE will deliver it on the next turn either way.
    setEffectiveModel(r.effectiveModel ?? null);
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
    // Update polling cursor. Prefer the server's authoritative
    // `maxMessageId` (true max across ALL roles) over the max id of the
    // returned window — the window can exclude trailing edit_snapshot/event
    // rows, and using the window max made the delta poll return the same
    // rows forever (cursor stuck). MONOTONIC: never let the cursor go
    // backwards (a stale/cached response must not rewind it).
    let maxId = lastSeenServerIdRef.current;
    const serverMax = typeof r.maxMessageId === 'number' ? r.maxMessageId : 0;
    if (serverMax > maxId) maxId = serverMax;
    for (const m of (r.messages ?? []) as { id: number }[]) {
      if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
    }
    lastSeenServerIdRef.current = maxId;
    // The initial load has produced data → the polling loop can switch
    // from "full refetch" to "delta poll" (even if maxId is still 0 for an
    // empty session).
    initialLoadDoneRef.current = true;
  }, []);

  // ── Apply a polling DELTA to local state ───────────────────────────────
  // ⚠ CURRENTLY UNUSED (kept for reference / possible future re-enable).
  // The polling loop no longer merges deltas incrementally — it does a
  // CLEAN full `refetchHistory()` whenever the cheap `?since=` probe reports
  // new rows (see `pollDelta`). Incremental merging here proved fragile
  // (duplicate React keys, partial tool pairs → render throw → error-
  // boundary remount loop). The full reload is what "hitting refresh" does
  // and is corruption-proof. If you re-enable this, fix the dedup first.
  // cf. CLAUDE.md §14 gotcha 24.
  //
  // Only handles messages with id > lastSeenServerIdRef. Crucial properties:
  //   - Idempotent: if a row was already added locally by an SSE event,
  //     we detect the duplicate by (role,content) match and upgrade the
  //     synthetic local id ('a...'/'tu...'/etc.) to the DB-derived id
  //     ('m<dbid>'). No visible duplicate.
  //   - No flicker: we only setState when something actually changes.
  //   - Append-only for messages and toolCalls. Edits/todos/files are
  //     merged.
  //   - Live state (status, mode, streaming text, pendings) is updated
  //     too, since pollDelta is also our way of catching status drift if
  //     the SSE missed an event.
  // Returns true if the delta contained anything new (used for
  // observability / future "did poll catch anything" stats).
  const applyDelta = useCallback((r: ClaudeSessionDetailResponse): boolean => {
    if (!r?.session) return false;
    // Cheap live-state updates (no-op if unchanged).
    setSessionMeta((prev) => (prev?.id === r.session.id ? r.session : (prev ?? r.session)));
    const newStatus = (r.liveStatus ?? r.session.status) as WorkerStatus;
    setStatus((prev) => (prev === newStatus ? prev : newStatus));
    const newMode = (['normal', 'acceptEdits', 'auto', 'plan'] as const).includes(
      r.session?.permissionMode as PermissionMode,
    ) ? (r.session.permissionMode as PermissionMode) : 'normal';
    setPermissionMode((prev) => (prev === newMode ? prev : newMode));
    // Streaming text from the server — only adopt it if local is empty
    // (we're between flushes) or if server's is longer (we missed deltas).
    // This avoids "regression flicker" where the server's snapshot is a
    // few tokens behind the SSE we just received locally.
    const serverStreamingText = String(r.streamingText ?? '');
    if (serverStreamingText.length > assistantBufRef.current.length) {
      assistantBufRef.current = serverStreamingText;
      setCurrentAssistant(serverStreamingText);
    } else if (serverStreamingText.length === 0 && assistantBufRef.current.length > 0) {
      // Server has flushed (streamingText empty, the assistant_text is
      // now a persisted message). If our local buffer is still non-empty
      // AND the persisted message will be in the delta (we'll see it
      // below as a new row matching our buf), the buffer is safe to clear.
      // BUT only if the corresponding row is in the delta — if it isn't,
      // we'd lose the streaming preview. We detect the match below and
      // clear at the end of applyDelta (see `clearBufAfterMerge`).
    }
    // Pendings: replace if the count or contents differ.
    const sid = r.session.id;
    const newPerms = ((r.pendingPermissions ?? []) as Omit<PermissionRequest, 'sessionId'>[])
      .map((p) => ({ ...p, sessionId: sid }));
    setPermQueue((prev) => sameQueueById(prev, newPerms) ? prev : newPerms);
    const newQs = ((r.pendingQuestions ?? []) as Omit<PendingQuestion, 'sessionId'>[])
      .map((q) => ({ ...q, sessionId: sid }));
    setQuestionQueue((prev) => sameQueueById(prev, newQs) ? prev : newQs);
    const newExits = ((r.pendingExitPlans ?? []) as Omit<PendingExitPlan, 'sessionId'>[])
      .map((e) => ({ ...e, sessionId: sid }));
    setExitPlanQueue((prev) => sameQueueById(prev, newExits) ? prev : newExits);

    const rows = (r.messages ?? []) as { id: number }[];
    if (rows.length === 0) return false;

    // Advance the cursor BEFORE applying so the next poll won't re-fetch
    // the same rows even if a setState below throws.
    let maxId = lastSeenServerIdRef.current;
    for (const m of rows) {
      if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
    }
    lastSeenServerIdRef.current = maxId;

    const rebuilt = rebuildStateFromMessages(r.messages, newStatus);
    let anythingChanged = false;

    // ── Phantom-buffer detection ─────────────────────────────────────
    // Scenario: the SSE dropped mid-stream, `stop` never reached us, so
    // `flushAssistantBuf` never ran. `assistantBufRef.current` still holds
    // the partial response and `setCurrentAssistant` is rendering it.
    // Meanwhile the server has long since persisted the final assistant
    // message (visible in this delta) AND cleared its streamingText.
    // Without the clear below, we'd display the finalized DB message AND
    // the in-flight buffer in parallel — a "phantom" duplicate.
    //
    // Trigger: server has no in-flight stream (`serverStreamingText` empty)
    // AND a new assistant row in this delta starts with our buf as a
    // prefix (exact match if SSE dropped at a clean boundary; prefix
    // match if SSE delivered the buf's tokens but missed the tail before
    // dropping). We use prefix to catch both shapes — a false positive
    // here would just clear a buf that's about to be flushed anyway by
    // the next SSE event.
    let shouldClearBufAfterMerge = false;
    if (serverStreamingText.length === 0 && assistantBufRef.current.length > 0) {
      const buf = assistantBufRef.current;
      for (const m of rebuilt.messages) {
        if (m.role === 'assistant' && typeof m.content === 'string' &&
            (m.content === buf || m.content.startsWith(buf))) {
          shouldClearBufAfterMerge = true;
          break;
        }
      }
    }

    // ── messages: append new, dedup against SSE-added local copies ────
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => String(m.id)));
      // Local SSE-added messages may shortly afterward also appear in the
      // delta as DB rows. We dedup by (role,content). For text-heavy
      // assistant messages the content match is exact (we flushed
      // exactly what was in the SSE buffer). For tool_use/tool_result
      // the JSON.stringify is also deterministic.
      const localContentToId = new Map<string, string>();
      for (const m of prev) {
        const idStr = String(m.id);
        if (!idStr.startsWith('m')) {
          localContentToId.set(`${m.role}|${m.content}`, idStr);
        }
      }
      const newMsgs: typeof rebuilt.messages = [];
      const idsToRename = new Map<string, string>();
      for (const m of rebuilt.messages) {
        const idStr = String(m.id);
        if (existingIds.has(idStr)) continue; // already in via earlier delta or initial load
        const localHash = `${m.role}|${m.content}`;
        const localId = localContentToId.get(localHash);
        if (localId) {
          // SSE got there first — upgrade the local id to the DB-backed one.
          idsToRename.set(localId, idStr);
          localContentToId.delete(localHash); // each local msg matches one DB row
          continue;
        }
        newMsgs.push(m);
      }
      if (newMsgs.length === 0 && idsToRename.size === 0) return prev;
      anythingChanged = true;
      let result = idsToRename.size > 0
        ? prev.map((m) => {
            const newId = idsToRename.get(String(m.id));
            return newId ? { ...m, id: newId } : m;
          })
        : prev;
      if (newMsgs.length > 0) result = [...result, ...newMsgs];
      return result;
    });

    // ── toolCalls: append new ────────────────────────────────────────
    if (rebuilt.toolCalls.length > 0) {
      setToolCalls((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const additions = rebuilt.toolCalls.filter((c) => !existingIds.has(c.id));
        if (additions.length === 0) return prev;
        anythingChanged = true;
        return [...prev, ...additions];
      });
    }

    // ── todos: replace if there were any todo_update events in the delta ──
    // rebuildStateFromMessages only sets `todos` if it saw a todo_update;
    // an empty array means "no update in this batch" — keep the current.
    if (rebuilt.todos.length > 0) {
      setTodos((prev) => {
        if (prev.length === rebuilt.todos.length &&
            prev.every((t, i) => t.content === rebuilt.todos[i].content && t.status === rebuilt.todos[i].status)) {
          return prev;
        }
        anythingChanged = true;
        return rebuilt.todos;
      });
    }

    // ── edits: merge, but never overwrite a live edit with an older one ──
    if (rebuilt.edits.size > 0) {
      setEdits((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const [k, v] of rebuilt.edits) {
          const cur = next.get(k);
          if (!cur) { next.set(k, v); changed = true; continue; }
          // Merge before/after: take whichever the existing entry is missing.
          let updated = cur;
          if (cur.before == null && v.before != null) {
            updated = { ...updated, before: v.before, truncated: updated.truncated || v.truncated };
          }
          if (cur.after == null && v.after != null) {
            updated = { ...updated, after: v.after, truncated: updated.truncated || v.truncated };
          }
          if (updated !== cur) {
            next.set(k, updated);
            changed = true;
          }
        }
        if (changed) anythingChanged = true;
        return changed ? next : prev;
      });
    }

    if (rebuilt.files.size > 0) {
      setFiles((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const f of rebuilt.files) {
          if (!next.has(f)) { next.add(f); changed = true; }
        }
        if (changed) anythingChanged = true;
        return changed ? next : prev;
      });
    }

    // Clear the phantom streaming preview if we detected a matching
    // persisted message above. We do this AFTER the setMessages so the
    // new assistant row is visible in the same render cycle as the buf
    // disappearing (no flash of "nothing while we waited for the row").
    if (shouldClearBufAfterMerge) {
      assistantBufRef.current = '';
      setCurrentAssistant('');
      anythingChanged = true;
    }

    return anythingChanged;
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

  // ── Lazy edit-content loader (CLAUDE.md §14 gotcha 41) ──────────────────
  // Fetches the latest before/after content per file from the dedicated
  // /edits endpoint and fills the (content-stripped) skeleton entries for
  // `targetPaths`. Only fills entries that are currently unloaded so it never
  // clobbers live edit_snapshot SSE content. Marks any file it couldn't fill
  // as "attempted" so the auto-load effect terminates.
  const loadEdits = useCallback(async (targetPaths: string[]) => {
    if (editsLoadInflightRef.current) return;
    if (targetPaths.length === 0) return;
    editsLoadInflightRef.current = true;
    try {
      const r = await api.getClaudeSessionEdits(sessionId);
      const byPath = new Map(r.edits.map((e) => [e.filePath, e] as const));
      setEdits((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const path of targetPaths) {
          const cur = next.get(path);
          // Skip if gone, or already loaded/filled live in the meantime.
          if (!cur || cur.before != null || cur.after != null) continue;
          const got = byPath.get(path);
          if (got && (got.before != null || got.after != null)) {
            next.set(path, {
              ...cur,
              before: got.before,
              after: got.after,
              truncated: cur.truncated || got.truncated,
              toolUseId: got.toolUseId || cur.toolUseId,
            });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Anything we asked for but couldn't fill (absent from the response or
      // budget-dropped → null content) is marked attempted, so we don't loop.
      for (const path of targetPaths) {
        const got = byPath.get(path);
        if (!got || (got.before == null && got.after == null)) {
          editsLoadAttemptedRef.current.add(path);
        }
      }
    } catch {
      // Transient (network / 503). Leave `attempted` untouched so the next
      // edits change retries. Silent — the diffs tab is non-critical UI.
    } finally {
      editsLoadInflightRef.current = false;
    }
  }, [sessionId]);

  // ── Delta poll (safety-net loop) ───────────────────────────────────────
  // Independent of the SSE: fetches `GET ?since=<lastSeenServerId>` and
  // applies the delta. Designed to be cheap when nothing changed (most
  // calls return an empty messages array). Coexists with the SSE-driven
  // live updates: SSE is the fast path (sub-second latency), polling is
  // the floor guarantee (max staleness = poll interval = 5s).
  //
  // Why both? Because the SSE has historically been fragile:
  //   - The browser's EventSource may close permanently on a non-200
  //     response from the reverse proxy (CLAUDE.md §14 gotcha 24).
  //   - Hydration errors in React 19 can re-render the entire root,
  //     tearing down our subscribeReconnect listeners.
  //   - Network blips, mobile sleep, proxy buffering, etc.
  // Polling makes ALL of these failure modes self-healing: even if every
  // SSE-related fix breaks tomorrow, the user still sees new messages
  // within 5s. cf. CLAUDE.md §14 gotcha 24.
  const pollDelta = useCallback(async () => {
    if (inflightPollRef.current) return;
    // Skip background tabs to save battery — visibilitychange handler
    // will trigger an immediate catch-up poll when the tab returns.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    // Skip when the browser knows it's offline — pointless to fire a
    // request that will immediately ERR_NETWORK. The `online` event
    // handler force-polls the moment connectivity returns.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    // Don't poll before the initial full load has completed — a delta
    // before we know the cursor would either pull the whole history
    // (since=0) or miss the window. safetyTick does the full refetch in
    // that state; once it's done we switch to cheap deltas.
    if (!initialLoadDoneRef.current) return;
    const since = lastSeenServerIdRef.current;
    inflightPollRef.current = true;
    const ac = new AbortController();
    pollAbortRef.current = ac;
    try {
      const r = await api.pollClaudeSessionSince(sessionId, since, ac.signal) as ClaudeSessionDetailResponse;
      const n = r?.messages?.length ?? 0;
      if (n > 0) {
        // Something new on the server. Rather than incrementally merge the
        // delta into local state (which historically produced corrupted
        // state — duplicate React keys, partial tool pairs — that threw
        // during render and looped the error boundary), we do a CLEAN FULL
        // RELOAD: exactly what hitting F5 does, but without losing the SSE
        // or scroll. `refetchHistory` → `applyApiData` →
        // `rebuildStateFromMessages` rebuilds the whole chat from scratch
        // and sets the cursor to the authoritative `maxMessageId`, so the
        // next poll returns 0. cf. CLAUDE.md §14 gotcha 24.
        if (typeof console !== 'undefined') {
          // eslint-disable-next-line no-console
          console.info(`[charon] poll ${sessionId.slice(0, 8)}: +${n} row(s) since ${since} → clean reload`);
        }
        await refetchHistory();
      }
    } catch (e) {
      // Network errors are silent — the next tick will retry. We don't
      // want to surface a banner each time the user drops Wi-Fi for 2s.
      // One exception: 404 means the session was deleted server-side
      // (could be SSE-missed, especially if the SSE is currently down).
      // Trigger the same onKilled path so the parent navigates away.
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes('→ 404')) {
        onKilledRef.current?.();
      }
    } finally {
      if (pollAbortRef.current === ac) pollAbortRef.current = null;
      inflightPollRef.current = false;
    }
  }, [sessionId, refetchHistory]);

  // safetyTick: the unit of work the 5s loop runs. SELF-SUFFICIENT — it
  // does NOT depend on the SSE or on the mount-time refetch ever
  // succeeding:
  //   - cursor not yet set (lastSeenServerId === 0): the initial full load
  //     either hasn't completed or FAILED (e.g. it raced a Charon restart
  //     and 503'd). Do a full refetch here — that sets the cursor. Without
  //     this, a failed initial load left polling permanently disabled
  //     (pollDelta bails on since===0), so the chat stayed frozen until
  //     F5 even though the loop was "running".
  //   - cursor set: cheap delta poll.
  const safetyTick = useCallback(() => {
    if (!initialLoadDoneRef.current) {
      refetchHistory();
    } else {
      pollDelta();
    }
  }, [refetchHistory, pollDelta]);

  // Force an immediate sync, cancelling any in-flight poll. Used by the
  // wake-up handlers (online / visibilitychange): a poll that was issued
  // before the device slept may still be "in flight" (hung socket), which
  // would block the inflight guard. We abort it and start clean so the
  // user sees fresh data within ~1s of waking, not after the hung
  // request's 12s timeout.
  const forcePoll = useCallback(() => {
    if (pollAbortRef.current) {
      try { pollAbortRef.current.abort(); } catch {}
      pollAbortRef.current = null;
    }
    inflightPollRef.current = false;
    safetyTick();
  }, [safetyTick]);

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
        case 'user_echo': {
          // If we already rendered this message optimistically in `send`,
          // suppress the echo (consume its token) to avoid a duplicate.
          // Echoes without a token (e.g. a message sent from another tab or
          // device) fall through and append as before.
          const tokenIdx = pendingUserEchoRef.current.indexOf(ev.content);
          if (tokenIdx >= 0) {
            pendingUserEchoRef.current.splice(tokenIdx, 1);
            break;
          }
          setMessages((prev) => [...prev, {
            id: 'u' + Date.now() + Math.random(), role: 'user',
            content: ev.content, createdAt: ev.createdAt,
          }]);
          break;
        }
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
        case 'model_changed':
          setModelState(ev.model ?? null);
          setFallbackModelState(ev.fallbackModel ?? null);
          // appliedAtNextStart=true means a live SDK client exists and the
          // change is queued. The next sleep+resume cycle clears the flag
          // (applyApiData resets it on full reload).
          setModelPendingApply(!!ev.appliedAtNextStart);
          break;
        case 'effort_changed': {
          // Defensive cast: the wire type is EffortLevel|null but the
          // backend's isValidEffort already filtered invalid strings.
          const e = ev.effort;
          const valid: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
          setEffortState((valid as readonly (string | null)[]).includes(e) ? e : null);
          setEffortPendingApply(!!ev.appliedAtNextStart);
          break;
        }
        case 'effective_model':
          // What Anthropic actually used this turn. Always trustworthy
          // (extracted from AssistantMessage.model). Display in the badge
          // when it differs from the configured `model` field.
          if (typeof ev.model === 'string' && ev.model.length > 0) {
            setEffectiveModel(ev.model);
          }
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
      // Belt-and-suspenders: trigger BOTH a refetch (replaces local
      // state) AND a poll (incremental, catches anything refetch missed
      // due to a race). The poll is idempotent so the cost is one
      // extra HTTP roundtrip with empty body.
      refetchHistory();
      pollDelta();
    });
    return () => unsub();
  }, [refetchHistory, pollDelta]);

  // ── Polling safety-net loop ────────────────────────────────────────────
  // Always-on: every 5s the hook polls the server for any messages with
  // id > lastSeenServerId. Independent of the SSE — if everything else
  // fails (SSE dead, subscribeReconnect listeners torn down, React
  // hydration error wreaking havoc), this loop alone keeps the chat in
  // sync within 5s. The poll is cheap (typically returns 0 messages) and
  // setState calls are guarded inside applyDelta to only fire when state
  // actually changes — no spurious re-renders.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // First tick fires immediately after mount (not 5s later) so resync
    // happens on session switch / tab return without waiting for the
    // first interval. safetyTick is self-sufficient (full refetch when the
    // cursor isn't set yet, delta otherwise).
    safetyTick();
    const id = setInterval(safetyTick, 5_000);
    return () => clearInterval(id);
  }, [safetyTick]);

  // ── Auto-load stripped diff content (CLAUDE.md §14 gotcha 41) ────────────
  // The session GET strips edit_snapshot content, so a full reload leaves the
  // edits Map with content-less skeleton entries (before == after == null).
  // Whenever such entries appear, fetch their content from /edits. The
  // `attempted` set bounds this to one fetch per file (no infinite retry on
  // budget-dropped / empty snapshots). Live edit_snapshot SSE events already
  // carry content, so they never enter this path.
  useEffect(() => {
    const unloaded: string[] = [];
    for (const [k, v] of edits) {
      if (v.before == null && v.after == null && !editsLoadAttemptedRef.current.has(k)) {
        unloaded.push(k);
      }
    }
    if (unloaded.length === 0) return;
    loadEdits(unloaded);
  }, [edits, loadEdits]);

  // Immediate catch-up poll on tab focus / network online — don't wait
  // 5s after the user obviously expects the latest state. Use forcePoll
  // (not pollDelta) so a request that hung while the device slept is
  // aborted and replaced immediately rather than blocking the inflight
  // guard until its 12s timeout.
  //
  // The `window` 'focus' listener is what fixes the notification-click case:
  // clicking a web-push notification calls `client.focus()` in the service
  // worker, which refocuses the browser WINDOW. If the Charon tab was
  // already the active tab (just the window was unfocused — second monitor,
  // another app on top), `visibilityState` never left 'visible', so
  // `visibilitychange` does NOT fire and nothing refetched — the pending
  // question (which arrived live while we weren't looking, or was missed by
  // a throttled SSE) stayed invisible until a manual refresh. 'focus' fires
  // in that case and force-polls, pulling the pending interaction from the DB.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') forcePoll();
    };
    const onOnline = () => forcePoll();
    const onFocus = () => forcePoll();
    // Explicit signal: a notification was clicked targeting a session.
    // ClaudePanel dispatches this on the SW `open-session` message. If it's
    // for THIS session, force an immediate resync (covers the case where the
    // hook was already mounted for this session but missed the live SSE
    // event — e.g. the window was focused the whole time so neither 'focus'
    // nor 'visibilitychange' fired).
    const onNotifOpen = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sid || sid === sessionId) forcePoll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    window.addEventListener('charon:notif-open', onNotifOpen as EventListener);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('charon:notif-open', onNotifOpen as EventListener);
    };
  }, [forcePoll, sessionId]);

  // ── Actions ────────────────────────────────────────────────────────────
  const send = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // Optimistic UI: render the user's bubble + flip the status pill to
    // 'thinking' immediately, instead of waiting for the user_echo / status
    // SSE to round-trip through the remote VPS agent. The token lets the
    // user_echo handler suppress the (now-redundant) echo; the 5s delta poll
    // later upgrades the synthetic 'u…' id to the DB-backed 'm<id>' via
    // applyDelta's (role,content) dedup.
    //
    // On failure we intentionally keep the bubble + token: the dominant
    // failure (the agent RPC throwing) happens AFTER the server has already
    // persisted the row and broadcast the echo, so the message IS real. A
    // genuinely-unsent phantom self-heals on the next full refetch
    // (applyApiData replaces wholesale from the DB) and a stale token is
    // reconciled by the poll. cf. CLAUDE.md §14 gotcha 24.
    pendingUserEchoRef.current.push(trimmed);
    setMessages((prev) => [...prev, {
      id: 'u' + Date.now() + Math.random(), role: 'user',
      content: trimmed, createdAt: Math.floor(Date.now() / 1000),
    }]);
    setStatus('thinking');
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
    const prev = permissionMode;
    setPermissionMode(mode); // optimistic — reconciled by the mode_changed SSE
    try { await api.setClaudeMode(sessionId, mode); }
    catch (e) {
      setPermissionMode(prev); // revert: the agent never applied the change
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId, permissionMode]);

  const setModel = useCallback(async (newModel: string | null, newFallbackModel: string | null = null) => {
    // Idempotency guard: skip the round-trip if both fields already match.
    // (Comparing both prevents a stale fallback from leaking when the user
    // sets only the primary.)
    if (newModel === model && newFallbackModel === fallbackModel) return;
    const prevModel = model;
    const prevFallback = fallbackModel;
    // Optimistic UI — the model_changed SSE will reconcile + set
    // modelPendingApply based on whether a live SDK client exists.
    setModelState(newModel);
    setFallbackModelState(newFallbackModel);
    try {
      await api.setClaudeSessionModel(sessionId, newModel, newFallbackModel);
    } catch (e) {
      setModelState(prevModel);
      setFallbackModelState(prevFallback);
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId, model, fallbackModel]);

  const setEffort = useCallback(async (newEffort: ClaudeEffortLevel | null) => {
    if (newEffort === effort) return;
    const prev = effort;
    setEffortState(newEffort);
    try {
      await api.setClaudeSessionEffort(sessionId, newEffort);
    } catch (e) {
      setEffortState(prev);
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId, effort]);

  const doSleep = useCallback(async () => {
    // Optimistic: the server marks the DB row 'sleeping' unconditionally
    // (even if the agent is unreachable — cf. sessionOps.sleepSession), so
    // flipping the pill now is always correct and saves the up-to-5s wait
    // for the agent's SDK teardown (session.py stop() awaits the in-flight
    // turn before the RPC returns).
    setStatus('sleeping');
    try {
      await api.sleepClaudeSession(sessionId);
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
    model, fallbackModel, effort, modelPendingApply, effortPendingApply,
    effectiveModel,
    toolCalls, todos, edits, files,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    send, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, loadMoreHistory, clearError,
  }), [
    sessionMeta, messages, currentAssistant, status, permissionMode,
    model, fallbackModel, effort, modelPendingApply, effortPendingApply,
    effectiveModel,
    toolCalls, todos, edits, files,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    send, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, loadMoreHistory, clearError,
  ]);
}
