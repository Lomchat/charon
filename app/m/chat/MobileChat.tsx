'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { createPatch } from 'diff';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import type { WorkerStatus, PermissionMode } from '@/lib/server/claude/types';
import {
  getCached, fetchAndCache, invalidate as invalidateCache, extendWithOlder,
} from '../chatCache';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
// Msg / ToolCallEntry / Todo / EditSnapshot / PermissionRequest /
// PendingQuestion / PendingExitPlan types imported from the module shared
// with the desktop view. The shape includes `sessionId: string` (filled on
// the mobile side with the current sessionId, see constructions below).
import type {
  Msg, ToolCallEntry, Todo, EditSnapshot,
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from '../../sessionTypes';
import { useClaudeSessionStream, type StreamCache } from '../../useClaudeSessionStream';
import { useCrossSessionInteractionFeed } from '../../useCrossSessionInteractionFeed';
import { useInputDraft } from '../../inputDraftStore';
import { computeQuickNavGroups, QuickNavChip, type QuickNavItem } from '../quickNav';
import type { SessionListItem, ShellInfo } from '@/lib/types/api';

type SessionMeta = {
  id: string;
  vpsId: string;
  cwd: string;
  name: string | null;
  status: WorkerStatus;
  permissionMode: PermissionMode;
};

// ──────────────────────────────────────────────────────────────────────────
// MobileChat
// ──────────────────────────────────────────────────────────────────────────
type Props = {
  sessionId: string;
  vpsList: Vps[];
  vpsPaths: VpsPath[];
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  starting: 'starting',
  active: 'active',
  thinking: 'thinking',
  sleeping: 'sleeping',
  killed: 'killed',
  error: 'error',
  reconnecting: 'reconnecting…',
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

export default function MobileChat({ sessionId, vpsList }: Props) {
  const router = useRouter();
  // Stable cache (cf. ../chatCache.ts) — passed to the hook via the StreamCache contract.
  // Invalidating after deletion clears the entry so we don't display an
  // already-deleted session as still active on the way back to
  // /m/select while the poll hasn't yet run.
  const cacheRef = useRef<StreamCache>({
    get: (id) => getCached(id),
    fetch: (id, force) => fetchAndCache(id, force),
    invalidate: (id) => invalidateCache(id),
    extendWithOlder: (id, older) => extendWithOlder(id, older),
  });

  // ── Session stream (SSE + state + actions) — shared desktop/mobile hook ──
  const stream = useClaudeSessionStream(sessionId, {
    cache: cacheRef.current,
    onKilled: () => {
      cacheRef.current.invalidate?.(sessionId);
      router.push('/m/select');
    },
  });
  const {
    sessionMeta, messages, currentAssistant, status, permissionMode,
    toolCalls, todos, edits,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory,
    hasMore, isLoadingMore,
    clearPrefillInput, clearError, loadMoreHistory,
  } = stream;

  // Cross-session interactions feed: counts the perms/questions/exit-plans
  // pending on OTHER sessions than this one. Displayed as a banner at the
  // top of the chat view, click → /m/select to go process them.
  const cross = useCrossSessionInteractionFeed();
  const otherSessionsPending = useMemo(() => {
    const filter = <T extends { sessionId: string }>(arr: T[]) => arr.filter((x) => x.sessionId !== sessionId);
    return filter(cross.perms).length + filter(cross.questions).length + filter(cross.exitPlans).length;
  }, [cross, sessionId]);

  // Purely mobile UI state (menus + scroll). NOTE: the textarea `input` state,
  // its auto-resize, the prefill_input draining and `send` all moved into
  // <MobileInputBar> (isolated, bottom of this file) so a keystroke only
  // re-renders that small component — never this one, and therefore never the
  // message list. See CLAUDE.md §11 / §14.
  const [showMenu, setShowMenu] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // "All active sessions" overlay (3rd header button) — mobile equivalent of
  // the desktop TabBar. Data is fetched lazily (only while the sheet is open)
  // since MobileChat otherwise only knows about the current session.
  const [showSessions, setShowSessions] = useState(false);
  const [navSessions, setNavSessions] = useState<SessionListItem[]>([]);
  const [navShells, setNavShells] = useState<ShellInfo[]>([]);

  const chatBodyRef = useRef<HTMLDivElement | null>(null);

  // ── Scroll: flex-direction: column-reverse ──────────────────────────────
  // The chat body is rendered in column-reverse, so:
  //   - DOM[0] = visual bottom (newest message)
  //   - scrollTop = 0 = really at the bottom (regardless of scrollHeight)
  //   - When we add a message (at DOM[0]) the browser keeps scrollTop=0 →
  //     we auto-follow the new message.
  //   - When we prepend old ones at the top (append to the end of the DOM),
  //     the browser does scroll anchoring → we stay at the same position.
  //   - Markdown / images that change scrollHeight? scrollTop=0 stays 0,
  //     we're always at the bottom, no drift.
  // → 0 useLayoutEffect, the browser does all the work.
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastMessageCountRef = useRef(0);

  // Progressive batching removed: we render all messages at once.
  // Combined with the cache + column-reverse, this gives an instant display
  // WITHOUT a perceived "scrolling" effect (no more batches arriving one by one).

  const [isAtTop, setIsAtTop] = useState(false);
  const handleScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    // In column-reverse, scrollTop ≈ 0 means "visually at the bottom".
    // The user "scrolls up" to see older messages → scrollTop becomes
    // negative on some browsers (Safari) or positive (Chrome/Firefox).
    // We consider "at the bottom" = |scrollTop| < threshold.
    const atBottom = Math.abs(el.scrollTop) < 80;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
    if (atBottom) setNewCount(0);
    // Near-top → loadMore. Cf. ClaudeSessionView for the formula.
    const max = el.scrollHeight - el.clientHeight;
    const distFromTop = max - Math.abs(el.scrollTop);
    if (distFromTop < 400 && hasMore && !isLoadingMore) {
      loadMoreHistory();
    }
    setIsAtTop(max <= 0 || distFromTop < 4);
  }, [hasMore, isLoadingMore, loadMoreHistory]);
  // Recompute isAtTop when the content changes.
  useEffect(() => { handleScroll(); }, [messages.length, handleScroll]);
  const onPillClick = useCallback(() => {
    setNewCount(0);
    const el = chatBodyRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // ── Scroll-up to the previous user message ────────────────────────────
  // Symmetric to the ↓ pill: jump to the last user message above the visible
  // area. Repeated click → we keep stepping back. If nothing above but
  // pagination available, trigger loadMoreHistory. Otherwise jump to the
  // visual top. Cf. ClaudeSessionView.tsx for the desktop version.
  // scrollIntoView({block:'start'}) handles the cross-browser scrollTop sign.
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
      if (gap > 4 && gap < bestGap) {
        bestGap = gap;
        target = bubble;
      }
    }
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (hasMore && !isLoadingMore) {
      loadMoreHistory();
    } else {
      const last = el.lastElementChild as HTMLElement | null;
      if (last) last.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [hasMore, isLoadingMore, loadMoreHistory]);

  const showScrollUpButton = !isAtTop || hasMore || isLoadingMore;

  const vps = useMemo(() => vpsList.find((v) => v.id === sessionMeta?.vpsId) ?? null, [vpsList, sessionMeta]);

  // Poll the cross-session list ONLY while the overlay is open. Grouped by VPS
  // with the same logic as the /m/select strip (shared in ../quickNav).
  useEffect(() => {
    if (!showSessions) return;
    let alive = true;
    const load = async () => {
      try { const r = await api.listClaudeSessions(); if (alive) setNavSessions(r.sessions); } catch {}
      try { const r = await api.listShells(); if (alive) setNavShells(r?.shells ?? []); } catch {}
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [showSessions]);
  const navGroups = useMemo(
    () => computeQuickNavGroups(navSessions, navShells, vpsList),
    [navSessions, navShells, vpsList],
  );
  const navTo = useCallback((item: QuickNavItem) => {
    setShowSessions(false);
    if (item.kind === 'session') {
      if (item.id !== sessionId) router.push(`/m/chat?id=${encodeURIComponent(item.id)}`);
    } else {
      router.push(`/m/shell?id=${encodeURIComponent(item.id)}`);
    }
  }, [router, sessionId]);

  // [SSE + state + refetch are handled by useClaudeSessionStream (shared
  // desktop/mobile hook, cf. ../../useClaudeSessionStream.ts). Before the
  // extraction, this file contained ~250 lines for applyApiData /
  // refetchHistory / SSE useEffect / visibilitychange useEffect — all of it
  // now lives in the hook.]

  // Count new messages WHEN the user is NOT at the bottom, in order to
  // display the "↓ N" pill. (At the bottom, we auto-follow via column-reverse.)
  useEffect(() => {
    const prev = lastMessageCountRef.current;
    const cur = messages.length;
    if (cur > prev && !isAtBottomRef.current) {
      setNewCount((c) => c + (cur - prev));
    }
    lastMessageCountRef.current = cur;
  }, [messages.length]);

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
    const consumed = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool_result') {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed?.tool_use_id && resultByToolUseId.has(String(parsed.tool_use_id))) {
            if (consumed.has(m.id)) continue;
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
            if (attached) consumed.add(attached.id);
          }
        } catch {}
        out.push({ msg: m, attached });
        continue;
      }
      out.push({ msg: m });
    }
    return out;
  }, [messages]);

  // ── Oldest pending interaction ──────────────────────────────────────
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

  // See ClaudeSessionView: only surface a current-turn unresolved tool, so a
  // stale tool from a past turn never flashes in the ThinkingBar.
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

  const stepCount = useMemo(() => {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') break;
      if (messages[i].role === 'tool_use') count++;
    }
    return count;
  }, [messages]);

  // ── Mobile UI actions (thin wrappers around the hook's actions) ─────────
  // The wrappers only handle mobile UI state (closing the menu after the
  // action). `send` lives in <MobileInputBar> (it needs the input state).
  // The business logic lives in useClaudeSessionStream.
  async function interrupt() {
    setShowMenu(false);
    await stream.interrupt();
  }
  async function forceStop() {
    setShowMenu(false);
    await stream.forceStop();
  }
  async function doSleep() {
    setShowMenu(false);
    await stream.doSleep();
  }
  async function doResume() {
    setShowMenu(false);
    await stream.doResume();
  }
  async function doDelete() {
    if (!confirm('Permanently delete this session and all its history?')) return;
    setShowMenu(false);
    await stream.doDelete();
    // navigation to /m/select handled by the hook's onKilled callback
  }
  // setMode is used directly as `stream.setMode` in the JSX.

  // ── Render ────────────────────────────────────────────────────────────
  const title = sessionMeta?.name || (sessionMeta?.cwd ? sessionMeta.cwd.split('/').slice(-2).join('/') : 'session');
  const subtitle = vps && sessionMeta ? `${vps.name}:${sessionMeta.cwd}` : '';

  return (
    <>
      <header className="m-topbar">
        <button className="m-back" onClick={() => router.push('/m/select')} aria-label="back">←</button>
        <div className="m-title-block">
          <span className="m-title">{title}</span>
          {subtitle && <span className="m-subtitle">{subtitle}</span>}
        </div>
        <div className="m-actions">
          <button
            className="m-act-btn"
            onClick={() => { setShowMenu(false); setShowSessions((v) => !v); }}
            aria-label="all active sessions"
            title="all active sessions"
          >⧉</button>
          <button
            className="m-act-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="tools"
            title="diffs / todos / tools"
            disabled={edits.size === 0 && todos.length === 0 && toolCalls.length === 0}
          >▤</button>
          <button
            className="m-act-btn"
            onClick={() => setShowMenu((v) => !v)}
            aria-label="menu"
          >⋮</button>
        </div>
        {showMenu && (
          <MenuPopover
            status={status}
            onClose={() => setShowMenu(false)}
            onSleep={doSleep}
            onResume={doResume}
            onDelete={doDelete}
            onInterrupt={interrupt}
            onForceStop={forceStop}
          />
        )}
      </header>

      {showSessions && (
        <>
          <div className="m-sessions-bg" onClick={() => setShowSessions(false)} />
          <div className="m-sessions-sheet" role="dialog" aria-modal="true" aria-label="all active sessions">
            <div className="m-sessions-head">
              <span>active sessions</span>
              <button className="m-sessions-close" onClick={() => setShowSessions(false)} aria-label="close">✕</button>
            </div>
            {navGroups.length === 0 ? (
              <div className="m-sessions-empty">nothing active right now</div>
            ) : (
              navGroups.map((g) => (
                <div key={g.vpsId} className={`m-quicknav-row${g.hasAttention ? ' attention' : ''}`}>
                  <span className="m-quicknav-vps" title={g.vpsName}>{g.vpsName}</span>
                  <div className="m-quicknav-chips">
                    {g.items.map((it) => (
                      <QuickNavChip
                        key={`${it.kind}-${it.id}`}
                        item={it}
                        active={it.kind === 'session' && it.id === sessionId}
                        onClick={() => navTo(it)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {otherSessionsPending > 0 && (
        <button
          type="button"
          className="m-cross-banner"
          onClick={() => router.push('/m/select')}
          aria-label="go to other sessions"
        >
          ↑ {otherSessionsPending} {otherSessionsPending === 1 ? 'interaction' : 'interactions'} pending on other sessions
        </button>
      )}

      <div className="m-chat-statusbar">
        {status === 'thinking' ? (
          <span className="m-status-pill status-amber-pulse">
            <span className="dot" /> claude is thinking
          </span>
        ) : oldestPending ? (
          <span className="m-status-pill status-orange-pulse">
            <span className="dot" /> waiting for your response
          </span>
        ) : status ? (
          <span className={`m-status-pill status-${STATUS_DOT[status]}`}>
            <span className="dot" /> {STATUS_LABEL[status]}
          </span>
        ) : null}
        {sessionMeta?.cwd && (
          <span className="m-status-cwd">{sessionMeta.cwd}</span>
        )}
      </div>

      {(status === 'sleeping' || status === 'error') && (
        <div className="m-banner disconnect" onClick={doResume} role="button">
          ↺ session inactive — tap to reconnect
          {error?.msg && (<><br/><em style={{ fontStyle: 'italic', fontSize: 10, opacity: 0.7 }}>{error.msg.split('\n')[0].slice(0, 80)}</em></>)}
        </div>
      )}
      {status === 'reconnecting' && (
        <div className="m-banner reconnect">↻ auto-reconnecting…</div>
      )}
      {error && status !== 'sleeping' && status !== 'error' && (
        <div className="m-banner error">
          <pre>{error.msg}</pre>
          <button onClick={() => clearError()}>✕</button>
        </div>
      )}

      <div className="m-chat-wrap">
        {/* En column-reverse : DOM[0] = bas visuel.
            On met donc le streaming en 1er, puis les messages en ordre inverse
            (newest first dans le DOM = en bas, oldest last = en haut). */}
        <div className="m-chat-body" ref={chatBodyRef} onScroll={handleScroll}>
          {isLoadingHistory && messages.length === 0 ? (
            <div className="m-history-loading" role="status" aria-live="polite">
              <span className="m-history-loading-spinner" aria-hidden />
              <span>loading history…</span>
            </div>
          ) : (
            <>
              {currentAssistant && (
                <div className="m-bubble assistant streaming">
                  <div className="m-bubble-h"><span>assistant</span></div>
                  <div className="m-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}>
                      {currentAssistant}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
              {[...renderable].reverse().map(({ msg, attached }) => (
                <MobileMessage key={msg.id} m={msg} attached={attached} />
              ))}
              {/* In column-reverse, the last DOM child renders visually at
                  the top — that's where we expect the "older" indicator. */}
              {(hasMore || isLoadingMore) && (
                <div className="m-loadmore-indicator" role="status" aria-live="polite">
                  {isLoadingMore ? (
                    <><span className="m-history-loading-spinner" aria-hidden /> loading…</>
                  ) : (
                    <button type="button" onClick={() => loadMoreHistory()}>↑ older</button>
                  )}
                </div>
              )}
              {!hasMore && !isLoadingMore && messages.length > 0 && (
                <div className="m-history-start">— start —</div>
              )}
            </>
          )}
        </div>
        {/* Fixed area for the scroll buttons. The ↓ pill can disappear when
            at the bottom but the ↑ button keeps its position above. */}
        {showScrollUpButton && (
          <button
            type="button"
            className="m-scroll-up-pill"
            onClick={onScrollUpClick}
            aria-label="scroll up to last user message"
          >
            <span className="m-scroll-arrow">▴</span>
          </button>
        )}
        {!isAtBottom && (
          <button
            type="button"
            className={`m-scroll-pill${newCount > 0 ? ' has-new' : ''}`}
            onClick={onPillClick}
            aria-label={newCount > 0 ? `${newCount} new message — go to bottom` : 'go to bottom'}
          >
            <span className="m-scroll-arrow">▾</span>
            {newCount > 0 && <span className="m-scroll-count">{newCount}</span>}
          </button>
        )}
      </div>

      {status === 'thinking' && (
        <ThinkingBar currentTool={currentTool} stepCount={stepCount} startedAt={turnStartedAt} />
      )}

      {/* Bottom zone: 3 cases (the old `'killed'` middle state no longer
          exists, cf. CLAUDE.md §10 — permanent deletion empties the session
          immediately, and the server's `status='killed'` event triggers the
          hook's `onKilled` which redirects us to /m/select before we have a
          chance to display this branch):
          1. sleeping/error session → resume CTA
          2. pending interaction → card
          3. normal → mode switch + input bar */}
      {status === 'sleeping' || status === 'error' ? (
        <div className="m-resume-cta">
          <button onClick={doResume}>↺ RESUME THIS SESSION</button>
        </div>
      ) : oldestPending ? (
        <div className="m-pending-zone">
          {oldestPending.kind === 'permission' && (
            <PermCard
              perm={oldestPending.perm}
              onRespond={(allow, always) => stream.respondPermission(oldestPending.perm.id, allow, always)}
            />
          )}
          {oldestPending.kind === 'question' && (
            <QuestionCard
              q={oldestPending.q}
              onAnswer={(answers) => stream.respondQuestion(oldestPending.q.id, answers)}
              onCancel={() => stream.respondQuestion(oldestPending.q.id, null)}
            />
          )}
          {oldestPending.kind === 'exit_plan' && (
            <ExitPlanCard
              plan={oldestPending.ep.plan || fallbackPlanFromMessages}
              onApprove={() => stream.respondExitPlan(oldestPending.ep.id, 'approve')}
              onReject={(feedback) => stream.respondExitPlan(oldestPending.ep.id, 'reject', feedback)}
            />
          )}
        </div>
      ) : (
        <MobileInputBar
          sessionId={sessionId}
          permissionMode={permissionMode}
          onSetMode={stream.setMode}
          onSend={stream.send}
          prefillInput={prefillInput}
          clearPrefillInput={clearPrefillInput}
        />
      )}

      {drawerOpen && (
        <Drawer
          onClose={() => setDrawerOpen(false)}
          toolCalls={toolCalls}
          todos={todos}
          edits={edits}
          onRevert={async (filePath, content) => {
            try {
              await api.revertClaudeEdit(sessionId, filePath, content);
            } catch (e: any) {
              alert('revert: ' + (e?.message ?? e));
            }
          }}
        />
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Menu popover (sleep/resume/delete/interrupt/force-stop)
//
// The old "pause session" button (which called `kill`) was removed: soft-
// kill `status='killed'` no longer exists. Permanent deletion is behind
// `onDelete` (with confirm on the caller side). To pause without losing
// history, use `onSleep` (reversible).
// ──────────────────────────────────────────────────────────────────────────
function MenuPopover({
  status, onClose, onSleep, onResume, onDelete, onInterrupt, onForceStop,
}: {
  status: WorkerStatus | null;
  onClose: () => void;
  onSleep: () => void;
  onResume: () => void;
  onDelete: () => void;
  onInterrupt: () => void;
  onForceStop: () => void;
}) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 50 }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'absolute', top: 56, right: 8,
          background: 'var(--stone-2)',
          border: '1px solid var(--gold-deep)',
          padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
          zIndex: 51, minWidth: 180,
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        }}
      >
        {status === 'thinking' && (
          <MenuItem onClick={onInterrupt} label="⏸ interrupt" />
        )}
        {['thinking', 'active', 'starting'].includes(status ?? '') && (
          <MenuItem onClick={onForceStop} label="⏹ force stop" danger />
        )}
        {(status === 'sleeping' || status === 'error') ? (
          <MenuItem onClick={onResume} label="↺ resume" />
        ) : (
          <MenuItem onClick={onSleep} label="💤 sleep" />
        )}
        <MenuItem onClick={onDelete} label="🗑 delete" danger />
      </div>
    </>
  );
}

function MenuItem({ onClick, label, danger }: { onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        background: 'transparent',
        border: '1px solid var(--gold-deep)',
        color: danger ? 'var(--crimson)' : 'var(--parchment)',
        fontFamily: 'var(--mono)',
        fontSize: 13,
      }}
    >{label}</button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Input bar (isolated)
// ──────────────────────────────────────────────────────────────────────────
// Owns the textarea `input` state + auto-resize + prefill draining + send, so
// typing only re-renders THIS component, never the parent MobileChat and thus
// never the message list. Mirrors the desktop <ChatInputBar>. See CLAUDE.md §11.
const MobileInputBar = memo(function MobileInputBar({
  sessionId, permissionMode, onSetMode, onSend, prefillInput, clearPrefillInput,
}: {
  sessionId: string;
  permissionMode: PermissionMode;
  onSetMode: (mode: PermissionMode) => void;
  onSend: (content: string) => Promise<void>;
  prefillInput: string | null;
  clearPrefillInput: () => void;
}) {
  // Wired to inputDraftStore so the draft survives /m/chat ↔ /m/select
  // navigation and ?id= session switches (the mobile page has no `key`, so the
  // hook reconciles in-render). F5 wipes everything (in-memory Map).
  const [input, setInput] = useInputDraft(sessionId);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Drain prefill_input. If this bar is unmounted when a prefill arrives, the
  // hook keeps prefillInput non-null (clearPrefillInput only runs here) so it
  // self-applies when the bar remounts.
  useEffect(() => {
    if (prefillInput !== null) {
      setInput(prefillInput);
      clearPrefillInput();
    }
  }, [prefillInput, clearPrefillInput, setInput]);

  // Textarea auto-resize: follow scrollHeight with a max of ~30vh.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = window.innerHeight * 0.3;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [input]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content) return;
    setInput('');
    await onSend(content);
  }, [input, onSend, setInput]);

  return (
    <>
      <div className="m-mode-switch" role="radiogroup" aria-label="permission mode">
        <button
          type="button"
          className={`m-mode-btn normal${permissionMode === 'normal' ? ' on' : ''}`}
          onClick={() => onSetMode('normal')}
        >▷ normal</button>
        <button
          type="button"
          className={`m-mode-btn acceptEdits${permissionMode === 'acceptEdits' ? ' on' : ''}`}
          onClick={() => onSetMode('acceptEdits')}
        >▶▶ edits</button>
        <button
          type="button"
          className={`m-mode-btn auto${permissionMode === 'auto' ? ' on' : ''}`}
          onClick={() => onSetMode('auto')}
        >▶▶ accept all</button>
        <button
          type="button"
          className={`m-mode-btn plan${permissionMode === 'plan' ? ' on' : ''}`}
          onClick={() => onSetMode('plan')}
        >⏸ plan</button>
      </div>
      <footer className="m-input-bar">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="message to Claude…"
          rows={2}
          onKeyDown={(e) => {
            // No submit on Enter on mobile — always native line break.
            // Ctrl/Cmd+Enter sends for connected hardware keyboards.
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="m-send" onClick={send} disabled={!input.trim()} aria-label="send">
          ▶
        </button>
      </footer>
    </>
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────────────────────────────────
// Memoized like the desktop <Message> (same reason): one bubble per history
// item, re-rendered on every parent render. Without memo, a parent re-render
// re-parses markdown + re-runs syntax highlighting for the whole history.
// Props come from a useMemo so refs stay stable until the message changes.
const MobileMessage = memo(function MobileMessage({ m, attached }: { m: Msg; attached?: Msg }) {
  if (m.role === 'tool_use') return <ToolUseBubble m={m} attached={attached} />;
  if (m.role === 'tool_result') return <ToolResultBubble m={m} />;
  if (m.role === 'event' || m.role === 'edit_snapshot') return null;
  if (m.role === 'user_question' || m.role === 'exit_plan_request') return null;
  if (m.role === 'thinking') return <ThinkingBubble m={m} />;

  const isAssistant = m.role === 'assistant';
  const isUser = m.role === 'user';
  return (
    <div
      className={`m-bubble ${isUser ? 'user' : isAssistant ? 'assistant' : 'system'}`}
      data-msg-role={m.role}
    >
      <div className="m-bubble-h">
        <span>{m.role}</span>
        {m.createdAt > 0 && <span style={{ marginLeft: 'auto' }}>{fmtTime(m.createdAt)}</span>}
      </div>
      {isAssistant ? (
        <div className="m-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
          >
            {m.content}
          </ReactMarkdown>
        </div>
      ) : (
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5 }}>{m.content}</div>
      )}
    </div>
  );
});

function ThinkingBubble({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  const first = m.content.split('\n')[0].slice(0, 110);
  const hasMore = m.content.length > first.length;
  return (
    <div className="m-bubble thinking">
      <div className="m-bubble-h" onClick={() => setOpen((v) => !v)} style={{ cursor: hasMore ? 'pointer' : 'default' }}>
        {hasMore && <span>{open ? '▾' : '▸'}</span>}
        <span>thinking</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--parchment-soft)', whiteSpace: open ? 'pre-wrap' : 'normal' }}>
        {open ? m.content : first + (hasMore ? '…' : '')}
      </div>
    </div>
  );
}

function ToolUseBubble({ m, attached }: { m: Msg; attached?: Msg }) {
  const [expanded, setExpanded] = useState(false);
  const [showInput, setShowInput] = useState(false);
  let parsed: any = null;
  try { parsed = JSON.parse(m.content); } catch {}
  const name = parsed?.name ?? '?';
  const input = parsed?.input ?? {};
  const summary = summarizeToolInput(name, input);

  let resultObj: { content: string; isError: boolean } | null = null;
  if (attached) {
    try {
      const rp = JSON.parse(attached.content);
      resultObj = { content: String(rp.content ?? ''), isError: !!rp.is_error };
    } catch {
      resultObj = { content: attached.content, isError: false };
    }
  }

  return (
    <div className={`m-bubble tool-use${resultObj ? ' has-result' : ''}${resultObj?.isError ? ' err' : ''}${expanded ? ' expanded' : ''}`}>
      <div className="m-tu-head" onClick={() => setShowInput((v) => !v)}>
        <span style={{ color: 'var(--lavender)' }}>⚒</span>
        <span className="m-tu-name">{name}</span>
        <span className="m-tu-summary">{summary}</span>
        {!resultObj && <span className="m-tu-status">…</span>}
        {resultObj && <span className="m-tu-status ok">{resultObj.isError ? '✗' : '✓'}</span>}
      </div>
      {showInput && (
        <pre className="m-tu-input">{JSON.stringify(input, null, 2)}</pre>
      )}
      {resultObj && (
        <>
          <div className="m-tu-result" onClick={() => setExpanded((v) => !v)}>
            {resultObj.content || '(empty)'}
          </div>
          {resultObj.content.length > 100 && (
            <span className="m-tu-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '▾ less' : '▸ show all'}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function ToolResultBubble({ m }: { m: Msg }) {
  let content = m.content;
  try {
    const parsed = JSON.parse(m.content);
    if (typeof parsed === 'object' && parsed?.content != null) content = String(parsed.content);
  } catch {}
  return (
    <div className="m-bubble tool-use">
      <div className="m-tu-head">
        <span className="m-tu-name">tool_result</span>
      </div>
      <div className="m-tu-result expanded" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
        {content.slice(0, 4000)}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Thinking bar
// ──────────────────────────────────────────────────────────────────────────
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
    <div className="m-thinking-bar">
      <span className="m-tb-dot" />
      <span style={{ color: 'var(--gold-bright)' }}>thinking</span>
      {currentTool && (
        <span className="m-tb-tool">
          · {currentTool.name} {summarizeToolInput(currentTool.name, currentTool.input)}
        </span>
      )}
      <span className="m-tb-elapsed">
        {stepCount > 0 && `· step ${stepCount}`}
        {elapsed != null && ` · ${fmtElapsed(elapsed)}`}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Permission / Question / ExitPlan cards (mobile-optimized)
// ──────────────────────────────────────────────────────────────────────────
function PermCard({ perm, onRespond }: { perm: PermissionRequest; onRespond: (allow: boolean, always: boolean) => void }) {
  const summary = summarizeToolInput(perm.tool, perm.input);
  return (
    <div className="m-perm-card">
      <h3>🔒 permission requested</h3>
      <div className="m-pc-tool">{perm.tool}</div>
      {summary && <div className="m-pc-summary">{summary}</div>}
      <pre>{JSON.stringify(perm.input, null, 2).slice(0, 1200)}</pre>
      <div className="m-pc-actions">
        <button type="button" className="allow" onClick={() => onRespond(true, false)}>allow once</button>
        <button type="button" className="always" onClick={() => onRespond(true, true)}>always (session)</button>
        <button type="button" className="deny" onClick={() => onRespond(false, false)}>deny</button>
      </div>
    </div>
  );
}

function QuestionCard({ q, onAnswer, onCancel }: {
  q: PendingQuestion;
  onAnswer: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [selections, setSelections] = useState<Record<number, Set<string>>>(() => {
    const init: Record<number, Set<string>> = {};
    q.questions.forEach((_, i) => { init[i] = new Set(); });
    return init;
  });
  const [customs, setCustoms] = useState<Record<number, string>>({});

  function toggle(qIdx: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const next = { ...prev };
      const cur = new Set(prev[qIdx] ?? new Set<string>());
      if (multi) {
        if (cur.has(label)) cur.delete(label); else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      next[qIdx] = cur;
      return next;
    });
  }

  function answerForQuestion(qIdx: number): string | null {
    const custom = (customs[qIdx] ?? '').trim();
    if (custom) return custom;
    const sel = selections[qIdx];
    if (!sel || sel.size === 0) return null;
    return Array.from(sel).join(', ');
  }

  const allAnswered = q.questions.every((_, i) => !!answerForQuestion(i));

  function submit() {
    const answers: Record<string, string> = {};
    q.questions.forEach((qq, i) => {
      const a = answerForQuestion(i);
      if (a) answers[qq.question] = a;
    });
    onAnswer(answers);
  }

  return (
    <div className="m-question-card">
      <h3>❓ question{q.questions.length > 1 ? `s × ${q.questions.length}` : ''}</h3>
      {q.questions.map((qq, qIdx) => {
        const multi = !!qq.multiSelect;
        const sel = selections[qIdx] ?? new Set<string>();
        const customVal = customs[qIdx] ?? '';
        return (
          <div key={qIdx} className="m-q-block">
            {qq.header && <div className="m-q-header">{qq.header}</div>}
            <div className="m-q-text">{qq.question}</div>
            {multi && <div className="m-q-multi-hint">multiple choice ☑</div>}
            {qq.options.map((opt) => {
              const on = sel.has(opt.label);
              return (
                <button
                  type="button"
                  key={opt.label}
                  className={`m-q-option${on ? ' selected' : ''}`}
                  onClick={() => toggle(qIdx, opt.label, multi)}
                >
                  <span className="m-q-radio">{multi ? (on ? '☑' : '☐') : (on ? '◉' : '◯')}</span>
                  <span>{opt.label}</span>
                  {opt.description && <span className="m-q-desc">{opt.description}</span>}
                </button>
              );
            })}
            <textarea
              placeholder="or free-form answer…"
              value={customVal}
              onChange={(e) => setCustoms((c) => ({ ...c, [qIdx]: e.target.value }))}
              rows={2}
              style={{ marginTop: 6 }}
            />
          </div>
        );
      })}
      <div className="m-pc-actions">
        <button type="button" className="approve" onClick={submit} disabled={!allAnswered}>send</button>
        <button type="button" className="deny" onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}

function ExitPlanCard({ plan, onApprove, onReject }: {
  plan: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
}) {
  const [askingFeedback, setAskingFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  return (
    <div className="m-exitplan-card">
      <h3>📋 plan ready</h3>
      <div style={{ marginTop: 8 }} className="m-md">
        {plan ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        ) : (
          <em style={{ color: 'var(--parchment-soft)' }}>The plan was written to a file (see messages above).</em>
        )}
      </div>
      {!askingFeedback ? (
        <div className="m-pc-actions">
          <button type="button" className="approve" onClick={onApprove}>approve and execute</button>
          <button type="button" className="reject" onClick={() => setAskingFeedback(true)}>request changes</button>
        </div>
      ) : (
        <>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="what would you like to change?"
            rows={4}
            autoFocus
          />
          <div className="m-pc-actions">
            <button
              type="button"
              className="approve"
              onClick={() => onReject(feedback.trim() || 'Please revise the plan.')}
              disabled={!feedback.trim()}
            >send feedback</button>
            <button type="button" className="deny" onClick={() => { setAskingFeedback(false); setFeedback(''); }}>cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Drawer (ToolPanel mobile)
// ──────────────────────────────────────────────────────────────────────────
type DrawerTab = 'diffs' | 'todos' | 'calls';
function Drawer({
  onClose, toolCalls, todos, edits, onRevert,
}: {
  onClose: () => void;
  toolCalls: ToolCallEntry[];
  todos: Todo[];
  edits: Map<string, EditSnapshot>;
  onRevert: (filePath: string, content: string | null) => Promise<void>;
}) {
  const [tab, setTab] = useState<DrawerTab>(edits.size > 0 ? 'diffs' : todos.length > 0 ? 'todos' : 'calls');
  // Hide content-less skeleton entries (edit_snapshot content is stripped by
  // the GET and refilled lazily — CLAUDE.md §14 gotcha 41).
  const editArr = useMemo(
    () => Array.from(edits.values()).filter((e) => e.before != null || e.after != null),
    [edits],
  );

  return (
    <>
      <div className="m-drawer-bg" onClick={onClose} />
      <div className="m-drawer" role="dialog" aria-modal="true">
        <div className="m-drawer-handle" onClick={onClose} />
        <button className="m-drawer-close" onClick={onClose} aria-label="close">✕</button>
        <nav className="m-drawer-tabs">
          <button className={tab === 'diffs' ? 'on' : ''} onClick={() => setTab('diffs')}>
            diffs {editArr.length > 0 && <span className="m-badge">{editArr.length}</span>}
          </button>
          <button className={tab === 'todos' ? 'on' : ''} onClick={() => setTab('todos')}>
            todos {todos.length > 0 && <span className="m-badge">{todos.filter((t) => t.status !== 'completed').length}/{todos.length}</span>}
          </button>
          <button className={tab === 'calls' ? 'on' : ''} onClick={() => setTab('calls')}>
            tools {toolCalls.length > 0 && <span className="m-badge">{toolCalls.length}</span>}
          </button>
        </nav>
        <div className="m-drawer-body">
          {tab === 'diffs' && <DiffsTab edits={editArr} onRevert={onRevert} />}
          {tab === 'todos' && <TodosTab todos={todos} />}
          {tab === 'calls' && <CallsTab calls={toolCalls} />}
        </div>
      </div>
    </>
  );
}

function DiffsTab({ edits, onRevert }: { edits: EditSnapshot[]; onRevert: (filePath: string, content: string | null) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (edits.length === 0) return <div className="m-tp-empty">no modified files</div>;
  async function revert(filePath: string, before: string | null) {
    if (!confirm(`Restore "${filePath}" to its initial state?`)) return;
    setBusy(filePath);
    try { await onRevert(filePath, before); } finally { setBusy(null); }
  }
  return (
    <>
      {edits.map((e) => {
        const patch = createPatch(e.filePath, e.before ?? '', e.after ?? '', '', '', { context: 3 });
        let add = 0, del = 0;
        for (const l of patch.split('\n')) {
          if (l.startsWith('+') && !l.startsWith('+++')) add++;
          else if (l.startsWith('-') && !l.startsWith('---')) del++;
        }
        const lines = patch.split('\n').slice(4);
        return (
          <div key={e.toolUseId + e.filePath} className="m-tp-diff-card">
            <div className="m-diff-path">{e.filePath}</div>
            <div className="m-diff-stats">
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
              <button
                style={{ float: 'right', background: 'transparent', border: '1px solid var(--crimson-deep)', color: 'var(--crimson)', padding: '2px 8px', fontSize: 11 }}
                onClick={() => revert(e.filePath, e.before)}
                disabled={busy === e.filePath}
              >{busy === e.filePath ? '…' : 'revert'}</button>
            </div>
            {e.truncated && <div style={{ fontSize: 11, color: '#f0a060', marginTop: 4 }}>⚠ snapshot truncated</div>}
            <pre>{lines.map((l, i) => {
              let cls = 'ctx';
              if (l.startsWith('+')) cls = 'add';
              else if (l.startsWith('-')) cls = 'del';
              else if (l.startsWith('@@')) cls = 'hunk';
              return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
            })}</pre>
          </div>
        );
      })}
    </>
  );
}

function TodosTab({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return <div className="m-tp-empty">no todo</div>;
  return (
    <ul className="m-tp-todo-list">
      {todos.map((t, i) => (
        <li key={i} className={`todo-${t.status}`}>
          <span className="m-chk">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}</span>
          <span>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function CallsTab({ calls }: { calls: ToolCallEntry[] }) {
  if (calls.length === 0) return <div className="m-tp-empty">no tool call</div>;
  return (
    <ul className="m-tp-calls-list">
      {calls.slice().reverse().map((c) => (
        <li key={c.id} className={c.result?.isError ? 'err' : ''}>
          <div>
            <span className="name">{c.name}</span>
            <span style={{ float: 'right', color: 'var(--parchment-soft)' }}>{fmtTime(c.startedAt)}</span>
          </div>
          <div className="input">{summarizeToolInput(c.name, c.input)}</div>
          {c.result && (
            <div style={{ fontSize: 10, color: c.result.isError ? 'var(--crimson)' : 'var(--parchment-soft)', marginTop: 2 }}>
              {c.result.isError ? '✗' : '✓'} {c.result.content.slice(0, 80)}{c.result.content.length > 80 ? '…' : ''}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Read':       return String(input.file_path ?? '');
    case 'Edit':       return String(input.file_path ?? '') + (input.replace_all ? ' (replace_all)' : '');
    case 'Write':      return String(input.file_path ?? '');
    case 'MultiEdit':  return String(input.file_path ?? '') + ` (${(input.edits ?? []).length} edits)`;
    case 'Bash':       return String(input.command ?? '').slice(0, 100);
    case 'Grep':       return `"${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Glob':       return String(input.pattern ?? '');
    case 'TodoWrite':  return `${(input.todos ?? []).length} todos`;
    case 'WebFetch':   return String(input.url ?? '');
    case 'WebSearch':  return String(input.query ?? '');
    default: {
      const keys = Object.keys(input);
      if (keys.length === 0) return '';
      const first = keys[0];
      const v = input[first];
      return `${first}=${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`;
    }
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtElapsed(s: number): string {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

// rebuildStateFromMessages: extracted to `app/sessionRebuild.ts` (shared
// with ClaudePanel desktop). Import at the top of the file.
