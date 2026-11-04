/**
 * Desktop geometry of the two side columns (§11): the session sidebar on the
 * left, the ToolPanel on the right. ONE number per column, continuous from its
 * minimum to its maximum: release a drag anywhere and the column keeps that
 * width, its contents re-laid out for it (the TIERS below). The minimum is the
 * CLOSED state — the sidebar's cards reduced to their icons, the ToolPanel to
 * its activity bar alone — and only there does hovering the sidebar peek it
 * open, at its default width. Each column remembers its last OPEN width, which
 * is what the ToolPanel's icons reopen it at.
 *
 * Pure on purpose (no React, no 'use client'): the page reads the cookie
 * SERVER-side and renders the user's columns in the first paint. A
 * localStorage read could only land after hydration — one frame of the default
 * grid, then a jump. Browser-local like every layout choice (a phone and a
 * desktop do not share column widths). Drawers below the breakpoints ignore all
 * of it: the CSS gates the tiers and the edges by media query.
 */

export type PanelId = 'side' | 'tools';

export type PanelLayout = {
  sideW: number;
  toolsW: number;
  /** Last open (> min) width of each column: what a reopen restores. */
  sideLast: number;
  toolsLast: number;
};

export const PANEL_LAYOUT_COOKIE = 'charon_panels';

/** `min` is the closed width (mirrored in app.css), `def` what a
 *  double-click restores and the size a hover-peek opens at. */
export const PANEL_BOUNDS: Record<PanelId, { min: number; def: number; max: number }> = {
  side: { min: 56, def: 280, max: 560 },
  // The 40px activity bar + the body's historical 340px.
  tools: { min: 40, def: 380, max: 760 },
};

/** The chat column a drag may never squeeze below. */
export const MAIN_MIN_WIDTH = 420;

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  sideW: PANEL_BOUNDS.side.def,
  toolsW: PANEL_BOUNDS.tools.def,
  sideLast: PANEL_BOUNDS.side.def,
  toolsLast: PANEL_BOUNDS.tools.def,
};

export const PANEL_WIDTH_KEY: Record<PanelId, 'sideW' | 'toolsW'> = { side: 'sideW', tools: 'toolsW' };
export const PANEL_LAST_KEY: Record<PanelId, 'sideLast' | 'toolsLast'> = { side: 'sideLast', tools: 'toolsLast' };

/** How a column lays its contents out at a width, as `data-side` /
 *  `data-tools` on the grid (app.css § SIDE COLUMNS). Sidebar: icons only
 *  (also the closed state), then cards with names but no state pill, then
 *  everything. ToolPanel: its activity bar alone when closed, the bar beside
 *  the body otherwise. */
export type SideTier = 'icons' | 'narrow' | 'full';
export type ToolsTier = 'closed' | 'open';

const SIDE_NAMES_FROM = 160;
const SIDE_FULL_FROM = 240;

export function sideTier(width: number): SideTier {
  return width < SIDE_NAMES_FROM ? 'icons' : width < SIDE_FULL_FROM ? 'narrow' : 'full';
}

export function toolsTier(width: number): ToolsTier {
  return width <= PANEL_BOUNDS.tools.min ? 'closed' : 'open';
}

export function panelTier(panel: PanelId, width: number): string {
  return panel === 'side' ? sideTier(width) : toolsTier(width);
}

export function isPanelClosed(panel: PanelId, width: number): boolean {
  return width <= PANEL_BOUNDS[panel].min;
}

export function clampPanelWidth(panel: PanelId, value: unknown): number {
  const { min, def, max } = PANEL_BOUNDS[panel];
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** A remembered width is an OPEN one: anything closed or invalid is the
 *  default. */
function clampLastWidth(panel: PanelId, value: unknown): number {
  const w = clampPanelWidth(panel, value);
  return w > PANEL_BOUNDS[panel].min ? w : PANEL_BOUNDS[panel].def;
}

export function normalizePanelLayout(layout: PanelLayout): PanelLayout {
  return {
    sideW: clampPanelWidth('side', layout.sideW),
    toolsW: clampPanelWidth('tools', layout.toolsW),
    sideLast: clampLastWidth('side', layout.sideLast),
    toolsLast: clampLastWidth('tools', layout.toolsLast),
  };
}

/** Apply new widths: an open width also becomes the column's remembered one,
 *  a closed width keeps the previous. */
export function withPanelWidths(
  current: PanelLayout, widths: Partial<Pick<PanelLayout, 'sideW' | 'toolsW'>>,
): PanelLayout {
  const next = normalizePanelLayout({ ...current, ...widths });
  for (const panel of ['side', 'tools'] as const) {
    const w = next[PANEL_WIDTH_KEY[panel]];
    if (!isPanelClosed(panel, w)) next[PANEL_LAST_KEY[panel]] = w;
  }
  return next;
}

/** Cookie value `v3.<sideW>.<toolsW>.<sideLast>.<toolsLast>`: digits and dots
 *  only, so it needs no encoding. Older shapes still read: `v2` (two widths)
 *  and `v1` (a width plus a folded flag, folded = the minimum). Anything else
 *  is the default layout. */
export function parsePanelLayout(raw: string | null | undefined): PanelLayout {
  const value = raw ?? '';
  const v3 = /^v3\.(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(value);
  if (v3) {
    return normalizePanelLayout({
      sideW: Number(v3[1]), toolsW: Number(v3[2]), sideLast: Number(v3[3]), toolsLast: Number(v3[4]),
    });
  }
  const v2 = /^v2\.(\d{1,4})\.(\d{1,4})$/.exec(value);
  if (v2) return withPanelWidths(DEFAULT_PANEL_LAYOUT, { sideW: Number(v2[1]), toolsW: Number(v2[2]) });
  const v1 = /^v1\.(\d{1,4})\.([01])\.(\d{1,4})\.([01])$/.exec(value);
  if (v1) {
    return normalizePanelLayout({
      sideW: v1[2] === '1' ? PANEL_BOUNDS.side.min : Number(v1[1]),
      toolsW: v1[4] === '1' ? PANEL_BOUNDS.tools.min : Number(v1[3]),
      sideLast: Number(v1[1]),
      toolsLast: Number(v1[3]),
    });
  }
  return DEFAULT_PANEL_LAYOUT;
}

export function serializePanelLayout(layout: PanelLayout): string {
  const l = normalizePanelLayout(layout);
  return `v3.${l.sideW}.${l.toolsW}.${l.sideLast}.${l.toolsLast}`;
}

/** Double-click on a column's edge: any width but the default returns to it
 *  (a closed column opens), the default closes. */
export function panelDoubleClick(width: number, panel: PanelId): number {
  const { min, def } = PANEL_BOUNDS[panel];
  return width === def ? min : def;
}

/** Where a drag lands, from the pointer's distance to the column's outer edge:
 *  any width from the minimum (closed) to the maximum, never more than what
 *  leaves the chat its own minimum. */
export function panelDragWidth(panel: PanelId, distance: number, maxForViewport: number): number {
  const { min, max } = PANEL_BOUNDS[panel];
  const upper = Math.max(min, Math.min(max, Math.floor(maxForViewport)));
  return Math.min(upper, Math.max(min, Math.round(distance)));
}
