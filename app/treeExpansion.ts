'use client';

/**
 * Which folders the explorer has open, remembered across switches (§14.77).
 *
 * Scoped to the SESSION: two sessions on the same repo are two people looking
 * at two different parts of it, and coming back to one of them must not show
 * the other's tree. The panel also renders beside the file editor, where there
 * is no session — that case falls back to `(vpsId, cwd)`, which is the only
 * identity available there.
 *
 * Browser-side, like `hub.tabs.lastByGroup.v1` and for the same reason: this is
 * a browsing position, not a workspace fact. Publishing it (§14.78) would make
 * two devices fight over which folders are open, and a phone has no business
 * dictating the shape of a tree on a desktop.
 *
 * PATHS are stored, never indices — which is what makes the answer survive a
 * refresh that adds, removes or reorders entries: a new folder simply is not in
 * the set, and one that disappeared never matches again.
 */

const KEY = 'hub.tree.expanded.v1';
/** Distinct trees remembered. Beyond this the least-recently-touched is
 *  dropped: this is a convenience, not an archive, and localStorage is shared
 *  with everything else the hub keeps there. */
const MAX_SCOPES = 60;
/** Open folders per tree. A tree with 400 expanded folders is already past
 *  what anyone reads; the OLDEST expansions are the ones dropped. */
const MAX_PATHS = 400;
const MAX_PATH_LEN = 1024;

/** Insertion-ordered, so the Map itself is the LRU and the array is the
 *  expansion order. Hydrated once, then authoritative. */
let mem: Map<string, string[]> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function hydrate(): Map<string, string[]> {
  if (mem) return mem;
  mem = new Map();
  if (typeof window === 'undefined') return mem;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return mem;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return mem;
    for (const [scope, paths] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(paths)) continue;
      mem.set(scope, paths.filter((p): p is string => typeof p === 'string' && !!p && p.length <= MAX_PATH_LEN)
        .slice(-MAX_PATHS));
    }
  } catch {
    // A corrupt or unreadable store (private mode, quota, another version's
    // shape) means the tree opens closed — never that it fails to render.
  }
  return mem;
}

function persist(): void {
  if (typeof window === 'undefined' || !mem) return;
  if (saveTimer) clearTimeout(saveTimer);
  // Expanding a path triggers a listing, a re-render and often several more
  // expansions in a row (revealing a file opens every ancestor). One write.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(mem!)));
    } catch { /* quota or private mode — the in-memory copy still works */ }
  }, 400);
}

/** The identity of one tree. Session when there is one (that is the thing
 *  being switched between), the folder otherwise. */
export function treeScope(sessionId: string | null, vpsId: string, cwd: string): string {
  return sessionId ? `s:${sessionId}` : `d:${vpsId}:${cwd}`;
}

/** Folders to open for this scope. Always contains the root. */
export function readExpanded(scope: string): Set<string> {
  const paths = hydrate().get(scope) ?? [];
  return new Set(['', ...paths]);
}

export function writeExpanded(scope: string, expanded: Set<string>): void {
  const m = hydrate();
  const paths: string[] = [];
  for (const p of expanded) {
    if (!p || p.length > MAX_PATH_LEN) continue;  // '' is the root, implied
    paths.push(p);
  }
  // Re-insert to move this scope to the end: the Map's order IS the LRU.
  m.delete(scope);
  m.set(scope, paths.length > MAX_PATHS ? paths.slice(-MAX_PATHS) : paths);
  while (m.size > MAX_SCOPES) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
  persist();
}

/** Test seam — the store is module state and vitest keeps modules warm. */
export function __resetTreeExpansion(): void {
  mem = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}
