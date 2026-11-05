'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCodeLike, tipFromAttrs, tipFromTitle, type HoverTipContent } from './tooltipText';

export type { HoverTipContent, TipAction } from './tooltipText';

/**
 * Themed tooltips, in place of the browser's `title` (late, unstyled, one
 * line). VS Code's rhythm: the first one waits, the next ones — the pointer
 * sliding along a toolbar — show at once; a press, a scroll or Escape hides.
 *
 * Two entry points share one card:
 *  - `useHoverTip` — a control that builds its own structured content (the
 *    ToolPanel's activity bar);
 *  - `<TooltipLayer/>` — mounted once in the root layout, it serves EVERY
 *    plain `title` attribute: on hover it borrows the attribute — its
 *    ancestors' too, so no native tooltip fires — shows the parsed text
 *    (app/tooltipText.ts) and puts them back when the pointer leaves. An object's element adds what it is and
 *    what can be done with it (`tipAttrs`). `data-tip-side` picks a side for
 *    the element and what it contains (a list's rows); sideways inside a
 *    `data-tip-region` (a sidebar column) it clears the whole column, level
 *    with the row, never over the list's neighbours;
 *    `data-tip="native"` opts an element out; `data-tip-instant` skips the
 *    open delay (a readout whose only purpose is its tooltip); an EMPTY title is transparent
 *    (an icon inside a row lets the row speak).
 *
 * Portaled to <body> and placed beside the control on the side that fits
 * (left of a right-edge bar, right of a left-edge rail, otherwise below, or
 * above when the bottom is short), clamped to the viewport.
 */

export type TipSide = 'top' | 'bottom' | 'left' | 'right';

const OPEN_DELAY_MS = 450;
/** After one hides, the next opens instantly for this long. */
const WARM_MS = 400;
const GAP_PX = 8;
const EDGE_PX = 8;
/** Controls this close to a viewport side are an edge bar: tip goes inward. */
const EDGE_BAR_PX = 72;
/** Past these, a control is a region (a full-height edge, a wide row): the tip
 *  anchors at the pointer along that axis, not at the region's middle. */
const TALL_PX = 120;
const WIDE_PX = 420;

type Shown = { rect: DOMRect; content: HoverTipContent; side?: TipSide };
type Placement = { side: TipSide; left: number; top: number; arrow: number };

const OPPOSITE: Record<TipSide, TipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** Selection gestures listen to Ctrl OR Cmd: name the one this keyboard has.
 *  Rendered here, not in the attribute — the server cannot know. */
function gestureLabel(gesture: string): string {
  if (typeof navigator === 'undefined' || !/Mac|iPhone|iPad/.test(navigator.platform)) return gesture;
  return gesture.replace(/\bCtrl\b/g, '⌘');
}

function place(rect: DOMRect, w: number, h: number, preferred?: TipSide): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits: Record<TipSide, boolean> = {
    bottom: rect.bottom + GAP_PX + h <= vh - EDGE_PX,
    top: rect.top - GAP_PX - h >= EDGE_PX,
    left: rect.left - GAP_PX - w >= EDGE_PX,
    right: rect.right + GAP_PX + w <= vw - EDGE_PX,
  };
  const auto: TipSide = rect.right > vw - EDGE_BAR_PX && rect.width < EDGE_BAR_PX ? 'left'
    : rect.left < EDGE_BAR_PX && rect.width < EDGE_BAR_PX ? 'right'
    : 'bottom';
  const first = preferred ?? auto;
  const order: TipSide[] = [first, OPPOSITE[first], 'bottom', 'top', 'left', 'right'];
  const side = order.find((s) => fits[s]) ?? first;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (side === 'top' || side === 'bottom') {
    const left = Math.min(vw - EDGE_PX - w, Math.max(EDGE_PX, cx - w / 2));
    const top = side === 'bottom' ? rect.bottom + GAP_PX : rect.top - GAP_PX - h;
    return { side, left, top, arrow: cx - left };
  }
  const top = Math.min(vh - EDGE_PX - h, Math.max(EDGE_PX, cy - h / 2));
  const left = side === 'left' ? rect.left - GAP_PX - w : rect.right + GAP_PX;
  return { side, left, top, arrow: cy - top };
}

function TipCard({ id, rect, content, side }: Shown & { id: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<Placement | null>(null);
  // Measured hidden, then placed before paint: no visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setAt(place(rect, el.offsetWidth, el.offsetHeight, side));
  }, [rect, side, content]);
  const vertical = at?.side === 'top' || at?.side === 'bottom';
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`hover-tip ${at?.side ?? 'bottom'}`}
      style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {at && (
        <span
          className="hover-tip-arrow"
          style={vertical ? { left: at.arrow } : { top: at.arrow }}
          aria-hidden
        />
      )}
      {(content.title || content.keys?.length) && (
        <div className="hover-tip-head">
          {content.title && <span className="hover-tip-title">{content.title}</span>}
          {content.count != null && content.count > 0 && <span className="hover-tip-count">{content.count}</span>}
          {content.keys && content.keys.length > 0 && (
            <span className="hover-tip-keys">{content.keys.map((k, i) => <kbd key={`${k}${i}`}>{k}</kbd>)}</span>
          )}
        </div>
      )}
      {content.detail && (
        <div className={`hover-tip-detail${content.mono ? ' mono' : ''}${content.title ? '' : ' alone'}`}>{content.detail}</div>
      )}
      {content.lines && (
        <div className="hover-tip-lines">
          {content.lines.map((line, i) => <div key={i} className={isCodeLike(line) ? 'mono' : undefined}>{line}</div>)}
        </div>
      )}
      {content.quote && <div className="hover-tip-quote">{content.quote}</div>}
      {content.hint && <div className="hover-tip-hint">{content.hint}</div>}
      {content.actions && (
        <div className="hover-tip-actions">
          {content.actions.map(([gesture, effect]) => (
            <span key={gesture} className="hover-tip-action"><kbd>{gestureLabel(gesture)}</kbd>{effect}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared open/close rhythm: one module-wide warm window, so sliding from a
 *  structured tip onto a `title` one stays instant too. */
const warm = { until: 0 };

export function useHoverTip(side?: TipSide) {
  const [shown, setShown] = useState<(Shown & { owner: string }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  /** `key` names the control, for its `aria-describedby`. */
  const show = useCallback((el: HTMLElement, content: HoverTipContent, key: string) => {
    clear();
    const open = () => setShown({ rect: el.getBoundingClientRect(), content, side, owner: key });
    if (Date.now() < warm.until) open();
    else timer.current = setTimeout(open, OPEN_DELAY_MS);
  }, [side]);
  const hide = useCallback(() => {
    clear();
    setShown((prev) => {
      if (prev) warm.until = Date.now() + WARM_MS;
      return null;
    });
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [shown, hide]);
  useEffect(() => clear, []);

  const node = shown && typeof document !== 'undefined'
    ? createPortal(<TipCard id={id} rect={shown.rect} content={shown.content} side={shown.side} />, document.body)
    : null;
  const describedBy = (key: string) => (shown?.owner === key ? id : undefined);
  return { show, hide, node, describedBy };
}

const SIDES = new Set<string>(['top', 'bottom', 'left', 'right']);

/** The nearest titled element from `start`, stopping at `current`. Titles
 *  are read through `titleOf`: a borrowed one is off the DOM, so a plain
 *  `closest('[title]')` would skip past it. An empty title is transparent. */
function titledFrom(
  start: Element | null, current: Element | null, titleOf: (el: Element) => string | null,
): Element | null {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    if (el === current) return current;
    if (titleOf(el)?.trim()) return el;
  }
  return null;
}

/** Every plain `title` on the page, as a themed tooltip. Mount once. */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const id = useId();

  useEffect(() => {
    let anchor: Element | null = null;
    // The anchor's title AND every titled ancestor's: with only its own
    // borrowed, the browser shows the nearest ancestor's natively (a gauge
    // row inside a titled button: two tooltips at once).
    const borrowed = new Map<Element, string>();
    const titleOf = (el: Element) => borrowed.get(el) ?? el.getAttribute('title');
    let visible = false;
    // Pressed, typed or scrolled: hidden until the pointer leaves — but the
    // title stays borrowed, or the native tooltip would show in its place.
    let dismissed = false;
    let px = 0;
    let py = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watch: ReturnType<typeof setInterval> | null = null;
    let observer: MutationObserver | null = null;

    const open = () => {
      timer = null;
      if (dismissed) return;
      if (!anchor || !anchor.isConnected) { release(); return; }
      const data = (anchor as HTMLElement).dataset ?? {};
      const text = borrowed.get(anchor);
      const content = data.tipDetail !== undefined
        ? tipFromAttrs(text, data.tipDetail, data.tipQuote, data.tipActions)
        : tipFromTitle(text);
      if (!content) return;
      const sided = anchor.closest<HTMLElement>('[data-tip-side]');
      const wanted = sided?.dataset.tipSide;
      const side = wanted && SIDES.has(wanted) ? wanted as TipSide : undefined;
      const box = anchor.getBoundingClientRect();
      // Sideways in a column: its whole width is the anchor's.
      const region = side === 'left' || side === 'right' ? anchor.closest('[data-tip-region]') : null;
      const span = region?.getBoundingClientRect() ?? null;
      const rect = new DOMRect(
        span ? span.left : box.width > WIDE_PX ? Math.min(box.right - 8, Math.max(box.left, px - 8)) : box.left,
        box.height > TALL_PX ? Math.min(box.bottom - 16, Math.max(box.top, py - 8)) : box.top,
        span ? span.width : box.width > WIDE_PX ? 16 : box.width,
        box.height > TALL_PX ? 16 : box.height,
      );
      visible = true;
      setShown({ rect, content, side });
      // The control can vanish under a still pointer (a re-render, a closed
      // modal): no pointerout comes then.
      watch ??= setInterval(() => { if (!anchor?.isConnected) release(); }, 400);
    };
    // Give the titles back — unless a re-render set a NEW one meanwhile,
    // which then stands.
    const release = () => {
      if (timer) clearTimeout(timer);
      if (watch) clearInterval(watch);
      timer = null;
      watch = null;
      observer?.disconnect();
      observer = null;
      for (const [el, title] of borrowed) if (!el.hasAttribute('title')) el.setAttribute('title', title);
      borrowed.clear();
      if (visible) {
        warm.until = Date.now() + WARM_MS;
        setShown(null);
      }
      anchor = null;
      visible = false;
      dismissed = false;
    };
    const dismiss = () => {
      if (!anchor) return;
      if (timer) clearTimeout(timer);
      timer = null;
      dismissed = true;
      if (visible) {
        warm.until = Date.now() + WARM_MS;
        setShown(null);
      }
      visible = false;
    };
    const take = (el: Element) => {
      anchor = el;
      // A re-render with a changed title puts the attribute back: take the
      // new text, keep the native tooltip away.
      const watched = new MutationObserver((records) => {
        for (const { target } of records) {
          const node = target as Element;
          const title = node.getAttribute('title');
          if (title == null) continue;
          borrowed.set(node, title);
          node.removeAttribute('title');
          if (node === anchor && visible) open();
        }
      });
      observer = watched;
      for (let up: Element | null = el; up && up !== document.documentElement; up = up.parentElement) {
        const title = up.getAttribute('title');
        if (!title?.trim()) continue;
        borrowed.set(up, title);
        up.removeAttribute('title');
        watched.observe(up, { attributes: true, attributeFilter: ['title'] });
      }
      if (Date.now() < warm.until || (el as HTMLElement).dataset?.tipInstant !== undefined) open();
      else timer = setTimeout(open, OPEN_DELAY_MS);
    };

    const onMove = (e: PointerEvent) => { px = e.clientX; py = e.clientY; };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      onMove(e);
      const next = titledFrom(e.target as Element | null, anchor, titleOf);
      if (next === anchor) return;
      release();
      if (!next || (next as HTMLElement).dataset?.tip === 'native' || next.tagName === 'IFRAME') return;
      take(next);
    };
    const onOut = (e: PointerEvent) => {
      if (!anchor) return;
      const to = e.relatedTarget as Node | null;
      if (to && anchor.contains(to)) return;
      release();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('wheel', dismiss, { capture: true, passive: true });
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
    window.addEventListener('blur', release);
    window.addEventListener('resize', dismiss);
    return () => {
      release();
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('wheel', dismiss, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      window.removeEventListener('blur', release);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  return shown ? createPortal(<TipCard id={id} {...shown} />, document.body) : null;
}
