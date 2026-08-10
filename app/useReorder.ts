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
 *  - a drop outside the list, or onto the item you picked up, is a no-op — a
 *    reorder nobody asked for is worse than one that didn't happen.
 */
export type ReorderHandlers = {
  draggingId: string | null;
  overId: string | null;
  /** Spread onto each item element. */
  itemProps: (id: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    'data-dragging'?: string;
    'data-over'?: string;
  };
};

export function useReorder(ids: string[], onCommit: (ordered: string[]) => void): ReorderHandlers {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // The dragged id ALSO lives in a ref. The state copy exists only to drive
  // the styling; the logic must not depend on React having re-rendered between
  // `dragstart` and `drop`, which is true in a real drag (frames apart) but
  // not when the events arrive in one task.
  const draggingRef = useRef<string | null>(null);
  // The live list is read at drop time, not captured at drag start: another
  // device can add a tab mid-drag and the commit must be against what is
  // actually on screen now.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const finish = useCallback(() => {
    draggingRef.current = null;
    setDraggingId(null);
    setOverId(null);
  }, []);

  const itemProps = useCallback((id: string) => ({
    draggable: true as const,
    onDragStart: (e: React.DragEvent) => {
      draggingRef.current = id;
      setDraggingId(id);
      e.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without some payload.
      try { e.dataTransfer.setData('text/plain', id); } catch { /* ignore */ }
    },
    onDragEnter: (e: React.DragEvent) => {
      if (!draggingRef.current || draggingRef.current === id) return;
      e.preventDefault();
      setOverId(id);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!draggingRef.current) return;
      // Without preventDefault the browser never fires `drop`.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const from = draggingRef.current;
      finish();
      if (!from || from === id) return;
      const cur = idsRef.current;
      const fromIdx = cur.indexOf(from);
      const toIdx = cur.indexOf(id);
      if (fromIdx === -1 || toIdx === -1) return;
      const next = [...cur];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      onCommit(next);
    },
    onDragEnd: finish,
    ...(draggingId === id ? { 'data-dragging': 'true' } : {}),
    ...(overId === id ? { 'data-over': 'true' } : {}),
  }), [draggingId, overId, finish, onCommit]);

  return { draggingId, overId, itemProps };
}
