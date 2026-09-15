'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, SessionListItem } from '@/lib/types/api';
import AgentLogo from './AgentLogo';

/**
 * Header shortcut to the sessions you are actually using: a trigger carrying
 * how many are working and how many finished unread, opening a panel with what
 * is running, the last few that finished (and how long ago), and every session
 * under a search box.
 *
 * It reads the SAME projection of the session list the sidebar already holds —
 * no new request, no second source of truth. The only field added for it is
 * `lastActivityMs` (sessions route): "finished 4 minutes ago" cannot be ordered
 * from `unreadStop` (a flag) or `createdAt` (the launch).
 */

/** How many finished sessions the dedicated section shows. The rest are one
 *  scroll away in the full list, which is the point of having both. */
const FINISHED_SHOWN = 5;

// The sidebar's own vocabulary (§14.47, §14.91), reused verbatim so a session
// never reads as "working" here and "finished" three inches to the left.
const WORKING_STATUSES = new Set(['thinking', 'starting', 'background']);

type NavRow = {
  s: SessionListItem;
  working: boolean;
  waiting: boolean;
  unread: boolean;
  /** When this session last did anything; the launch for one that never spoke. */
  when: number;
};

function rowOf(s: SessionListItem): NavRow {
  const working = WORKING_STATUSES.has(String(s.liveStatus));
  const waiting = (s.pendingPermissions ?? 0) > 0;
  return {
    s,
    working,
    waiting,
    unread: !!s.unreadStop && !working && !waiting,
    when: s.lastActivityMs ?? (s.createdAt ? s.createdAt * 1000 : 0),
  };
}

function label(s: SessionListItem): string {
  return s.name || s.firstUserMessage?.slice(0, 40) || '(unnamed)';
}

function ago(ms: number): string {
  if (!ms) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function stateClass(r: NavRow): string {
  if (r.waiting) return 'needs-you';
  if (r.working) return 'working';
  if (['error', 'failed'].includes(String(r.s.liveStatus))) return 'error';
  if (String(r.s.liveStatus) === 'sleeping') return 'idle';
  return 'ready';
}

function stateWord(r: NavRow): string {
  if (r.waiting) return 'needs you';
  if (r.working) return String(r.s.liveStatus) === 'background' ? 'background' : 'working';
  if (r.unread) return 'finished, unread';
  if (['error', 'failed'].includes(String(r.s.liveStatus))) return 'error';
  if (String(r.s.liveStatus) === 'sleeping') return 'paused';
  return 'ready';
}

type Props = {
  sessions: SessionListItem[];
  vpsName: (vpsId: string) => string;
  selectedId: string | null;
  onOpen: (id: string) => void;
};

export default function HeaderSessionNav({ sessions, vpsName, selectedId, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  // Opening lands on the search box; closing forgets the query, so the panel
  // always reopens on the live picture rather than on an old filter.
  useEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
    else setQuery('');
  }, [open]);

  const rows = useMemo(
    () => sessions.map(rowOf).sort((a, b) => b.when - a.when),
    [sessions],
  );
  const running = rows.filter((r) => r.working || r.waiting);
  const finished = rows.filter((r) => !r.working && !r.waiting).slice(0, FINISHED_SHOWN);
  const unreadCount = rows.filter((r) => r.unread).length;

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return rows;
    const terms = q.split(/\s+/);
    return rows.filter((r) => {
      const hay = [
        label(r.s), r.s.handle ?? '', r.s.cwd, vpsName(r.s.vpsId), String(r.s.kind),
      ].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, q, vpsName]);

  function pick(id: string) { onOpen(id); setOpen(false); }
  const rowProps = { onPick: pick, selectedId, vpsName };

  return (
    <div className="hnav" ref={wrap}>
      <button
        type="button"
        className={`hnav-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${running.length} working · ${unreadCount} finished, unread · ${rows.length} sessions`}
      >
        <span className={`hnav-dot ${running.length ? 'working' : 'idle'}`} aria-hidden />
        <span className="hnav-trigger-count">{running.length}</span>
        <span className="hnav-trigger-word">working</span>
        {!!unreadCount && (
          <span className="hnav-trigger-unread" title={`${unreadCount} finished and not opened yet`}>
            <span className="hnav-dot unread" aria-hidden />{unreadCount}
          </span>
        )}
        <span className="hnav-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="hnav-panel" role="menu">
          <div className="hnav-search">
            <input
              ref={search}
              className="hnav-search-input"
              value={query}
              placeholder="search sessions — name, path, machine…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {!!query && (
              <button type="button" className="hnav-search-clear" onClick={() => setQuery('')}
                aria-label="clear search">×</button>
            )}
          </div>
          {q ? (
            <Section title={`Matches (${matches.length})`} rows={matches}
              empty="nothing matches" scroll {...rowProps} />
          ) : (
            <>
              <Section title={`Working (${running.length})`} rows={running}
                empty="nothing running" {...rowProps} />
              <Section title="Recently finished" rows={finished}
                empty="no finished session yet" {...rowProps} />
              <Section title={`All sessions (${rows.length})`} rows={matches}
                empty="" scroll {...rowProps} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

type RowProps = {
  onPick: (id: string) => void;
  selectedId: string | null;
  vpsName: (id: string) => string;
};

function Section({ title, rows, empty, scroll, ...rowProps }: RowProps & {
  title: string; rows: NavRow[]; empty: string; scroll?: boolean;
}) {
  if (!rows.length && !empty) return null;
  return (
    <div className={`hnav-section${scroll ? ' is-scroll' : ''}`}>
      <div className="hnav-section-title">{title}</div>
      {rows.length === 0 && <div className="hnav-empty">{empty}</div>}
      <div className="hnav-section-rows">
        {rows.map((r) => <Row key={r.s.id} r={r} {...rowProps} />)}
      </div>
    </div>
  );
}

function Row({ r, onPick, selectedId, vpsName }: RowProps & { r: NavRow }) {
  const machine = vpsName(r.s.vpsId);
  return (
    <button
      type="button"
      role="menuitem"
      data-nav-id={r.s.id}
      className={`hnav-row ${stateClass(r)}${r.unread ? ' unread' : ''}${r.s.id === selectedId ? ' is-open' : ''}`}
      onClick={() => onPick(r.s.id)}
      title={`${label(r.s)} — ${stateWord(r)} · ${machine} · ${r.s.cwd}`}
    >
      <span className="hnav-dot" aria-hidden />
      <AgentLogo kind={r.s.kind as AgentKind} size={13} />
      <span className="hnav-row-name">{label(r.s)}</span>
      {/* Machine and path are TWO facts, joined the way the session subtitle
          joins them (`CwdSubtitle`). Glued with a colon, a machine whose name
          ends in a word — "chalco - new" — read as a prefix of the path. */}
      <span className="hnav-row-where">
        <span className="hnav-row-vps">{machine}</span>
        <span className="hnav-row-cwd">{r.s.cwd}</span>
      </span>
      <span className="hnav-row-when">{ago(r.when)}</span>
    </button>
  );
}
