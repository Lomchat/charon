'use client';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * The composer's size, set by dragging the grip on its top edge
 * (`ComposerGrip.tsx`).
 *
 * Three states, not a continuum: HIDDEN (only the grip strip remains), the
 * DEFAULT size (whatever the stylesheet gives — density, phone layout and the
 * provider's mode column all decide it), or TALLER than that. There is nothing
 * between hidden and default: the default is a detent that holds the bar while
 * the pointer moves a little, and only a deliberate pull past half-way hides it.
 *
 * One value for every session — this is how the user likes to write, not a
 * property of a conversation. Browser-local ON PURPOSE (like `showPaused.ts`):
 * a height dragged on a desktop means nothing on a phone.
 */

export const COMPOSER_SIZE_KEY = 'hub.claude.composerSize.v1';

/** `height` = the textarea's min-height in px; `null` = the stylesheet's. */
export type ComposerSize = { readonly hidden: boolean; readonly height: number | null };

export const DEFAULT_COMPOSER_SIZE: ComposerSize = Object.freeze({ hidden: false, height: null });

/** The detent: this far above the default, the bar still sits AT the default. */
export const COMPOSER_DETENT_PX = 24;
/** One arrow-key press on the grip. Above the detent, or ↑ could never leave it. */
export const COMPOSER_KEY_STEP_PX = 32;
/** The tallest the textarea may grow, as a share of the viewport. ChatInputBar
 *  clamps the saved height with the same share (`min(…px, 60dvh)`), so a height
 *  saved on a tall window shrinks with a short one instead of eating the chat. */
export const COMPOSER_MAX_VIEWPORT_SHARE = 0.6;

/** What the grip measures before it moves anything (`measureComposer`). */
export type ComposerMetrics = {
  /** The footer's height at the default size. */
  baseFooter: number;
  /** The textarea's height at the default size. */
  baseText: number;
  /** The footer's height when hidden — the grip strip alone. */
  hiddenFooter: number;
  /** The tallest the textarea may get on this viewport. */
  maxText: number;
};

export function sameComposerSize(a: ComposerSize, b: ComposerSize): boolean {
  return a.hidden === b.hidden && a.height === b.height;
}

/**
 * Where a drag lands. `footer` is the height the bar WOULD have if it followed
 * the pointer exactly; the answer is the state it actually takes.
 */
export function snapComposer(footer: number, m: ComposerMetrics): ComposerSize {
  if (footer < (m.baseFooter + m.hiddenFooter) / 2) return { hidden: true, height: null };
  const extra = footer - m.baseFooter;
  if (extra < COMPOSER_DETENT_PX) return DEFAULT_COMPOSER_SIZE;
  return { hidden: false, height: Math.round(Math.min(m.maxText, m.baseText + extra)) };
}

/** One arrow key on the grip: ↑ grows (and un-hides), ↓ shrinks, then hides. */
export function stepComposer(s: ComposerSize, dir: 1 | -1, m: ComposerMetrics): ComposerSize {
  if (s.hidden) return dir > 0 ? DEFAULT_COMPOSER_SIZE : s;
  const h = Math.max(s.height ?? m.baseText, m.baseText);
  if (dir > 0) {
    return { hidden: false, height: Math.round(Math.min(m.maxText, h + COMPOSER_KEY_STEP_PX)) };
  }
  if (s.height == null) return { hidden: true, height: null };
  const next = h - COMPOSER_KEY_STEP_PX;
  return next < m.baseText + COMPOSER_DETENT_PX
    ? DEFAULT_COMPOSER_SIZE
    : { hidden: false, height: Math.round(next) };
}

/** A click on the grip: hidden or taller → the default; the default → hidden. */
export function clickComposer(s: ComposerSize): ComposerSize {
  return !s.hidden && s.height == null ? { hidden: true, height: null } : DEFAULT_COMPOSER_SIZE;
}

/** Never trust storage: anything odd reads as the default. */
export function parseComposerSize(raw: string | null): ComposerSize {
  if (!raw) return DEFAULT_COMPOSER_SIZE;
  try {
    const v = JSON.parse(raw) as { hidden?: unknown; height?: unknown };
    const height = typeof v.height === 'number' && Number.isFinite(v.height)
      && v.height > 0 && v.height < 10_000 ? Math.round(v.height) : null;
    return { hidden: v.hidden === true, height };
  } catch {
    return DEFAULT_COMPOSER_SIZE;
  }
}

const g = globalThis as unknown as {
  __charonComposerSize?: ComposerSize;
  __charonComposerSizeSubs?: Set<() => void>;
  __charonComposerSizeSync?: boolean;
};
g.__charonComposerSizeSubs ??= new Set<() => void>();

function notify(): void {
  for (const fn of g.__charonComposerSizeSubs!) fn();
}

/** Read lazily on the client: the server snapshot is the default, and React
 *  re-renders after hydration when the stored size differs. */
function getSnapshot(): ComposerSize {
  if (!g.__charonComposerSize) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(COMPOSER_SIZE_KEY); } catch {}
    g.__charonComposerSize = parseComposerSize(raw);
  }
  return g.__charonComposerSize;
}

function subscribe(fn: () => void): () => void {
  g.__charonComposerSizeSubs!.add(fn);
  // Another tab of this browser resized it: follow, so every open session of
  // the client agrees.
  if (!g.__charonComposerSizeSync && typeof window !== 'undefined') {
    g.__charonComposerSizeSync = true;
    window.addEventListener('storage', (e) => {
      if (e.key !== COMPOSER_SIZE_KEY) return;
      g.__charonComposerSize = parseComposerSize(e.newValue);
      notify();
    });
  }
  return () => { g.__charonComposerSizeSubs!.delete(fn); };
}

export function writeComposerSize(next: ComposerSize): void {
  if (sameComposerSize(getSnapshot(), next)) return;
  g.__charonComposerSize = next;
  try { localStorage.setItem(COMPOSER_SIZE_KEY, JSON.stringify(next)); } catch {}
  notify();
}

/** Something is being put into the message (a drop, a path, a prefill): the
 *  user has to see it, so a hidden composer comes back. */
export function revealComposer(): void {
  const cur = getSnapshot();
  if (cur.hidden) writeComposerSize({ ...cur, hidden: false });
}

export function useComposerSize(): [ComposerSize, (next: ComposerSize) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_COMPOSER_SIZE);
  return [value, useCallback((next: ComposerSize) => writeComposerSize(next), [])];
}
