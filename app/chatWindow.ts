'use client';
// The transcript's mounted window (CLAUDE.md §14.128): only the rows near the
// viewport are in the DOM; the others are two spacers of their measured (or
// estimated) heights. Every mounted bubble is paid on each style, layout and
// hit test — a session switch used to build all of them at once.
//
// The chat column is `flex-direction: column-reverse` (SessionView): DOM order
// = newest first = visual bottom first, and the browser keeps `scrollTop` =
// the distance from the BOTTOM. So the window is computed in "distance from
// the list's bottom" coordinates:
//   · `keys` are newest first; row i's bottom sits `S[i]` above the list's
//     bottom, its top `S[i] + h(i)` (S = prefix sums of h + gap; a row that
//     draws nothing, `.vrow:empty`, takes no height and no gap);
//   · rows ABOVE the viewport changing height never move what is read (the
//     bottom origin absorbs it); rows BELOW it do. A row measured for the
//     first time while below the viewport (a jump into history, then reading
//     down) swaps its estimate for its height: the difference is scrolled
//     back before paint, nothing else is (a bubble growing below behaves as
//     it always did);
//   · the range is kept by KEYS (a new row at either end never shifts it),
//     with hysteresis: re-cut only when the viewport ± HALF the overscan
//     leaves it, then to ± the overscan.
// Hidden (a kept-alive pane, <Activity>): effects are unmounted, nothing is
// measured at size 0; shown again, the layout effect re-measures.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Rows mounted on the first frame, before anything is measured. */
const INITIAL_ROWS = 24;
/** Pixels mounted beyond each edge of the viewport (at least). */
const MIN_OVERSCAN_PX = 900;
/** Alignment passes of one `scrollToKey` (estimates converge in 2–3). */
const ALIGN_TRIES = 5;
/** Where an aligned row's top lands below the chat's top edge. */
const ALIGN_MARGIN_PX = 16;

export type ChatWindowController = {
  /** Mount `key`'s row and put its top under the chat's top edge. False when
   *  the row is not loaded. */
  scrollToKey(key: string, opts?: { smooth?: boolean }): boolean;
  /** The newest row is mounted (the reader is at or near the live end). */
  atNewest(): boolean;
  /** The newest row (newest first) whose top is above the viewport's top by
   *  more than 4px and that passes `test` — the one an "up" step lands on. */
  findAbove(test: (key: string) => boolean): string | null;
  /** The mounted row element of `key`, if mounted. */
  rowElement(key: string): HTMLElement | null;
};

type Range = { startKey: string | null; endKey: string | null };

export function useChatWindow(o: {
  /** Newest first. */
  keys: readonly string[];
  /** Height guess for a row never measured (0 = draws nothing). */
  estimate: (index: number) => number;
  scrollerRef: RefObject<HTMLElement | null>;
  controllerRef?: { current: ChatWindowController | null };
}): { start: number; end: number; bottomSpace: number; topSpace: number } {
  const { keys, estimate, scrollerRef, controllerRef } = o;
  const heights = useRef(new Map<string, number>()).current;
  const gapRef = useRef(10);
  const [range, setRange] = useState<Range>(() => ({
    startKey: null,
    endKey: keys.length ? keys[Math.min(keys.length, INITIAL_ROWS) - 1]! : null,
  }));
  // What the layout effect needs from the render, without re-creating it.
  const live = useRef({ keys, estimate, range });
  live.current = { keys, estimate, range };
  const alignRef = useRef<{ key: string; tries: number; smooth: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const observed = useRef(new Map<string, Element>()).current;
  const roRef = useRef<ResizeObserver | null>(null);

  const indexOf = (k: string | null, fallback: number) => {
    if (k == null) return fallback;
    const i = keys.indexOf(k);
    return i < 0 ? fallback : i;
  };
  const start = range.startKey == null ? 0 : indexOf(range.startKey, 0);
  let end = range.endKey == null ? Math.min(keys.length, start + INITIAL_ROWS) : indexOf(range.endKey, -1) + 1;
  if (end <= start) end = Math.min(keys.length, start + INITIAL_ROWS);

  const contrib = (i: number) => {
    const h = heights.get(keys[i]!) ?? estimate(i);
    return h > 0 ? h + gapRef.current : 0;
  };
  let bottomSum = 0;
  for (let i = 0; i < start; i++) bottomSum += contrib(i);
  let topSum = 0;
  for (let i = end; i < keys.length; i++) topSum += contrib(i);
  // A spacer is one flex item: the gap after it is already the last row's.
  const bottomSpace = bottomSum > 0 ? Math.max(0, bottomSum - gapRef.current) : 0;
  const topSpace = topSum > 0 ? Math.max(0, topSum - gapRef.current) : 0;

  /** Measures the mounted rows, compensates first measurements below the
   *  viewport, aligns a pending jump, then re-cuts the range if needed. */
  const settleRef = useRef<() => void>(() => {});
  settleRef.current = () => {
    const el = scrollerRef.current;
    if (!el || el.clientHeight === 0) return;   // hidden: nothing to read
    const { keys: ks, estimate: est, range: cur } = live.current;
    const gap = gapRef.current;
    const box = el.getBoundingClientRect();
    const viewTop = box.top + el.clientTop;
    const viewBottom = viewTop + el.clientHeight;
    const atBottom = Math.abs(el.scrollTop) < 2;
    const index = new Map<string, number>();
    ks.forEach((k, i) => index.set(k, i));

    // 1. Measure. A first measurement below the viewport replaces the
    //    estimate the spacer used: scroll that difference back.
    let shift = 0;
    let anchor: { i: number; bottom: number } | null = null;
    const ro = roRef.current;
    const seen = new Set<string>();
    for (const child of el.children) {
      const key = (child as HTMLElement).dataset?.vkey;
      if (key == null) continue;
      const i = index.get(key);
      if (i == null) continue;
      seen.add(key);
      if (ro && !observed.has(key)) { ro.observe(child); observed.set(key, child); }
      const r = child.getBoundingClientRect();
      const h = r.height;
      const before = heights.get(key);
      if (before === undefined && !atBottom && r.top >= viewBottom - 1) {
        const e = est(i);
        shift += (h > 0 ? h + gap : 0) - (e > 0 ? e + gap : 0);
      }
      heights.set(key, h);
      if (h > 0 && (anchor == null || i < anchor.i)) anchor = { i, bottom: r.bottom };
    }
    for (const [k, node] of observed) {
      if (!seen.has(k)) { ro?.unobserve(node); observed.delete(k); }
    }
    if (shift !== 0) el.scrollTop -= shift;

    // 2. A pending jump: align the row's top, again until it holds.
    const pending = alignRef.current;
    if (pending) {
      const node = observed.get(pending.key) as HTMLElement | undefined;
      if (node) {
        const delta = node.getBoundingClientRect().top - (viewTop + ALIGN_MARGIN_PX);
        if (Math.abs(delta) > 1) {
          if (pending.smooth && pending.tries === 0) el.scrollBy({ top: delta, behavior: 'smooth' });
          else el.scrollTop += delta;
        }
        pending.tries += 1;
        if (Math.abs(delta) <= 1 || pending.tries >= ALIGN_TRIES || pending.smooth) alignRef.current = null;
        else schedule();
      }
    }

    // 3. The band to cover, in distance-from-the-list-bottom coordinates.
    if (!ks.length) return;
    const n = ks.length;
    const S = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const h = heights.get(ks[i]!) ?? est(i);
      S[i + 1] = S[i]! + (h > 0 ? h + gap : 0);
    }
    let listBottom: number;
    if (anchor) {
      listBottom = anchor.bottom + S[anchor.i]!;
    } else {
      // Nothing mounted draws anything: the window is wherever it is.
      return;
    }
    const lo = listBottom - (viewBottom - 0);
    const hi = lo + el.clientHeight;
    const over = Math.max(MIN_OVERSCAN_PX, el.clientHeight);
    const firstFrom = (bound: number) => {   // first i whose top is above `bound`
      let a = 0, b = n;
      while (a < b) { const m = (a + b) >> 1; if (S[m + 1]! - gap > bound) b = m; else a = m + 1; }
      return a;
    };
    const firstAtOrAbove = (bound: number) => { // first i whose bottom is ≥ bound
      let a = 0, b = n;
      while (a < b) { const m = (a + b) >> 1; if (S[m]! >= bound) b = m; else a = m + 1; }
      return a;
    };
    const curStart = cur.startKey == null ? 0 : (index.get(cur.startKey) ?? 0);
    const curEnd = cur.endKey == null ? Math.min(n, curStart + INITIAL_ROWS) : (index.get(cur.endKey) ?? curStart) + 1;
    const needStart = firstFrom(lo - over / 2);
    const needEnd = Math.max(needStart + 1, Math.min(n, firstAtOrAbove(hi + over / 2)));
    // A pending jump's row must be inside.
    const pin = alignRef.current ? index.get(alignRef.current.key) : undefined;
    // Covered, and not grown far past the need (a reader parked at the live
    // end while rows keep arriving mounts each new one).
    const covered = curStart <= needStart && curEnd >= needEnd
      && (pin == null || (pin >= curStart && pin < curEnd))
      && curEnd - curStart <= 3 * (needEnd - needStart) + INITIAL_ROWS;
    if (covered) return;
    let s = firstFrom(lo - over);
    let e = Math.max(s + 1, Math.min(n, firstAtOrAbove(hi + over)));
    if (pin != null) { s = Math.min(s, pin); e = Math.max(e, pin + 1); }
    const next: Range = { startKey: s === 0 ? null : ks[s]!, endKey: ks[e - 1]! };
    if (next.startKey !== cur.startKey || next.endKey !== cur.endKey) setRange(next);
  };

  function schedule() {
    if (rafRef.current != null || typeof window === 'undefined') return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      settleRef.current();
    });
  }

  // After every commit: measure what is mounted and settle (before paint).
  useLayoutEffect(() => { settleRef.current(); });

  // Scroll, resizes, the gap (density): settle on the next frame.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const readGap = () => {
      const g = parseFloat(getComputedStyle(el).rowGap);
      if (Number.isFinite(g)) gapRef.current = g;
    };
    readGap();
    const ro = new ResizeObserver(() => { readGap(); schedule(); });
    roRef.current = ro;
    ro.observe(el);
    const onScroll = () => schedule();
    el.addEventListener('scroll', onScroll, { passive: true });
    settleRef.current();
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      roRef.current = null;
      observed.clear();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerRef]);

  // The controller the transcript's navigation goes through.
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      scrollToKey(key, opts) {
        const { keys: ks } = live.current;
        const i = ks.indexOf(key);
        if (i < 0) return false;
        alignRef.current = { key, tries: 0, smooth: !!opts?.smooth && observed.has(key) };
        const { range: cur } = live.current;
        const s = cur.startKey == null ? 0 : ks.indexOf(cur.startKey);
        const e = cur.endKey == null ? s + 1 : ks.indexOf(cur.endKey) + 1;
        if (i >= s && i < e && observed.has(key)) settleRef.current();
        else {
          // Mount a window around it now; the layout effect aligns.
          const half = INITIAL_ROWS >> 1;
          const ns = Math.max(0, i - half);
          const ne = Math.min(ks.length, i + half + 1);
          setRange({ startKey: ns === 0 ? null : ks[ns]!, endKey: ks[ne - 1]! });
        }
        return true;
      },
      atNewest() {
        return live.current.range.startKey == null;
      },
      findAbove(test) {
        const el = scrollerRef.current;
        if (!el) return null;
        const { keys: ks, estimate: est } = live.current;
        const viewTop = el.getBoundingClientRect().top + el.clientTop;
        // Mounted rows: measured on screen. Above them, every row's top is
        // above the viewport anyway (spacer): the first that passes.
        let lastMounted = -1;
        for (let i = 0; i < ks.length; i++) {
          const node = observed.get(ks[i]!) as HTMLElement | undefined;
          if (!node) {
            if (lastMounted >= 0 && i > lastMounted) {
              if (test(ks[i]!) && (heights.get(ks[i]!) ?? est(i)) > 0) return ks[i]!;
            }
            continue;
          }
          lastMounted = i;
          const top = node.getBoundingClientRect().top;
          if (top < viewTop - 4 && node.getBoundingClientRect().height > 0 && test(ks[i]!)) return ks[i]!;
        }
        return null;
      },
      rowElement(key) {
        return (observed.get(key) as HTMLElement | undefined) ?? null;
      },
    };
    return () => { if (controllerRef.current) controllerRef.current = null; };
  }, [controllerRef, scrollerRef, observed, heights]);

  return { start, end, bottomSpace, topSpace };
}
