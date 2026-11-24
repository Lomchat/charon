// The sidebar's middle card stays put across a change of every card's height
// (the details switch, Sidebar): the card nearest the middle of the list is
// read before the change and scrolled back to the same height after it, so
// what was in the middle is still in the middle. At the very top the list
// stays at its top.

export type ScrollAnchor = { id: string; center: number };

/** The card (`data-tab-id`) whose centre is nearest the scroller's middle,
 *  with that centre's offset from the scroller's top edge. */
export function captureMiddleAnchor(viewport: HTMLElement | null): ScrollAnchor | null {
  if (!viewport || viewport.scrollTop <= 0) return null;
  const v = viewport.getBoundingClientRect();
  if (v.height === 0) return null;
  const middle = v.top + v.height / 2;
  let best: { id: string; center: number; distance: number } | null = null;
  for (const card of viewport.querySelectorAll<HTMLElement>('[data-tab-id]')) {
    const r = card.getBoundingClientRect();
    if (r.height === 0) continue;
    const center = (r.top + r.bottom) / 2;
    const distance = Math.abs(center - middle);
    if (!best || distance < best.distance) {
      best = { id: card.dataset.tabId ?? '', center: center - v.top, distance };
    } else if (center > middle) {
      break; // Document order is top to bottom: only farther cards follow.
    }
  }
  return best && best.id ? { id: best.id, center: best.center } : null;
}

/** Scroll so the anchored card's centre is back where it was read. */
export function restoreAnchor(viewport: HTMLElement | null, anchor: ScrollAnchor | null): void {
  if (!viewport || !anchor) return;
  const card = viewport.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(anchor.id)}"]`);
  if (!card) return;
  const v = viewport.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const delta = (r.top + r.bottom) / 2 - v.top - anchor.center;
  if (delta !== 0) viewport.scrollTop += delta;
}
