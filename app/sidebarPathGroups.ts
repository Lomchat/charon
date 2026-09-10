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
 * The API deliberately receives the full VPS list; sending only the subgroup
 * would move that whole path to the front because omitted ids are appended.
 */
export function mergeSidebarPathOrder(
  all: SidebarPathItem[],
  path: string,
  orderedPathIds: string[],
): string[] | null {
  const current = all.filter((item) => sidebarPathKey(item.cwd) === path).map((item) => item.id);
  if (current.length !== orderedPathIds.length) return null;
  const expected = new Set(current);
  if (new Set(orderedPathIds).size !== expected.size || orderedPathIds.some((id) => !expected.has(id))) return null;
  let cursor = 0;
  return all.map((item) => sidebarPathKey(item.cwd) === path ? orderedPathIds[cursor++] : item.id);
}
