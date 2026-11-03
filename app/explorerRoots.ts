'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { normalizeWorkspacePath, workspaceScopeKey } from './workspaceScope';

/**
 * The explorer's folder tabs: other roots on the same VPS (`/etc/nginx` beside
 * the project), opened with the strip's ＋ and shown one at a time above the
 * tree. The first tab is always the workspace's own folder and never stored.
 *
 * Scoped to the WORKSPACE `(vpsId, cwd)` the tabs were opened from — each
 * session folder keeps its own list — and browser-local, like the tree's
 * expansion (`treeExpansion.ts`): a way of browsing, not a workspace fact to
 * publish (§14.78). `active` null = the workspace's own folder.
 *
 * Hydration matches `treeHideIgnored.ts`: the server and the first client
 * render show no extra tab, the stored ones arrive after mount.
 */

export type ExplorerRoots = { folders: readonly string[]; active: string | null };

export const EXPLORER_ROOTS_KEY = 'hub.tree.roots.v1';
/** Workspaces remembered; the least recently changed is dropped beyond. */
const MAX_SCOPES = 60;
/** Tabs per workspace; the oldest goes first. */
const MAX_FOLDERS = 20;
const MAX_PATH_LEN = 1024;
const EMPTY: ExplorerRoots = Object.freeze({ folders: Object.freeze([] as string[]), active: null });

/** Insertion-ordered: the Map is its own LRU. */
let mem = new Map<string, ExplorerRoots>();
let hydrated = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();

function notify(): void {
  for (const fn of subs) fn();
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function clean(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH_LEN) return null;
  return normalizeWorkspacePath(path);
}

function sanitize(raw: unknown): ExplorerRoots | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { folders, active } = raw as { folders?: unknown; active?: unknown };
  if (!Array.isArray(folders)) return null;
  const list = [...new Set(folders.map(clean).filter((p): p is string => !!p))].slice(-MAX_FOLDERS);
  if (list.length === 0) return null;
  const on = clean(active);
  return { folders: list, active: on && list.includes(on) ? on : null };
}

/** Adopt the stored tabs, once per page and never during render. */
function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(EXPLORER_ROOTS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = sanitize(value);
      if (entry && !mem.has(scope)) mem.set(scope, entry);
    }
  } catch {
    // Unreadable or another version's shape: the explorer opens on the
    // workspace's own folder alone — never fails to render.
  }
  notify();
}

function persist(): void {
  if (typeof window === 'undefined') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      window.localStorage.setItem(EXPLORER_ROOTS_KEY, JSON.stringify(Object.fromEntries(mem)));
    } catch { /* quota or private mode — the in-memory copy still works */ }
  }, 200);
}

function write(scope: string, next: ExplorerRoots): void {
  mem.delete(scope);
  if (next.folders.length > 0) mem.set(scope, next);
  while (mem.size > MAX_SCOPES) {
    const oldest = mem.keys().next();
    if (oldest.done) break;
    mem.delete(oldest.value);
  }
  persist();
  notify();
}

function current(vpsId: string, cwd: string): [string, ExplorerRoots] {
  hydrate();   // a change before the first effect must not overwrite the store
  const scope = workspaceScopeKey(vpsId, cwd);
  return [scope, mem.get(scope) ?? EMPTY];
}

/** This workspace's folder tabs, outside React. */
export function readExplorerRoots(vpsId: string, cwd: string): ExplorerRoots {
  return current(vpsId, cwd)[1];
}

/** This workspace's folder tabs. */
export function useExplorerRoots(vpsId: string | null, cwd: string | null): ExplorerRoots {
  const scope = workspaceScopeKey(vpsId, cwd);
  const value = useSyncExternalStore(subscribe, () => mem.get(scope) ?? EMPTY, () => EMPTY);
  useEffect(() => { hydrate(); }, []);
  return value;
}

/** Open `path` as a tab of this workspace (or focus it). The workspace's own
 *  folder is the first tab already: asking for it just shows it. */
export function openExplorerRoot(vpsId: string, cwd: string, path: string): void {
  const p = clean(path);
  if (!p) return;
  const [scope, cur] = current(vpsId, cwd);
  if (p === normalizeWorkspacePath(cwd)) {
    if (cur.active !== null) write(scope, { ...cur, active: null });
    return;
  }
  const folders = cur.folders.includes(p) ? cur.folders : [...cur.folders, p].slice(-MAX_FOLDERS);
  write(scope, { folders, active: p });
}

/** Show a tab; null = the workspace's own folder. */
export function selectExplorerRoot(vpsId: string, cwd: string, path: string | null): void {
  const [scope, cur] = current(vpsId, cwd);
  const p = path == null ? null : clean(path);
  if (p !== null && !cur.folders.includes(p)) return;
  if (cur.active === p) return;
  write(scope, { ...cur, active: p });
}

/** Close a tab. When it was the one shown, its left neighbour takes over
 *  (the workspace's own folder, left of every other). */
export function closeExplorerRoot(vpsId: string, cwd: string, path: string): void {
  const [scope, cur] = current(vpsId, cwd);
  const i = cur.folders.indexOf(path);
  if (i < 0) return;
  const folders = cur.folders.filter((f) => f !== path);
  const active = cur.active === path ? (folders[i - 1] ?? null) : cur.active;
  write(scope, { folders, active });
}

/**
 * A file opened from another root's tab lands in THAT folder's tab group
 * (§14.78), so the panel beside it is that folder's workspace. Hand it the
 * tabs it came from — the workspace's own folder first — so the trees stay
 * one click apart there too. Never touches what the target shows.
 */
export function carryExplorerRoots(vpsId: string, from: string, to: string): void {
  const src = clean(from);
  const dst = clean(to);
  if (!src || !dst || src === dst) return;
  const [, fromCur] = current(vpsId, src);
  const [toScope, toCur] = current(vpsId, dst);
  const add = [src, ...fromCur.folders].filter((p) => p !== dst && !toCur.folders.includes(p));
  if (add.length === 0) return;
  write(toScope, { folders: [...toCur.folders, ...add].slice(-MAX_FOLDERS), active: toCur.active });
}

/**
 * Each tab's label: the folder's name, or as many trailing segments as it
 * takes to tell two same-named folders apart (`sites/conf`, `app/conf`).
 * `/` is `/`. The workspace's own folder takes part, so a tab named like the
 * project is told apart from it too.
 */
export function explorerRootLabels(paths: readonly string[]): Map<string, string> {
  const segs = new Map(paths.map((p) => [p, p.split('/').filter(Boolean)]));
  const out = new Map<string, string>();
  for (const p of paths) {
    const mine = segs.get(p)!;
    if (mine.length === 0) { out.set(p, '/'); continue; }
    let n = 1;
    const tail = (s: string[], k: number) => s.slice(-k).join('/');
    while (n < mine.length && paths.some((o) => o !== p && tail(segs.get(o)!, n) === tail(mine, n))) n++;
    out.set(p, tail(mine, n));
  }
  return out;
}

/** Test seam — the store is module state and vitest keeps modules warm. */
export function __resetExplorerRoots(): void {
  mem = new Map();
  hydrated = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}
