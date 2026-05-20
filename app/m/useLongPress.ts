'use client';
import { useRef } from 'react';
import type { TouchEvent as RTouchEvent, MouseEvent as RMouseEvent } from 'react';

// Hook: detects a long-press (touch or long mouse press) and provides
// handlers to spread onto an element. If the long-press fires, the
// following onClick is swallowed (to avoid an unwanted navigation).
//
// Usage:
//   const lp = useLongPress(() => openMenu(), { ms: 500 });
//   <button {...lp.handlers} onClick={...} onContextMenu={lp.onContextMenu}>
//     ...
//   </button>
//
// The onClick passed by the caller can test `lp.consume()` at the start to
// know whether the long-press fired (in which case it should return).

const MOVE_THRESHOLD_PX = 8;

export type LongPressApi = {
  handlers: {
    onTouchStart: (e: RTouchEvent) => void;
    onTouchEnd: () => void;
    onTouchMove: (e: RTouchEvent) => void;
    onTouchCancel: () => void;
    onMouseDown: (e: RMouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
  };
  onContextMenu: (e: RMouseEvent) => void;
  /** Call at the start of onClick: returns true if the long-press
   * fired and the click should be ignored. */
  consume: () => boolean;
};

export function useLongPress(callback: () => void, opts: { ms?: number } = {}): LongPressApi {
  const ms = opts.ms ?? 500;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  function fire() {
    firedRef.current = true;
    // haptic feedback if available (Android)
    try { (navigator as any).vibrate?.(15); } catch {}
    callback();
  }

  function cancel() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  return {
    handlers: {
      onTouchStart: (e) => {
        firedRef.current = false;
        const t = e.touches[0];
        startRef.current = { x: t.clientX, y: t.clientY };
        timerRef.current = setTimeout(fire, ms);
      },
      onTouchMove: (e) => {
        if (!startRef.current || !timerRef.current) return;
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - startRef.current.x);
        const dy = Math.abs(t.clientY - startRef.current.y);
        if (dx > MOVE_THRESHOLD_PX || dy > MOVE_THRESHOLD_PX) cancel();
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
      onMouseDown: (e) => {
        if (e.button !== 0) return;
        firedRef.current = false;
        startRef.current = { x: e.clientX, y: e.clientY };
        timerRef.current = setTimeout(fire, ms);
      },
      onMouseUp: cancel,
      onMouseLeave: cancel,
    },
    onContextMenu: (e) => {
      // On mobile, a long-press also sometimes triggers oncontextmenu.
      // On desktop (forced mobile mode), it's the right-click.
      // In both cases we prevent the native menu and open the sheet.
      e.preventDefault();
      cancel();
      if (!firedRef.current) fire();
    },
    consume: () => {
      if (firedRef.current) {
        firedRef.current = false;
        return true;
      }
      return false;
    },
  };
}
