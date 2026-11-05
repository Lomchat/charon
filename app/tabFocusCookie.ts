/**
 * This browser's tab focus (tabStore § persistActiveId), mirrored into a
 * cookie so the SSR first paint is already ITS tab. Projected from the shared
 * layout's legacy `active` bit, the first frame showed another device's last
 * open — the pane mounted that session and the sidebar revealed its card,
 * then both jumped to the local tab once `restoreLocalTabFocus` ran.
 * localStorage stays the source of truth; the projection below mirrors that
 * restore exactly, so it finds nothing to change.
 *
 * Pure on purpose (no React, no 'use client'): page.tsx reads it server-side,
 * like the panel layout (panelLayout.ts).
 */
import type { TabDTO } from '@/lib/types/api';

export const TAB_FOCUS_COOKIE = 'charon_tab';

/** '' = explicitly no tab (an emptied workspace). */
export function serializeTabFocus(activeId: string | null): string {
  return encodeURIComponent(activeId ?? '');
}

/** `undefined` = no cookie (keep the layout's own choice); `null` = no tab. */
export function parseTabFocus(raw: string | null | undefined): string | null | undefined {
  if (raw == null) return undefined;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return undefined;
  }
}

/** The tabs as this browser will focus them: a remembered tab that no longer
 *  exists means no tab (as `restoreLocalTabFocus`). */
export function projectTabFocus(tabs: TabDTO[], focus: string | null | undefined): TabDTO[] {
  if (focus === undefined) return tabs;
  const activeId = focus && tabs.some((t) => t.id === focus) ? focus : null;
  return tabs.map((t) => (t.active === (t.id === activeId) ? t : { ...t, active: t.id === activeId }));
}
