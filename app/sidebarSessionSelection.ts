/**
 * The sidebar's browser-local selection FOLLOWS THE OPEN TAB. Opening a
 * session from anywhere — a plain sidebar click, the header nav, a
 * notification, the tab bar, a deep link, a freshly created row — leaves
 * exactly that card highlighted, instead of painting the previous one as still
 * selected. ⚠ The open tab is not always a session: a shell / install / file
 * owns the pane with `sessionId === null`, and the session left behind must
 * NOT keep its highlight — two cards would read as selected while only the
 * shell is open. "No session open" is therefore not the same answer as "no tab
 * open" (`openTabRef`), which leaves a deliberate selection alone. The
 * gestures that build one (Ctrl/Cmd, Shift) never navigate, so they never
 * reach this. Returning the existing Set when nothing changes avoids an
 * unnecessary React render.
 */
export function reconcileSidebarSessionSelection(
  current: Set<string>,
  sessionId: string | null,
  openTabRef: string | null,
): Set<string> {
  if (!sessionId) {
    if (!openTabRef) return current;
    return current.size === 0 ? current : new Set();
  }
  if (current.size === 1 && current.has(sessionId)) return current;
  return new Set([sessionId]);
}
