'use client';
import { useRef } from 'react';
import type { TouchEvent as RTouchEvent } from 'react';

// Touch long-press detector for opening context menus on mobile, where there
// is no right-click. Spread {...lp.handlers} onto the element and call
// lp.consume() at the top of its onClick to swallow the click synthesized
// after a long-press. The callback receives the screen coordinates of the
// press so the caller can position a context menu there.
//
// Touch-only by design: desktop keeps its own onContextMenu (right-click)
// handler, so there is zero desktop behavior change. On Android a native
// `contextmenu` may also fire on long-press; if both paths call the same
// single-state context-menu opener that is harmless (idempotent), and
// consume() still swallows the trailing click. cf. CLAUDE.md §11.
//
// Supersedes the old app/m/useLongPress.ts (deleted with /m).

const MOVE_THRESHOLD_PX = 8;

export type LongPressCoords = { x: number; y: number };

export type LongPressApi = {
  handlers: {
    onTouchStart: (e: RTouchEvent) => void;
    onTouchEnd: () => void;
    onTouchMove: (e: RTouchEvent) => void;
    onTouchCancel: () => void;
  };
  /** Call at the start of onClick: returns true if a long-press just fired
   * and the synthesized click should be ignored. */
  consume: () => boolean;
};

export function useLongPress(
  callback: (coords: LongPressCoords) => void,
  opts: { ms?: number } = {},
): LongPressApi {
  const ms = opts.ms ?? 500;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const startRef = useRef<LongPressCoords>({ x: 0, y: 0 });

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
        if (!t) return;
        startRef.current = { x: t.clientX, y: t.clientY };
        cancel();
        timerRef.current = setTimeout(() => {
          firedRef.current = true;
          try { (navigator as any).vibrate?.(15); } catch {}
          callback(startRef.current);
        }, ms);
      },
      onTouchMove: (e) => {
        if (!timerRef.current) return;
        const t = e.touches[0];
        if (!t) return;
        const dx = Math.abs(t.clientX - startRef.current.x);
        const dy = Math.abs(t.clientY - startRef.current.y);
        if (dx > MOVE_THRESHOLD_PX || dy > MOVE_THRESHOLD_PX) cancel();
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
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
