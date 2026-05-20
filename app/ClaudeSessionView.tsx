'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';
import type { SessionListItem } from '@/lib/types/api';
import { api } from '@/lib/api';
import Message, { type Msg, summarizeToolInput } from './Message';
import ToolPanel from './ToolPanel';
import QuestionCard from './QuestionCard';
import ExitPlanCard from './ExitPlanCard';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan, ToolCallEntry,
} from './sessionTypes';
import { useClaudeSessionStream, type StreamCache } from './useClaudeSessionStream';
import {
  getCached, fetchAndCache, invalidate as invalidateCache,
  extendWithOlder as extendCacheWithOlder,
} from './sessionCache';
import { useInputDraft } from './inputDraftStore';

// ClaudeSessionView
// ─────────────────────────────────────────────────────────────────────────────
// Component that renders the entire "active session" area of the desktop
// dashboard:
//   - Actions bar (sleep / resume / interrupt / force-stop) — permanent
//     deletion goes through the context menu (right-click on the sidebar),
//     not through a button in the bar (cf. kill→delete rework: only
//     `sleep` is reversible, everything else destroys)
//   - Reconnect / disconnect / error banner
//   - Slot for overlay (LoginConsole for `claude login`)
//   - Scroll-reverse chat + scroll pill
//   - ThinkingBar during 'thinking'
//   - Input bar (mode switch + textarea + send) — replaced by
//     QuestionCard / ExitPlanCard / InlinePermissionCard when pending
//   - ToolPanel (diffs / todos / calls)
//
// All SSE + per-session state logic lives in useClaudeSessionStream,
// so this component is essentially rendering + computeds.
//
// The parent (ClaudePanel) keeps: sidebar, global modals, push, service
// worker, cross-session permission popup, sessions list polling, etc.

type Props = {
  sessionId: string;
  selected: SessionListItem;
  selectedVps: Vps | null;
  // Slot for parent overlay (LoginConsole for `claude login`). Rendered
  // between the bar and the chat. Agent bootstrap no longer goes through
  // here — it opens a dedicated install session
  // (cf. ClaudePanel.openInstallSession).
  overlay?: React.ReactNode;
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
  sessionId, selected, selectedVps,
  overlay, onImportError, onKilled, onAfterRevert,
}: Props) {
  const stream = useClaudeSessionStream(sessionId, {
    cache: sharedCacheRef,
    onKilled,
  });
  const {
    messages, currentAssistant, status, permissionMode,
    toolCalls, todos, edits,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    send: streamSend, interrupt, forceStop, setMode,
    doSleep, doResume,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, loadMoreHistory, clearError,
  } = stream;

  // ── Local UI state (textarea, scroll, error details) ──────────────────────
  // `input` is wired to `inputDraftStore` so the draft survives session
  // switches (component remount via `key={selectedId}`) — cf.
  // app/inputDraftStore.ts. F5 wipes everything (in-memory Map).
  const [input, setInput] = useInputDraft(sessionId);
  const [errorOpen, setErrorOpen] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);

  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Drain prefill_input: copy into the textarea then clear.
  useEffect(() => {
    if (prefillInput !== null) {
      setInput(prefillInput);
      clearPrefillInput();
    }
  }, [prefillInput, clearPrefillInput]);

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

  const currentTool = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      if (!toolCalls[i].result) return toolCalls[i];
    }
    return null;
  }, [toolCalls]);

  const turnStartedAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].createdAt;
    }
    return null;
  }, [messages]);

  // ── Scroll mechanics (column-reverse, |scrollTop| ≈ 0 = visual bottom) ───
  // In column-reverse:
  //   scrollTop ≈ 0           → visually at the bottom (newest message)
  //   |scrollTop| ≈ scrollHeight - clientHeight → visually at the top (oldest)
  // So distance from VISUAL TOP = scrollHeight - clientHeight - |scrollTop|.
  // loadMore threshold: 400px ≈ 2-3 messages before the end → gives the
  // backend time to respond before the user is visually stuck.
  // `isAtTop` = at the ABSOLUTE top (used to decide whether the ↑ button
  // should disappear; it stays as long as there's something to scroll back up to).
  const [isAtTop, setIsAtTop] = useState(false);
  const handleChatScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const atBottom = Math.abs(el.scrollTop) < 80;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
    if (atBottom) setNewCount(0);
    // Near-top detect → loadMore. The hook guards against concurrent calls
    // and hasMore=false. The browser does scroll anchoring natively when
    // we append to the end of the DOM (= visual top in column-reverse),
    // so the position is preserved without manually fiddling with scrollTop.
    const max = el.scrollHeight - el.clientHeight;
    const distFromTop = max - Math.abs(el.scrollTop);
    if (distFromTop < 400 && hasMore && !isLoadingMore) {
      loadMoreHistory();
    }
    setIsAtTop(max <= 0 || distFromTop < 4);
  }, [hasMore, isLoadingMore, loadMoreHistory]);
  // Recompute isAtTop when the content changes (new messages → max moves).
  useEffect(() => { handleChatScroll(); }, [messages.length, handleChatScroll]);
  const onPillClick = useCallback(() => {
    setNewCount(0);
    const el = chatBodyRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // ── Scroll-up to the previous user message ────────────────────────────
  // The "↑" button (above the ↓ pill) jumps to the last user message above
  // the visible area. Repeated click → we keep going message by message.
  // If there's no more user message above but there's still history to
  // paginate, we trigger loadMoreHistory. Otherwise (at the very top, nothing
  // more to load), we jump to the visual top.
  //
  // We use scrollIntoView({block:'start'}) which aligns the top of the
  // element with the top of the container IN SCREEN COORDS, independently
  // of the sign of scrollTop (Chrome negative, Firefox positive in column-reverse).
  const onScrollUpClick = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const containerRect = el.getBoundingClientRect();
    const userBubbles = Array.from(el.querySelectorAll<HTMLElement>('[data-msg-role="user"]'));
    let target: HTMLElement | null = null;
    let bestGap = Infinity;
    for (const bubble of userBubbles) {
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
      // No more user message above, but there's still history left:
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

  // The ↑ button stays visible as long as there's something to scroll up to:
  //   - not at the ABSOLUTE visual top, OR
  //   - there's still history left to paginate (hasMore || isLoadingMore).
  const showScrollUpButton = !isAtTop || hasMore || isLoadingMore;

  // Count new messages when the user is NOT at the bottom, for the ↓ N pill.
  useEffect(() => {
    const prev = lastMessageCountRef.current;
    const cur = messages.length;
    if (cur > prev && !isAtBottomRef.current) {
      setNewCount((c) => c + (cur - prev));
    }
    lastMessageCountRef.current = cur;
  }, [messages.length]);

  // ── Action wrappers (just handle local UI around the hook) ────────────────
  const send = useCallback(async () => {
    const content = input.trim();
    if (!content) return;
    setInput('');
    await streamSend(content);
  }, [input, streamSend]);

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
      <main className="claude-main">
        <div className="claude-bar">
          <span className="bar-name">{selected.name || '(unnamed)'}</span>
          {status === 'sleeping' || status === 'error' ? (
            <button onClick={() => doResume()}>resume</button>
          ) : (
            <button onClick={doSleep}>sleep</button>
          )}
          <button onClick={interrupt} disabled={status !== 'thinking'}>interrupt</button>
          <button
            className="kill"
            onClick={forceStop}
            disabled={!['thinking', 'active', 'starting'].includes(status ?? '')}
            title="Force cancel (SDK stuck) — session goes to sleeping, resume possible"
          >force stop</button>
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

        {overlay}

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
                  <Message m={{ id: '__streaming', role: 'assistant', content: currentAssistant, createdAt: 0 }} streaming />
                )}
                {[...renderable].reverse().map(({ msg, attached }) => (
                  <Message key={msg.id} m={msg} attachedResult={attached} />
                ))}
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
          {/* Fixed area for the scroll buttons. The ↓ pill may disappear
              (when at the bottom), but the ↑ button keeps its fixed position
              above, independently. */}
          {showScrollUpButton && (
            <button
              type="button"
              className="claude-scroll-up-pill"
              onClick={onScrollUpClick}
              aria-label="scroll up to last user message"
              title="scroll up to last user message"
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
          <ThinkingBar currentTool={currentTool} stepCount={stepCount} startedAt={turnStartedAt} />
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
          <footer className="claude-input-bar">
            <div className="mode-switch" role="radiogroup" aria-label="permission mode">
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'normal'}
                className={`m-btn normal${permissionMode === 'normal' ? ' on' : ''}`}
                onClick={() => setMode('normal')}
                title="normal — asks permission for every tool"
              >
                <span className="m-glyph">▷</span><span className="m-label">normal</span>
              </button>
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'acceptEdits'}
                className={`m-btn acceptEdits${permissionMode === 'acceptEdits' ? ' on' : ''}`}
                onClick={() => setMode('acceptEdits')}
                title="accept edits — auto-accepts file edits, asks for the rest"
              >
                <span className="m-glyph">▶▶</span><span className="m-label">accept edits</span>
              </button>
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'auto'}
                className={`m-btn auto${permissionMode === 'auto' ? ' on' : ''}`}
                onClick={() => setMode('auto')}
                title="accept all — accepts everything without asking (DANGER)"
              >
                <span className="m-glyph">▶▶</span><span className="m-label">accept all</span>
              </button>
              <button
                type="button" role="radio"
                aria-checked={permissionMode === 'plan'}
                className={`m-btn plan${permissionMode === 'plan' ? ' on' : ''}`}
                onClick={() => setMode('plan')}
                title="plan mode — proposes a plan without running tools"
              >
                <span className="m-glyph">⏸</span><span className="m-label">plan mode</span>
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="message to Claude (Enter sends, Shift/Ctrl+Enter for newline)"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault();
                send();
              }}
              rows={3}
            />
            <button className="send" onClick={send} disabled={!input.trim()}>send</button>
          </footer>
        )}
      </main>

      <ToolPanel
        sessionId={sessionId}
        toolCalls={toolCalls}
        todos={todos}
        edits={edits}
        onRevert={() => onAfterRevert?.()}
      />
    </>
  );
}

// ── View-specific sub-components ────────────────────────────────────────────

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
  void tick;
  const elapsed = startedAt ? Math.max(0, Math.floor(Date.now() / 1000 - startedAt)) : null;
  return (
    <div className="thinking-bar">
      <span className="t-dot" />
      <span className="t-label">Claude is thinking</span>
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
