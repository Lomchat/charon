'use client';
import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  DEFAULT_PANEL_LAYOUT,
  PANEL_LAYOUT_COOKIE,
  parsePanelLayout,
  serializePanelLayout,
  withPanelWidths,
  type PanelLayout,
} from './panelLayout';

/**
 * The browser's copy of the column layout (app/panelLayout.ts). One value per
 * tab on `globalThis` (§14.106), read lazily from the cookie the server
 * seeded the page from — so the client's first snapshot equals the server's.
 *
 * The seeded value travels by CONTEXT, not by a module write: a server-side
 * global would be shared by every request. Its presence also says "this tree
 * is Charon's main layout"; outside it (the desk's session modal) the panels
 * neither close nor resize.
 */

const g = globalThis as unknown as {
  __charonPanelLayout?: PanelLayout;
  __charonPanelLayoutSubs?: Set<() => void>;
};
g.__charonPanelLayoutSubs ??= new Set<() => void>();

function readCookie(): PanelLayout {
  if (typeof document === 'undefined') return DEFAULT_PANEL_LAYOUT;
  const m = new RegExp(`(?:^|;\\s*)${PANEL_LAYOUT_COOKIE}=([^;]*)`).exec(document.cookie);
  return parsePanelLayout(m?.[1]);
}

export function readPanelLayout(): PanelLayout {
  return (g.__charonPanelLayout ??= readCookie());
}

function subscribe(fn: () => void): () => void {
  g.__charonPanelLayoutSubs!.add(fn);
  return () => { g.__charonPanelLayoutSubs!.delete(fn); };
}

export function writePanelLayout(widths: Partial<Pick<PanelLayout, 'sideW' | 'toolsW'>>): void {
  const current = readPanelLayout();
  const next = withPanelWidths(current, widths);
  if (serializePanelLayout(next) === serializePanelLayout(current)) return;
  g.__charonPanelLayout = next;
  try {
    document.cookie = `${PANEL_LAYOUT_COOKIE}=${serializePanelLayout(next)}; path=/; max-age=31536000; samesite=lax`;
  } catch {}
  for (const fn of g.__charonPanelLayoutSubs!) fn();
}

const PanelLayoutSsr = createContext<PanelLayout | null>(null);
export const PanelLayoutProvider = PanelLayoutSsr.Provider;

/** For the component that renders the grid itself (it provides the context,
 *  so it cannot read it). */
export function usePanelLayoutRoot(ssr: PanelLayout): PanelLayout {
  return useSyncExternalStore(subscribe, readPanelLayout, () => ssr);
}

/** The layout, or null outside Charon's main grid (nothing to fold there). */
export function usePanelLayout(): PanelLayout | null {
  const ssr = useContext(PanelLayoutSsr);
  const value = useSyncExternalStore(subscribe, readPanelLayout, () => ssr ?? DEFAULT_PANEL_LAYOUT);
  return ssr ? value : null;
}
