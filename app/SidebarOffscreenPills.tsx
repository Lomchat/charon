'use client';
// Rows lit for attention that sit ABOVE or BELOW the visible part of the
// sidebar: one pill per colour at the top centre (under the pinned server
// head) and at the bottom centre — a triangle pointing where they are and how
// many. A click scrolls to the nearest of that colour in that direction
// (unfolding a collapsed group first); the next click, to the one after.
// What counts and where it sits: app/sidebarOffscreen.ts.
//
// Mounted as the FIRST child of `.cs-scroll`: a zero-height sticky layer
// pinned to the scroller's top edge, its rows placed from measurements — no
// wrapper around the list, nothing for the aside's own positioning to change.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { tipAttrs } from './tooltipText';
import {
  anchorSelector, countOffscreen, nearestOffscreen, OFFSCREEN_WORDS, sameCounts,
  type OffscreenCount, type OffscreenKind, type OffscreenSide, type OffscreenTarget, type PlacedTarget,
} from './sidebarOffscreen';

/** Pill height + its gap to the edge it hangs from (CSS `.cs-offscreen-pill`). */
const PILL_H = 22;
const EDGE_GAP = 6;
/** Frames a reveal waits for the unfolded card to mount (a folder unfolds
 *  through the server: allow a couple of seconds). */
const REVEAL_FRAMES = 150;

type View = { pin: number; height: number; up: OffscreenCount[]; down: OffscreenCount[] };
const EMPTY: View = { pin: 0, height: 0, up: [], down: [] };

function sameView(a: View, b: View): boolean {
  return a.pin === b.pin && a.height === b.height && sameCounts(a.up, b.up) && sameCounts(a.down, b.down);
}

/** The triangle, pointing the way the rows are. */
function Tri({ side }: { side: OffscreenSide }) {
  return (
    <svg className="cs-offscreen-tri" viewBox="0 0 10 8" aria-hidden>
      <path d={side === 'up' ? 'M5 0L10 8H0Z' : 'M0 0H10L5 8Z'} />
    </svg>
  );
}

/** A collapsed server's lit rows (its head, app/Sidebar.tsx): a dot + count
 *  per colour. */
export function CollapsedAttention({ counts }: { counts: readonly OffscreenCount[] }) {
  if (!counts.length) return null;
  return (
    <span className="cs-vps-attention"
      title={counts.map((c) => `${c.count} ${OFFSCREEN_WORDS[c.kind]}`).join(' · ')}>
      {counts.map((c) => (
        <span key={c.kind} className={`cs-vps-attention-n ${c.kind}`}><i aria-hidden />{c.count}</span>
      ))}
    </span>
  );
}

export default function SidebarOffscreenPills({ scrollRef, targets, onReveal }: {
  scrollRef: RefObject<HTMLElement | null>;
  targets: readonly OffscreenTarget[];
  /** Unfold the groups hiding `t` (its `reveal`). */
  onReveal: (t: OffscreenTarget) => void;
}) {
  const [view, setView] = useState<View>(EMPTY);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const frame = useRef(0);
  const revealRun = useRef(0);

  /** Every target's anchor, measured, and the visible band: from under the
   *  pinned server head (a card beneath it is covered) to the bottom edge. */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !targetsRef.current.length) return null;
    const box = el.getBoundingClientRect();
    let covered = box.top;
    for (const head of el.querySelectorAll<HTMLElement>('.cs-vps-head')) {
      const r = head.getBoundingClientRect();
      if (r.top <= box.top + 1 && r.bottom > box.top) covered = Math.max(covered, r.bottom);
    }
    const placed: PlacedTarget[] = [];
    for (const t of targetsRef.current) {
      const a = el.querySelector(anchorSelector(t.anchor));
      if (!a) continue;
      const r = a.getBoundingClientRect();
      placed.push({ id: t.id, kind: t.kind, top: r.top, bottom: r.bottom });
    }
    return { el, box, placed, view: { top: covered, bottom: box.bottom } };
  }, [scrollRef]);

  const update = useCallback(() => {
    frame.current = 0;
    const m = measure();
    const next: View = m
      ? { pin: Math.round(m.view.top - m.box.top), height: Math.round(m.box.height), ...countOffscreen(m.placed, m.view) }
      : EMPTY;
    setView((prev) => (sameView(prev, next) ? prev : next));
  }, [measure]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(update);
  }, [update]);

  // A new set of lit rows (or a group folding over one): re-read before paint.
  const key = targets.map((t) => `${t.id}:${t.kind}:${t.anchor.kind}`).join('|');
  useLayoutEffect(() => { update(); }, [key, update]);

  // Scrolling, the scroller resizing, rows mounting or growing: one read per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(schedule);
    const observe = () => {
      ro.disconnect();
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    };
    observe();
    const mo = new MutationObserver(() => { observe(); schedule(); });
    mo.observe(el, { childList: true, subtree: true });
    el.addEventListener('scroll', schedule, { passive: true });
    return () => {
      el.removeEventListener('scroll', schedule);
      ro.disconnect();
      mo.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      revealRun.current += 1;
    };
  }, [scrollRef, schedule]);

  function jump(side: OffscreenSide, kind: OffscreenKind) {
    const m = measure();
    if (!m) return;
    const id = nearestOffscreen(m.placed, m.view, side, kind);
    const target = id ? targetsRef.current.find((t) => t.id === id) : undefined;
    if (!target) return;
    if (target.anchor.kind !== 'row') onReveal(target);
    const run = ++revealRun.current;
    let frames = 0;
    const land = () => {
      if (run !== revealRun.current) return;
      const el = scrollRef.current;
      const row = el?.querySelector<HTMLElement>(anchorSelector({ kind: 'row', key: target.id }));
      if (!el || !row) {
        if (++frames < REVEAL_FRAMES) requestAnimationFrame(land);
        return;
      }
      const box = el.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      el.scrollTo({ top: el.scrollTop + r.top - box.top - (box.height - r.height) / 2, behavior: 'smooth' });
      // Where you landed: a short ring, drawn by the animation itself (the
      // card's class list belongs to React).
      const ring = getComputedStyle(row).getPropertyValue('--text-strong').trim() || 'currentColor';
      row.animate?.([
        { outline: `2px solid ${ring}`, outlineOffset: '1px' },
        { outline: '2px solid transparent', outlineOffset: '1px' },
      ], { duration: 1400, delay: 250, easing: 'ease-out' });
    };
    land();
  }

  const rows: [OffscreenSide, OffscreenCount[], number][] = [
    ['up', view.up, view.pin + EDGE_GAP],
    ['down', view.down, view.height - PILL_H - EDGE_GAP],
  ];
  return (
    <div className="cs-offscreen">
      {rows.map(([side, counts, top]) => counts.length > 0 && (
        <div key={side} className="cs-offscreen-row" style={{ top }}>
          {counts.map((c) => {
            const where = side === 'up' ? 'above' : 'below';
            return (
              <button key={c.kind} type="button" className={`cs-offscreen-pill ${c.kind}`}
                onClick={() => jump(side, c.kind)}
                aria-label={`${c.count} ${OFFSCREEN_WORDS[c.kind]} ${where} — scroll to the nearest`}
                title={`${c.count} ${OFFSCREEN_WORDS[c.kind]} ${where}`}
                {...tipAttrs({ actions: [['Click', 'scroll to the nearest']] })}>
                <Tri side={side} />{c.count}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
