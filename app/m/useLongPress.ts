'use client';
import { useRef } from 'react';
import type { TouchEvent as RTouchEvent, MouseEvent as RMouseEvent } from 'react';

// Hook : détecte un long-press (touch ou souris longue) et fournit des
// handlers à spreader sur un élément. Si le long-press se déclenche, le
// onClick suivant est swallow (pour éviter une navigation parasite).
//
// Usage :
//   const lp = useLongPress(() => openMenu(), { ms: 500 });
//   <button {...lp.handlers} onClick={...} onContextMenu={lp.onContextMenu}>
//     ...
//   </button>
//
// L'onClick passé par l'appelant peut tester `lp.consume()` au début pour
// savoir si le long-press a fired (auquel cas il doit return).

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
  /** À appeler au début du onClick : retourne true si le long-press
   * a fired et que le click doit être ignoré. */
  consume: () => boolean;
};

export function useLongPress(callback: () => void, opts: { ms?: number } = {}): LongPressApi {
  const ms = opts.ms ?? 500;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  function fire() {
    firedRef.current = true;
    // haptic feedback si dispo (Android)
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
      // Sur mobile, un long-press déclenche aussi parfois oncontextmenu.
      // Sur desktop (mode mobile forcé), c'est le clic droit.
      // Dans les deux cas on prévient la menu native et on ouvre le sheet.
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
