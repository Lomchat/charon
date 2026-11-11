'use client';
/**
 * Fold any chat bubble to one line (CLAUDE.md §11). The bubble's LEFT EDGE is
 * the button, clickable over its whole height, so a long message folds from
 * wherever the reader is in it; a click anywhere on a folded line unfolds it;
 * Alt+click on an edge folds (or unfolds) every bubble of that chat.
 *
 * In memory only, keyed by row id: a reload unfolds everything. A streaming
 * bubble has no key (its id changes when it lands), so it cannot fold.
 */
import { useCallback, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

// key → the bubble's body height in text lines when it was folded: the "N lines"
// its folded line shows (measured, so a long single-paragraph message counts).
const folded = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

/** Whether row `key`'s bubble is folded; null = this bubble cannot fold. */
export function useBubbleFold(key: string | null | undefined): boolean {
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    let set = listeners.get(key);
    if (!set) listeners.set(key, set = new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(key);
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => !!key && folded.has(key), () => false);
}

/** The props a foldable bubble's root carries (with `is-folded` in its class). */
export function foldRootProps(key: string | null | undefined) {
  return key ? { 'data-fold-key': key, onClickCapture: onFoldClickCapture } : {};
}

/** The bubble's body height in lines of its own font (header and footer left out). */
function bodyLines(bubble: HTMLElement): number {
  let height = 0;
  for (const child of Array.from(bubble.children) as HTMLElement[]) {
    if (child.matches('.bubble-h, header, .bubble-edge, .bubble-f')) continue;
    height += child.offsetHeight;
  }
  const fontSize = parseFloat(getComputedStyle(bubble).fontSize) || 14;
  return Math.max(1, Math.round(height / (fontSize * 1.5)));
}

function toggle(bubble: HTMLElement, all: boolean) {
  const key = bubble.dataset.foldKey;
  if (!key) return;
  const fold = !folded.has(key);
  const chat = bubble.closest<HTMLElement>('.app-chat');
  const targets = all && chat ? Array.from(chat.querySelectorAll<HTMLElement>('[data-fold-key]')) : [bubble];
  const sizes = targets.map((el) => (fold && !folded.has(el.dataset.foldKey!) ? bodyLines(el) : 0));
  const top = bubble.getBoundingClientRect().top;
  flushSync(() => {
    targets.forEach((el, i) => {
      const k = el.dataset.foldKey!;
      if (fold === folded.has(k)) return;
      if (fold) folded.set(k, sizes[i]); else folded.delete(k);
      notify(k);
    });
  });
  if (!chat) return;
  // The clicked bubble's first line stays where the eye is: in place, or at the
  // top of the chat when its start was scrolled away. Without this the
  // column-reverse chat (§14.92) leaves the folded line where the bubble ENDED,
  // often below the screen, and a long unfold grows upward out of sight.
  const want = Math.max(top, chat.getBoundingClientRect().top + 8);
  chat.scrollTop += bubble.getBoundingClientRect().top - want;
}

function onFoldClickCapture(e: MouseEvent<HTMLElement>) {
  const bubble = e.currentTarget;
  const target = e.target as Element;
  const onEdge = target.closest('.bubble-edge')?.parentElement === bubble;
  if (!onEdge) {
    if (!bubble.classList.contains('is-folded')) return;
    // A folded line's own controls (copy, peer links) still work.
    if (target.closest('a, button, input, textarea, select, summary')) return;
  }
  // Capture phase: the header's own toggles (tool input, thinking) never see it.
  e.preventDefault();
  e.stopPropagation();
  toggle(bubble, onEdge && e.altKey);
}

/** Unfold the bubble holding `el` before a jump scrolls to it. */
export function unfoldBubbleAt(el: Element) {
  const key = el.closest<HTMLElement>('[data-fold-key]')?.dataset.foldKey;
  if (key && folded.delete(key)) notify(key);
}

/** The edge: first child of a foldable bubble. */
export function FoldEdge({ isFolded }: { isFolded: boolean }) {
  return (
    <span className="bubble-edge" role="button" aria-expanded={!isFolded}
      aria-label={isFolded ? 'Expand' : 'Fold to one line'}
      title={isFolded ? 'Expand · Alt+click: expand all' : 'Fold to one line · Alt+click: fold all'} />
  );
}

/** What a folded bubble's header adds: the start of its text, then its size. */
export function FoldLine({ foldKey, text, size }: { foldKey: string; text?: ReactNode; size?: string }) {
  const lines = folded.get(foldKey) ?? 1;
  return <>
    {text ? <span className="bubble-fold-text">{text}</span> : null}
    <span className="bubble-fold-size">{size ?? `${lines} line${lines === 1 ? '' : 's'}`}</span>
  </>;
}

/** The first line worth reading in a message: headings, code fences, rules
 *  and quoted lines skipped, Markdown markers dropped. */
export function foldText(content: string): string {
  const lines = content.split('\n');
  const pick = (skipQuotes: boolean) => {
    let fence = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence || !line || /^#{1,6}\s/.test(line) || /^([-*_])(\s*\1){2,}$/.test(line)) continue;
      if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue;
      if (skipQuotes && line.startsWith('>')) continue;
      return line;
    }
    return '';
  };
  const line = pick(true) || pick(false) || content.trim().split('\n')[0] || '';
  return line
    .replace(/^>\s?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .slice(0, 300);
}
