'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * Drag-to-reorder for a single list, on native HTML5 drag events.
 *
 * Native rather than @dnd-kit (which the repo already has, for the VPS/folder
 * DnD in DataModal): that library earns its weight for a two-dimensional
 * layout with cross-container moves. Here every list is one dimension with no
 * cross-container drops, and the native events do it in forty lines with no
 * pointer-sensor configuration and no bundle cost on the main page.
 *
 * The contract is deliberately narrow:
 *  - ids only, never elements. The caller stays in charge of rendering.
 *  - `onCommit` receives the FULL new order, because that is what both reorder
 *    endpoints take: a from/to pair is only meaningful against the list the
 *    dragger was looking at, and these lists are shared and polled.
 *  - a drop outside the list, or one that changes nothing, is a no-op — a
 *    reorder nobody asked for is worse than one that didn't happen.
 *
 * Drops land BEFORE or AFTER the row under the pointer, decided by the row's
 * midpoint along `axis`. That is what makes the LAST slot reachable: an
 * insert-at-the-target's-index rule can only ever express "before this one",
 * so the end of the list has no target and the tail is unreachable — you could
 * put a row second-to-last and no further.
 */
export type ReorderHandlers = {
  draggingId: string | null;
  overId: string | null;
  /** Spread onto each item element. */
  itemProps: (id: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    'data-dragging'?: string;
    'data-over'?: string;
  };
};

type Opts = {
  /** Layout direction of the list: 'x' for a strip of tabs, 'y' for a column. */
  axis?: 'x' | 'y';
};

/**
 * The whole ordering rule, pure so it can be tested without a DOM: move `from`
 * to just before (or after) `target`. Returns null when nothing would change —
 * a drop that reorders nothing must not round-trip to the server.
 */
export function insertRelative(
  ids: string[], from: string, target: string, after: boolean,
): string[] | null {
  // Dropping a row on itself: not a reorder, and `rest` wouldn't contain the
  // target, so the splice below would silently insert at the wrong end.
  if (from === target) return null;
  if (ids.indexOf(from) === -1 || ids.indexOf(target) === -1) return null;
  // Built against the list WITHOUT the dragged row, so "before/after this row"
  // means the same thing wherever the row came from.
  const rest = ids.filter((x) => x !== from);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  rest.splice(at, 0, from);
  return rest.every((x, i) => x === ids[i]) ? null : rest;
}

export function useReorder(
  ids: string[],
  onCommit: (ordered: string[]) => void,
  opts: Opts = {},
): ReorderHandlers {
  const axis = opts.axis ?? 'x';
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  // The dragged id ALSO lives in a ref. The state copy exists only to drive
  // the styling; the logic must not depend on React having re-rendered between
  // `dragstart` and `drop`, which is true in a real drag (frames apart) but
  // not when the events arrive in one task.
  const draggingRef = useRef<string | null>(null);
  // Same for the drop side: `drop` must not read a `setState` that React has
  // not flushed yet.
  const overRef = useRef<{ id: string; after: boolean } | null>(null);
  // The live list is read at drop time, not captured at drag start: another
  // device can add a tab mid-drag and the commit must be against what is
  // actually on screen now.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const finish = useCallback(() => {
    draggingRef.current = null;
    overRef.current = null;
    setDraggingId(null);
    setOver(null);
  }, []);

  /** Is the pointer past the midpoint of the row it is over? */
  const isAfter = useCallback((e: React.DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return axis === 'y'
      ? e.clientY > r.top + r.height / 2
      : e.clientX > r.left + r.width / 2;
  }, [axis]);

  const itemProps = useCallback((id: string) => ({
    draggable: true as const,
    onDragStart: (e: React.DragEvent) => {
      draggingRef.current = id;
      setDraggingId(id);
      e.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without some payload.
      try { e.dataTransfer.setData('text/plain', id); } catch { /* ignore */ }
    },
    onDragOver: (e: React.DragEvent) => {
      if (!draggingRef.current) return;
      // Without preventDefault the browser never fires `drop`.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = isAfter(e);
      const cur = overRef.current;
      if (cur?.id === id && cur.after === after) return;   // no re-render per pixel
      overRef.current = { id, after };
      setOver({ id, after });
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const from = draggingRef.current;
      // The drop side comes from this event, not from the last dragover: a
      // pointer can move between the two, and the indicator the user saw must
      // be the one that lands.
      const after = isAfter(e);
      finish();
      if (!from) return;
      const next = insertRelative(idsRef.current, from, id, after);
      if (next) onCommit(next);
    },
    onDragEnd: finish,
    ...(draggingId === id ? { 'data-dragging': 'true' } : {}),
    ...(over?.id === id && over.id !== draggingId
      ? { 'data-over': over.after ? 'after' : 'before' }
      : {}),
  }), [draggingId, over, finish, onCommit, isAfter]);

  return { draggingId, overId: over?.id ?? null, itemProps };
}
