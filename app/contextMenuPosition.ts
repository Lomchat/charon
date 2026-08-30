export type ContextMenuPosition = { left: number; top: number };

/**
 * Place a measured fixed-position menu inside the viewport.
 *
 * Prefer the click as its top-left anchor. If the real rendered height would
 * cross the bottom edge, open upward from the click instead; final clamping
 * covers clicks at an edge and viewports smaller than the menu. CSS gives the
 * menus a viewport-bounded max-height, so an oversized menu scrolls internally
 * while its box remains fully visible.
 */
export function positionContextMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): ContextMenuPosition {
  const safeMargin = Math.max(0, Math.min(
    margin,
    viewportWidth / 2,
    viewportHeight / 2,
  ));
  const maxLeft = Math.max(safeMargin, viewportWidth - safeMargin - width);
  const maxTop = Math.max(safeMargin, viewportHeight - safeMargin - height);

  const left = Math.min(Math.max(safeMargin, x), maxLeft);
  const preferredTop = y + height > viewportHeight - safeMargin
    ? y - height
    : y;
  const top = Math.min(Math.max(safeMargin, preferredTop), maxTop);
  return { left, top };
}
