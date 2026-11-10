'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * The sidebar's two view switches (CLAUDE.md §14.118). Two independent axes:
 *
 * - the MOON picks the status: off = sessions that are not asleep, on = ONLY
 *   the sleeping ones;
 * - the HIDDEN switch picks the visibility: off = normal sessions, on = ONLY
 *   the hidden ones.
 *
 * So four views, the default (both off) being "awake, not hidden". The moon
 * filters the sidebar alone; the hidden switch also filters the workspace
 * strip (app/pausedTabs.ts) and decides whether THIS device gets hidden
 * sessions' pushes (mirrored into its push preferences).
 *
 * Browser-local ON PURPOSE (like the tab focus, §14.78): a view of the fleet,
 * not a property of it — a phone watching one session must not re-filter a
 * desktop. The server has no localStorage, so the first render shows the
 * default and the stored choice is read after mount.
 */

type Switch = { value: boolean; subs: Set<() => void>; read: boolean };
const g = globalThis as unknown as { __charonViewSwitches?: Record<string, Switch> };
g.__charonViewSwitches ??= {};

function makeSwitch(key: string, onChange?: (next: boolean) => void) {
  const state = (g.__charonViewSwitches![key] ??= { value: false, subs: new Set(), read: false });
  const notify = () => { for (const fn of state.subs) fn(); };
  const getSnapshot = () => state.value;
  const subscribe = (fn: () => void) => { state.subs.add(fn); return () => { state.subs.delete(fn); }; };
  const write = (next: boolean) => {
    if (state.value === next) return;
    state.value = next;
    try { localStorage.setItem(key, next ? '1' : '0'); } catch {}
    notify();
    onChange?.(next);
  };
  const hydrate = () => {
    if (state.read) return;
    state.read = true;
    try {
      if (localStorage.getItem(key) === '1') { state.value = true; notify(); }
    } catch {}
    onChange?.(state.value);
  };
  return function useSwitch(): [boolean, () => void] {
    const value = useSyncExternalStore(subscribe, getSnapshot, () => false);
    useEffect(() => { hydrate(); }, []);
    return [value, useCallback(() => { write(!getSnapshot()); }, [])];
  };
}

/** v2: the moon used to mean "also show paused" (default on). Its old stored
 *  value would now mean "only paused", so the key moved. */
export const SHOW_PAUSED_KEY = 'hub.claude.showPaused.v2';
export const SHOW_HIDDEN_KEY = 'hub.sidebar.showHidden.v1';

/** `[sleepingOnly, toggle]` — the moon. */
export const useShowPaused = makeSwitch(SHOW_PAUSED_KEY);

/** `[hiddenOnly, toggle]` — the hidden-sessions switch. */
export const useShowHidden = makeSwitch(SHOW_HIDDEN_KEY, (next) => {
  void import('./browserNotifications').then((m) => m.syncShowHidden(next)).catch(() => {});
});
