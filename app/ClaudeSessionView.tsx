'use client';
import SessionSettingsModal from './SessionSettingsModal';
import { IconGear, IconPause, IconPlay, IconStop, IconRewind, IconGitBranch } from './icons';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';
import type { SessionListItem, AgentKind, SessionAttachment } from '@/lib/types/api';
import type { AccountUsage } from '@/lib/server/claude/types';
import {
  CODEX_SANDBOX_MODES, sessionCapabilities,
  type CodexSandboxMode, type SessionMode,
} from '@/lib/sessionCapabilities';
import { isTurnInterrupted } from '@/lib/turnInterrupted';
import { parseSessionError } from '@/lib/sessionError';
import { resolveResetAtMs } from '@/lib/rateLimitReset';
import Message, { type Msg, summarizeToolInput } from './Message';
import ToolPanel, { type Tab as ToolTab } from './ToolPanel';
import { refreshGit, useGitStatus, workspaceAheadBehind, workspaceDirtyCount } from './gitStore';
import BgTasksBar from './BgTasksBar';
import UsageMeter from './UsageMeter';
import QuestionCard from './QuestionCard';
import ExitPlanCard from './ExitPlanCard';
import ApprovalDeadline from './ApprovalDeadline';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan, ToolCallEntry,
} from './sessionTypes';
import { useAgentSessionStream, type StreamCache } from './useClaudeSessionStream';
import ModelPicker from './ModelPicker';
import EffortPicker from './EffortPicker';
import CodexModelPicker from './CodexModelPicker';
import CodexEffortPicker from './CodexEffortPicker';
import AgentLogo from './AgentLogo';
import ForkModal from './ForkModal';
import RewindModal from './RewindModal';

import {
  getCached, fetchAndCache, invalidate as invalidateCache,
  extendWithOlder as extendCacheWithOlder,
} from './sessionCache';
import { useInputDraft } from './inputDraftStore';
import { isPathDrag, readPathDrag } from './pathDrag';
import { IconInsert } from './fileIcons';
import {
  useSessionAttachments, type PendingUpload,
} from './sessionAttachments';
import { IconPaperclip } from './icons';
import { IconExternal } from './fileIcons';
import { shouldShowChatRole } from './chatVisibility';
import { canCompactSession } from './sessionInsightState';
import { useSessionContext } from './useSessionContext';
import HeaderContextGauge from './HeaderContextGauge';

// ClaudeSessionView
// ─────────────────────────────────────────────────────────────────────────────
// Component that renders the entire "active session" area of the desktop
// dashboard:
//   - Actions bar (sleep / resume / force-stop) — permanent; interrupt lives
//     beside the transient ThinkingBar label while a turn is running
//     deletion goes through the context menu (right-click on the sidebar),
//     not through a button in the bar (cf. kill→delete rework: only
//     `sleep` is reversible, everything else destroys)
//   - Reconnect / disconnect / error banner
//   - Scroll-reverse chat + scroll pill
//   - ThinkingBar during 'thinking'
//   - Input bar (mode switch + textarea + send) — replaced by
//     QuestionCard / ExitPlanCard / InlinePermissionCard when pending
//   - ToolPanel (diffs / calls / files)
//
// All SSE + per-session state logic lives in useClaudeSessionStream,
// so this component is essentially rendering + computeds.
//
// The parent (ClaudePanel) keeps: sidebar, global modals, push, service
// worker, cross-session permission popup, sessions list polling, etc.

type Props = {
  sessionId: string;
  selected: SessionListItem;
  /** Show technical transcript activity (tool calls/results, plans and
   * reasoning). False is a render-only conversation view. */
  showTools: boolean;
  /** This session's addressable handle (unique on its VPS). Shown in the
   *  header so the user knows what other agents type to reach it. */
  handle?: string | null;
  /** Kept for wire compatibility with older parents. New Charon handles are
   * durable DB identities and therefore always confirmed. */
  handleConfirmed?: boolean;
  /** Other sessions on the SAME machine — the ones this one can address.
   *  Feeds the `@` menu in the composer. */
  siblings?: Array<{ id: string; name: string | null; handle: string; confirmed?: boolean; status: string }>;
  selectedVps: Vps | null;
  // Opens the Claude sign-in modal for this session's VPS — handed down to
  // <Message> so a provider authentication-error bubble carries its own fix
  // (Claude hosted OAuth or Codex device-code login, §14.65/68).
  onReauth?: () => void;
  // Sound + native Notification handled by the parent (cross-session), but
  // we can still play a beep on stop if configured.
  notifSoundEnabled?: boolean;
  // Detection of "claude-agent-sdk not installed" error on the VPS → parent
  // opens an install session for this VPS (cf. ClaudePanel.openInstallSession).
  onImportError?: (vps: Vps) => void;
  // Post-kill navigation (parent setSelectedId(null) + refresh).
  onKilled: () => void;
  // After reverting a file edit → refresh parent's sessions list.
  onAfterRevert?: () => void;
  // Account-usage gauges for this session's VPS account (the header `/usage`
  // widget). Subscribed/held in ClaudePanel (account-scoped, LOW_VOLUME). §14.58.
  usage?: AccountUsage | null;
  onUsageRefresh?: () => void;
  // Opens the ToolPanel drawer on narrow screens (<=1100px it's hidden behind
  // a transform). Used by the git chip, which must reveal the panel it points
  // at — on desktop the panel is always visible and this is a no-op.
  onOpenTools?: () => void;
  /** Jump to another session, from the explorer's activity icons (§14.88). */
  // §14.78: opening something that was just CREATED must carry the created row
  // and pin it. A bare id loses the race against the session-list refresh, and
  // an unpinned tab is a preview the next preview evicts.
  onOpenSession?: (
    sessionId: string,
    hint?: { vpsId: string; cwd: string },
    pin?: boolean,
  ) => void;
};

// Module-side session cache — sessionCache.ts shared desktop/mobile.
// The StreamCache instance is created once, not per-render.
const sharedCacheRef: StreamCache = {
  get: (id) => getCached(id),
  fetch: (id, force) => fetchAndCache(id, force),
  invalidate: (id) => invalidateCache(id),
  extendWithOlder: (id, older) => extendCacheWithOlder(id, older),
};

export default function ClaudeSessionView({
  sessionId, selected, showTools, selectedVps, handle, handleConfirmed, siblings,
  onImportError, onKilled, onAfterRevert, usage, onUsageRefresh, onReauth,
  onOpenTools,
  onOpenSession,
}: Props) {
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const closeSessionSettings = useCallback(() => setSessionSettingsOpen(false), []);
  const stream = useAgentSessionStream(sessionId, {
    cache: sharedCacheRef,
    onKilled,
  });
  const {
    sessionMeta,
    messages, currentAssistant, status, permissionMode,
    model, fallbackModel, effort, modelPendingApply, effortPendingApply,
    effectiveModel, liveUsage,
    toolCalls, edits, bgTasks,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    send: streamSend, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doRestart,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, loadMoreHistory, setHistoryHold, clearError,
  } = stream;

  // Backend of this session (Claude vs Codex). Drives the mode selector
  // (permission modes vs sandbox levels), the model/effort pickers, the
  // per-message logo, the diff rendering, and whether a config change shows the
  // deferred "apply now ↻" badge (Codex applies on the next turn → no badge).
  const sessionKind: AgentKind = (selected.kind as AgentKind) === 'codex' ? 'codex' : 'claude';
  const vpsId = selectedVps?.id ?? '';
  const {
    context: sessionContext,
    loaded: contextLoaded,
    loading: contextLoading,
    refresh: refreshContext,
  } = useSessionContext(sessionId);
  const compactAllowed = canCompactSession(status);

  // ── Source control (§14.76) ───────────────────────────────────────────────
  // The repository chip below context opens the ToolPanel on the git tab (and reveals
  // the drawer on narrow screens). One-shot so the user can move tabs after.
  const [requestedToolTab, setRequestedToolTab] = useState<ToolTab | null>(null);
  const clearRequestedToolTab = useCallback(() => setRequestedToolTab(null), []);
  const openGitTab = useCallback(() => {
    setRequestedToolTab('git');
    onOpenTools?.();
  }, [onOpenTools]);

  // A finished turn is the moment an agent has just stopped writing files, so
  // it's the highest-value refresh there is — worth far more than a faster
  // background poll. Fires on the thinking → anything-else edge only.
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const was = prevStatusRef.current;
    prevStatusRef.current = status ?? null;
    if (was === 'thinking' && status !== 'thinking' && vpsId && selected.cwd) {
      refreshGit(vpsId, selected.cwd);
    }
    // Context telemetry changes once per model request, not on every streamed
    // token. Refresh on the authoritative lifecycle edge, including
    // starting→active after a resume. The initial null→status edge is skipped:
    // the hook already owns that first request for header + Tools.
    if (was !== null && was !== status && status
        && !['thinking', 'starting', 'reconnecting'].includes(status)) {
      void refreshContext();
    }
  }, [status, vpsId, selected.cwd, refreshContext]);

  // ── Session attachments ───────────────────────────────────────────────────
  // One list, two consumers: <ChatInputBar> (underline + insert on upload) and
  // the ToolPanel "files" tab (re-download / copy / re-insert). Held here so
  // they can never disagree. cf. app/sessionAttachments.ts.
  const {
    attachments, pending: pendingUploads, upload: uploadAttachments,
    remove: removeAttachment, dismissPending: dismissPendingUpload,
  } = useSessionAttachments(sessionId);
  // "Insert this path into the message" from the Files tab. Carries a nonce so
  // inserting the SAME path twice in a row still fires (a plain string would
  // be === the previous value and the drain effect would skip it).
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number } | null>(null);
  const requestInsertPath = useCallback((text: string) => {
    setInsertRequest({ text, nonce: Date.now() });
  }, []);
  const clearInsertRequest = useCallback(() => setInsertRequest(null), []);

  // ── Local UI state (scroll, error details) ────────────────────────────────
  // NOTE: the textarea `input` state now lives inside <ChatInputBar> (isolated
  // at the bottom of this file). Keeping it out of this component is what stops
  // a keystroke from re-rendering the whole session view — and therefore the
  // (expensive) message list. See CLAUDE.md §11 / §14.
  // Fork = branch into native Claude OR import this history into a fresh Codex
  // thread. The source stays live in both cases (§14.94).
  const [forkModalOpen, setForkModalOpen] = useState(false);
  const [forking, setForking] = useState<AgentKind | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const doCompact = useCallback(async () => {
    if (compacting || !compactAllowed) return;
    setCompacting(true);
    setCompactError(null);
    try {
      const r = await fetch(`/api/claude/sessions/${sessionId}/compact`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || 'compaction failed');
      // Codex compact() resolves after the operation. Claude queues /compact
      // and refreshes again on thinking→active, so this immediate read is both
      // useful for Codex and harmless for Claude.
      await refreshContext();
    } catch (e: any) {
      setCompactError(String(e?.message || e));
    } finally { setCompacting(false); }
  }, [compacting, compactAllowed, refreshContext, sessionId]);
  const doRewind = useCallback(async (messageId: string) => {
    if (rewinding || status === 'thinking') return;
    setRewinding(true); setRewindError(null);
    try {
      const r = await fetch(`/api/claude/sessions/${sessionId}/rollback`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || 'rewind failed');
      // The local hook intentionally never deletes historical rows during an
      // SSE stream. Reload once after this explicit destructive action so its
      // cache is rebuilt from the now-rewound SQLite transcript.
      window.location.reload();
    } catch (e: any) {
      setRewindError(String(e?.message || e)); setRewinding(false);
    }
  }, [rewinding, sessionId, status]);
  const doFork = useCallback(async (targetKind: AgentKind, options?: {
    lastTurnId?: string; cutoffMessageId?: number; replacementPrompt?: string;
  }) => {
    if (forking) return;
    setForking(targetKind);
    setForkError(null);
    try {
      const r = await fetch(`/api/claude/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetKind, ...options }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.session?.id) {
        setForkError(j?.error || 'fork failed');
        return;
      }
      // Open the branch straight away: the point of forking is to work in it.
      // Creating, not browsing — so hand over the row we just got back and PIN
      // it (§14.78). Looking the id up in `sessions` would lose the race with
      // the list refresh and land on a pane the tab bar does not list.
      setForkError(null);
      setForkModalOpen(false);
      onOpenSession?.(
        j.session.id,
        { vpsId: j.session.vpsId, cwd: j.session.cwd ?? '' },
        true,
      );
    } catch (e: any) {
      setForkError(String(e?.message || e));
    } finally {
      setForking(null);
    }
  }, [forking, sessionId, onOpenSession]);

  const [errorOpen, setErrorOpen] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);

  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Import-error detection → parent callback to open an install session.
  // The "No module named claude_agent_sdk" error message comes from the
  // Python SDK that cannot load the module — the agent is probably
  // installed but the pip dependency is missing.
  useEffect(() => {
    if (!error?.msg) return;
    const needsBootstrap =
      /No module named ['"]?claude_agent_sdk['"]?/i.test(error.msg) ||
      /claude-agent-sdk indisponible/i.test(error.msg) ||
      /ModuleNotFoundError/i.test(error.msg);
    if (needsBootstrap && selectedVps && onImportError) {
      clearError();
      onImportError(selectedVps);
    }
  }, [error, selectedVps, onImportError, clearError]);

  // ── Computeds ─────────────────────────────────────────────────────────────
  // Pair tool_use ↔ tool_result for inline rendering.
  const renderable = useMemo(() => {
    const resultByToolUseId = new Map<string, Msg>();
    for (const m of messages) {
      if (m.role !== 'tool_result') continue;
      try {
        const parsed = JSON.parse(m.content);
        if (parsed?.tool_use_id) resultByToolUseId.set(String(parsed.tool_use_id), m);
      } catch {}
    }
    const out: { msg: Msg; attached?: Msg }[] = [];
    const consumedResults = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool_result') {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.tool_use_id && resultByToolUseId.has(String(parsed.tool_use_id))) {
            if (consumedResults.has(m.id)) continue;
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
  }, [messages]);

  const visibleRenderable = useMemo(
    () => showTools
      ? renderable
      : renderable.filter(({ msg }) => shouldShowChatRole(msg.role, false)),
    [renderable, showTools],
  );

  // ── "Continue" affordance for a turn the transport cut (§14.68) ───────────
  // The CLI closes such a turn with a synthetic assistant bubble ("API Error:
  // Connection closed mid-response…"); the one-word fix is to send "Continue".
  // We offer it on the LAST VISIBLE message only: further down the history the
  // interruption was already handled (a user bubble follows), and a row of
  // dead buttons up the scrollback is noise. Side-channel rows (event /
  // edit_snapshot) render as null, so they must be skipped when looking for
  // "the last thing the user sees" — otherwise a trailing edit_snapshot would
  // hide the CTA. Gated on the turn being over: while it's thinking, Continue
  // would just queue a redundant prompt.
  const continuableMsgId = useMemo(() => {
    if (status === 'thinking' || status === 'starting' || currentAssistant) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'event' || m.role === 'edit_snapshot') continue;
      if (m.role === 'assistant' && isTurnInterrupted(m.content, m.model)) return m.id;
      if (m.role === 'error' && parseSessionError(m.content)?.action === 'continue') return m.id;
      return null;
    }
    return null;
  }, [messages, status, currentAssistant]);

  const schedulableMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'event' || m.role === 'edit_snapshot') continue;
      const parsed = m.role === 'error' ? parseSessionError(m.content) : null;
      return parsed?.kind === 'rate_limit' && resolveResetAtMs(parsed.resetAt, parsed.message) ? m.id : null;
    }
    return null;
  }, [messages]);

  // Stable ref (memo(Message), §14.38). `send` is optimistic, so the user
  // bubble appears at once and `continuableMsgId` goes null on the next render.
  const sendContinue = useCallback(() => { void streamSend('Continue'); }, [streamSend]);
  const scheduleResume = useCallback(async (messageId: string) => {
    const sourceMessageId = Number(messageId.replace(/^m/, ''));
    if (!Number.isSafeInteger(sourceMessageId)) throw new Error('invalid rate-limit message');
    const res = await fetch(`/api/claude/sessions/${sessionId}/scheduled-resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceMessageId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'could not schedule resume');
  }, [sessionId]);
  const cancelScheduledResume = useCallback(async (scheduleId: string) => {
    const res = await fetch(`/api/claude/sessions/${sessionId}/scheduled-resume`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduleId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'could not cancel resume');
  }, [sessionId]);
  const revertAndRefresh = useCallback(() => { onAfterRevert?.(); }, [onAfterRevert]);

  const stepCount = useMemo(() => {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') break;
      if (m.role === 'tool_use') count++;
    }
    return count;
  }, [messages]);

  type PendingInteraction =
    | { kind: 'permission'; createdAt: number; perm: PermissionRequest }
    | { kind: 'question'; createdAt: number; q: PendingQuestion }
    | { kind: 'exit_plan'; createdAt: number; ep: PendingExitPlan };
  const oldestPending = useMemo<PendingInteraction | null>(() => {
    const items: PendingInteraction[] = [];
    for (const p of permQueue) items.push({ kind: 'permission', createdAt: p.createdAt, perm: p });
    for (const q of questionQueue) items.push({ kind: 'question', createdAt: q.createdAt, q });
    for (const ep of exitPlanQueue) items.push({ kind: 'exit_plan', createdAt: ep.createdAt, ep });
    if (!items.length) return null;
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items[0];
  }, [permQueue, questionQueue, exitPlanQueue]);

  const fallbackPlanFromMessages = useMemo(() => {
    if (!oldestPending || oldestPending.kind !== 'exit_plan' || oldestPending.ep.plan) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'tool_use') continue;
      try {
        const parsed = JSON.parse(m.content);
        if ((parsed.name === 'Write' || parsed.name === 'Edit') &&
            typeof parsed.input?.file_path === 'string' &&
            parsed.input.file_path.startsWith('/root/.claude/plans/')) {
          if (parsed.name === 'Write' && typeof parsed.input.content === 'string') {
            return String(parsed.input.content);
          }
          const snap = edits.get(parsed.input.file_path);
          if (snap?.after) return snap.after;
        }
      } catch {}
    }
    return '';
  }, [oldestPending, messages, edits]);

  const turnStartedAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].createdAt;
    }
    return null;
  }, [messages]);

  // Tool shown in the ThinkingBar = the most recent UNRESOLVED tool, but only
  // if it belongs to the CURRENT turn. The turn guard (startedAt >= the last
  // user message) stops a tool left unresolved by a past turn — an interrupted
  // turn, or the transient gap before a refetch re-pairs results — from
  // flashing as "running" the instant a new turn merely starts thinking.
  // See CLAUDE.md §14 gotcha 39.
  const currentTool = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const c = toolCalls[i];
      if (c.result) continue;
      if (turnStartedAt !== null && c.startedAt < turnStartedAt) return null;
      return c;
    }
    return null;
  }, [toolCalls, turnStartedAt]);

  // ── Scroll mechanics (column-reverse, |scrollTop| ≈ 0 = visual bottom) ───
  // In column-reverse:
  //   scrollTop ≈ 0           → visually at the bottom (newest message)
  //   |scrollTop| ≈ scrollHeight - clientHeight → visually at the top (oldest)
  // So distance from VISUAL TOP = scrollHeight - clientHeight - |scrollTop|.
  // loadMore threshold: ~one screenful before the end, so the fetch is already
  // in flight by the time the user gets there. It used to be 400px, which a
  // wheel flick crosses in a single frame: the reader hit the actual top and
  // sat there waiting for the round trip, which is most of what "scrolling
  // back is hard work" was.
  // `isAtTop` = at the ABSOLUTE top (used to decide whether the ↑ button
  // should disappear; it stays as long as there's something to scroll back up to).
  const [isAtTop, setIsAtTop] = useState(false);
  // Top-center "⤒ message start" pill: shown when the NEWEST chat bubble is an
  // assistant message (typically the long end-of-turn recap) whose TOP is
  // scrolled out of view above — i.e. the user is inside/below a long final
  // message and wants to jump back to its beginning.
  const [showJumpToMsgStart, setShowJumpToMsgStart] = useState(false);
  const measureChatScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const atBottom = Math.abs(el.scrollTop) < 80;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
    if (atBottom) setNewCount(0);
    // Scrolled away from the bottom = the user is reading back through the
    // transcript. Hold the poll's clean full reload until they return, or it
    // discards the paginated pages mid-read (CLAUDE.md §14 gotcha 24).
    setHistoryHold(!atBottom);
    // Near-top detect → loadMore. The hook guards against concurrent calls
    // and hasMore=false. The browser does scroll anchoring natively when
    // we append to the end of the DOM (= visual top in column-reverse),
    // so the position is preserved without manually fiddling with scrollTop.
    const max = el.scrollHeight - el.clientHeight;
    const distFromTop = max - Math.abs(el.scrollTop);
    // One screenful of lead time, so a wheel flick doesn't outrun the fetch.
    const loadAhead = Math.max(400, el.clientHeight);
    // `max > 0` guard: when the content is shorter than the container there is
    // nothing to scroll, distFromTop is 0, and this would otherwise paginate
    // the whole history in a loop on every commit.
    if (max > 0 && distFromTop < loadAhead && hasMore && !isLoadingMore) {
      loadMoreHistory();
    }
    setIsAtTop(max <= 0 || distFromTop < 4);
    // Jump-to-message-start pill visibility. In column-reverse the FIRST
    // [data-msg-role] element in DOM order is the newest user/assistant
    // bubble (tool/thinking cards don't carry the attribute — irrelevant
    // here). Show only when that bubble is an assistant one AND its top sits
    // >4px above the visible top (start of the message out of view). Cheap:
    // querySelector stops at the first match, which is near the DOM start.
    const newest = el.querySelector<HTMLElement>('[data-msg-role]');
    let jumpable = false;
    if (newest && newest.dataset.msgRole === 'assistant') {
      const gap = el.getBoundingClientRect().top - newest.getBoundingClientRect().top;
      jumpable = gap > 4;
    }
    setShowJumpToMsgStart(jumpable);
  }, [hasMore, isLoadingMore, loadMoreHistory, setHistoryHold]);
  // rAF-coalesced scroll handler. The measurement above reads scrollHeight /
  // clientHeight and two getBoundingClientRect — each one forces a synchronous
  // layout, and with `content-visibility: auto` on every bubble that layout has
  // to materialize the sizes of the nodes coming into view. Running it on every
  // wheel event (which browsers fire far faster than they paint) made scrolling
  // back through a long transcript visibly stutter. One measurement per frame
  // is all the pills and the loadMore trigger can act on anyway.
  const scrollRafRef = useRef<number | null>(null);
  const handleChatScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      measureChatScroll();
    });
  }, [measureChatScroll]);
  useEffect(() => () => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
  }, []);
  // Recompute isAtTop when the content changes (new messages → max moves).
  useEffect(() => { handleChatScroll(); }, [visibleRenderable.length, handleChatScroll]);
  const onPillClick = useCallback(() => {
    setNewCount(0);
    const el = chatBodyRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // ── Scroll-up, message by message ─────────────────────────────────────
  // TWO up buttons stacked above the ↓ pill, one per role, so the user can
  // walk back through EITHER side of the conversation:
  //   green (top, double chevron) → previous USER message  = "previous turn"
  //   blue  (middle, single)      → previous AGENT message = the agent's own
  //                                 replies, incl. the intermediate bubbles a
  //                                 single turn flushes around tool calls.
  // Same mechanics for both: jump to the closest bubble of that role whose top
  // sits ABOVE the visible area; repeated clicks keep walking up. If there is
  // no such bubble left but history remains, paginate instead (a later click
  // continues into the freshly-loaded rows); at the very top with nothing left
  // to load, jump to the visual top.
  //
  // We use scrollIntoView({block:'start'}) which aligns the top of the
  // element with the top of the container IN SCREEN COORDS, independently
  // of the sign of scrollTop (Chrome negative, Firefox positive in column-reverse).
  // Roles come from Message.tsx's `data-msg-role` — only the rendered chat
  // bubbles carry it (tool/thinking cards don't), which is exactly the set
  // worth stopping on.
  const scrollUpToRole = useCallback((role: 'user' | 'assistant') => {
    const el = chatBodyRef.current;
    if (!el) return;
    const containerRect = el.getBoundingClientRect();
    const bubbles = Array.from(el.querySelectorAll<HTMLElement>(`[data-msg-role="${role}"]`));
    let target: HTMLElement | null = null;
    let bestGap = Infinity;
    for (const bubble of bubbles) {
      const r = bubble.getBoundingClientRect();
      const gap = containerRect.top - r.top;
      // gap > 4: bubble is at least 4px above the visible top
      // (filters out hits on the bubble that's exactly at the limit).
      if (gap > 4 && gap < bestGap) {
        bestGap = gap;
        target = bubble;
      }
    }
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (hasMore && !isLoadingMore) {
      // No more message of that role above, but there's still history left:
      // paginate. Once the older messages are loaded, the user can click
      // again to keep scrolling up.
      loadMoreHistory();
    } else {
      // Visual top reached: align the last DOM child (= visually at the
      // very top in column-reverse) with the top of the container.
      const last = el.lastElementChild as HTMLElement | null;
      if (last) last.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [hasMore, isLoadingMore, loadMoreHistory]);
  const onScrollUpUserClick = useCallback(() => scrollUpToRole('user'), [scrollUpToRole]);
  const onScrollUpAgentClick = useCallback(() => scrollUpToRole('assistant'), [scrollUpToRole]);

  // The ↑ buttons stay visible as long as there's something to scroll up to:
  //   - not at the ABSOLUTE visual top, OR
  //   - there's still history left to paginate (hasMore || isLoadingMore).
  const showScrollUpButton = !isAtTop || hasMore || isLoadingMore;

  // ── Jump to the start of the last (assistant) message ─────────────────
  // Fast deterministic scroll (~240ms ease-out) instead of native
  // scrollIntoView({behavior:'smooth'}): a long recap means a multi-thousand-px
  // hop, and native smooth is slow/inconsistent across browsers for that.
  // Absolute scrollTop math is sign-agnostic (Chrome AND Firefox use negative
  // scrollTop in column-reverse; the delta is continuous either way), and
  // appended older pages (visual top = DOM end) don't shift existing
  // coordinates, so the animation stays stable even if loadMore fires.
  const onJumpToMsgStart = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const bubble = el.querySelector<HTMLElement>('[data-msg-role="assistant"]');
    if (!bubble) return;
    const start = el.scrollTop;
    // Land with the bubble's top 8px below the container top (breathing room;
    // also puts the post-jump gap at -8 < 4 → the pill auto-hides).
    const delta = bubble.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    if (Math.abs(delta) < 2) return;
    const t0 = performance.now();
    const DURATION = 240;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION);
      const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.scrollTop = start + delta * ease;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  // Count new VISIBLE messages when the user is NOT at the bottom, for the ↓ N
  // pill. Hidden tool/reasoning rows must not advertise a message the reader
  // cannot reach. Toggling the preference only changes the baseline; it is not
  // new activity.
  const previousShowToolsRef = useRef(showTools);
  useEffect(() => {
    const prev = lastMessageCountRef.current;
    const cur = visibleRenderable.length;
    if (previousShowToolsRef.current !== showTools) {
      previousShowToolsRef.current = showTools;
      lastMessageCountRef.current = cur;
      setNewCount(0);
      return;
    }
    if (cur > prev && !isAtBottomRef.current) {
      setNewCount((c) => c + (cur - prev));
    }
    lastMessageCountRef.current = cur;
  }, [visibleRenderable.length, showTools]);

  // ── Action wrappers (just handle local UI around the hook) ────────────────
  // The "pause" button in the header used to be a false friend: it called
  // `kill` which put the session in a non-resumable `'killed'` state. The
  // rework removed this middle state. Permanent deletion now happens via
  // the sidebar context menu (right-click → "Delete permanently"),
  // not from this area. See CLAUDE.md §11 and §14.

  const copyError = useCallback(async () => {
    if (!error?.msg) return;
    try {
      await navigator.clipboard.writeText(error.msg);
      setErrorCopied(true);
      setTimeout(() => setErrorCopied(false), 1500);
    } catch {}
  }, [error]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {sessionSettingsOpen && <SessionSettingsModal session={selected} onClose={closeSessionSettings} />}
      <main className="claude-main">
        <div className="claude-bar">
          <div className="session-header-layout">
          {/* Session identity: title, cwd, then the live context gauge. The
              path is the fastest "where am I?" cue when several sessions
              share a name (or have none); context is the next thing most
              likely to change how the user continues the conversation. */}
          <div className="bar-ident">
            <span className="bar-name">{selected.name || '(unnamed)'}</span>
            {/* The addressing form of the same identity. Shown next to the
                name because it is what ANOTHER agent on this machine types to
                reach this session — knowing it requires seeing it. */}
            {handle && (
              <span
                className="bar-handle"
                title={`Stable Charon address on ${selectedVps?.name ?? 'this machine'} (${selected.addressable ? 'currently reachable' : 'not currently reachable'})`}
              >@{handle}</span>
            )}
            {selected.cwd && (
              <span className="bar-sub">
                <CwdSubtitle cwd={selected.cwd} vpsName={selectedVps?.name} />
              </span>
            )}
            <HeaderContextGauge
              context={sessionContext}
              onCompact={doCompact}
              compacting={compacting}
              compactDisabled={!compactAllowed}
              compactError={compactError}
            />
            {selected.cwd && <span className="bar-repo">
              <GitChip vpsId={vpsId} cwd={selected.cwd} onOpen={openGitTab} />
            </span>}
          </div>
          <SessionRuntimePanel
            usage={usage ?? null} vpsName={selectedVps?.name} onUsageRefresh={onUsageRefresh}
            kind={sessionKind} vpsId={vpsId}
            model={model} fallbackModel={fallbackModel} effort={effort}
            modelPendingApply={modelPendingApply} effortPendingApply={effortPendingApply}
            effectiveModel={effectiveModel}
            claudeSessionId={sessionMeta?.claudeSessionId ?? null}
            onSetModel={setModel} onSetEffort={setEffort}
            onApplyNow={doRestart}
          />

          <div className="session-header-controls">
            <div className="session-header-actions" role="group" aria-label="Session actions">
              {status === 'sleeping' || status === 'error' ? (
                <button type="button" className="session-action" onClick={() => doResume()} aria-label="Resume session" title="Resume session"><IconPlay /></button>
              ) : (
                <button type="button" className="session-action" onClick={doSleep} aria-label="Sleep session" title="Sleep session"><IconPause /></button>
              )}
              <button type="button" className="session-action session-action-stop" onClick={forceStop}
                disabled={!['thinking', 'active', 'starting', 'failed', 'background'].includes(status ?? '')}
                aria-label="Stop session" title="Force stop — the session can be resumed"><IconStop /></button>
              <button type="button" className="session-action"
                onClick={() => { setForkError(null); setForkModalOpen(true); }}
                disabled={!!forking || !selected.claudeSessionId}
                aria-label="Fork session" aria-busy={!!forking}
                title={selected.claudeSessionId ? 'Fork conversation' : 'Send a message before forking'}>
                <IconGitBranch />
              </button>
              <button type="button" className="session-action"
                onClick={() => { setRewindError(null); setRewindOpen(true); }}
                disabled={rewinding || status === 'thinking' || status === 'starting' || status === 'sleeping' || status === 'error'}
                aria-label="Rewind session" aria-busy={rewinding}
                title={status === 'sleeping' || status === 'error' ? 'Resume the session before rewinding' : 'Rewind to an earlier turn'}><IconRewind /></button>
              <button type="button" className="session-action session-settings-button" onClick={() => setSessionSettingsOpen(true)} aria-label="Session settings" title="Session settings"><IconGear /></button>
            </div>
          </div>
          </div>
        </div>

        {status === 'reconnecting' && (
          <div className="claude-reconnect-banner">
            <span className="msg"><span className="spin">↻</span> auto-reconnecting…</span>
          </div>
        )}

        {(status === 'sleeping' || status === 'error') && (
          <div className="claude-disconnect-banner-wrap">
            <div className="claude-disconnect-banner" onClick={() => doResume()} role="button">
              <span className="msg">
                inactive session — click to reconnect
                {error?.msg ? <em className="why"> · {error.msg.split('\n')[0].slice(0, 160)}</em> : null}
              </span>
              <span className="resume-chip">↺ resume</span>
            </div>
            {error?.msg && (
              <div className="claude-error-details">
                <div className="err-tools">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setErrorOpen((v) => !v); }}>
                    {errorOpen ? '▾ hide details' : '▸ show details'}
                  </button>
                  <button type="button" className="copy-btn" onClick={(e) => { e.stopPropagation(); copyError(); }} title="copy the error">
                    {errorCopied ? '✓ copied' : '📋 copy'}
                  </button>
                  <button type="button" className="dismiss-btn" onClick={(e) => { e.stopPropagation(); clearError(); }} title="hide the error">✕</button>
                </div>
                {errorOpen && <pre className="err-pre">{error.msg}</pre>}
              </div>
            )}
          </div>
        )}

        {status !== 'sleeping' && status !== 'error' && error && (
          <div className="claude-error">
            <span className="msg">{error.msg.split('\n')[0].slice(0, 200)}</span>
            <button type="button" className="copy-btn" onClick={copyError} title="copy the error">
              {errorCopied ? '✓' : '📋'}
            </button>
            <button onClick={clearError}>✕</button>
          </div>
        )}

        <div className="claude-chat-wrap">
          <div className="claude-chat" ref={chatBodyRef} onScroll={handleChatScroll}>
            {isLoadingHistory && messages.length === 0 ? (
              // Placeholder during the 1st refetch — differentiates "empty
              // session" from "history not yet loaded". Disappears as soon
              // as applyApiData has run (cache or fetch).
              <div className="claude-history-loading" role="status" aria-live="polite">
                <span className="claude-history-loading-spinner" aria-hidden />
                <span>loading history…</span>
              </div>
            ) : (
              <>
                {currentAssistant && (
                  <Message m={{ id: '__streaming', role: 'assistant', content: currentAssistant, createdAt: 0, model: effectiveModel }} streaming kind={sessionKind} onReauth={onReauth} />
                )}
                <MessageHistory
                  renderable={visibleRenderable}
                  kind={sessionKind}
                  onReauth={onReauth}
                  continuableMsgId={continuableMsgId}
                  onContinue={sendContinue}
                  onScheduleResume={scheduleResume}
                  onCancelScheduledResume={cancelScheduledResume}
                  schedulableMsgId={schedulableMsgId}
                  // Conservative on purpose: `reconnecting` means we don't
                  // know yet, and a wrong "interrupted" is worse than a
                  // late one.
                  turnInFlight={status === 'thinking' || status === 'starting'
                    || status === 'reconnecting' || !!currentAssistant}
                />
                {/* "Loading older" / "start of history" indicator.
                    In column-reverse, the last DOM child renders visually at
                    the TOP of the chat — exactly where the user wants it. */}
                {(hasMore || isLoadingMore) && (
                  <div className="claude-loadmore-indicator" role="status" aria-live="polite">
                    {isLoadingMore ? (
                      <><span className="claude-history-loading-spinner" aria-hidden /> loading history…</>
                    ) : (
                      <button type="button" onClick={() => loadMoreHistory()}>↑ load older</button>
                    )}
                  </div>
                )}
                {!hasMore && !isLoadingMore && messages.length > 0 && (
                  <div className="claude-history-start">— start of history —</div>
                )}
              </>
            )}
          </div>
          {/* Top-center pill: jump to the START of the last assistant message
              (the long end-of-turn recap). Only when the turn is over (not
              thinking/starting) and the message start is scrolled out of view. */}
          {showJumpToMsgStart && status !== 'thinking' && status !== 'starting' && (
            <button
              type="button"
              className="claude-jump-msg-start-pill"
              onClick={onJumpToMsgStart}
              aria-label="scroll to the start of the last message"
              title="scroll to the start of the last message"
            >
              <span className="claude-scroll-arrow">⤒</span> scroll to start
            </button>
          )}
          {/* Fixed area for the scroll buttons. The ↓ pill may disappear
              (when at the bottom), but the two ↑ buttons keep their fixed
              positions above, independently — and they show/hide together so
              the stack never shifts under the cursor. */}
          {showScrollUpButton && (
            <button
              type="button"
              className="claude-scroll-up-pill is-user"
              onClick={onScrollUpUserClick}
              aria-label="scroll up to the previous user message"
              title="previous user message"
            >
              <span className="claude-scroll-arrow claude-scroll-arrow-dbl" aria-hidden="true">
                <span>▴</span>
                <span>▴</span>
              </span>
            </button>
          )}
          {showScrollUpButton && (
            <button
              type="button"
              className="claude-scroll-up-pill is-agent"
              onClick={onScrollUpAgentClick}
              aria-label="scroll up to the previous agent message"
              title="previous agent message"
            >
              <span className="claude-scroll-arrow">▴</span>
            </button>
          )}
          {!isAtBottom && (
            <button
              type="button"
              className={`claude-scroll-pill${newCount > 0 ? ' has-new' : ''}`}
              onClick={onPillClick}
              aria-label={newCount > 0 ? `${newCount} new message — go to bottom` : 'go to bottom'}
              title={newCount > 0 ? `${newCount} new message` : 'go to bottom'}
            >
              <span className="claude-scroll-arrow">▾</span>
              {newCount > 0 && <span className="claude-scroll-count">{newCount}</span>}
            </button>
          )}
        </div>

        {status === 'thinking' && (
          <ThinkingBar
            label={sessionKind === 'codex' ? 'Codex is thinking' : 'Claude is thinking'}
            onInterrupt={interrupt}
            currentTool={showTools ? currentTool : null}
            stepCount={showTools ? stepCount : 0}
            startedAt={turnStartedAt}
            tokens={showTools ? (liveUsage?.output ?? null) : null}
          />
        )}

        {/* Background tasks (Bash run_in_background / bg subagents): slim
            status line above the input, click → details modal. Renders null
            when the session has no live/recent background work. */}
        {showTools && (
          <BgTasksBar tasks={bgTasks} sessionId={sessionId}
            provider={sessionKind === 'codex' ? 'codex' : 'claude'}
            sessionStatus={status ?? 'sleeping'} />
        )}

        {/* Input area — replaced by resume CTA if disconnected, or
            QuestionCard/ExitPlanCard/PermissionCard if pending. */}
        {(status === 'sleeping' || status === 'error') ? (
          <div className="claude-disconnect-cta">
            <button onClick={() => doResume()}>↺ RESUME THIS SESSION</button>
          </div>
        ) : oldestPending ? (
          <div className="claude-pending-zone">
            {oldestPending.kind === 'question' && (
              <QuestionCard
                questions={oldestPending.q.questions}
                onAnswer={(answers) => respondQuestion(oldestPending.q.id, answers)}
                onCancel={() => respondQuestion(oldestPending.q.id, null)}
              />
            )}
            {oldestPending.kind === 'exit_plan' && (
              <ExitPlanCard
                plan={oldestPending.ep.plan || fallbackPlanFromMessages}
                onApprove={() => respondExitPlan(oldestPending.ep.id, 'approve')}
                onReject={(feedback) => respondExitPlan(oldestPending.ep.id, 'reject', feedback)}
              />
            )}
            {oldestPending.kind === 'permission' && (
              <InlinePermissionCard
                perm={oldestPending.perm}
                onRespond={(allow, always) => respondPermission(oldestPending.perm.id, allow, always)}
              />
            )}
          </div>
        ) : (
          <ChatInputBar
            sessionId={sessionId}
            kind={sessionKind}
            permissionMode={permissionMode}
            onSetMode={setMode}
            onSend={streamSend}
            prefillInput={prefillInput}
            clearPrefillInput={clearPrefillInput}
            pending={pendingUploads}
            onUploadFiles={uploadAttachments}
            onDismissPending={dismissPendingUpload}
            insertRequest={insertRequest}
            clearInsertRequest={clearInsertRequest}
            siblings={siblings}
          />
        )}
      </main>

      <ToolPanel
        sessionId={sessionId}
        kind={sessionKind}
        toolCalls={toolCalls}
        edits={edits}
        onRevert={revertAndRefresh}
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onInsertPath={requestInsertPath}
        vpsId={vpsId || null}
        cwd={selected.cwd || null}
        repoBusy={status === 'thinking'}
        requestedTab={requestedToolTab}
        onTabConsumed={clearRequestedToolTab}
        onOpenSession={onOpenSession}
        onReveal={onOpenTools}
        context={sessionContext}
        contextLoaded={contextLoaded}
        contextLoading={contextLoading}
        onRefreshContext={refreshContext}
        onCompact={doCompact}
        compacting={compacting}
        compactDisabled={!compactAllowed}
        compactError={compactError}
      />
      {forkModalOpen && (
        <ForkModal
          sourceKind={sessionKind}
          sessionId={sessionId}
          sourceName={selected.name || '(unnamed)'}
          vpsName={selectedVps?.name}
          codexAvailable={selectedVps?.codexAvailable === 1}
          busy={forking}
          error={forkError}
          onChoose={(kind, options) => { void doFork(kind, options); }}
          onClose={() => { if (!forking) setForkModalOpen(false); }}
        />
      )}
      {rewindOpen && <RewindModal messages={messages}
        provider={sessionKind === 'codex' ? 'Codex' : 'Claude'} busy={rewinding} error={rewindError}
        onConfirm={(messageId) => { void doRewind(messageId); }}
        onClose={() => { if (!rewinding) setRewindOpen(false); }} />}
    </>
  );
}

// ── View-specific sub-components ────────────────────────────────────────────

// Completed history is immutable while an assistant streams. Keeping the map
// inside a memoized child means a delta no longer creates/reconciles hundreds
// of <Message> elements; only the small live-tail bubble changes.
const MessageHistory = memo(function MessageHistory({
  renderable, kind, onReauth, continuableMsgId, schedulableMsgId, onContinue, onScheduleResume, onCancelScheduledResume, turnInFlight,
}: {
  renderable: { msg: Msg; attached?: Msg }[];
  kind: AgentKind;
  onReauth?: () => void;
  continuableMsgId: string | null;
  schedulableMsgId: string | null;
  onContinue: () => void;
  onScheduleResume: (messageId: string) => Promise<void>;
  onCancelScheduledResume: (scheduleId: string) => Promise<void>;
  // Is a turn in flight right now? A tool_use with no tool_result can only
  // still be running while one is: outside a turn nothing can produce that
  // result anymore (§14.91). Only the unresolved tool cards receive the
  // derived `orphaned`, so a turn boundary re-runs this map but re-renders
  // at most those few messages (memo, §14.38).
  turnInFlight: boolean;
}) {
  return [...renderable].reverse().map(({ msg, attached }) => (
    <Message
      key={msg.id} m={msg} attachedResult={attached} kind={kind}
      onReauth={onReauth}
      onContinue={msg.id === continuableMsgId ? onContinue : undefined}
      onScheduleResume={msg.id === schedulableMsgId ? () => onScheduleResume(msg.id) : undefined}
      onCancelScheduledResume={onCancelScheduledResume}
      orphaned={msg.role === 'tool_use' && !attached && !turnInFlight}
    />
  ));
});

// Isolated input bar. It owns the textarea `input` state (via useInputDraft)
// so that typing only re-renders THIS small component — never the parent
// ClaudeSessionView, and therefore never the message list. Before this
// isolation, every keystroke re-rendered the whole session view; combined with
// the (now memoized) <Message>, that meant re-parsing markdown + re-running
// syntax highlighting for the entire history on each keypress, which is why
// long sessions lagged by seconds. Memoized too, so a parent re-render
// (new message, status change) doesn't needlessly re-render it either.
// See CLAUDE.md §11 / §14.
const CODEX_MODE_META: Record<CodexSandboxMode, { glyph: string; label: string; title: string }> = {
  'read-only': { glyph: '⊘', label: 'read only', title: 'read-only — can read files & run read-only commands; no writes' },
  'workspace-write': { glyph: '✎', label: 'workspace', title: 'workspace write — can edit files in the workspace; network off by default' },
  'full-access': { glyph: '⚡', label: 'full access', title: 'full access — no sandbox, but sensitive actions can still request approval (DANGER)' },
  'accept-all': { glyph: '▶▶', label: 'accept all', title: 'accept all — no sandbox and no approval prompts (DANGER)' },
};

const ChatInputBar = memo(function ChatInputBar({
  sessionId, kind, permissionMode, onSetMode, onSend, prefillInput, clearPrefillInput,
  pending, onUploadFiles, onDismissPending, insertRequest, clearInsertRequest, siblings,
}: {
  sessionId: string;
  kind: AgentKind;
  permissionMode: SessionMode;
  onSetMode: (mode: SessionMode) => void;
  onSend: (content: string) => Promise<void>;
  prefillInput: string | null;
  clearPrefillInput: () => void;
  pending: PendingUpload[];
  onUploadFiles: (files: File[], onEach?: (att: SessionAttachment) => void) => Promise<void>;
  onDismissPending: (key: string) => void;
  // "Insert this path" request coming from the Files tab. Same drain pattern as
  // prefillInput: the parent holds it until this bar is mounted to consume it,
  // so clicking + in the tab while a permission card is showing isn't lost.
  insertRequest: { text: string; nonce: number } | null;
  clearInsertRequest: () => void;
  /** Other sessions on the same machine, for the `@` menu. `confirmed:false`
   *  = the handle is predicted, not yet what the CLI answers to. */
  siblings?: Array<{ id: string; name: string | null; handle: string; confirmed?: boolean; status: string }>;
}) {
  const isCodex = kind === 'codex';
  // `input` is wired to `inputDraftStore` so the draft survives session
  // switches (this component remounts via the parent's key={selectedId}) — cf.
  // app/inputDraftStore.ts. F5 wipes everything (in-memory Map).
  const [input, setInput] = useInputDraft(sessionId);
  const [touchInput, setTouchInput] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Last known caret offset. A drop lands on the WINDOW, not the textarea, so
  // by the time we insert, the textarea may not even be focused — without this
  // the path would always be appended at the end, which is exactly what the
  // "insert where my cursor is" requirement rules out.
  const caretRef = useRef<number | null>(null);
  // Mirror of `input` that is updated SYNCHRONOUSLY by insertAtCaret. Dropping
  // three files fires three inserts back-to-back, all before React has
  // re-rendered — reading state there would make each one overwrite the last,
  // and only the final path would survive.
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);

  // What is being dragged over the page, or null. Two kinds land in the same
  // place (the caret) but do very different things on the way: 'files' uploads
  // to the VPS first, 'path' is already there and only needs splicing.
  const [dragKind, setDragKind] = useState<'files' | 'path' | null>(null);

  // Drain prefill_input: copy into the textarea then clear. If this bar is
  // unmounted when a prefill arrives (pending interaction / sleeping session),
  // the hook keeps prefillInput non-null (clearPrefillInput only runs here), so
  // it self-applies the moment the bar remounts.
  useEffect(() => {
    if (prefillInput !== null) {
      setInput(prefillInput);
      clearPrefillInput();
    }
  }, [prefillInput, clearPrefillInput, setInput]);

  // Focus on desktop session entry/remount, after pane transitions. Touch
  // devices keep the keyboard closed until the user taps the composer.
  useEffect(() => {
    const media = window.matchMedia?.('(pointer: coarse)');
    const syncTouchInput = () => setTouchInput(media?.matches ?? false);
    syncTouchInput();
    media?.addEventListener('change', syncTouchInput);
    const id = requestAnimationFrame(() => {
      if (!media?.matches) taRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      media?.removeEventListener('change', syncTouchInput);
    };
  }, [sessionId]);

  const rememberCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) caretRef.current = ta.selectionStart;
  }, []);

  /**
   * Insert text at the remembered caret, padding with spaces so a path never
   * gets glued to an adjacent word (`voir/tmp/a.png` would be unreadable to
   * the model AND break the exact-match underline).
   */
  const insertAtCaret = useCallback((text: string) => {
    const cur = inputRef.current;
    const pos = Math.min(caretRef.current ?? cur.length, cur.length);
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length === 0 || !/^\s/.test(after) ? ' ' : '';
    const chunk = lead + text + trail;
    const next = before + chunk + after;
    inputRef.current = next;
    setInput(next);
    const caret = before.length + chunk.length;
    caretRef.current = caret;
    // After React commits the new value — setting the selection before that
    // would be overwritten by the controlled re-render.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(caret, caret); } catch { /* detached */ }
    });
  }, [setInput]);

  // ── `@` mention menu ────────────────────────────────────────────────────
  // Naming a session is only half of addressing it: you also have to know what
  // the others are called. Typing `@` lists the sessions on THIS machine — the
  // ones this session can actually reach, since cross-session messaging is
  // filesystem-scoped — and picking one inserts its handle, so "tell @api to
  // regenerate the types" names a real, resolvable target instead of a guess.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const mentionMatches = useMemo(() => {
    if (!mention || !siblings?.length) return [];
    const q = mention.query.toLowerCase();
    return siblings
      .filter((x) => !q || x.handle.toLowerCase().includes(q)
        || (x.name ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, siblings]);

  /** Re-derive the pending mention from the text and caret. `@` only opens a
   *  menu at a word boundary — an email address or a decorator must not. */
  const syncMention = useCallback((value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const m = /(?:^|\s)@([a-zA-Z0-9-]*)$/.exec(upto);
    if (!m) { setMention(null); return; }
    setMention({ start: caret - m[1].length - 1, query: m[1] });
    setMentionIdx(0);
  }, []);

  const applyMention = useCallback((handle: string) => {
    if (!mention) return;
    const cur = inputRef.current;
    const caret = Math.min(caretRef.current ?? cur.length, cur.length);
    const next = cur.slice(0, mention.start) + '@' + handle + ' ' + cur.slice(caret);
    const pos = mention.start + handle.length + 2;
    inputRef.current = next;
    setInput(next);
    caretRef.current = pos;
    setMention(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch { /* detached */ }
    });
  }, [mention, setInput]);

  // Drain "insert this path" from the Files tab.
  useEffect(() => {
    if (!insertRequest) return;
    insertAtCaret(insertRequest.text);
    clearInsertRequest();
  }, [insertRequest, insertAtCaret, clearInsertRequest]);

  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    // The path is appended as each upload lands, so the user sees progress
    // rather than a frozen bar followed by a burst of paths.
    void onUploadFiles(files, (att) => insertAtCaret(att.remotePath));
  }, [onUploadFiles, insertAtCaret]);

  // ── Window-level drag & drop ──────────────────────────────────────────────
  // Listeners go on the window, not the textarea: the requirement is to drop
  // anywhere on the page. Scoping is automatic — this bar only exists while a
  // chat session is open, so a drop over a shell terminal or an install log
  // never reaches here.
  useEffect(() => {
    // Depth counter, because dragenter/dragleave fire for every child element
    // the pointer crosses; a naive boolean flickers the overlay constantly.
    let depth = 0;
    // Which of the app's three HTML5 drags this is — see app/pathDrag.ts. A
    // tab or sidebar REORDER carries only 'text/plain' and matches neither, so
    // dragging a tab must never light up the chat's drop overlay.
    const kindOf = (e: DragEvent): 'files' | 'path' | null => {
      const dt = e.dataTransfer;
      if (!dt) return null;
      if (Array.prototype.indexOf.call(dt.types, 'Files') !== -1) return 'files';
      return isPathDrag(dt) ? 'path' : null;
    };
    const onEnter = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      depth++;
      setDragKind(kind);
    };
    const onOver = (e: DragEvent) => {
      if (!kindOf(e)) return;
      // MANDATORY: without preventDefault the drop event never fires and the
      // browser navigates away to the dropped file instead.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!kindOf(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragKind(null);
    };
    const onDrop = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      e.preventDefault();
      depth = 0;
      setDragKind(null);
      if (kind === 'path') {
        // Dropping back onto the explorer is how a drag gets CANCELLED — the
        // panel is both the source and, being fixed on the right, the easiest
        // place to let go by accident. Everywhere else is a valid target.
        if (e.target instanceof Element && e.target.closest('.tool-panel')) return;
        const p = readPathDrag(e.dataTransfer);
        // No upload: this path already exists on the VPS, so it goes straight
        // to the caret and `pending` stays empty (no blocking upload overlay).
        if (p) insertAtCaret(p);
        return;
      }
      const files = Array.from(e.dataTransfer?.files ?? []);
      handleFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles, insertAtCaret]);

  // Paste a screenshot straight into the message (Cmd/Ctrl+V). Same pipeline as
  // a drop — on desktop this is how screenshots actually reach a chat.
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;   // plain text paste → let the browser do it
    e.preventDefault();
    rememberCaret();
    handleFiles(files);
  }, [handleFiles, rememberCaret]);

  // An upload is in flight (an entry with an `error` is a finished failure, not
  // progress). Drives the blocking overlay: the ssh push to the VPS takes a few
  // seconds, and without a visible gate the user types into a textarea that is
  // about to have a path spliced into it at a caret that has since moved.
  const uploading = pending.filter((p) => !p.error);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content) return;
    setInput('');
    inputRef.current = '';
    caretRef.current = 0;
    await onSend(content);
  }, [input, onSend, setInput]);

  return (
    <footer className="claude-input-bar">
      {isCodex ? (
        // The automatic reviewer is a fleet default in Settings. Per-session
        // controls only select execution semantics; accept-all is the one
        // explicit sandbox+approval bypass, parallel to Claude's auto mode.
        <div className="mode-switch codex" role="radiogroup" aria-label="Codex permission mode">
          {CODEX_SANDBOX_MODES.map((m) => {
            const meta = CODEX_MODE_META[m];
            return (
              <button
                key={m}
                type="button" role="radio"
                aria-checked={permissionMode === m}
                className={`m-btn ${m}${permissionMode === m ? ' on' : ''}`}
                onClick={() => onSetMode(m)}
                title={meta.title}
              >
                <span className="m-glyph">{meta.glyph}</span><span className="m-label">{meta.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mode-switch" role="radiogroup" aria-label="permission mode">
          <button
            type="button" role="radio"
            aria-checked={permissionMode === 'normal'}
            className={`m-btn normal${permissionMode === 'normal' ? ' on' : ''}`}
            onClick={() => onSetMode('normal')}
            title="normal — asks permission for every tool"
          >
            <span className="m-glyph">▷</span><span className="m-label">normal</span>
          </button>
          <button
            type="button" role="radio"
            aria-checked={permissionMode === 'acceptEdits'}
            className={`m-btn acceptEdits${permissionMode === 'acceptEdits' ? ' on' : ''}`}
            onClick={() => onSetMode('acceptEdits')}
            title="accept edits — auto-accepts file edits, asks for the rest"
          >
            <span className="m-glyph">▶▶</span><span className="m-label">accept edits</span>
          </button>
          <button
            type="button" role="radio"
            aria-checked={permissionMode === 'auto'}
            className={`m-btn auto${permissionMode === 'auto' ? ' on' : ''}`}
            onClick={() => onSetMode('auto')}
            title="accept all — accepts everything without asking (DANGER)"
          >
            <span className="m-glyph">▶▶</span><span className="m-label">accept all</span>
          </button>
          <button
            type="button" role="radio"
            aria-checked={permissionMode === 'plan'}
            className={`m-btn plan${permissionMode === 'plan' ? ' on' : ''}`}
            onClick={() => onSetMode('plan')}
            title="plan mode — proposes a plan without running tools"
          >
            <span className="m-glyph">⏸</span><span className="m-label">plan mode</span>
          </button>
        </div>
      )}
      {mention && mentionMatches.length > 0 && (
        <div className="ci-mentions" role="listbox" aria-label="sessions on this machine">
          {mentionMatches.map((x, i) => (
            <button
              key={x.id}
              type="button"
              role="option"
              aria-selected={i === mentionIdx}
              className={`ci-mention${i === mentionIdx ? ' on' : ''}`}
              // mousedown, not click: click fires after blur, and the blur has
              // already torn the menu down.
              onMouseDown={(e) => { e.preventDefault(); applyMention(x.handle); }}
              onMouseEnter={() => setMentionIdx(i)}
            >
              <span className={`cim-handle${x.confirmed === false ? ' unconfirmed' : ''}`}>@{x.handle}{x.confirmed === false ? '?' : ''}</span>
              {x.name && x.name !== x.handle && <span className="cim-name">{x.name}</span>}
              <span className={`cim-state ${x.status}`}>{x.status}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        enterKeyHint="enter"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          caretRef.current = e.target.selectionStart;
          syncMention(e.target.value, e.target.selectionStart ?? 0);
        }}
        onPaste={onPaste}
        onSelect={rememberCaret}
        onClick={rememberCaret}
        onKeyUp={rememberCaret}
        onBlur={rememberCaret}
        placeholder={touchInput
          ? `message to ${isCodex ? 'Codex' : 'Claude'} — use 📎 to attach (Enter for newline, tap send to send)`
          : `message to ${isCodex ? 'Codex' : 'Claude'} — drop a file anywhere or use 📎 (Enter sends, Shift/Ctrl+Enter for newline)`}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          // Mobile Enter always inserts a newline, even with the @ menu open.
          if (e.key === 'Enter' && window.matchMedia?.('(pointer: coarse)').matches) return;
          // While the @ menu is open it owns the navigation keys — otherwise
          // Enter would send a half-typed handle instead of completing it.
          if (mention && mentionMatches.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setMentionIdx((i) => {
                const n = mentionMatches.length;
                return (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
              });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              applyMention(mentionMatches[mentionIdx]!.handle);
              return;
            }
            if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
          }
          if (e.key !== 'Enter') return;
          if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          send();
        }}
        rows={3}
      />
      <div className="ci-send-col">
        <button
          type="button"
          className="ci-attach"
          onClick={() => { rememberCaret(); fileInputRef.current?.click(); }}
          title="attach a file — it is uploaded to the session workspace and its path inserted here"
          aria-label="attach a file"
        >
          <IconPaperclip />
        </button>
        <button className="send" onClick={send} disabled={!input.trim()}>send</button>
      </div>
      {/* No `accept` filter: any file type goes through, on purpose — whether
          the agent can do something with it is ITS verdict, not ours. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="ci-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so re-picking the SAME file fires change again.
          e.target.value = '';
          handleFiles(files);
        }}
      />
      {pending.length > 0 && (
        <div className="ci-pending">
          {pending.map((p) => (
            <span key={p.key} className={`ci-chip${p.error ? ' err' : ''}`} title={p.error ?? undefined}>
              <span className="ci-chip-name">{p.name}</span>
              {p.error
                ? <button type="button" className="ci-chip-x" onClick={() => onDismissPending(p.key)} aria-label="dismiss">✕</button>
                : <span className="ci-chip-spin">uploading…</span>}
            </span>
          ))}
        </div>
      )}
      {dragKind && (
        <div className="ci-drop-overlay">
          <div className="ci-drop-card">
            {dragKind === 'path' ? <IconInsert /> : <IconPaperclip />}
            <span>
              {dragKind === 'path'
                // Saying "the path" and not "the file" is the whole point:
                // nothing is copied anywhere, the agent is simply told where
                // to look on its own disk.
                ? 'drop to put this path in the message'
                : 'drop to attach — the file lands in the session workspace'}
            </span>
          </div>
        </div>
      )}
      {/* Blocking gate while the upload runs. Same visual language as the drop
          overlay, but this one INTERCEPTS pointer events on purpose: the hub
          has to push the bytes to the VPS over ssh, which takes seconds, and
          the path is spliced in at the remembered caret when it lands. Letting
          the user keep typing or click send in the meantime means the insert
          arrives somewhere they no longer expect — or after the message has
          already gone. */}
      {uploading.length > 0 && (
        <div className="ci-upload-overlay" role="status" aria-live="polite">
          <div className="ci-drop-card">
            <span className="ci-spinner" aria-hidden="true" />
            <span>
              uploading {uploading.length > 1 ? `${uploading.length} files` : uploading[0].name}
              {' — '}pushing to the session workspace…
            </span>
          </div>
        </div>
      )}
    </footer>
  );
});

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
      <ApprovalDeadline expiresAt={perm.expiresAt} />
      <pre className="ip-input">{JSON.stringify(perm.input, null, 2).slice(0, 1200)}</pre>
      <footer className="ip-actions">
        <button type="button" className="allow" onClick={() => onRespond(true, false)}>allow once</button>
        <button type="button" className="always" onClick={() => onRespond(true, true)}>allow always (session)</button>
        <button type="button" className="deny" onClick={() => onRespond(false, false)}>deny</button>
      </footer>
    </div>
  );
}

/**
 * Header subtitle: the cwd the session was opened in.
 *
 * The path is split into [leading dirs, last segment] so that only the HEAD
 * ellipsizes when the bar is narrow — the last segment is what actually
 * identifies the project, so it must never be the part that gets cut. (A
 * plain `text-overflow: ellipsis` on the whole path would eat exactly that.)
 * Full path (+ VPS name) stays available in the tooltip.
 */
function CwdSubtitle({ cwd, vpsName }: { cwd: string; vpsName?: string }) {
  const clean = cwd.replace(/\/+$/, '') || cwd;
  const cut = clean.lastIndexOf('/');
  const head = cut > 0 ? clean.slice(0, cut + 1) : '';
  const tail = cut > 0 ? clean.slice(cut + 1) : clean;
  return (
    <span className="bar-cwd" title={vpsName ? `${vpsName} · ${cwd}` : cwd}>
      {head && <span className="c-head">{head}</span>}
      <span className="c-tail">{tail}</span>
    </span>
  );
}

/**
 * Repository name/link and branch chip, beneath the session context gauge.
 *
 * Shown for the whole life of a git cwd, not only when dirty: on a clean tree
 * the branch name is itself the thing worth knowing at a glance (am I on main
 * or on the feature branch?), and a control that appears and disappears is
 * harder to rely on than one that is always in the same place. The COUNT is
 * the notification — it appears only when there is something to see.
 *
 * It stays silent while the state is merely degraded (agent offline or too
 * old): the git tab explains that, and a header chip is the wrong place for an
 * error you can't act on from here.
 *
 * The forge link is separate on purpose — same row, its own hit target, so
 * "open source control" and "open GitHub" can't be misclicked for each other.
 */
function GitChip({ vpsId, cwd, onOpen }: { vpsId: string; cwd: string; onOpen: () => void }) {
  const { workspace } = useGitStatus(vpsId || null, cwd || null);
  if (!workspace?.ok || workspace.mode === 'none' || workspace.repos.length === 0) return null;

  const n = workspaceDirtyCount(workspace);
  const { ahead } = workspaceAheadBehind(workspace);

  // A folder OF projects (§14.83) has no single branch to name, so the chip
  // counts the checkouts instead and the badge sums their changes — the number
  // is what makes it worth glancing at, and the tab has the breakdown. The
  // forge link only makes sense when there is exactly one place to go.
  const multi = workspace.mode === 'multi' && workspace.repos.length > 1;
  const one = multi ? null : workspace.repos[0];
  const repoName = one?.name || one?.root?.split('/').filter(Boolean).pop() || cwd.split('/').filter(Boolean).pop();
  const web = one?.remoteWebUrl;
  const host = web ? web.replace(/^https:\/\//, '').split('/')[0] : null;

  const label = multi
    ? `▤ ${workspace.repos.length} repos`
    : `⎇ ${one!.detached ? (one!.head ?? 'detached') : (one!.branch ?? '?')}`;

  const title = (multi
    ? [
      `${workspace.repos.length} repositories under this folder`,
      ...workspace.repos.map((r) => {
        const c = r.fileCount ?? r.files.length;
        return `  ${r.rel || r.name}${r.branch ? ` (${r.branch})` : ''}${c ? ` — ${c} changed` : ''}`;
      }),
    ]
    : [
      one!.detached ? `detached @ ${one!.head ?? '?'}` : `branch ${one!.branch ?? '?'}`,
      n > 0 ? `${n} changed file${n > 1 ? 's' : ''} (+${one!.added ?? 0} −${one!.deleted ?? 0})` : 'working tree clean',
      ahead > 0 ? `${ahead} commit${ahead > 1 ? 's' : ''} to push` : '',
    ]
  ).concat('click to open source control').filter(Boolean).join('\n');

  return (
    <span className="git-chip-wrap">
      {one && (web ? (
        <a className="git-remote" href={web} target="_blank" rel="noopener noreferrer" title={`open ${repoName} on ${host}`}>
          <span className="gr-name">{repoName}</span><IconExternal className="gr-ico" />
        </a>
      ) : <span className="git-repo-name" title={one.root ?? undefined}>{repoName}</span>)}
      <button type="button" className={`git-chip${multi ? ' multi' : ''}`} onClick={onOpen} title={title}>
        <span className="gc-branch">{label}</span>
        {n > 0 && <span className="gc-count">{n}</span>}
        {ahead > 0 && <span className="gc-ahead">↑{ahead}</span>}
      </button>

    </span>
  );
}

function ThinkingBar({
  currentTool, stepCount, startedAt, tokens, onInterrupt, label = 'Claude is thinking',
}: {
  currentTool: ToolCallEntry | null;
  stepCount: number;
  startedAt: number | null;
  tokens: number | null;
  onInterrupt: () => void | Promise<void>;
  label?: string;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;
  const elapsed = startedAt ? Math.max(0, Math.floor(Date.now() / 1000 - startedAt)) : null;
  return (
    <div className="thinking-bar">
      <span className="t-dot" />
      <span className="t-label">{label}</span>
      <button
        type="button"
        className="t-interrupt"
        onClick={() => { void onInterrupt(); }}
        title="Interrupt the current turn"
      >interrupt</button>
      {currentTool && (
        <span className="t-tool">
          <span className="sep">·</span>
          <span className="glyph">⚒</span>
          <span className="name">{currentTool.name}</span>
          <span className="sum">{summarizeToolInput(currentTool.name, currentTool.input)}</span>
        </span>
      )}
      <span className="t-meta">
        {stepCount > 0 && <><span className="sep">·</span> step {stepCount}</>}
        {elapsed != null && <><span className="sep">·</span> {fmtElapsed(elapsed)}</>}
        {tokens != null && tokens > 0 && <><span className="sep">·</span> ↑ {fmtTokens(tokens)} tokens</>}
      </span>
    </div>
  );
}

function fmtElapsed(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

// 14200 → "14.2k", 850 → "850" (mirrors Claude Code's terminal counter).
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
}

/** Direct choices use the same provider catalogs as the creation/settings forms. */
function SessionRuntimePanel({
  usage, vpsName, onUsageRefresh, kind, vpsId, model, fallbackModel, effort,
  modelPendingApply, effortPendingApply, effectiveModel, claudeSessionId,
  onSetModel, onSetEffort, onApplyNow,
}: {
  usage: AccountUsage | null;
  vpsName?: string | null;
  onUsageRefresh?: () => void;
  kind: AgentKind;
  vpsId: string;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  modelPendingApply: boolean;
  effortPendingApply: boolean;
  effectiveModel: string | null;
  claudeSessionId: string | null;
  onSetModel: (m: string | null, fallback?: string | null) => Promise<void>;
  onSetEffort: (e: string | null) => Promise<void>;
  onApplyNow?: () => Promise<void> | void;
}) {
  const isCodex = kind === 'codex';
  const [open, setOpen] = useState<'model' | 'effort' | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const effortButton = useRef<HTMLButtonElement>(null);

  function close() {
    (open === 'model' ? modelButton : effortButton).current?.focus({ preventScroll: true });
    setOpen(null);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        (open === 'model' ? modelButton : effortButton).current?.focus({ preventScroll: true });
        setOpen(null);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  async function choose(value: string) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (open === 'model' && (value || null) !== model) {
        // Preserve the independently configured fallback when changing Claude's model.
        await onSetModel(value || null, isCodex ? null : fallbackModel);
      } else if (open === 'effort' && (value || null) !== effort) {
        await onSetEffort(value || null);
      }
      close();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save this selection.');
    } finally { setSaving(false); }
  }

  const modelLabel = (model ?? effectiveModel ?? 'Default').replace(/^claude-/, '');
  const mismatch = !isCodex && !!model && !!effectiveModel && effectiveModel !== model
    && !['opus', 'sonnet', 'haiku'].includes(model);
  const anyPending = !isCodex && (modelPendingApply || effortPendingApply);
  const title = `Model: ${model ?? 'default'}${effectiveModel ? ` · effective: ${effectiveModel}` : ''}${anyPending ? ' · pending until resume' : ''}`;
  const pickerProps = { presentation: 'list' as const, disabled: saving, onChange: choose };
  const toggle = (target: 'model' | 'effort') => {
    setSaveError(null);
    setOpen((current) => current === target ? null : target);
  };

  return (
    <div className="session-runtime-panel" role="group" aria-label="Model, effort and usage">
      <div className="runtime-config" ref={popRef}>
        <button ref={modelButton} type="button" className={`runtime-cell runtime-model${mismatch ? ' has-mismatch' : ''}${anyPending ? ' has-pending' : ''}`}
          onClick={() => toggle('model')} disabled={saving} title={title} aria-label="Change model" aria-haspopup="menu" aria-expanded={open === 'model'}>
          <span className="runtime-value"><AgentLogo kind={kind} size={15} /><span>{modelLabel}</span>{anyPending && <span className="runtime-pending" aria-label="Pending change">•</span>}</span>
          {!!model && !!effectiveModel && effectiveModel !== model && <span className="runtime-effective">→ {effectiveModel}</span>}
        </button>
        <button ref={effortButton} type="button" className={`runtime-cell runtime-effort${anyPending ? ' has-pending' : ''}`}
          onClick={() => toggle('effort')} disabled={saving} title={`Effort: ${effort ?? 'default'}`} aria-label="Change effort" aria-haspopup="menu" aria-expanded={open === 'effort'}>
          <span className="runtime-value"><span className="runtime-effort-symbol" aria-hidden="true">✦</span><span>{effort ?? 'Default'}</span></span>
        </button>
        {open && <div className="runtime-choice-popover" aria-busy={saving}>
          {open === 'model' ? (isCodex
            ? <CodexModelPicker {...pickerProps} vpsId={vpsId} value={model ?? ''} />
            : <ModelPicker {...pickerProps} value={model ?? ''} />)
            : (isCodex
              ? <CodexEffortPicker {...pickerProps} vpsId={vpsId} value={effort ?? ''} modelId={model || effectiveModel || ''} />
              : <EffortPicker {...pickerProps} value={effort ?? ''} modelId={model || effectiveModel || ''} />)}
          {saveError && <p className="runtime-choice-error" role="alert">{saveError}</p>}
          {!isCodex && open === 'model' && claudeSessionId && <p className="runtime-choice-note">An existing Claude conversation may keep its original model. Use Fork to switch models while preserving history.</p>}
          {anyPending && onApplyNow && <button type="button" className="runtime-apply" disabled={saving} onClick={async () => {
            setSaving(true); setSaveError(null);
            try { await onApplyNow(); close(); }
            catch (e) { setSaveError(e instanceof Error ? e.message : 'Could not apply the change.'); }
            finally { setSaving(false); }
          }}>↻ Apply pending changes</button>}
        </div>}
      </div>
      <UsageMeter usage={usage} vpsName={vpsName} compact runtime onRefresh={onUsageRefresh} />
    </div>
  );
}
