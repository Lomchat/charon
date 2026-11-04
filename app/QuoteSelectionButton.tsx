'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { quotableSelection } from './chatQuote';

// The floating "Quote" button over a text selection in the chat (chatQuote.ts).
// Portaled to <body>: a transformed drawer would trap `position: fixed`
// (§14.80). Above the selection with a mouse; BELOW it on touch, where the
// OS selection menu already sits above.

type Anchor = { text: string; x: number; y: number; below: boolean };

const GAP = 8;

export default function QuoteSelectionButton({ chatRef, onQuote }: {
  chatRef: React.RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  anchorRef.current = anchor;
  const frame = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const root = chatRef.current;
      const hit = quotableSelection(root, typeof window === 'undefined' ? null : window.getSelection());
      if (!hit || !root) { setAnchor(null); return; }
      // Hidden once the selection scrolls out of the chat viewport.
      const view = root.getBoundingClientRect();
      if (hit.rect.bottom < view.top || hit.rect.top > view.bottom) { setAnchor(null); return; }
      const below = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      const x = Math.min(Math.max(hit.rect.left + hit.rect.width / 2, view.left + 40), view.right - 40);
      const y = below
        // Below on touch, clear of the end-selection handle.
        ? Math.min(hit.rect.bottom, view.bottom - 48) + GAP + 18
        : Math.max(hit.rect.top, view.top + 36) - GAP;
      setAnchor({ text: hit.text, x, y, below });
    });
  }, [chatRef]);

  useEffect(() => {
    const root = chatRef.current;
    document.addEventListener('selectionchange', measure);
    root?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame.current);
      document.removeEventListener('selectionchange', measure);
      root?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [chatRef, measure]);

  const quote = useCallback(() => {
    const cur = anchorRef.current;
    if (!cur) return;
    anchorRef.current = null; // a pointerdown AND the click that follows quote once
    onQuote(cur.text);
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  }, [onQuote]);

  // `q` quotes the selection too — only while the button is up, so the key
  // never fires from a text field (a selection there is not quotable) and
  // never with a modifier (Ctrl/Cmd+Q, Alt+Q stay the browser's/OS's).
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      // By physical key, so Caps Lock, Shift and non-Latin layouts work.
      if ((e.code !== 'KeyQ' && e.key.toLowerCase() !== 'q') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      e.preventDefault();
      quote();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anchor, quote]);

  if (!anchor || typeof document === 'undefined') return null;
  return createPortal(
    <button
      type="button"
      className={`chat-quote-btn${anchor.below ? ' is-below' : ''}`}
      style={{ left: anchor.x, top: anchor.y }}
      // Mouse: act on pointerdown (preventDefault keeps the selection; by the
      // click it could be gone). Touch: a TAP — quote on pointerup if the
      // finger barely moved, so a pan starting on the button never quotes.
      // onClick serves the keyboard; quote() runs once per gesture.
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (e.pointerType === 'mouse') quote();
        else touchStart.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        const s = touchStart.current;
        touchStart.current = null;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) quote();
      }}
      onPointerCancel={() => { touchStart.current = null; }}
      onClick={quote}
      title="Quote in the reply (Q)"
    >
      <span aria-hidden>❝</span> Quote
    </button>,
    document.body,
  );
}
