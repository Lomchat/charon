import { normalizeWorkspacePath } from './workspaceScope';

export type SidebarPathItem = { id: string; cwd: string | null | undefined };

export function sidebarPathKey(cwd: string | null | undefined): string {
  return normalizeWorkspacePath(cwd) ?? '~';
}

/** Exact card order after the sidebar visually groups an already-sorted VPS. */
export function sidebarPathOrderedIds(items: SidebarPathItem[]): string[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const path = sidebarPathKey(item.cwd);
    const ids = groups.get(path) ?? [];
    ids.push(item.id);
    groups.set(path, ids);
  }
  return [...groups.values()].flat();
}

/** The path headings, in the order the sidebar draws them for one VPS. */
export function sidebarPathOrder(items: SidebarPathItem[]): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const item of items) {
    const path = sidebarPathKey(item.cwd);
    if (known.has(path)) continue;
    known.add(path);
    seen.push(path);
  }
  return seen;
}

/** Keep the path order anchored to all sessions when some rows are hidden. */
export function sidebarVisiblePathItems<T extends SidebarPathItem>(
  orderedAll: T[], visible: (item: T) => boolean,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of orderedAll) {
    const path = sidebarPathKey(item.cwd);
    if (!groups.has(path)) groups.set(path, []);
    if (visible(item)) groups.get(path)!.push(item);
  }
  return [...groups.values()].flat();
}

export type PositionedSidebarPathItem = SidebarPathItem & { position: number; createdAt: number };

/**
 * A path has no position of its own: its first session determines its place.
 * When that session is deleted, later sessions of the same path may sit after
 * other paths in the flat order. Preserve the path order from BEFORE deletion
 * and pack each surviving group into consecutive positions only if deleting
 * the row would move a path. Null means existing positions already work.
 */
export function sidebarOrderAfterDelete(items: PositionedSidebarPathItem[], deletedId: string): string[] | null {
  const sorted = [...items].sort((a, b) => a.position - b.position
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const surviving = sorted.filter((item) => item.id !== deletedId);
  const survivingPaths = new Set(surviving.map((item) => sidebarPathKey(item.cwd)));
  const before = sidebarPathOrder(sorted).filter((path) => survivingPaths.has(path));
  const after = sidebarPathOrder(surviving);
  if (before.every((path, i) => path === after[i])) return null;
  const groups = new Map<string, string[]>();
  for (const item of sorted) {
    const path = sidebarPathKey(item.cwd);
    if (!groups.has(path)) groups.set(path, []);
    if (item.id !== deletedId) groups.get(path)!.push(item.id);
  }
  return [...groups.values()].flat();
}

/**
 * Expand a reorder of the path HEADINGS back into the VPS's complete order:
 * every session follows its path, keeping its rank inside it. Path order is
 * not stored anywhere — it is read off the sessions — so moving a heading is
 * moving all of its sessions at once, which is exactly what the drag says.
 *
 * Only the mentioned headings are permuted; any other keeps its slot, the same
 * way a session drag only ever permutes its own group.
 */
export function mergeSidebarPathGroupOrder(
  all: SidebarPathItem[],
  orderedPaths: string[],
): string[] | null {
  const groups = new Map<string, string[]>();
  for (const item of all) {
    const path = sidebarPathKey(item.cwd);
    const ids = groups.get(path) ?? [];
    ids.push(item.id);
    groups.set(path, ids);
  }
  const moved = new Set(orderedPaths);
  // A repeated or unknown heading would drop or duplicate whole groups.
  if (moved.size !== orderedPaths.length) return null;
  if (orderedPaths.some((path) => !groups.has(path))) return null;
  let cursor = 0;
  return [...groups.keys()]
    .map((path) => moved.has(path) ? orderedPaths[cursor++] : path)
    .flatMap((path) => groups.get(path) ?? []);
}

/**
 * Expand a reorder from one path group back into the VPS's complete order.
 * Hidden cards keep their slots when visiblePathIds is supplied. The API
 * receives the full VPS list; omitted ids would otherwise move to the end.
 */
export function mergeSidebarPathOrder(
  all: SidebarPathItem[],
  path: string,
  orderedPathIds: string[],
  visiblePathIds?: string[],
): string[] | null {
  const current = all.filter((item) => sidebarPathKey(item.cwd) === path).map((item) => item.id);
  const visible = visiblePathIds ?? current;
  const expected = new Set(visible);
  if (visible.length !== orderedPathIds.length || expected.size !== visible.length) return null;
  if (visible.some((id) => !current.includes(id))) return null;
  if (new Set(orderedPathIds).size !== expected.size || orderedPathIds.some((id) => !expected.has(id))) return null;
  let cursor = 0;
  return all.map((item) => sidebarPathKey(item.cwd) === path && expected.has(item.id)
    ? orderedPathIds[cursor++] : item.id);
}
