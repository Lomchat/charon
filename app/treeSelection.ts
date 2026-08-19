export type TreeSelectionModifiers = {
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle: boolean;
  /** Select the visible interval from the last anchor to this row. */
  range: boolean;
};

/** A modifier gesture changes selection only; it must never navigate. */
export function isTreeSelectionOnly(modifiers: TreeSelectionModifiers): boolean {
  return modifiers.toggle || modifiers.range;
}

export type TreeSelectionResult = {
  selected: Set<string>;
  anchor: string;
};

export type StoredTreeSelection = {
  selected: Set<string>;
  anchor: string | null;
};

type StoredValue = { selected: string[]; anchor: string | null };
const globalSelection = globalThis as unknown as {
  __charonTreeSelections?: Map<string, StoredValue>;
};
const storedSelections = (globalSelection.__charonTreeSelections ??= new Map());

/** Selection follows a project tree across chat/file views, not a session. */
export function treeSelectionScope(vpsId: string | null, cwd: string | null): string {
  return JSON.stringify([vpsId ?? '', (cwd ?? '').replace(/\/+$/, '')]);
}

/** Returns defensive copies: React state must never mutate the shared cache. */
export function readTreeSelection(scope: string): StoredTreeSelection {
  const stored = storedSelections.get(scope);
  return {
    selected: new Set(stored?.selected ?? []),
    anchor: stored?.anchor ?? null,
  };
}

/**
 * Write synchronously before opening a file. The click swaps ToolPanel
 * instances immediately, so an effect that persisted later would be too late.
 */
export function writeTreeSelection(
  scope: string,
  selected: ReadonlySet<string>,
  anchor: string | null,
): void {
  storedSelections.delete(scope);
  storedSelections.set(scope, { selected: [...selected], anchor });
  // Browser-lifetime browsing state only; bound inactive project folders.
  while (storedSelections.size > 60) {
    const oldest = storedSelections.keys().next().value as string | undefined;
    if (oldest == null) break;
    storedSelections.delete(oldest);
  }
}

/**
 * Explorer-style row selection. Paths, rather than row indices, are the
 * durable identity: expanding a folder can insert rows without making an old
 * selection point at a different file.
 */
export function selectTreeRow(
  visiblePaths: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  path: string,
  modifiers: TreeSelectionModifiers,
): TreeSelectionResult {
  if (modifiers.range) {
    const end = visiblePaths.indexOf(path);
    const start = anchor == null ? -1 : visiblePaths.indexOf(anchor);
    if (start !== -1 && end !== -1) {
      const interval = visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1);
      return {
        selected: new Set(modifiers.toggle ? [...current, ...interval] : interval),
        // Repeated Shift-clicks keep extending from the original row.
        anchor: anchor!,
      };
    }
  }

  if (modifiers.toggle) {
    const selected = new Set(current);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path };
  }

  return { selected: new Set([path]), anchor: path };
}

/**
 * Deleting a selected folder already deletes everything below it. Remove
 * descendant targets so a bulk delete cannot report a misleading "missing"
 * failure after successfully deleting their parent.
 */
export function collapseTreeDeletePaths<T extends { path: string }>(rows: readonly T[]): T[] {
  const ordered = [...rows].sort((a, b) => {
    const depth = (p: string) => p.split('/').length;
    return depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
  });
  const kept: T[] = [];
  for (const row of ordered) {
    if (kept.some((parent) => row.path.startsWith(`${parent.path}/`))) continue;
    kept.push(row);
  }
  return kept;
}
