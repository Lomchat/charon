'use client';
// The session header's magnifier (Alt+F): this session's rows matching the
// text, newest first (GET /api/sessions/[id]/search, a worker-thread FTS on
// the hub). Enter jumps to the selected hit and moves to the next one,
// Shift+Enter back; ↑/↓ move; Esc closes. The transcript mounts only the rows
// near the viewport (chatWindow.ts), so the browser's own Ctrl+F cannot reach
// the rest: this does, through SessionView's jump (a window around the row
// when it is not loaded).
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import type { TranscriptView } from '@/lib/transcriptRows';
import type { SessionSearchHit, SessionTranscriptSearchResponse } from '@/lib/types/api';
import { IconSearch } from './icons';

const DEBOUNCE_MS = 220;

const ROLE_LABEL: Record<string, string> = {
  user: 'you', assistant: 'agent', external: 'peer', tool_use: 'tool', tool_result: 'output',
  thinking: 'thinking', error: 'error', side: 'aside', async_question: 'question',
};

function when(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** The hub's snippet: \u0002…\u0003 around matches, JSON escapes of tool rows flattened. */
function Snippet({ text }: { text: string }) {
  const flat = text.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ');
  const parts = flat.split(/\u0002|\u0003/);
  return <span className="ssearch-snip">{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</span>;
}

export default memo(function SessionSearch({ sessionId, view, focusSignal, onJump, onClose }: {
  sessionId: string;
  view: TranscriptView;
  /** Bumped by Alt+F / the button: the box takes the focus again. */
  focusSignal: number;
  /** Show this hit in the transcript (`terms`: what to highlight in it). */
  onJump: (hit: SessionSearchHit, terms: string[]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SessionTranscriptSearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [focusSignal]);
  // Esc closes it from anywhere on the page, unless something else used the
  // key (a menu, the composer's popups) or a modal is open over it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.app-modal-bg, [aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const text = q.trim();
    if (!text) { setRes(null); setError(null); setBusy(false); return; }
    const ac = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      api.searchSessionTranscript(sessionId, text, view, ac.signal).then((r) => {
        setRes(r); setSel(0); setError(null); setBusy(false);
      }, (e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e)); setBusy(false);
      });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q, sessionId, view]);

  const terms = useMemo(() => q.match(/[\p{L}\p{N}_]+/gu) ?? [], [q]);
  const hits = res?.results ?? [];

  useEffect(() => {
    listRef.current?.querySelector('.ssearch-hit.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  function go(i: number) {
    const hit = hits[i];
    if (!hit) return;
    setSel(i);
    onJump(hit, terms);
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter shows the selected hit, then the next press goes on (older);
      // Shift+Enter walks back (newer).
      go(sel);
      setSel((s) => (e.shiftKey ? Math.max(0, s - 1) : Math.min(hits.length - 1, s + 1)));
    }
  }

  const count = res ? (res.total >= res.cap ? `${res.cap}+` : String(res.total)) : '';
  return (
    <div className="ssearch pop-kit" role="dialog" aria-label="Search this session">
      <div className="ssearch-bar">
        <IconSearch />
        <input
          ref={inputRef} type="text" value={q} spellCheck={false}
          onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          placeholder="search this session" aria-label="Search this session"
        />
        {busy ? <span className="ssearch-count app-history-loading-spinner" aria-hidden="true" />
          : res && <span className="ssearch-count">{count}{res.mode === 'words' && <em title="these words, in any order">any order</em>}</span>}
        <button type="button" className="ssearch-close" onClick={onClose} aria-label="Close search" title="Esc">✕</button>
      </div>
      {error && <p className="ssearch-error" role="alert">{error}</p>}
      {hits.length > 0 && (
        <ul className="ssearch-list" ref={listRef}>
          {hits.map((h, i) => (
            <li key={h.id}>
              <button type="button" className={`ssearch-hit${i === sel ? ' on' : ''}`} onClick={() => go(i)}>
                <span className={`ssearch-role role-${h.role}`}>{ROLE_LABEL[h.role] ?? h.role}</span>
                <span className="ssearch-when">{when(h.tsMs)}</span>
                <Snippet text={h.snippet} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
