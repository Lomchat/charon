'use client';
/**
 * Client mirror of the workspace layout (§14.78).
 *
 * The tab set and order live in the DB and are SHARED. Focus is deliberately
 * LOCAL: each browser keeps its own active tab, so a phone can watch one
 * session while a desktop works in another. Incoming `tabs_changed` snapshots
 * therefore update the layout without ever adopting their `active` flag.
 *
 * Every mutation returns the server's list and overwrites the shared fields.
 * The server validates eviction/order; the client preserves its local focus
 * and mirrors the close choice so a neighbour opens immediately.
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
  /** Browser-local source of truth. `TabDTO.active` is only its render-time
   *  projection; the server's legacy active bit is never adopted after seed. */
  activeId: string | null;
  /** Tab ids with unsaved edits. Part of the snapshot ON PURPOSE: it is not
   *  in `tabs`, so if it lived outside, marking a buffer dirty would mutate a
   *  Set nobody re-reads and the badge would never appear. */
  dirty: ReadonlySet<string>;
};

const g = globalThis as unknown as {
  __charonTabState?: State;
  __charonTabSubs?: Set<() => void>;
  __charonTabMru?: string[];
};
// The snapshot is REPLACED, never mutated: useSyncExternalStore compares by
// identity, so an in-place edit is a change nothing re-renders for.
let state: State = (g.__charonTabState ??= {
  tabs: [], loaded: false, activeId: null, dirty: new Set(),
});
// A live tab can cross a deployment/HMR boundary with the previous snapshot
// shape still on globalThis. Derive its focus once instead of blanking the pane.
if (!(Object.prototype.hasOwnProperty.call(state, 'activeId'))) {
  state = {
    ...state,
    activeId: state.tabs.find((t) => t.active)?.id ?? null,
  };
  g.__charonTabState = state;
}
const subs = (g.__charonTabSubs ??= new Set<() => void>());
export const ACTIVE_TAB_STORAGE_KEY = 'hub.tabs.active.v1';
/**
 * Focus history, most-recent-first. NOT in the snapshot — nothing renders it.
 *
 * It exists so that closing a tab returns you to the one you were ACTUALLY on,
 * not to whichever neighbour happens to sit next to the hole. Open a file from
 * tab 1, close it, and you belong back on tab 1 — "the last tab in the row" is
 * only ever right by accident. Browser-side like `lastByGroup`: which tab you
 * were looking at is a per-screen fact.
 */
const mru = (g.__charonTabMru ??= []);

function touchMru(id: string | null | undefined) {
  if (!id) return;
  const i = mru.indexOf(id);
  if (i !== -1) mru.splice(i, 1);
  mru.unshift(id);
  if (mru.length > 60) mru.length = 60;
}

/** The tab focus should fall to when `closing` goes away.
 *
 * Focus never escapes the closing tab's `(VPS, path)` group. Within that
 * group, return to the immediately previous tab only if it belongs to that
 * group. If that previous tab belongs elsewhere (or there is no history), use
 * the visual neighbour (left first, then right). Closing the group's final tab
 * deliberately leaves the workspace without an active pane even when another
 * group still has tabs.
 */
export function chooseNextFocusAfterClosing(
  tabs: TabDTO[], focusHistory: readonly string[], closing: TabDTO,
): string | null {
  const siblings = tabs
    .filter((t) => t.vpsId === closing.vpsId && t.path === closing.path)
    .slice().sort((a, b) => a.position - b.position);
  const liveById = new Map(tabs.filter((t) => t.id !== closing.id).map((t) => [t.id, t]));
  const previous = focusHistory.map((id) => liveById.get(id)).find((t) => t !== undefined);
  if (previous?.vpsId === closing.vpsId && previous.path === closing.path) return previous.id;
  const idx = siblings.findIndex((t) => t.id === closing.id);
  return siblings[idx - 1]?.id ?? siblings[idx + 1]?.id ?? null;
}

function nextFocusAfterClosing(closing: TabDTO): string | null {
  return chooseNextFocusAfterClosing(state.tabs, mru, closing);
}

function commit(next: State) {
  state = next;
  g.__charonTabState = next;
  for (const cb of subs) cb();
}

/** Apply this browser's focus to a shared tab snapshot. Exported to pin the
 *  no-cross-device-focus invariant without reaching into the singleton. */
export function projectLocalTabFocus(tabs: TabDTO[], activeId: string | null): TabDTO[] {
  return tabs.map((t) => ({ ...t, active: t.id === activeId }));
}

function persistActiveId(activeId: string | null) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, JSON.stringify(activeId)); } catch {}
}

function setTabs(tabs: TabDTO[], requestedActiveId?: string | null) {
  const ids = new Set(tabs.map((t) => t.id));
  let activeId = requestedActiveId === undefined ? state.activeId : requestedActiveId;
  // A shared layout change may close/evict the tab this browser was viewing.
  // Fall back locally within the old group; never adopt the sender's active.
  if (activeId && !ids.has(activeId)) {
    const closing = state.tabs.find((t) => t.id === activeId);
    const context = closing
      ? [closing, ...tabs.filter((t) => t.id !== closing.id)]
      : tabs;
    activeId = closing ? chooseNextFocusAfterClosing(context, mru, closing) : null;
    if (activeId && !ids.has(activeId)) activeId = null;
  }
  const focusedTabs = projectLocalTabFocus(tabs, activeId);
  // Drop dirty marks for tabs that no longer exist, or the badge outlives its
  // editor and the close guard fires on a tab that is already gone.
  const live = ids;
  const dirty = new Set([...state.dirty].filter((id) => live.has(id)));
  for (let i = mru.length - 1; i >= 0; i--) if (!live.has(mru[i])) mru.splice(i, 1);
  if (activeId !== state.activeId) {
    touchMru(activeId);
    persistActiveId(activeId);
  }
  const sameTabs = state.loaded && focusedTabs.length === state.tabs.length && focusedTabs.every((tab, i) => {
    const prev = state.tabs[i];
    return prev != null
      && tab.id === prev.id && tab.vpsId === prev.vpsId && tab.path === prev.path
      && tab.kind === prev.kind && tab.ref === prev.ref && tab.pinned === prev.pinned
      && tab.position === prev.position && tab.active === prev.active
      && tab.vpsPos === prev.vpsPos && tab.groupPos === prev.groupPos;
  });
  const sameDirty = dirty.size === state.dirty.size && [...dirty].every((id) => state.dirty.has(id));
  if (sameTabs && sameDirty && activeId === state.activeId) return;
  commit({ tabs: focusedTabs, loaded: true, activeId, dirty });
}

/** Seed the client store from the SSR payload before the first subscription.
 * A remounted/HMR store that is already live wins over the older SSR snapshot. */
export function hydrateTabs(tabs: TabDTO[]): void {
  if (state.loaded) return;
  // Use the SSR choice for the hydration frame only. Browser-local persisted
  // focus is restored in an effect so server/client markup stays identical.
  const activeId = tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? null;
  state = {
    tabs: projectLocalTabFocus(tabs, activeId), loaded: true,
    activeId, dirty: state.dirty,
  };
  g.__charonTabState = state;
  touchMru(activeId);
}

/** Restore focus after hydration. No `storage` listener on purpose: even two
 *  live windows sharing one browser profile must not steer each other. */
export function restoreLocalTabFocus(): void {
  if (typeof window === 'undefined') return;
  let found = false;
  let stored: string | null = null;
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed === 'string') {
        found = true;
        stored = parsed;
      }
    }
  } catch { /* corrupt/unavailable storage: keep the hydration fallback */ }
  const activeId = found
    ? (stored && state.tabs.some((t) => t.id === stored) ? stored : null)
    : state.activeId;
  setTabs(state.tabs, activeId);
  if (!found) persistActiveId(activeId);
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

// Optimistic updates make clicks immediate, while serializing the actual
// mutations prevents two rapid actions from being processed/answered out of
// order and letting an older full-layout response overwrite the newer one.
let mutationTail: Promise<unknown> = Promise.resolve();
function runMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(fn, fn);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

export function useTabs(): State {
  const sub = useCallback((cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; }, []);
  const snap = useCallback(() => state, []);
  return useSyncExternalStore(sub, snap, () => state);
}

export const activeTab = (): TabDTO | null => state.tabs.find((t) => t.id === state.activeId) ?? null;

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
      ...t, pinned: t.pinned || (t.id === existing.id && !!input.pin),
    })), existing.id);
    // Re-focusing an already-open tab is entirely local. Only promotion from
    // preview to pinned changes the shared layout and needs an API mutation.
    if (!input.pin || existing.pinned) return existing;
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
    setTabs([...kept, provisional], provisional.id);
  }
  try {
    const r = await runMutation(() => api.openTab(input));
    // Replace the provisional id with the durable one without letting the
    // server response's shared/legacy active bit choose for this browser.
    setTabs(r.tabs, r.tab.id);
    return r.tab;
  } catch {
    void refreshTabs();
    return null;
  }
}

export async function activateTab(id: string): Promise<void> {
  if (!state.tabs.some((t) => t.id === id)) return;
  setTabs(state.tabs, id);
}

export async function pinTab(id: string): Promise<void> {
  setTabs(state.tabs.map((t) => (t.id === id ? { ...t, pinned: true } : t)), id);
  try {
    setTabs((await runMutation(() => api.updateTab(id, { pin: true, activate: false }))).tabs, id);
  } catch { void refreshTabs(); }
}

export async function closeTab(id: string): Promise<void> {
  const closing = state.tabs.find((t) => t.id === id);
  const wasActive = closing?.id === state.activeId;
  // Decide the next focus BEFORE the row disappears: immediate history when
  // it stays in-group, otherwise the row's left/right geometry.
  const next = wasActive && closing ? nextFocusAfterClosing(closing) : null;
  setTabs(state.tabs.filter((t) => t.id !== id), wasActive ? next : state.activeId);
  try {
    setTabs((await runMutation(() => api.closeTab(id, next ?? undefined))).tabs);
  } catch { void refreshTabs(); }
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
  try { setTabs((await runMutation(() => api.reorderTabs(body))).tabs); } catch { void refreshTabs(); }
}

export async function closeTabsWhere(q: { vpsId?: string; path?: string; exceptId?: string }): Promise<void> {
  try { setTabs((await runMutation(() => api.closeTabsWhere(q))).tabs); } catch { void refreshTabs(); }
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
 * browser, so closing the tab is the moment the work is lost. The ASKING is
 * the caller's (ClaudePanel renders `<ConfirmModal>`; a store can't render,
 * and `confirm()` is out for the reasons in §14.80), this only answers
 * "would anything be lost". Closing then discards by construction: the buffer
 * dies with the editor that owned it.
 */

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
