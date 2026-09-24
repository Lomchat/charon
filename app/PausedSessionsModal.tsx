'use client';
// Paused-sessions cleanup — the trash beside the sidebar's "show paused".
//
// Lists every paused session of the fleet in the sidebar's own tree (folder →
// VPS → path), each with the day and time of its last message, and deletes
// whatever is ticked in ONE request (`/api/claude/sessions/bulk-delete`).
// Order, filters and the meaning of a group checkbox live in
// `pausedCleanup.ts`; this file only draws them.
//
// Deliberate choices:
// - A group checkbox acts on the rows the FILTER shows, never on hidden ones:
//   "select this VPS" after typing a query means what is on screen. A
//   selection made before a filter change survives it, and the footer says how
//   much of it is out of sight, so nothing is deleted unseen by accident.
// - The confirmation is a second step IN the footer, not a stacked dialog.
// - The server re-checks "still paused" at deletion time: a session that woke
//   up after the list was drawn is kept and reported, not deleted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Vps, VpsFolder } from '@/lib/db/schema';
import type { BulkDeleteSessionsResponse, SessionListItem, AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { IconSearch, IconTrash } from './icons';
import {
  buildPausedTree, formatAgo, formatStamp, groupCheckState, sessionHeadline,
  toggleGroup, toggleRow, type CheckState,
} from './pausedCleanup';

type Props = {
  sessions: SessionListItem[];
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  deletingSessionIds: ReadonlySet<string>;
  /** Resolves with the server's verdict; throws on a transport failure. */
  onDelete: (ids: string[]) => Promise<BulkDeleteSessionsResponse>;
  onClose: () => void;
};

const DAY = 86_400_000;
const AGE_FILTERS: { key: string; label: string; ms: number }[] = [
  { key: 'any', label: 'any', ms: 0 },
  { key: '1d', label: '> 1 d', ms: DAY },
  { key: '7d', label: '> 7 d', ms: 7 * DAY },
  { key: '30d', label: '> 30 d', ms: 30 * DAY },
  { key: '90d', label: '> 90 d', ms: 90 * DAY },
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A checkbox that can also say "some". Purely visual: the row around it owns
 *  the click and the keyboard, so shift-click can reach the range logic. */
function TriCheck({ state }: { state: CheckState }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return (
    <input ref={ref} type="checkbox" className="pc-check" checked={state === 'all'}
      readOnly tabIndex={-1} aria-hidden="true" />
  );
}

/** Keyboard + pointer contract of every clickable checkbox row. */
function checkRowProps(state: CheckState, disabled: boolean, onToggle: (range: boolean) => void) {
  return {
    role: 'checkbox' as const,
    'aria-checked': state === 'some' ? ('mixed' as const) : state === 'all',
    'aria-disabled': disabled || undefined,
    tabIndex: disabled ? -1 : 0,
    // Shift-click would otherwise select the text between two rows.
    onMouseDown: (e: React.MouseEvent) => { if (e.shiftKey) e.preventDefault(); },
    onClick: (e: React.MouseEvent) => { if (!disabled) onToggle(e.shiftKey); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (disabled || (e.key !== ' ' && e.key !== 'Enter')) return;
      e.preventDefault();
      onToggle(e.shiftKey);
    },
  };
}

export default function PausedSessionsModal({
  sessions, vpsList, vpsFolders, deletingSessionIds, onDelete, onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [age, setAge] = useState('any');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "3 h ago" must not freeze while the dialog stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Desktop only: on a phone the keyboard would cover the list it filters.
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    searchRef.current?.focus();
  }, []);

  const minIdleMs = AGE_FILTERS.find((f) => f.key === age)?.ms ?? 0;
  const everything = useMemo(
    () => buildPausedTree(sessions, vpsList, vpsFolders),
    [sessions, vpsList, vpsFolders],
  );
  const tree = useMemo(
    () => buildPausedTree(sessions, vpsList, vpsFolders, { query, minIdleMs, now }),
    [sessions, vpsList, vpsFolders, query, minIdleMs, now],
  );

  // A selected session that left the list (woke up, deleted elsewhere) leaves
  // the selection too: the count on the button is what gets deleted. A row
  // merely BEING deleted stays — that is this dialog's own request running.
  const pausedIds = useMemo(() => new Set(everything.ids), [everything]);
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => pausedIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [pausedIds]);

  const selectable = (ids: readonly string[]) => ids.filter((id) => !deletingSessionIds.has(id));
  const visible = useMemo(() => new Set(tree.ids), [tree]);
  const selectedIds = everything.ids.filter((id) => selected.has(id));
  const hiddenSelected = selectedIds.filter((id) => !visible.has(id)).length;
  const order = selectable(tree.ids);

  function edit(next: Set<string>) {
    setSelected(next);
    setConfirming(false);
    setNotice(null);
  }
  function toggleIds(ids: readonly string[]) {
    anchor.current = null;
    edit(toggleGroup(selectable(ids), selected));
  }
  function onRow(id: string, range: boolean) {
    edit(toggleRow(order, selected, id, anchor.current, range));
    anchor.current = id;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.preventDefault();
      // Inside a non-empty filter, Escape empties it first.
      if (e.target === searchRef.current && searchRef.current?.value) { setQuery(''); return; }
      // Two steps back out one at a time: Escape first withdraws the
      // confirmation, then closes.
      if (confirming) setConfirming(false); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, confirming, onClose]);

  async function runDelete() {
    if (busy || selectedIds.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await onDelete(selectedIds);
      const done = new Set([...r.deleted, ...r.missing, ...r.notPaused]);
      setSelected((current) => new Set([...current].filter((id) => !done.has(id))));
      setConfirming(false);
      if (r.failed.length === 0 && r.notPaused.length === 0) { onClose(); return; }
      const parts = [`${plural(r.deleted.length + r.missing.length, 'session')} deleted.`];
      if (r.notPaused.length) {
        parts.push(`${plural(r.notPaused.length, 'session')} kept: running again since the list was drawn.`);
      }
      if (r.failed.length) setError(`${plural(r.failed.length, 'session')} could not be deleted: ${r.failed[0].error}`);
      setNotice(parts.join(' '));
    } catch (e: unknown) {
      // Ambiguous (a timeout can land after the server finished): the list
      // refresh the parent runs either way shows what is really left.
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const allState = groupCheckState(order, selected);
  const vpsCount = everything.folders.reduce((n, f) => n + f.vps.length, 0);
  // Folder headings only earn their line when they say something: a fleet
  // whose paused sessions all sit in the default folder gets no "No folder".
  const showFolders = tree.folders.length > 1 || (tree.folders[0] && tree.folders[0].key !== 'default');

  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal paused-cleanup" role="dialog" aria-modal="true" aria-label="Paused sessions">
        <div className="pc-head">
          <span className="confirm-ico"><IconTrash /></span>
          <div className="pc-title">
            <h2>Paused sessions</h2>
            <p>
              {everything.ids.length === 0
                ? 'Nothing is paused.'
                : `${plural(everything.ids.length, 'paused session')} on ${vpsCount} VPS`}
              {' · deleting removes a session and its whole history.'}
            </p>
          </div>
          <button type="button" className="pc-close" onClick={onClose} disabled={busy} aria-label="close">✕</button>
        </div>

        <div className="pc-tools">
          {/* A div, not a label: `.claude-modal label` restyles both itself
              and the input inside it as a form field caption. */}
          <div className="pc-search">
            <IconSearch />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter: name, message, path, VPS, @handle…"
              aria-label="filter paused sessions"
            />
          </div>
          <div className="pc-age" role="group" aria-label="last message older than">
            <span>idle</span>
            {AGE_FILTERS.map((f) => (
              <button key={f.key} type="button" className={age === f.key ? 'on' : ''}
                aria-pressed={age === f.key} onClick={() => setAge(f.key)}>{f.label}</button>
            ))}
          </div>
        </div>

        <div className="pc-all" {...checkRowProps(allState, order.length === 0, () => toggleIds(tree.ids))}>
          <TriCheck state={allState} />
          <span className="pc-all-label">
            {query.trim() || minIdleMs ? 'select everything shown' : 'select all'}
          </span>
          <span className="pc-count">{tree.ids.length}</span>
        </div>

        <div className="pc-body">
          {tree.ids.length === 0 && (
            <p className="pc-empty">
              {everything.ids.length === 0 ? 'No paused session — nothing to clean up.' : 'No paused session matches the filter.'}
            </p>
          )}
          {tree.folders.map((folder) => (
            <section key={folder.key} className="pc-folder">
              {showFolders && (() => {
                const st = groupCheckState(selectable(folder.ids), selected);
                return (
                  <div className="pc-folder-head" {...checkRowProps(st, selectable(folder.ids).length === 0, () => toggleIds(folder.ids))}>
                    <TriCheck state={st} />
                    <span className="pc-folder-name">{folder.name}</span>
                    <span className="pc-count">{folder.ids.length}</span>
                  </div>
                );
              })()}
              {folder.vps.map((v) => {
                const vst = groupCheckState(selectable(v.ids), selected);
                return (
                  <section key={v.key} className="pc-vps">
                    <div className="pc-vps-head" {...checkRowProps(vst, selectable(v.ids).length === 0, () => toggleIds(v.ids))}>
                      <TriCheck state={vst} />
                      <span className="pc-vps-name">{v.name}</span>
                      {v.host && <span className="pc-vps-host">{v.host}</span>}
                      <span className="pc-count">{v.ids.length}</span>
                    </div>
                    {v.paths.map((p) => {
                      const pst = groupCheckState(selectable(p.ids), selected);
                      return (
                        <div key={p.key} className="pc-path">
                          <div className="pc-path-head" title={p.path}
                            {...checkRowProps(pst, selectable(p.ids).length === 0, () => toggleIds(p.ids))}>
                            <TriCheck state={pst} />
                            <span className="pc-path-name">{p.path === '~' ? '~ (home)' : p.path}</span>
                            <span className="pc-count">{p.ids.length}</span>
                          </div>
                          {p.sessions.map((s) => (
                            <SessionLine key={s.id} s={s} now={now}
                              checked={selected.has(s.id)}
                              deleting={deletingSessionIds.has(s.id)}
                              onToggle={(range) => onRow(s.id, range)} />
                          ))}
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </section>
          ))}
        </div>

        {(notice || error) && (
          <div className="pc-messages">
            {notice && <p className="pc-notice">{notice}</p>}
            {error && <p className="confirm-err">{error}</p>}
          </div>
        )}

        <div className={`pc-foot${confirming ? ' confirming' : ''}`}>
          {confirming ? (
            <>
              <p className="pc-warn">
                Permanently delete <b>{plural(selectedIds.length, 'session')}</b> and their whole
                history{hiddenSelected ? <> — <b>{hiddenSelected}</b> of them hidden by the filter</> : null}?
                {' '}This cannot be undone.
              </p>
              <div className="pc-actions">
                <button type="button" className="confirm-btn ghost" autoFocus disabled={busy}
                  onClick={() => setConfirming(false)}>back</button>
                <button type="button" className="confirm-btn danger" disabled={busy || selectedIds.length === 0}
                  onClick={() => { void runDelete(); }}>
                  {busy ? 'deleting…' : 'delete permanently'}
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="pc-selected">
                {selectedIds.length === 0 ? 'nothing selected' : `${selectedIds.length} selected`}
                {hiddenSelected > 0 && <span className="pc-hidden"> · {hiddenSelected} hidden by the filter</span>}
                {selectedIds.length > 0 && (
                  <button type="button" className="pc-clear" onClick={() => { anchor.current = null; edit(new Set()); }}>
                    clear
                  </button>
                )}
              </span>
              <div className="pc-actions">
                <button type="button" className="confirm-btn ghost" onClick={onClose}>close</button>
                <button type="button" className="confirm-btn danger" disabled={selectedIds.length === 0}
                  onClick={() => { setError(null); setConfirming(true); }}>
                  <IconTrash /> delete{selectedIds.length ? ` ${selectedIds.length}` : ''}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  // Portaled like ConfirmModal: the sidebar is a transformed drawer on a phone.
  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}

function SessionLine({ s, now, checked, deleting, onToggle }: {
  s: SessionListItem;
  now: number;
  checked: boolean;
  deleting: boolean;
  onToggle: (range: boolean) => void;
}) {
  const headline = sessionHeadline(s);
  const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  const showPreview = !!preview && !headline.startsWith(preview.slice(0, 30));
  const last = s.lastActivityMs ?? null;
  const created = s.createdAt ? s.createdAt * 1000 : null;
  const full = last ? new Date(last).toLocaleString() : null;
  return (
    <div
      className={`pc-row${checked ? ' checked' : ''}${deleting ? ' deleting' : ''}`}
      title={[headline, s.cwd, full ? `last message: ${full}` : 'no message yet',
        created ? `created: ${new Date(created).toLocaleString()}` : null].filter(Boolean).join('\n')}
      {...checkRowProps(checked ? 'all' : 'none', deleting, onToggle)}
    >
      <TriCheck state={checked ? 'all' : 'none'} />
      <AgentLogo kind={(s.kind as AgentKind) ?? 'claude'} size={15} endpointName={s.endpoint?.active?.name} />
      <span className="pc-main">
        <span className="pc-name">{headline}</span>
        {(showPreview || s.handle) && (
          <span className="pc-sub">
            {s.handle && <span className="pc-handle">@{s.handle}</span>}
            {showPreview && <span className="pc-preview">{preview}</span>}
          </span>
        )}
      </span>
      <span className="pc-when">
        {deleting ? (
          <span className="pc-stamp">deleting…</span>
        ) : last ? (
          <>
            <span className="pc-stamp">{formatStamp(last, now)}</span>
            <span className="pc-ago">{formatAgo(last, now)}</span>
          </>
        ) : (
          <>
            <span className="pc-stamp muted">no message</span>
            {created && <span className="pc-ago">created {formatAgo(created, now)}</span>}
          </>
        )}
      </span>
    </div>
  );
}
