'use client';
import type { KeyboardEvent, MouseEventHandler, PointerEvent as ReactPointerEvent } from 'react';
import {
  MAIN_MIN_WIDTH, PANEL_BOUNDS, PANEL_WIDTH_KEY, isPanelClosed, panelDoubleClick, panelDragWidth,
  panelTier, type PanelId,
} from './panelLayout';
import { readPanelLayout, usePanelLayout, writePanelLayout } from './panelLayoutStore';

/** A press must travel this far before it is a drag: the two presses of a
 *  double-click must not first resize by a pixel of jitter (which would turn
 *  "close" into "back to the default width"). */
const DRAG_THRESHOLD_PX = 3;
const KEY_STEP_PX = 16;

const CSS_VAR: Record<PanelId, string> = { side: '--side-w', tools: '--tools-w' };

/**
 * The draggable edge of a side column (app/panelLayout.ts). A grid SIBLING of
 * the column, not a child: both columns clip their overflow, and an edge drawn
 * inside one would sit on top of its scrollbar instead of straddling the border.
 *
 * While dragging, the width and its tier go straight to the grid (`--side-w`,
 * `data-side`, …) — a store write per pointer move would re-render the whole
 * panel tree at 60 Hz. Only crossing the closed state goes through the store
 * mid-drag (it changes what React renders: the peek, the tool icons' click);
 * the width lands on release.
 */
export default function PanelResizer({ panel, onMouseEnter, onMouseLeave }: {
  panel: PanelId;
  /** The sidebar's peek keeps itself open while the pointer is on its edge. */
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
}) {
  const layout = usePanelLayout();
  if (!layout) return null;
  const key = PANEL_WIDTH_KEY[panel];
  const width = layout[key];
  const closed = isPanelClosed(panel, width);
  const { min, max } = PANEL_BOUNDS[panel];

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const root = handle.closest<HTMLElement>('.app-root');
    if (!root) return;
    e.preventDefault();
    const startX = e.clientX;
    const rect = root.getBoundingClientRect();
    // Resolved track sizes; two tracks (≤1100px) means the tools column is a
    // drawer and takes no room.
    const tracks = getComputedStyle(root).gridTemplateColumns.split(' ').map(parseFloat);
    const other = tracks.length >= 3 ? (panel === 'side' ? tracks[2] : tracks[0]) || 0 : 0;
    const maxForViewport = rect.width - other - MAIN_MIN_WIDTH;
    let dragging = false;
    let dragged: number | null = null;
    let done = false;
    handle.setPointerCapture(e.pointerId);

    const show = (w: number) => {
      root.style.setProperty(CSS_VAR[panel], `${w}px`);
      root.dataset[panel] = panelTier(panel, w);
    };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        root.classList.add('panel-resizing');
        handle.classList.add('dragging');
      }
      const distance = panel === 'side' ? ev.clientX - rect.left : rect.right - ev.clientX;
      dragged = panelDragWidth(panel, distance, maxForViewport);
      show(dragged);
      if (isPanelClosed(panel, dragged) !== isPanelClosed(panel, readPanelLayout()[key])) {
        writePanelLayout({ [key]: dragged });
      }
    };
    const end = () => {
      if (done) return;
      done = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      root.classList.remove('panel-resizing');
      handle.classList.remove('dragging');
      if (dragging && dragged != null) writePanelLayout({ [key]: dragged });
      // React writes the grid only when the STORE value changes: put the
      // direct writes back on it in every case.
      show(readPanelLayout()[key]);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  }

  function toggle() {
    writePanelLayout({ [key]: panelDoubleClick(readPanelLayout()[key], panel) });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // Right widens the sidebar and narrows the tools: each edge follows the key.
    const grow = (e.key === 'ArrowRight') === (panel === 'side');
    writePanelLayout({ [key]: readPanelLayout()[key] + (grow ? KEY_STEP_PX : -KEY_STEP_PX) });
  }

  return (
    <div
      className={`panel-resizer ${panel}${closed ? ' closed' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={panel === 'side' ? 'sessions sidebar width' : 'tools panel width'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={closed
        ? 'Open — drag the edge, or double-click it'
        : 'Resize — drag the edge; double-click for the default width, again to close'}
      onPointerDown={onPointerDown}
      onDoubleClick={toggle}
      onKeyDown={onKeyDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
}
