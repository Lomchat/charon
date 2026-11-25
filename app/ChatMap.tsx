'use client';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ChatWindowController } from './chatWindow';

// ── ChatMap ──────────────────────────────────────────────────────────────────
// The conversation's map beside the scrollbar: a tick per user message (green)
// and per final agent answer (blue), where it sits in the scroll height; a
// click goes there, a hover opens its card on the left (who, when, the first
// lines). Positions come from the transcript window (`rowTops`:
// measured rows, estimates for the rest). Re-read on its own (debounced):
// rows changing, the chat resizing, a scroll settling, and `refreshRef` (the
// window's row resizes, a bubble growing while it streams).

export type ChatMapRow = { key: string; role: 'user' | 'agent'; text: string; /** s */ at: number };
type Tick = ChatMapRow & { y: number };

const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 1000;
/** The strip's inset from the chat's top and bottom. */
const INSET = 4;
/** Where the card's arrow sits below its top, when nothing clamps it. */
const ARROW = 18;

/** 11:28 today, 24/11 18:02 before. */
function when(at: number): string {
  if (!at) return '';
  const d = new Date(at * 1000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

function sameTicks(a: Tick[], b: Tick[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.key !== y.key || x.y !== y.y || x.role !== y.role || x.text !== y.text || x.at !== y.at) return false;
  }
  return true;
}

function ChatMap({ rows, scrollerRef, windowRef, refreshRef }: {
  rows: ChatMapRow[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  windowRef: RefObject<ChatWindowController | null>;
  /** Set to this map's (debounced) refresh, for the window's row resizes. */
  refreshRef: { current: (() => void) | null };
}) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [scrollbar, setScrollbar] = useState(0);
  const rowsRef = useRef(rows);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstAsk = useRef(0);

  const compute = useCallback(() => {
    timer.current = null;
    firstAsk.current = 0;
    const el = scrollerRef.current;
    const layout = windowRef.current?.rowTops() ?? null;
    if (!el || !layout || el.scrollHeight <= el.clientHeight + 4) {
      setTicks((cur) => (cur.length ? [] : cur));
      return;
    }
    setScrollbar(el.offsetWidth - el.clientWidth);
    const index = new Map(layout.keys.map((k, i) => [k, i] as const));
    const h = Math.max(0, el.clientHeight - 2 * INSET);
    const next: Tick[] = [];
    for (const r of rowsRef.current) {
      const i = index.get(r.key);
      if (i == null) continue;
      const y = Math.round(Math.min(1, Math.max(0, layout.tops[i]! / layout.total)) * h);
      next.push({ ...r, y });
    }
    setTicks((cur) => (sameTicks(cur, next) ? cur : next));
  }, [scrollerRef, windowRef]);

  /** Trailing debounce, at most MAX_WAIT_MS behind the first ask. */
  const refresh = useCallback(() => {
    const now = Date.now();
    if (!firstAsk.current) firstAsk.current = now;
    if (timer.current) clearTimeout(timer.current);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstAsk.current + MAX_WAIT_MS - now));
    timer.current = setTimeout(compute, wait);
  }, [compute]);

  useEffect(() => {
    rowsRef.current = rows;
    refresh();
  }, [rows, refresh]);

  useEffect(() => {
    refreshRef.current = refresh;
    const el = scrollerRef.current;
    const ro = el ? new ResizeObserver(refresh) : null;
    if (el && ro) { ro.observe(el); el.addEventListener('scroll', refresh, { passive: true }); }
    return () => {
      if (refreshRef.current === refresh) refreshRef.current = null;
      ro?.disconnect();
      el?.removeEventListener('scroll', refresh);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [refresh, refreshRef, scrollerRef]);

  // The hovered tick's card. Leaving waits a beat: sliding to a neighbour
  // moves the card instead of blinking it.
  const [hover, setHover] = useState<Tick | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = (t: Tick) => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    setHover(t);
  };
  const leave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHover(null); }, 120);
  };
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  // Placed beside its tick, kept inside the chat; the arrow keeps pointing at it.
  const peekRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = peekRef.current;
    const el = scrollerRef.current;
    if (!card || !el || !hover) return;
    const tickY = hover.y + INSET;
    const top = Math.max(4, Math.min(el.clientHeight - card.offsetHeight - 4, tickY - ARROW));
    card.style.top = `${top}px`;
    card.style.setProperty('--peek-arrow', `${tickY - top + 1}px`);
  }, [hover, scrollerRef]);

  if (!ticks.length) return null;
  // Clear of the scrollbar, and of the tools panel's resize edge (3 px into
  // the chat) when the scrollbar overlays (width 0).
  const right = Math.max(scrollbar, 4);
  return (
    <>
      <div className="app-chat-map" style={{ right }} aria-hidden>
        {ticks.map((t) => (
          <button key={t.key} type="button" tabIndex={-1}
            className={`app-chat-tick ${t.role}${hover?.key === t.key ? ' is-on' : ''}`} style={{ top: t.y + INSET }}
            onMouseEnter={() => enter(t)} onMouseLeave={leave}
            onClick={() => windowRef.current?.scrollToKey(t.key, { smooth: true })} />
        ))}
      </div>
      {hover && (
        <div ref={peekRef} className={`app-chat-peek ${hover.role}`} style={{ right: right + 16 }} aria-hidden>
          <div className="app-chat-peek-top"><span>{hover.role === 'user' ? 'you' : 'agent'}</span><time>{when(hover.at)}</time></div>
          <div className="app-chat-peek-text">{hover.text}</div>
        </div>
      )}
    </>
  );
}

export default memo(ChatMap);
