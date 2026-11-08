'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyDocHref } from './documentViews';
import { relayEscape } from './escapeRelay';

/**
 * Sandbox of every converted document and notebook HTML output. NEVER
 * `allow-scripts`: that absence is what makes `allow-same-origin` safe (the
 * hub measures the content) and lets untrusted markup render at all. Popups
 * escape the sandbox so a link opens a normal tab — only http(s)/mail links
 * survive `sanitizeFrameHtml`, and `target=_blank` implies noopener.
 */
export const DOC_FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

const XLINK = 'http://www.w3.org/1999/xlink';

/**
 * Untrusted HTML → head/body markup for `frameDocument`, plus its text.
 * Parsed in an inert document (nothing loads, nothing runs). Scripts are
 * dead in the sandbox anyway; they go so a stray `<base>`, `<meta refresh>`
 * or `javascript:` link cannot ride a popup out of it.
 */
export function sanitizeFrameHtml(html: string): { head: string; body: string; text: string } {
  // No parser, no markup: a server render shows an empty frame, never raw HTML.
  if (typeof DOMParser === 'undefined') return { head: '', body: '', text: '' };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, base, meta, object, embed, applet').forEach((el) => el.remove());
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || attr.name.toLowerCase() === 'formaction') el.removeAttribute(attr.name);
    }
  }
  for (const a of Array.from(doc.querySelectorAll('a, area'))) {
    const href = a.getAttribute('href') ?? a.getAttributeNS(XLINK, 'href');
    if (href == null) continue;
    const kind = classifyDocHref(href);
    if (kind === 'blocked') {
      a.removeAttribute('href');
      a.removeAttributeNS(XLINK, 'href');
    } else if (kind === 'fragment') {
      a.setAttribute('target', '_self');
    } else {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  doc.querySelectorAll('form').forEach((f) => f.removeAttribute('action'));
  return { head: doc.head.innerHTML, body: doc.body.innerHTML, text: doc.body.textContent ?? '' };
}

/**
 * The `--media-bg` plate, resolved: a srcdoc cannot read the hub's tokens.
 * Falls back to plain white (the token's value in every shipped theme) before
 * the stylesheet is there, e.g. during SSR.
 */
export function resolvedPaper(): string {
  if (typeof document === 'undefined') return 'white';
  return getComputedStyle(document.documentElement).getPropertyValue('--media-bg').trim() || 'white';
}

/** `resolvedPaper()`, kept current across theme switches (`<html data-theme>`, §14.99). */
export function usePaper(): string {
  const [paper, setPaper] = useState(resolvedPaper);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setPaper(resolvedPaper());
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return paper;
}

/**
 * A sandboxed srcdoc frame exactly as tall as its content, so the PARENT
 * scrolls (themed scrollbar, and a reload keeps the reader's place: the old
 * height stands until the new document measures). Re-measured on load, on
 * width changes, and a few times after load for late layout (fonts, image
 * decoding). The frame's own ResizeObserver is used when the browser lets
 * the hub drive it — scripts are off inside, so this is best effort.
 */
export default function DocFrame({ srcDoc, title, className }: {
  srcDoc: string; title: string; className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const inner = useRef<ResizeObserver | null>(null);
  const timers = useRef<number[]>([]);

  const measure = useCallback(() => {
    const frame = ref.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!frame || !doc?.documentElement || !doc.body) return;
    const content = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    // A horizontal scrollbar (a table wider than the pane) eats into the
    // frame's height: add it back or the last line hides under it.
    const bar = win ? Math.max(0, win.innerHeight - doc.documentElement.clientHeight) : 0;
    const next = Math.max(1, content + bar);
    if (Math.abs(frame.offsetHeight - next) > 1) frame.style.height = `${next}px`;
  }, []);

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  useEffect(() => {
    const frame = ref.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    let width = frame.clientWidth;
    const ro = new ResizeObserver(() => {
      if (frame.clientWidth === width) return;
      width = frame.clientWidth;
      measure();
    });
    ro.observe(frame);
    return () => {
      ro.disconnect();
      inner.current?.disconnect();
      inner.current = null;
      clearTimers();
    };
  }, [measure]);

  const onLoad = useCallback(() => {
    measure();
    clearTimers();
    for (const ms of [60, 300, 1200]) timers.current.push(window.setTimeout(measure, ms));
    inner.current?.disconnect();
    inner.current = null;
    try {
      const win = ref.current?.contentWindow as (Window & typeof globalThis) | null;
      const body = ref.current?.contentDocument?.body;
      if (win?.ResizeObserver && body) {
        inner.current = new win.ResizeObserver(() => measure());
        inner.current.observe(body);
      }
    } catch { /* timers and the width observer still cover it */ }
    // Keys pressed inside the frame never reach the hub: Esc is handed to the
    // <iframe> so the full-screen pane closes from a click into the document
    // too. The listener leaves with its document on the next load.
    try {
      const frame = ref.current;
      frame?.contentDocument?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) relayEscape(frame);
      });
    } catch { /* an inaccessible frame keeps its keys */ }
  }, [measure]);

  return (
    <iframe
      ref={ref}
      className={className}
      title={title}
      sandbox={DOC_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={onLoad}
    />
  );
}
