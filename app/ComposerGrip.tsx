'use client';
import { useRef, type RefObject } from 'react';
import {
  COMPOSER_MAX_VIEWPORT_SHARE, DEFAULT_COMPOSER_SIZE, clickComposer, sameComposerSize, snapComposer,
  stepComposer,
  type ComposerMetrics, type ComposerSize,
} from './composerSize';

/**
 * The handle on the composer's top edge (`composerSize.ts` owns the states and
 * the snapping). Drag up: taller. Drag down: back to the default, where it
 * holds, then hidden — the bar is then this strip alone. A click steps through
 * the same states: hidden or taller → the default, the default → hidden.
 */
export default function ComposerGrip({ footerRef, textRef, size, onPreview, onCommit }: {
  footerRef: RefObject<HTMLElement | null>;
  textRef: RefObject<HTMLTextAreaElement | null>;
  /** The committed size (not the preview of a drag in progress). */
  size: ComposerSize;
  /** Live state while dragging; `null` when the drag ends or is cancelled. */
  onPreview: (s: ComposerSize | null) => void;
  onCommit: (s: ComposerSize) => void;
}) {
  const drag = useRef<{
    pointerId: number; startY: number; startFooter: number;
    metrics: ComposerMetrics; last: ComposerSize | null;
  } | null>(null);

  const metrics = (): ComposerMetrics | null => {
    const footer = footerRef.current;
    const text = textRef.current;
    return footer && text ? measureComposer(footer, text) : null;
  };

  const end = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    onPreview(null);
    if (commit && d?.last) onCommit(d.last);
  };

  return (
    <div
      className="ci-grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label="message box size"
      aria-valuetext={size.hidden ? 'hidden' : size.height == null ? 'default size' : `${size.height} pixels`}
      tabIndex={0}
      title={size.hidden
        ? 'show the message box — click, or drag up'
        : size.height == null
          ? 'drag to resize the message box · click to hide it'
          : 'drag to resize the message box · click for the default size'}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const m = metrics();
        const footer = footerRef.current;
        if (!m || !footer) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          pointerId: e.pointerId, startY: e.clientY, startFooter: footer.offsetHeight,
          metrics: m, last: null,
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dy = d.startY - e.clientY;
        // A few px of jitter is still a click, not a resize.
        if (!d.last && Math.abs(dy) < 4) return;
        const next = snapComposer(d.startFooter + dy, d.metrics);
        if (d.last && sameComposerSize(d.last, next)) return;
        d.last = next;
        onPreview(next);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (d.last) { end(true); return; }
        // It never left the jitter zone: a click.
        end(false);
        onCommit(clickComposer(size));
      }}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => { if (drag.current) end(false); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCommit(clickComposer(size));
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          onCommit(DEFAULT_COMPOSER_SIZE);
          return;
        }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const m = metrics();
        if (m) onCommit(stepComposer(size, e.key === 'ArrowUp' ? 1 : -1, m));
      }}
    >
      <span className="ci-grip-pill" aria-hidden="true" />
    </div>
  );
}

/**
 * The default and hidden heights, measured on the real layout: they depend on
 * density, the phone breakpoint and the provider's mode column, none of which
 * this file should hard-code. The bar is switched to each state and back
 * within one task — layout is read synchronously, nothing is painted between.
 */
export function measureComposer(footer: HTMLElement, text: HTMLTextAreaElement): ComposerMetrics {
  const className = footer.className;
  const minHeight = text.style.minHeight;
  footer.classList.remove('is-collapsed', 'is-sized');
  text.style.minHeight = '';
  const baseFooter = footer.offsetHeight;
  const baseText = text.offsetHeight;
  footer.classList.add('is-collapsed');
  const hiddenFooter = footer.offsetHeight;
  footer.className = className;
  text.style.minHeight = minHeight;
  return {
    baseFooter, baseText, hiddenFooter,
    maxText: Math.max(baseText, Math.round(window.innerHeight * COMPOSER_MAX_VIEWPORT_SHARE)),
  };
}
