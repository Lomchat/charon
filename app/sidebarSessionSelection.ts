/**
 * Keep the sidebar's browser-local bulk selection independent from the open
 * tab, except when a caller explicitly asks to replace it (for example after
 * creating a session). Returning the existing Set when nothing changes avoids
 * an unnecessary React render.
 */
export function reconcileSidebarSessionSelection(
  current: Set<string>,
  sessionId: string | null,
  replace: boolean,
): Set<string> {
  if (!sessionId || (!replace && current.size > 0)) return current;
  if (current.size === 1 && current.has(sessionId)) return current;
  return new Set([sessionId]);
}
