'use client';
// The robot's conversation, in its drawer.
//
// Charon's own transcript, not a copy of it: the same hook (`useSessionStream`)
// asked for the CONVERSATION view — no tool rows, never fetched (§14.25) — and
// drawn with Charon's own bubbles (`Message`). The newest message sits at the
// foot, the answer being written streams in under it, and scrolling up pages
// the older ones in. On its side, Charon's own pills: ↑ walks up the agent's
// messages — from the foot, to the TOP of the last one — and ↓ comes back.
//
// One instance per session: mount it with `key={session.id}`.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Message, { type Msg } from '@/app/Message';
import { RecapNote, recapToShow } from '@/app/SessionView';
import { chatBubbleAbove } from '@/app/chatScroll';
import { shouldShowChatRole } from '@/app/chatVisibility';
import { extendWithOlder, fetchAndCache, getCached, invalidate } from '@/app/sessionCache';
import { liveStreamingMessage } from '@/app/sync/transcriptReducer';
import { useSessionStream, type StreamCache } from '@/app/useSessionStream';
import { asSessionProvider } from '@/lib/sessionCapabilities';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { AgentKind } from '@/lib/types/api';

// The transcript cache Charon's session view fills too: a robot opened in full
// after its drawer (or the other way round) paints at once.
const CACHE: StreamCache = {
  get: (id, view) => getCached(id, view),
  fetch: (id, opts) => fetchAndCache(id, opts),
  invalidate: (id) => invalidate(id),
  extendWithOlder: (id, older, view) => extendWithOlder(id, older, view),
};

/** Bubbles mounted at once. A window holds a couple of hundred messages, and
 *  the drawer opens on every robot picked: only the last ones are drawn, more
 *  as the reader goes up. */
const BATCH = 30;

/** Rows only the full view can answer (its own strip): the drawer's note says
 *  "it has a question", and Open goes there. */
const FULL_VIEW_ONLY = new Set(['async_question']);

// Finished messages never change while an answer streams: kept in a memoized
// child, a delta redraws the live bubble alone (§14.38).
const History = memo(function History({ rows, liveRow, kind, vpsId, cwd }: {
  rows: Msg[]; liveRow: Msg | null; kind: AgentKind; vpsId: string; cwd: string | null;
}) {
  // Newest first in the DOM: the box is a reversed column (its foot is its origin).
  return [...rows].reverse().map((msg) => {
    const live = liveRow && liveRow.id === msg.id ? liveRow : null;
    return <Message key={msg.id} m={live ?? msg} streaming={!!live} kind={kind} vpsId={vpsId} cwd={cwd} />;
  });
});

export default function UnitTalk({ session }: { session: SessionSummary }) {
  const {
    messages, currentAssistant, streamingInto, status, error, isLoadingHistory, hasMore, isLoadingMore, loadMoreHistory,
  } = useSessionStream(session.id, { cache: CACHE, view: 'conversation', provider: asSessionProvider(session.kind) });

  const rows = useMemo(
    () => messages.filter((m) => shouldShowChatRole(m.role, false) && !FULL_VIEW_ONLY.has(m.role)),
    [messages],
  );
  // The text being written: its own bubble, or the row it extends.
  const live = useMemo(
    () => liveStreamingMessage(messages, { assistant: currentAssistant, streamingInto, thinkingOpen: '' }),
    [messages, currentAssistant, streamingInto],
  );
  const recap = useMemo(
    () => recapToShow(session.recap ?? null, messages, status === 'thinking' || status === 'starting' || !!currentAssistant),
    [session.recap, messages, status, currentAssistant],
  );

  // Near the top ⇒ more of what is loaded, then the page before. In a
  // reversed column `scrollTop` is 0 at the foot and moves away from it
  // (negative in Chrome) on the way up.
  const [shown, setShown] = useState(BATCH);
  const drawn = useMemo(() => (rows.length > shown ? rows.slice(rows.length - shown) : rows), [rows, shown]);
  const held = rows.length - drawn.length;
  const older = useCallback(() => {
    if (held > 0) setShown((n) => n + BATCH);
    else if (hasMore && !isLoadingMore) void loadMoreHistory();
  }, [held, hasMore, isLoadingMore, loadMoreHistory]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  // Where the reader stands, for the side pills: at the foot, at the very top.
  const [edge, setEdge] = useState({ foot: true, top: true });
  const page = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const travel = box.scrollHeight - box.clientHeight;
    const gone = Math.abs(box.scrollTop);
    const foot = gone < 80;
    // Within the box's own padding of the top is the top.
    const top = travel <= 0 || travel - gone < 16;
    setEdge((e) => (e.foot === foot && e.top === top ? e : { foot, top }));
    // Nothing to scroll yet: the button below asks, never a loop of fetches.
    if (travel > 0 && travel - gone < Math.max(300, box.clientHeight)) older();
  }, [older]);
  const onScroll = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; page(); });
  }, [page]);
  useEffect(() => () => { if (frameRef.current != null) cancelAnimationFrame(frameRef.current); }, []);

  const kind = session.kind as AgentKind;
  const empty = rows.length === 0 && !live;
  const more = held > 0 || hasMore;
  // What is drawn changed: so did how far there is to go.
  useEffect(() => { onScroll(); }, [drawn.length, isLoadingHistory, onScroll]);

  // ↑: the closest agent message whose top is above — at the foot of a long
  // answer, the start of that answer; then one message up per click (Charon's
  // own step, app/chatScroll.ts). None left above: older ones, then the top.
  const up = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const target = chatBubbleAbove(box, 'assistant');
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else if (more) older();
    else (box.lastElementChild as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [more, older]);
  const down = useCallback(() => boxRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), []);

  return (
    // `data-theme`: Charon's dark tokens here, whatever theme the app wears —
    // the drawer is the desk's, and the desk is a night scene.
    <div className="dk-talk-wrap" data-theme="nordic">
    {/* `app-chat`: Charon's reversed column and its bubble rules (app.css). */}
    <div className="app-chat dk-talk" ref={boxRef} onScroll={onScroll} aria-label="conversation">
      {isLoadingHistory ? (
        <p className="dk-talk-note" role="status">{error ? error.msg : 'loading messages…'}</p>
      ) : empty ? (
        <p className="dk-talk-note">No message yet.</p>
      ) : (
        <>
          {recap && <RecapNote recap={recap} />}
          {live?.id === '__streaming' && <Message m={live} streaming kind={kind} vpsId={session.vpsId} cwd={session.cwd} />}
          <History rows={drawn} liveRow={live?.id === '__streaming' ? null : live} kind={kind} vpsId={session.vpsId} cwd={session.cwd} />
          {more || isLoadingMore ? (
            <p className="dk-talk-note" role="status">
              {isLoadingMore ? 'loading older messages…' : <button type="button" onClick={older}>↑ older messages</button>}
            </p>
          ) : (
            <p className="dk-talk-note">— start of the conversation —</p>
          )}
        </>
      )}
    </div>
    {/* Charon's side pills (app.css), each at its own fixed place. */}
    {!empty && !isLoadingHistory && (!edge.top || more) && (
      <button type="button" className="app-scroll-up-pill is-agent" onClick={up}
        aria-label="scroll up to the previous agent message" title="previous agent message — from the foot: the top of the last one">
        <span className="app-scroll-arrow">▴</span>
      </button>
    )}
    {!edge.foot && (
      <button type="button" className="app-scroll-pill" onClick={down} aria-label="go to the last message" title="go to the last message">
        <span className="app-scroll-arrow">▾</span>
      </button>
    )}
    </div>
  );
}
