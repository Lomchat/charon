/**
 * The sidebar's browser-local selection FOLLOWS THE OPEN SESSION. Opening one
 * from anywhere — a plain sidebar click, the header nav, a notification, the
 * tab bar, a deep link, a freshly created row — leaves exactly that card
 * highlighted, instead of painting the previous one as still selected. A
 * deliberate multi-row selection is safe: the gestures that build it
 * (Ctrl/Cmd, Shift) never navigate, so this never runs for them. Returning the
 * existing Set when nothing changes avoids an unnecessary React render.
 */
export function reconcileSidebarSessionSelection(
  current: Set<string>,
  sessionId: string | null,
): Set<string> {
  if (!sessionId) return current;
  if (current.size === 1 && current.has(sessionId)) return current;
  return new Set([sessionId]);
}
