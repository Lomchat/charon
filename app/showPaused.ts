'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * The "show paused" switch, shared by the two surfaces it filters.
 *
 * It started as sidebar-local state, which was right while the sidebar was the
 * only list of sessions. The workspace strip is a second one: hiding a paused
 * session on the left while its tab kept its dot on top is the same session
 * answering two ways at once. So the choice lives here — one value, one
 * localStorage key, both readers subscribed.
 *
 * Browser-local ON PURPOSE (like the tab focus, §14.78): "hide what is asleep"
 * is a view of the fleet, not a property of it, and a phone watching one
 * session should not re-filter a desktop.
 *
 * Hydration matches the old sidebar behaviour exactly: the first render shows
 * EVERYTHING (the server has no localStorage and must render the same markup),
 * and the stored choice is read after mount.
 */

export const SHOW_PAUSED_KEY = 'hub.claude.showPaused.v1';

const g = globalThis as unknown as {
  __charonShowPaused?: boolean;
  __charonShowPausedSubs?: Set<() => void>;
  __charonShowPausedRead?: boolean;
};
g.__charonShowPausedSubs ??= new Set<() => void>();

function notify(): void {
  for (const fn of g.__charonShowPausedSubs!) fn();
}

function getSnapshot(): boolean {
  return g.__charonShowPaused ?? true;
}

function subscribe(fn: () => void): () => void {
  g.__charonShowPausedSubs!.add(fn);
  return () => { g.__charonShowPausedSubs!.delete(fn); };
}

function write(next: boolean): void {
  if (getSnapshot() === next) return;
  g.__charonShowPaused = next;
  try { localStorage.setItem(SHOW_PAUSED_KEY, next ? '1' : '0'); } catch {}
  notify();
}

/** Adopt the stored choice, once per tab and never during render. */
function hydrate(): void {
  if (g.__charonShowPausedRead) return;
  g.__charonShowPausedRead = true;
  try {
    if (localStorage.getItem(SHOW_PAUSED_KEY) === '0') {
      g.__charonShowPaused = false;
      notify();
    }
  } catch {}
}

/** `[showPaused, toggle]` — the same shape the sidebar's own state had. */
export function useShowPaused(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => true);
  useEffect(() => { hydrate(); }, []);
  return [value, useCallback(() => { write(!getSnapshot()); }, [])];
}
