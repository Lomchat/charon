import { sidebarPathKey, type SidebarPathItem } from './sidebarPathGroups';

export type SubSessionItem = SidebarPathItem & { createdAt: number; parentSessionId?: string | null };

/** Rows deeper than this keep the same visual indent. */
export const MAX_SUB_INDENT = 3;

export type SubSessionRow<T> = {
  item: T;
  depth: number;
  /** Every descendant, folded or not (the fold count + its attention). */
  descendants: T[];
  folded: boolean;
};

export type SubSessionGroup<T> = {
  path: string;
  /** Rendered order: parent, then its children; a folded subtree is omitted. */
  rows: SubSessionRow<T>[];
  /** Every session of the group, folded ones included. */
  total: number;
};

/**
 * Nest sub-sessions under their parent inside ONE VPS's sessions (already in
 * the sidebar's flat order). A session whose parent is absent from `items`
 * (deleted, archived, filtered out) is a root; so is any member of a parent
 * cycle. Roots keep the incoming order and group by their OWN path; a child
 * joins its parent's group whatever its cwd, ordered by createdAt.
 */
export function nestSubSessions<T extends SubSessionItem>(
  items: T[], folded: ReadonlySet<string>,
): SubSessionGroup<T>[] {
  const ids = new Set(items.map((item) => item.id));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = item.parentSessionId;
    if (parent && parent !== item.id && ids.has(parent)) {
      const list = kids.get(parent) ?? [];
      list.push(item);
      kids.set(parent, list);
    } else roots.push(item);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  const seen = new Set<string>();
  /** Appends the row (unless inside a folded subtree); returns its descendants. */
  const walk = (item: T, depth: number, out: SubSessionRow<T>[], hidden: boolean): T[] => {
    seen.add(item.id);
    const own = (kids.get(item.id) ?? []).filter((child) => !seen.has(child.id));
    const row: SubSessionRow<T> = { item, depth, descendants: [], folded: own.length > 0 && folded.has(item.id) };
    if (!hidden) out.push(row);
    for (const child of own) {
      if (seen.has(child.id)) continue;
      row.descendants.push(child, ...walk(child, depth + 1, out, hidden || row.folded));
    }
    return row.descendants;
  };

  const groups = new Map<string, SubSessionGroup<T>>();
  const place = (root: T) => {
    const path = sidebarPathKey(root.cwd);
    let group = groups.get(path);
    if (!group) { group = { path, rows: [], total: 0 }; groups.set(path, group); }
    group.total += 1 + walk(root, 0, group.rows, false).length;
  };
  for (const root of roots) place(root);
  // Members of a parent cycle never reached a root: surface them as roots.
  for (const item of items) if (!seen.has(item.id)) place(item);
  return [...groups.values()];
}

/** Session ids in the exact order the sidebar draws them. */
export function renderedSessionIds<T extends SubSessionItem>(
  items: T[], folded: ReadonlySet<string>, pathHidden: (path: string) => boolean,
): string[] {
  return nestSubSessions(items, folded)
    .filter((group) => !pathHidden(group.path))
    .flatMap((group) => group.rows.map((row) => row.item.id));
}
