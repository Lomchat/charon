'use client';
import { useSyncExternalStore } from 'react';

/**
 * The date + time stamped on every transcript bubble: `Today - 14:32:05`,
 * `23/09 - 14:32:05`, and the year only once it is not this one
 * (`31/12/2025 - 18:04:00`). Local time, 24h.
 *
 * "Today" is relative, and the bubbles are memoized (§14.38) — nothing
 * re-renders a finished message. So the reference day is an external store
 * that ticks at local midnight (and when the tab comes back, since a timer
 * does not run on a suspended laptop): a transcript left open overnight
 * relabels yesterday's "Today" without a reload.
 */

/** `todayStartMs` = local midnight of the reference day (`useTodayStart`). */
export function formatMessageTime(tsSec: number, todayStartMs: number): string {
  const d = new Date(tsSec * 1000);
  const today = new Date(todayStartMs);
  // `hourCycle: 'h23'`, not `hour12: false`: the latter prints 00:05 as 24:05.
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  if (d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate()) {
    return `Today - ${time}`;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  let date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  if (d.getFullYear() !== today.getFullYear()) date += `/${d.getFullYear()}`;
  return `${date} - ${time}`;
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const fn of subs) fn();
}

function onVisible(): void {
  if (document.visibilityState === 'visible') notify();
}

// One timer for every bubble on the page, armed while any is mounted.
function arm(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  timer = setTimeout(() => { notify(); arm(); }, next - now.getTime() + 50);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (subs.size === 1) {
    arm();
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export function useTodayStart(): number {
  return useSyncExternalStore(subscribe, startOfToday, startOfToday);
}
