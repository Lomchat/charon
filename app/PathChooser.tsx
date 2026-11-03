'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';

/**
 * Choosing a folder on a VPS: its known paths as rows, then a path input whose
 * suggestions are the known paths ∪ the REAL subdirectories of the typed dir
 * (GET /api/vps/[id]/fs, debounced, cached per dir while mounted). One
 * component for every place that asks for a folder — the new-session wizard's
 * path step and the explorer's "open a folder" — so they complete, drill down
 * and answer the keyboard the same way. The caller owns the value and decides
 * what a chosen or submitted path means (existence checks, errors).
 */

export type KnownPath = { label: string; path: string };

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || '(root)';
}

/** The VPS's known folders (its saved paths, plus its default), by label. */
export function knownPathsFor(vps: Vps | null, vpsPaths: VpsPath[]): KnownPath[] {
  if (!vps) return [];
  const rows = vpsPaths
    .filter((p) => p.vpsId === vps.id)
    .map((p) => ({ label: p.label || basename(p.path), path: p.path }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const dp = (vps as any).defaultPath as string | null | undefined;
  if (dp && !rows.some((r) => r.path === dp)) rows.unshift({ label: 'default', path: dp });
  return rows;
}

type Suggestion = { path: string; kind: 'known' | 'dir' };

type Props = {
  vpsId: string;
  label: ReactNode;
  known: KnownPath[];
  /** Rows above the known paths (the wizard's "home" for a shell). */
  leading?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** A known row was picked: that path, as is. */
  onChoose: (path: string) => void;
  /** Enter with nothing highlighted, or the button: the typed path. */
  onSubmit: () => void;
  busy?: boolean;
  submitLabel?: string;
  placeholder?: string;
  /** The line under the input, reserved even when empty (a verdict arriving
   *  after the modal was measured must not need more room). */
  status?: ReactNode;
  statusError?: boolean;
  /** The verdict repeated on top of the suggestions, which cover that line. */
  note?: { err: boolean; text: string } | null;
  /** A new error shuts the suggestions so it can be read (an arrow key
   *  reopens them). */
  error?: string | null;
};

export default function PathChooser({
  vpsId, label, known, leading, value, onChange, onChoose, onSubmit,
  busy = false, submitLabel = 'Use ›', placeholder = '/custom/path…  (type / to browse the server)',
  status, statusError = false, note = null, error = null,
}: Props) {
  const [sug, setSug] = useState<Suggestion[]>([]);
  const [sugOpen, setSugOpen] = useState(false);
  const [sugIdx, setSugIdx] = useState(-1);
  const [sugLoading, setSugLoading] = useState(false); // ssh listing in flight (or debounce-pending)
  const [sugNote, setSugNote] = useState<string | null>(null); // "no match" / failure hint
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);  // input + button: the suggestions' anchor
  const sugListRef = useRef<HTMLDivElement | null>(null);
  const dirCacheRef = useRef(new Map<string, string[]>());  // `${vpsId}:${dir}` → subdirs
  const prefetchingRef = useRef(new Set<string>());
  const fetchSeqRef = useRef(0);

  // Live suggestions. No '/' typed yet → known paths only (fuzzy). Otherwise
  // split on the LAST '/': list the dir on the VPS (debounced; the per-dir
  // cache makes further keystrokes in the same dir instant) and prefix-filter
  // its subdirs, with matching known paths on top.
  useEffect(() => {
    const typed = value;
    const seq = ++fetchSeqRef.current;
    const q = typed.trim().toLowerCase();
    const knownMatches: Suggestion[] = known
      .filter((p) => p.path !== typed && (q === '' || p.path.toLowerCase().includes(q)))
      .map((p) => ({ path: p.path, kind: 'known' as const }));
    const lastSlash = typed.lastIndexOf('/');
    if (lastSlash === -1) { setSug(knownMatches.slice(0, 12)); setSugIdx(-1); setSugLoading(false); setSugNote(null); return; }
    const dir = typed.slice(0, lastSlash + 1) || '/';
    const base = typed.slice(lastSlash + 1);
    const compose = (subdirs: string[], failed = false) => {
      const dirMatches: Suggestion[] = subdirs
        .filter((n) => n.startsWith(base))
        .slice(0, 30)
        .map((n) => ({ path: dir + n + '/', kind: 'dir' as const }));
      const seen = new Set(dirMatches.map((s) => s.path));
      const merged = [
        ...knownMatches.filter((k) => !seen.has(k.path) && !seen.has(k.path + '/')).slice(0, 6),
        ...dirMatches,
      ];
      setSug(merged);
      setSugIdx(-1);
      setSugLoading(false);
      setSugNote(merged.length === 0 ? (failed ? 'listing failed' : 'no matching directory') : null);
    };
    const cacheKey = `${vpsId}:${dir}`;
    const cached = dirCacheRef.current.get(cacheKey);
    if (cached) { compose(cached); return; }
    // Uncached dir → the spinner shows through the debounce AND the ssh
    // round-trip (the user must SEE that deeper levels are on their way).
    setSugLoading(true); setSugNote(null);
    const t = setTimeout(() => {
      api.listVpsDirs(vpsId, dir)
        .then((r) => {
          if (seq !== fetchSeqRef.current) return;   // stale response
          const subdirs = r.ok && r.exists ? (r.dirs ?? []) : [];
          if (r.ok) dirCacheRef.current.set(cacheKey, subdirs); // never cache a FAILURE
          compose(subdirs, !r.ok);
        })
        .catch(() => { if (seq === fetchSeqRef.current) compose([], true); });
    }, 150);
    return () => clearTimeout(t);
  }, [value, vpsId, known]);

  // Warm-up: pre-list '/' in the background. This opens the per-VPS
  // persistent SSH master server-side (the expensive part) so the first real
  // keystroke listing returns fast, and pre-caches the root dir.
  useEffect(() => {
    const key = `${vpsId}:/`;
    if (dirCacheRef.current.has(key)) return;
    api.listVpsDirs(vpsId, '/')
      .then((r) => { if (r.ok) dirCacheRef.current.set(key, r.dirs ?? []); })
      .catch(() => {});
  }, [vpsId]);

  // Keyboard-usable the moment it opens: with nothing focused Enter did
  // nothing at all. The dropdown stays SHUT: the known paths are already
  // listed right above, and an overlay covering its own list on open reads as
  // a glitch. Coarse pointers are skipped (a phone keyboard would hide the
  // list).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      setSugOpen(false);   // batched with the focus handler's auto-open
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Pre-list a suggested dir while the user hovers/highlights it — by the
  // time they click, the drill-down composes straight from cache.
  function prefetchDir(p: string) {
    const key = `${vpsId}:${p}`;
    if (dirCacheRef.current.has(key) || prefetchingRef.current.has(key)) return;
    prefetchingRef.current.add(key);
    api.listVpsDirs(vpsId, p)
      .then((r) => { if (r.ok) dirCacheRef.current.set(key, r.dirs ?? []); })
      .catch(() => {})
      .finally(() => prefetchingRef.current.delete(key));
  }

  // Keep the highlighted suggestion visible while arrowing through the list
  // (+ prefetch it so Enter drills down instantly).
  useEffect(() => {
    if (sugIdx < 0) return;
    sugListRef.current?.children[sugIdx]?.scrollIntoView({ block: 'nearest' });
    const s = sug[sugIdx];
    if (s?.kind === 'dir') prefetchDir(s.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugIdx]);

  // Focus the input with the caret AFTER the text: the whole point of filling
  // it from a row is to keep typing DEEPER into that path. `.focus()` alone
  // lands at offset 0 on an input that wasn't focused (and mid-string on one
  // that was). The rAF is load-bearing: React must commit the controlled
  // `value` first, or the re-render wipes the selection we just set.
  function focusAtEnd(p: string) {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(p.length, p.length); } catch { /* detached */ }
    });
  }

  function fill(p: string) {
    onChange(p);
    setSugOpen(true);
    focusAtEnd(p);
  }

  useEffect(() => { if (error) setSugOpen(false); }, [error]);
  const sugShown = sugOpen && (sug.length > 0 || sugLoading || !!sugNote);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && sugShown) {
      // Close only the dropdown — NOT the modal (its window-level Escape
      // listener sits behind this stopPropagation).
      e.stopPropagation(); setSugOpen(false); return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sug.length > 0) {
      e.preventDefault();
      setSugOpen(true);
      setSugIdx((i) => {
        const n = sug.length;
        return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === 'Tab' && sugOpen && sug.length > 0) {
      e.preventDefault();
      fill(sug[Math.max(0, sugIdx)].path);
      return;
    }
    if (e.key === 'Enter') {
      if (sugOpen && sugIdx >= 0 && sug[sugIdx]) { fill(sug[sugIdx].path); return; }
      onSubmit();
    }
  }

  return (
    <>
      <div className="wiz-label">{label}</div>
      <div className="wiz-pick-list">
        {leading}
        {known.map((p) => (
          // A <div>, not a <button>: the row hosts the nested ⧉
          // copy-to-input button (nested <button> is invalid HTML).
          <div key={p.path} className="wiz-pick" role="button" tabIndex={0}
            onClick={() => onChoose(p.path)}
            onKeyDown={(e) => { if (e.key === 'Enter') onChoose(p.path); }}
          >
            <span className="wiz-pick-glyph">▤</span>
            <span className="wiz-pick-main">
              <span className="wiz-pick-name">{p.label}</span>
              <span className="wiz-pick-sub mono">{p.path}</span>
            </span>
            <button type="button" className="wiz-pick-copy"
              title="copy this path into the input (edit before use)"
              onClick={(e) => { e.stopPropagation(); fill(p.path.endsWith('/') ? p.path : p.path + '/'); }}
            >⧉</button>
            <span className="wiz-pick-go">›</span>
          </div>
        ))}
      </div>
      <div className="wiz-custom" ref={rowRef}>
        <input
          ref={inputRef}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          onChange={(e) => { onChange(e.target.value); setSugOpen(true); }}
          onFocus={() => setSugOpen(true)}
          onBlur={() => setTimeout(() => setSugOpen(false), 120)}
          onKeyDown={onKeyDown}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
        <button className="wiz-btn primary" onClick={onSubmit} disabled={busy}>
          {busy ? '…' : submitLabel}
        </button>
      </div>
      <div className={`wiz-status${statusError ? ' is-error' : ''}`} role="status">{status}</div>
      {sugShown && (
        <FloatingSuggestions anchor={rowRef}>
          {note && <div className={`wiz-sug-status${note.err ? ' is-error' : ''}`}>{note.text}</div>}
          <div className="wiz-sug-items" ref={sugListRef}>
            {sug.map((s, i) => (
              <button key={s.kind + s.path} type="button"
                className={`wiz-sug-item${i === sugIdx ? ' active' : ''}`}
                onMouseEnter={() => { if (s.kind === 'dir') prefetchDir(s.path); }}
                onClick={() => fill(s.path)}
              >
                <span className="wiz-sug-tag">{s.kind === 'known' ? '★' : '▸'}</span>
                <span className="wiz-sug-path">{s.path}</span>
              </button>
            ))}
          </div>
          {sugLoading && (
            <div className="wiz-sug-note"><span className="wiz-sug-spin">⟳</span> listing directory…</div>
          )}
          {!sugLoading && sugNote && sug.length === 0 && (
            <div className="wiz-sug-note">{sugNote}</div>
          )}
        </FloatingSuggestions>
      )}
    </>
  );
}

/** The suggestions, floated OVER the modal instead of laid out in it: in flow
 *  they grew the modal on every keystroke, and it keeps ONE size per page.
 *  Portaled (the scrolling body would clip them), as wide as the input row so
 *  they cover the status line under it, below the row, above it only when the
 *  viewport has no room below — PickerControl's rule. A mousedown anywhere in
 *  it keeps the input focused, so its blur-close never swallows a click. */
function FloatingSuggestions({ anchor, children }: {
  anchor: RefObject<HTMLElement | null>; children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const edgeX = viewport?.offsetLeft ?? 0, edgeY = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const below = height + edgeY - rect.bottom - 12, above = rect.top - edgeY - 12;
      const upwards = below < 160 && above > below;
      const maxHeight = Math.max(80, Math.min(320, upwards ? above : below));
      const popupWidth = Math.min(rect.width, width - 24);
      setPosition({ width: popupWidth, maxHeight,
        left: Math.max(edgeX + 12, Math.min(rect.left, edgeX + width - popupWidth - 12)),
        top: upwards ? Math.max(edgeY + 12, rect.top - 4 - Math.min(popup.current?.scrollHeight ?? maxHeight, maxHeight)) : rect.bottom + 4 });
    };
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    if (anchor.current) observer.observe(anchor.current);
    const onScroll = (e: Event) => { if (!popup.current?.contains(e.target as Node)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [anchor]);
  return createPortal(
    <div ref={popup} className="wiz-sug" style={position} onMouseDown={(e) => e.preventDefault()}>
      {children}
    </div>,
    anchor.current?.closest('.claude-root') ?? document.body,
  );
}
