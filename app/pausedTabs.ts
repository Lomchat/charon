/**
 * What the workspace strip drops when "show paused" is off, and how a drag
 * survives the drop.
 *
 * Pure — the strip's own filtering and its reorder callbacks both go through
 * here, and both are unit-tested (tests/pausedTabs.test.ts).
 */

/** What a filter needs of a resolved tab — the strip's `ResolvedTab` fits. */
export type PausableTab = { id: string; state: string; live: boolean };

/**
 * The tabs of ONE shown folder.
 *
 * `live` is the discriminator, not the state alone: a FILE tab is 'sleeping'
 * because nothing about it runs, and inside a folder you can still reach, a
 * switch named "show paused" has no business closing the file you are editing.
 * The ACTIVE tab always stays — the strip is where you are, and a bar that
 * omits the pane behind it reads as a bug.
 */
export function visibleTabs<T extends PausableTab>(
  tabs: readonly T[], showPaused: boolean, activeTabId: string | null,
): T[] {
  if (showPaused) return [...tabs];
  return tabs.filter((t) => t.id === activeTabId || !t.live || t.state !== 'sleeping');
}

/**
 * Does this tab earn its folder and its machine a row?
 *
 * A file does NOT: a machine whose sessions are all asleep is asleep, whatever
 * is open on it, and leaving it in row 1 because someone once opened a file
 * there is exactly the noise the switch is asked to remove. Its files come
 * back with the switch — the folder is one click away again.
 *
 * So the two levels answer differently on purpose: a file keeps its place
 * INSIDE a folder that something else keeps alive, and never on its own.
 */
export function keepsGroup(tab: PausableTab, activeTabId: string | null): boolean {
  return tab.id === activeTabId || (tab.live && tab.state !== 'sleeping');
}

/** Rows 1 and 2: a machine / a folder is drawn only if something in it is. */
export function groupShown(
  tabs: readonly PausableTab[], showPaused: boolean, activeTabId: string | null,
): boolean {
  return showPaused || tabs.some((t) => keepsGroup(t, activeTabId));
}

/**
 * Put a reordered VISIBLE sequence back into the FULL order.
 *
 * A reorder sends the whole order (§14.80), so committing what the user can
 * see would push every hidden tab behind it — turn the switch back on and the
 * paused sessions have all moved. The visible ids take the slots the visible
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
