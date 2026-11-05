// How far the sidebar scrolls to reveal the selected row (Sidebar § reveal).
// Fully shown: not at all. Cut by an edge or by the pinned server head: the
// LEAST scroll that shows it, plus a little air — a click on a card at the
// edge must not recentre the whole list. Entirely out of sight (opened from a
// tab, the header nav, a notification): centred in the visible band.

/** Viewport coordinates. The band runs from under the pinned server head to
 *  the scroller's bottom edge. */
export type RevealGeometry = { bandTop: number; bandBottom: number; rowTop: number; rowBottom: number };

export const REVEAL_MARGIN = 8;

/** How long a navigation waits for its row (a collapsed folder unfolds
 *  through the server) before the reveal is dropped. */
export const REVEAL_TTL_MS = 2000;

/** The `scrollTop` delta that reveals the row; 0 when it is fully visible. */
export function revealScrollDelta({ bandTop, bandBottom, rowTop, rowBottom }: RevealGeometry): number {
  if (rowTop >= bandTop && rowBottom <= bandBottom) return 0;
  if (rowBottom <= bandTop || rowTop >= bandBottom) {
    return (rowTop + rowBottom) / 2 - (bandTop + bandBottom) / 2;
  }
  const slack = (bandBottom - bandTop) - (rowBottom - rowTop);
  const margin = Math.min(REVEAL_MARGIN, Math.max(0, slack / 2));
  // Cut at the top, or taller than the band: align its top.
  if (rowTop < bandTop || slack < 0) return rowTop - bandTop - margin;
  return rowBottom - bandBottom + margin;
}
