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
