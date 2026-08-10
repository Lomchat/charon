'use client';
/**
 * Client mirror of the workspace layout (§14.78).
 *
 * The tab set lives in the DB and is SHARED — the same tabs, order and focus on
 * every device. So this store is not the source of truth, it is a cache with
 * two jobs: apply a mutation optimistically so clicking a tab feels instant,
 * and re-sync from `tabs_changed` so another device (or another browser tab)
 * never drifts.
 *
 * Every mutation returns the server's list and overwrites the local one — the
 * server owns the eviction rules (one preview per group, focus fallback on
 * close) and re-deriving them here would be two implementations of the same
 * thing, drifting.
 *
 * Dirty state is the exception: it is deliberately LOCAL. An unsaved buffer
 * lives in one browser and cannot be handed to another, so publishing it would
 * put a "modified" dot on a device that has no way to save it.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import type { ReorderTabsBody, TabDTO, TabKind } from '@/lib/types/api';

type State = {
  tabs: TabDTO[];
  loaded: boolean;
  /** Tab ids with unsaved edits. Part of the snapshot ON PURPOSE: it is not
   *  in `tabs`, so if it lived outside, marking a buffer dirty would mutate a
   *  Set nobody re-reads and the badge would never appear. */
  dirty: ReadonlySet<string>;
};

const g = globalThis as unknown as {
  __charonTabState?: State;
  __charonTabSubs?: Set<() => void>;
};
// The snapshot is REPLACED, never mutated: useSyncExternalStore compares by
// identity, so an in-place edit is a change nothing re-renders for.
let state: State = (g.__charonTabState ??= { tabs: [], loaded: false, dirty: new Set() });
const subs = (g.__charonTabSubs ??= new Set<() => void>());

function commit(next: State) {
  state = next;
  g.__charonTabState = next;
  for (const cb of subs) cb();
}

function setTabs(tabs: TabDTO[]) {
  // Drop dirty marks for tabs that no longer exist, or the badge outlives its
  // editor and the close guard fires on a tab that is already gone.
  const live = new Set(tabs.map((t) => t.id));
  const dirty = new Set([...state.dirty].filter((id) => live.has(id)));
  commit({ tabs, loaded: true, dirty });
}

let inflight: Promise<void> | null = null;
export function refreshTabs(): Promise<void> {
  if (inflight) return inflight;
  inflight = api.listTabs()
    .then((r) => setTabs(r.tabs))
    .catch(() => { /* the poll or the next event will retry */ })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useTabs(): State {
  const sub = useCallback((cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; }, []);
  const snap = useCallback(() => state, []);
  return useSyncExternalStore(sub, snap, () => state);
}

export const activeTab = (): TabDTO | null => state.tabs.find((t) => t.active) ?? null;

// ── Mutations ───────────────────────────────────────────────────────────────

export async function openTab(input: {
  vpsId: string; path: string; kind: TabKind; ref: string; pin?: boolean;
}): Promise<TabDTO | null> {
  // Optimistic focus: the pane must switch on the click, not on the round
  // trip. The server's answer replaces the whole list a moment later.
  const existing = state.tabs.find((t) =>
    t.vpsId === input.vpsId && t.path === input.path && t.kind === input.kind && t.ref === input.ref);
  if (existing) {
    setTabs(state.tabs.map((t) => ({
      ...t, active: t.id === existing.id, pinned: t.pinned || (t.id === existing.id && !!input.pin),
    })));
  } else {
    // Mirror the server's eviction rule locally so the strip doesn't flash a
    // second preview for the duration of the request. The id is provisional;
    // the server's list replaces it a moment later.
    const provisional: TabDTO = {
      id: `pending:${input.kind}:${input.ref}`, vpsId: input.vpsId, path: input.path,
      kind: input.kind, ref: input.ref, pinned: !!input.pin,
      position: Number.MAX_SAFE_INTEGER, active: true,
      // Inherit the group's rank so the provisional row doesn't jump its whole
      // folder to the front of row 2 for the length of one request.
      vpsPos: state.tabs.find((t) => t.vpsId === input.vpsId)?.vpsPos ?? Number.MAX_SAFE_INTEGER,
      groupPos: state.tabs.find((t) => t.vpsId === input.vpsId && t.path === input.path)?.groupPos
        ?? Number.MAX_SAFE_INTEGER,
    };
    const kept = state.tabs.filter((t) => !(
      !input.pin && t.vpsId === input.vpsId && t.path === input.path && !t.pinned));
    setTabs([...kept.map((t) => ({ ...t, active: false })), provisional]);
  }
  try {
    const r = await api.openTab(input);
    setTabs(r.tabs);
    return r.tab;
  } catch {
    void refreshTabs();
    return null;
  }
}

export async function activateTab(id: string): Promise<void> {
  setTabs(state.tabs.map((t) => ({ ...t, active: t.id === id })));
  try { setTabs((await api.updateTab(id, { activate: true })).tabs); } catch { void refreshTabs(); }
}

export async function pinTab(id: string): Promise<void> {
  setTabs(state.tabs.map((t) => (t.id === id ? { ...t, pinned: true } : t)));
  try { setTabs((await api.updateTab(id, { pin: true, activate: true })).tabs); } catch { void refreshTabs(); }
}

export async function closeTab(id: string): Promise<void> {
  setTabs(state.tabs.filter((t) => t.id !== id));
  try { setTabs((await api.closeTab(id)).tabs); } catch { void refreshTabs(); }
}

/**
 * Reorder one row. Applied locally first — a drag that snaps back while the
 * server answers is the single worst thing a sortable list can do.
 */
export async function reorderTabs(body: ReorderTabsBody): Promise<void> {
  const rank = (arr: string[], v: string) => {
    const i = arr.indexOf(v);
    return i === -1 ? arr.length : i;
  };
  if (body.scope === 'tabs') {
    setTabs(state.tabs.map((t) => (t.vpsId === body.vpsId && t.path === body.path
      ? { ...t, position: rank(body.ids, t.id) } : t)));
  } else if (body.scope === 'groups') {
    setTabs(state.tabs.map((t) => (t.vpsId === body.vpsId
      ? { ...t, groupPos: rank(body.paths, t.path) } : t)));
  } else {
    setTabs(state.tabs.map((t) => ({ ...t, vpsPos: rank(body.vpsIds, t.vpsId) })));
  }
  try { setTabs((await api.reorderTabs(body)).tabs); } catch { void refreshTabs(); }
}

export async function closeTabsWhere(q: { vpsId?: string; path?: string; exceptId?: string }): Promise<void> {
  try { setTabs((await api.closeTabsWhere(q)).tabs); } catch { void refreshTabs(); }
}

// ── Dirty tracking (local) ──────────────────────────────────────────────────

export function setTabDirty(id: string, isDirty: boolean) {
  if (isDirty === state.dirty.has(id)) return;
  const dirty = new Set(state.dirty);
  if (isDirty) dirty.add(id); else dirty.delete(id);
  commit({ ...state, dirty });
}
export const isTabDirty = (id: string) => state.dirty.has(id);
export const hasDirtyTabs = () => state.dirty.size > 0;

/**
 * A dirty tab must not vanish silently — the buffer only exists in this
 * browser, so closing the tab is the moment the work is lost.
 */
export async function closeTabGuarded(id: string, label: string): Promise<boolean> {
  if (state.dirty.has(id)) {
    const ok = window.confirm(
      `"${label}" has unsaved changes.\n\n`
      + 'They only exist in this browser — closing the tab discards them. '
      + 'Save with Ctrl+S first if you want to keep them.\n\nClose anyway?',
    );
    if (!ok) return false;
  }
  await closeTab(id);
  return true;
}

// The browser-level backstop for the same thing. Registered once.
if (typeof window !== 'undefined') {
  const gg = globalThis as unknown as { __charonTabUnloadArmed?: boolean };
  if (!gg.__charonTabUnloadArmed) {
    gg.__charonTabUnloadArmed = true;
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty.size === 0) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }
}
