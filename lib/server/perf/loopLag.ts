import 'server-only';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Event-loop lag instrumentation. better-sqlite3 is synchronous: one heavy
// query blocks the hub's ONLY thread, and with it every SSE frame, heartbeat
// and agent event. This module makes such stalls visible and attributable:
//
//   - `timeSection(label, fn)` times a SYNCHRONOUS section (a returned promise
//     is not awaited: only the sync part blocks the loop). > 100 ms ⇒ recorded
//     in a ring of 32; > 250 ms ⇒ `[perf] <label> <ms>ms` right away.
//   - a 60 s summary of `monitorEventLoopDelay` warns
//     `[eventloop] 60s p50=… p99=… max=…ms slow=[…]` when max > 200 ms;
//   - a 500 ms drift ticker warns `[eventloop] stall Nms; recent: …` as soon as
//     one gap between ticks exceeds 1000 ms. A late timer cannot run DURING a
//     stall, so the report comes after it and names the slow sections that
//     ended inside the gap — that list is the attribution.
//
// All state lives on ONE globalThis object (`__charonLoopLag`, created with
// `??=`): with module copies (tests' `vi.resetModules()`, dev rebuilds), a module-level `let` would give each
// copy its own ring and its own timers.

export type LoopLagSnapshot = {
  p50: number; p99: number; max: number; stalls1h: number;
  slow: Array<{ label: string; ms: number; at: number }>;
};

/** The slice of `IntervalHistogram` this module reads (injectable for tests). */
type LagHistogram = {
  readonly count: number;
  readonly max: number;
  percentile(p: number): number;
  reset(): void;
  enable(): void;
  disable(): void;
};

type SlowSection = { label: string; ms: number; at: number };

type LoopLagState = {
  now: () => number;
  warn: (m: string) => void;
  started: boolean;
  histogram: LagHistogram | null;
  driftTimer: ReturnType<typeof setInterval> | null;
  summaryTimer: ReturnType<typeof setInterval> | null;
  lastTick: number;
  lastSummaryAt: number;
  /** Ring of the last RING_SIZE slow sections, oldest first. */
  slow: SlowSection[];
  /** Label of the last timeSection that finished, slow or not. */
  lastLabel: string | null;
  /** `now()` of every stall within the last hour. */
  stalls: number[];
  /** The last completed 60 s window (served while the current one is empty). */
  lastWindow: { p50: number; p99: number; max: number } | null;
};

const RESOLUTION_MS = 20;
const SUMMARY_EVERY_MS = 60_000;
const SUMMARY_WARN_MAX_MS = 200;
const DRIFT_EVERY_MS = 500;
const STALL_GAP_MS = 1_000;
const SLOW_RING_MS = 100;
const SLOW_WARN_MS = 250;
const RING_SIZE = 32;
const HOUR_MS = 3_600_000;
const MAX_STALLS_KEPT = 1_000;

// Monotonic, but on the epoch scale so `at` reads as a timestamp.
const defaultNow = () => performance.timeOrigin + performance.now();
// Looked up at call time: a test spying on console.warn must see the calls.
const defaultWarn = (m: string) => { console.warn(m); };

const g = globalThis as typeof globalThis & { __charonLoopLag?: LoopLagState };

function state(): LoopLagState {
  return g.__charonLoopLag ??= {
    now: defaultNow,
    warn: defaultWarn,
    started: false,
    histogram: null,
    driftTimer: null,
    summaryTimer: null,
    lastTick: 0,
    lastSummaryAt: 0,
    slow: [],
    lastLabel: null,
    stalls: [],
    lastWindow: null,
  };
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;
const fmtSlow = (s: SlowSection) => `${s.label} ${Math.round(s.ms)}ms`;

/** Histogram values are nanoseconds and include the sampling interval (an idle
 *  loop reads ≈ RESOLUTION_MS); the lag is what exceeds it. */
function readWindow(h: LagHistogram): { p50: number; p99: number; max: number } {
  if (!(h.count > 0)) return { p50: 0, p99: 0, max: 0 };
  const lag = (ns: number) => round1(Math.max(0, ns / 1e6 - RESOLUTION_MS));
  return { p50: lag(h.percentile(50)), p99: lag(h.percentile(99)), max: lag(h.max) };
}

function pruneStalls(st: LoopLagState, t: number): void {
  const cutoff = t - HOUR_MS;
  let drop = 0;
  while (drop < st.stalls.length && st.stalls[drop] <= cutoff) drop += 1;
  if (drop) st.stalls.splice(0, drop);
  if (st.stalls.length > MAX_STALLS_KEPT) st.stalls.splice(0, st.stalls.length - MAX_STALLS_KEPT);
}

function driftTick(st: LoopLagState): void {
  const t = st.now();
  const from = st.lastTick;
  const gap = t - from;
  st.lastTick = t;
  if (!(gap > STALL_GAP_MS)) return;
  st.stalls.push(t);
  pruneStalls(st, t);
  const inGap = st.slow.filter((s) => s.at > from && s.at <= t);
  const recent = inGap.length
    ? inGap.map(fmtSlow).join(', ')
    : `none slow${st.lastLabel ? ` (last section: ${st.lastLabel})` : ''}`;
  st.warn(`[eventloop] stall ${Math.round(gap)}ms; recent: ${recent}`);
}

function summaryTick(st: LoopLagState): void {
  const h = st.histogram;
  if (!h) return;
  const since = st.lastSummaryAt;
  st.lastSummaryAt = st.now();
  const w = readWindow(h);
  if (w.max > SUMMARY_WARN_MAX_MS) {
    const slow = st.slow.filter((s) => s.at > since).map(fmtSlow).join(', ');
    st.warn(`[eventloop] 60s p50=${w.p50} p99=${w.p99} max=${w.max}ms slow=[${slow}]`);
  }
  if (h.count > 0) st.lastWindow = w;
  h.reset();
}

/** Idempotent (one monitor per process, whatever the number of module copies).
 *  Timers are `unref`.
 *  `now`/`warn`/`histogram` are test seams; a second call ignores its options. */
export function startLoopLagMonitor(opts: {
  now?: () => number;
  warn?: (m: string) => void;
  histogram?: LagHistogram;
} = {}): void {
  const st = state();
  if (st.started) return;
  st.started = true;
  if (opts.now) st.now = opts.now;
  if (opts.warn) st.warn = opts.warn;
  let h: LagHistogram | null = opts.histogram ?? null;
  if (!h) {
    try { h = monitorEventLoopDelay({ resolution: RESOLUTION_MS }); } catch { h = null; }
  }
  try { h?.enable(); } catch {}
  st.histogram = h;
  st.lastTick = st.now();
  st.lastSummaryAt = st.lastTick;
  st.driftTimer = setInterval(() => driftTick(st), DRIFT_EVERY_MS);
  st.driftTimer.unref?.();
  st.summaryTimer = setInterval(() => summaryTick(st), SUMMARY_EVERY_MS);
  st.summaryTimer.unref?.();
}

/** Stops the monitor and DROPS all state (tests, shutdown). */
export function stopLoopLagMonitor(): void {
  const st = g.__charonLoopLag;
  if (!st) return;
  if (st.driftTimer) clearInterval(st.driftTimer);
  if (st.summaryTimer) clearInterval(st.summaryTimer);
  try { st.histogram?.disable(); } catch {}
  delete g.__charonLoopLag;
}

/** Records a section the caller timed itself: > 100 ms ⇒ ring, > 250 ms ⇒ warn. */
export function noteSlowSection(label: string, ms: number): void {
  if (!(ms > SLOW_RING_MS)) return;
  const st = state();
  st.slow.push({ label, ms: round1(ms), at: st.now() });
  if (st.slow.length > RING_SIZE) st.slow.splice(0, st.slow.length - RING_SIZE);
  if (ms > SLOW_WARN_MS) st.warn(`[perf] ${label} ${ms.toFixed(1)}ms`);
}

/** Times the synchronous part of `fn` (hot path: two clock reads, no
 *  allocation unless slow). Works whether or not the monitor is started. */
export function timeSection<T>(label: string, fn: () => T): T {
  const st = state();
  const t0 = st.now();
  try {
    return fn();
  } finally {
    const ms = st.now() - t0;
    st.lastLabel = label;
    if (ms > SLOW_RING_MS) noteSlowSection(label, ms);
  }
}

/** Numbers for GET /api/perf: lag percentiles of the current 60 s window (the
 *  previous one right after a reset), stalls in the last hour, the slow ring. */
export function loopLagSnapshot(): LoopLagSnapshot {
  const st = state();
  const h = st.histogram;
  const w = (h && h.count > 0 ? readWindow(h) : null) ?? st.lastWindow ?? { p50: 0, p99: 0, max: 0 };
  pruneStalls(st, st.now());
  return {
    ...w,
    stalls1h: st.stalls.length,
    slow: st.slow.map((s) => ({ ...s })),
  };
}
