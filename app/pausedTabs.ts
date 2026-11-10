/**
 * What the workspace strip drops, and how a drag survives the drop.
 *
 * Only the HIDDEN switch filters the strip (§14.118): a hidden session's tab
 * shows only while this browser shows hidden sessions. The moon does not — an
 * open tab is where you work, asleep or not, and "sleeping only" would empty
 * the strip of everything running.
 *
 * Pure — the strip's own filtering and its reorder callbacks both go through
 * here.
 */

/** What a filter needs of a resolved tab — the strip's `ResolvedTab` fits. */
export type FilterableTab = { id: string; hidden?: boolean };

/** The ACTIVE tab always stays — the strip is where you are, and a bar that
 *  omits the pane behind it reads as a bug. */
function shown(tab: FilterableTab, showHidden: boolean, activeTabId: string | null): boolean {
  return tab.id === activeTabId || !tab.hidden || showHidden;
}

/** The tabs of ONE shown folder. */
export function visibleTabs<T extends FilterableTab>(
  tabs: readonly T[], showHidden: boolean, activeTabId: string | null,
): T[] {
  return tabs.filter((t) => shown(t, showHidden, activeTabId));
}

/** Rows 1 and 2: a machine / a folder is drawn only if something in it is. */
export function groupShown(
  tabs: readonly FilterableTab[], showHidden: boolean, activeTabId: string | null,
): boolean {
  return tabs.some((t) => shown(t, showHidden, activeTabId));
}

/**
 * Put a reordered VISIBLE sequence back into the FULL order.
 *
 * A reorder sends the whole order (§14.80), so committing what the user can
 * see would push every hidden tab behind it — turn the switch back on and the
 * hidden sessions have all moved. The visible ids take the slots the visible
 * ids occupied, in their new order; a hidden id keeps the index it had.
 */
export function mergeVisibleOrder(full: readonly string[], visibleNext: readonly string[]): string[] {
  const moving = new Set(visibleNext);
  const slots = full.filter((id) => moving.has(id)).length;
  // A visible id that is not in `full` means the two lists came from different
  // snapshots: commit what the user actually dragged rather than interleave.
  if (slots !== visibleNext.length) return [...visibleNext];
  let i = 0;
  return full.map((id) => (moving.has(id) ? visibleNext[i++] : id));
}
