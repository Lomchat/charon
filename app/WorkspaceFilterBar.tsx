'use client';
/**
 * Filter chip + URL builder for the sidebar path filter.
 *
 * Two jobs:
 *
 *  - WARN while a filter is on. A forgotten filter costs half an hour, so the
 *    chip permanently shows what is hidden — and above all how many hidden
 *    sessions are WAITING on the user. Without that counter a blocked session
 *    becomes invisible and you wait in front of a pane that never moves.
 *
 *  - BUILD the URL. Every known folder has a three-state button
 *    (ignored / included / excluded), the URL updates live, and it can be
 *    opened or copied to become a bookmark — one bookmark per project.
 *
 * Navigation uses `window.location.assign`, a real page load, not
 * `router.push`. That is deliberate: ClaudePanel reads the filter once on
 * mount, and Charon rewrites its own URL (`?session=`, `?shell=`) behind a
 * DeepLinkGuard. A hard load keeps the two mechanisms from racing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type PathFilter, buildFilterQuery, describeFilter, isFilterActive,
  nextPathState, pathState, withPathState,
} from './pathFilter';

type Props = {
  /** Every known folder: session and shell cwds, registered paths, defaults. */
  knownPaths: string[];
  /** The filter currently applied, parsed from the URL. */
  filter: PathFilter;
  /** How many entities the filter is hiding right now. */
  hiddenCount: number;
  /** How many of those are waiting on the user. */
  hiddenWaitingCount: number;
};

const STATE_LABEL = { off: 'ignored', include: 'included', exclude: 'excluded' } as const;
const STATE_MARK = { off: '·', include: '✓', exclude: '−' } as const;

export default function WorkspaceFilterBar({
  knownPaths, filter, hiddenCount, hiddenWaitingCount,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PathFilter>(filter);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | null>(null);

  // Keep the deep link. `?session=` / `?shell=` say WHAT is open, `?path=`
  // says what the sidebar lists — they are orthogonal, and applying a filter
  // must not close the session you are reading.
  const urlFor = useCallback((next: PathFilter | null) => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    params.delete('path');
    const query = next ? new URLSearchParams(buildFilterQuery(next).slice(1)) : null;
    if (query) for (const value of query.getAll('path')) params.append('path', value);
    const rest = params.toString();
    return window.location.origin + window.location.pathname + (rest ? '?' + rest : '');
  }, []);

  // Only DISPLAYED once the panel is open, i.e. after a user action, so the
  // server render (where `window` is undefined) can never mismatch.
  const url = useMemo(() => urlFor(draft), [urlFor, draft]);

  // Escape, or a click anywhere else, closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
  }, []);

  const active = isFilterActive(filter);
  const summary = describeFilter(filter);

  const copy = async () => {
    const done = () => {
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    };
    try {
      await navigator.clipboard.writeText(url);
      done();
    } catch {
      // Fallback: the clipboard API can be refused without surfacing an error.
      // An off-screen textarea + execCommand still works where it fails.
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch { /* the URL stays selectable by hand */ }
    }
  };

  return (
    <div className="wfb" ref={rootRef}>
      <button
        type="button"
        className={`wfb-toggle${active ? ' on' : ''}`}
        aria-expanded={open}
        onClick={() => { setDraft(filter); setOpen((o) => !o); }}
        title="filter the sidebar by folder"
      >
        ▤ {active ? 'filtered' : 'filter'}
      </button>

      {active && (
        <>
          <span className="wfb-summary" title={summary}>{summary}</span>
          {hiddenCount > 0 && (
            <span
              className={`wfb-hidden${hiddenWaitingCount > 0 ? ' warn' : ''}`}
              role="status"
              title={hiddenWaitingCount > 0
                ? `${hiddenCount} hidden, ${hiddenWaitingCount} waiting on you`
                : `${hiddenCount} hidden by the filter`}
            >
              {hiddenCount}{hiddenWaitingCount > 0 && ` · ${hiddenWaitingCount}⏳`}
            </span>
          )}
          <button
            type="button"
            className="wfb-clear"
            onClick={() => window.location.assign(urlFor(null))}
            title="show everything"
            aria-label="clear the filter and show everything"
          >✕</button>
        </>
      )}

      {open && (
        <div className="wfb-panel" role="dialog" aria-label="sidebar path filter">
          <div className="wfb-panel-head">
            Click a folder to cycle it:
            <span className="wfb-legend off">· ignored</span>
            <span className="wfb-legend include">✓ included</span>
            <span className="wfb-legend exclude">− excluded</span>
          </div>

          <div className="wfb-paths">
            {knownPaths.length === 0 && <div className="wfb-empty">no folder known yet</div>}
            {knownPaths.map((p) => {
              const state = pathState(p, draft);
              // Split parent from leaf: in a 280px sidebar a plain ellipsis
              // eats the END of the path, which is the only part that tells
              // /srv/projects/api from /srv/projects/web apart. The leaf never
              // shrinks; the parent is what gives way.
              const cut = p.lastIndexOf('/');
              const parent = cut > 0 ? p.slice(0, cut + 1) : '';
              const leaf = cut > 0 ? p.slice(cut + 1) : p;
              return (
                <button
                  key={p}
                  type="button"
                  className={`wfb-path ${state}`}
                  aria-label={`${p} — ${STATE_LABEL[state]}`}
                  onClick={() => setDraft(withPathState(draft, p, nextPathState(state)))}
                  title={p}
                >
                  <span className="wfb-path-mark" aria-hidden>{STATE_MARK[state]}</span>
                  {parent && <span className="wfb-path-dir" aria-hidden>{parent}</span>}
                  <span className="wfb-path-leaf" aria-hidden>{leaf}</span>
                </button>
              );
            })}
          </div>

          <div className="wfb-url" title={url}>{url}</div>

          <div className="wfb-actions">
            <button
              type="button"
              className="wfb-btn primary"
              onClick={() => window.location.assign(url)}
            >open</button>
            <button type="button" className="wfb-btn wide" onClick={copy}>
              {copied ? 'copied ✓' : 'copy URL'}
            </button>
            <button
              type="button"
              className="wfb-btn"
              onClick={() => setDraft({ include: [], exclude: [] })}
              title="untick everything above — does not navigate"
            >reset</button>
            <button type="button" className="wfb-btn" onClick={() => setOpen(false)}>close</button>
          </div>

          <div className="wfb-tip">Bookmark this URL — one bookmark per project.</div>
        </div>
      )}
    </div>
  );
}
