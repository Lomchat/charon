// Walking up a chat column message by message (SessionView's ↑ pills, and the
// desk drawer's). Browser-only, no state.

/**
 * The closest bubble of `role` whose top sits ABOVE the visible area of the
 * chat column `el` — the one an "up" step lands on — or null when none is
 * left above.
 *
 * Roles come from Message.tsx's `data-msg-role`: only the rendered chat
 * bubbles carry it (tool/thinking cards don't), which is exactly the set worth
 * stopping on. Measured in SCREEN coordinates, so the sign of `scrollTop` in a
 * reversed column (negative in Chrome) never matters.
 */
export function chatBubbleAbove(el: HTMLElement, role: 'user' | 'assistant'): HTMLElement | null {
  const top = el.getBoundingClientRect().top;
  let target: HTMLElement | null = null;
  let bestGap = Infinity;
  for (const bubble of el.querySelectorAll<HTMLElement>(`[data-msg-role="${role}"]`)) {
    const gap = top - bubble.getBoundingClientRect().top;
    // gap > 4: at least 4px above the visible top (not the bubble that sits
    // exactly at the limit).
    if (gap > 4 && gap < bestGap) {
      bestGap = gap;
      target = bubble;
    }
  }
  return target;
}
