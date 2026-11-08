'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/db/schema';
import type { AgentKind, HistoryPreviewResponse, HistorySession, HistoryTool, SessionListItem } from '@/lib/types/api';
import { profileLabel } from '@/lib/accountProfiles';
import PickerControl from './PickerControl';
import AgentLogo, { agentKindLabel } from './AgentLogo';
import { useAccountProfiles } from './accountProfileStore';
import { backendAvailability } from './vpsHealth';
import { fmtSize } from './sessionAttachments';
import { IconSearch } from './icons';
import type { EnabledBackends } from './enabledBackends';
import { PROVIDERS, SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import {
  ago, groupProjects, isNoise, leaf, matchesQuery, mergeHistory, scannedToHistory, shortModel,
  type ResumeItem, type ResumeState,
} from './resumeHistory';

// "Resume a session" — what one VPS holds that Charon does not show: sessions
// never imported, and archived ones. Projects on the left, their sessions as
// cards, and a panel that slides in with a session's first request and last
// exchanges before you import (or unarchive) it. A session in the sidebar is
// never listed — this is not a search.
//
// The list is the agent's history index (history.py: cached, so a reopen is
// instant; the first build of a box fills in over a few calls) merged with the
// sessions Charon already holds (resumeHistory.ts). An agent too old to index
// falls back to the per-provider scans; a provider without transcript files
// (`deployment.historyIndex: false`) always comes from its scan.
type Props = {
  vpsList: Vps[];
  dbSessions: SessionListItem[];
  enabledBackends?: EnabledBackends;
  initialVpsId?: string;
  onClose: () => void;
  // vpsId + cwd travel with the id: the caller opens its tab immediately and
  // the session list it would look them up in is a beat behind.
  onImported: (created: { id: string; vpsId: string; cwd: string }) => void;
  /** Resume (wakes it) and open. */
  onResumed: (id: string) => void;
  /** Open without resuming. */
  onOpen?: (id: string) => void;
};

type IndexState = {
  rows: HistorySession[];
  pending: number;
  total: number;
  loading: boolean;
  error: string | null;
  /** Rows from the old scans: no previews, counts are rough. */
  legacy: boolean;
};
const LOADING: IndexState = { rows: [], pending: 0, total: 0, loading: true, error: null, legacy: false };
const ALL = '*';
// Read from the agent's index (history.py), previews included; the others
// (no transcript file) come from their scan.
const INDEXED = SESSION_PROVIDERS.filter((p) => PROVIDERS[p].deployment.historyIndex);
const SCANNED = SESSION_PROVIDERS.filter((p) => !PROVIDERS[p].deployment.historyIndex);
const TURNS = 3;
const TURNS_MORE = 10;

type Preview = { turns: number; loading: boolean; data?: HistoryPreviewResponse };

const STATE_LABEL: Record<ResumeState, string> = { new: 'on VPS', archived: 'archived' };
const TOOL_MARK: Record<HistoryTool['k'], string> = {
  edit: '✎', read: '≡', cmd: '$', search: '⌕', web: '↗', agent: '◇', other: '·',
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function actionLabel(it: ResumeItem): string {
  return it.state === 'archived' ? 'Unarchive' : 'Import';
}

function countText(it: ResumeItem): string | null {
  if (it.prompts == null) return null;
  if (it.approx) return it.size != null ? fmtSize(it.size) : null;
  return `${it.prompts} prompt${it.prompts === 1 ? '' : 's'}`;
}

function timeOf(at?: string): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function ResumeModal({
  vpsList, dbSessions, enabledBackends, initialVpsId, onClose, onImported, onResumed, onOpen,
}: Props) {
  const [vpsId, setVpsId] = useState(initialVpsId ?? vpsList[0]?.id ?? '');
  const vps = vpsList.find((v) => v.id === vpsId);
  const [index, setIndex] = useState<IndexState>(LOADING);
  const [scanRows, setScanRows] = useState<HistorySession[]>([]);
  const [archivedDb, setArchivedDb] = useState<SessionListItem[]>([]);
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState('');
  const [offKinds, setOffKinds] = useState<ReadonlySet<AgentKind>>(new Set());
  const [showArchived, setShowArchived] = useState(true);
  const [hideNoise, setHideNoise] = useState(true);
  const [project, setProject] = useState(ALL);
  const [branch, setBranch] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Imported here without opening: gone from the list at once (the sidebar
  // has it), before the summaries catch up.
  const [imported, setImported] = useState<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  // ── Load: the index (in parts on a first build), the scans, archived rows ─
  const scanned = SCANNED.filter((k) => enabledBackends?.[k]);
  const scannedKey = scanned.join(',');
  useEffect(() => {
    if (!vpsId) return;
    let cancelled = false;
    setIndex(LOADING);
    setScanRows([]);
    const legacy = async () => {
      const parts = await Promise.all(INDEXED.map((k) => api.scanVpsSessions(vpsId, k)
        .then((r) => scannedToHistory(k, r.sessions ?? [])).catch(() => [] as HistorySession[])));
      if (!cancelled) setIndex({ rows: parts.flat(), pending: 0, total: 0, loading: false, error: null, legacy: true });
    };
    (async () => {
      try {
        // Each call indexes for ~2.5 s and answers what it has; a box's very
        // first build takes a few rounds, a warm one answers at once.
        for (let round = 0; round < 40 && !cancelled; round++) {
          const r = await api.historyIndex(vpsId);
          if (cancelled) return;
          if (!r.ok) {
            if (r.reason === 'unsupported') { await legacy(); return; }
            setIndex((x) => ({ ...x, loading: false, error: r.error || 'could not read the history of this VPS' }));
            return;
          }
          const pending = r.pending ?? 0;
          setIndex({ rows: r.sessions ?? [], pending, total: r.total ?? 0, loading: pending > 0, error: null, legacy: false });
          if (!pending) return;
        }
      } catch (e) {
        if (!cancelled) setIndex((x) => ({ ...x, loading: false, error: errText(e) }));
      }
    })();
    const kinds = scannedKey ? scannedKey.split(',') as AgentKind[] : [];
    Promise.all(kinds.map((k) => api.scanVpsSessions(vpsId, k)
      .then((r) => scannedToHistory(k, r.sessions ?? [])).catch(() => [] as HistorySession[])))
      .then((parts) => { if (!cancelled) setScanRows(parts.flat()); });
    return () => { cancelled = true; };
  }, [vpsId, reload, scannedKey]);

  // Archived Charon sessions stay out of the normal lists: fetched here so
  // they can be found (and unarchived) like the rest.
  useEffect(() => {
    let cancelled = false;
    setArchivedDb([]);
    if (!vpsId) return;
    api.listSessions({ vpsId, includeArchived: true })
      .then((r) => { if (!cancelled) setArchivedDb(r.sessions.filter((s) => s.archived === 1)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [vpsId]);

  // ── The list ──────────────────────────────────────────────────────────────
  const items = useMemo(() => {
    const charon = dbSessions.filter((s) => s.vpsId === vpsId);
    for (const a of archivedDb) if (!charon.some((s) => s.id === a.id)) charon.push(a);
    return mergeHistory([...index.rows, ...scanRows], charon).filter((it) => !imported.has(it.key));
  }, [dbSessions, archivedDb, index.rows, scanRows, vpsId, imported]);

  const kindsPresent = useMemo(() => {
    const c = new Map<AgentKind, number>();
    for (const it of items) if (!hideNoise || !isNoise(it)) c.set(it.kind, (c.get(it.kind) ?? 0) + 1);
    return c;
  }, [items, hideNoise]);
  const noiseCount = useMemo(() => items.filter(isNoise).length, [items]);
  const archivedCount = useMemo(() => items.filter((it) => it.state === 'archived').length, [items]);

  const filtered = useMemo(() => items.filter((it) => !offKinds.has(it.kind)
    && (showArchived || it.state !== 'archived')
    && (!hideNoise || !isNoise(it))
    && matchesQuery(it, q)), [items, offKinds, showArchived, hideNoise, q]);
  const projects = useMemo(() => groupProjects(filtered), [filtered]);
  // A project the filters emptied (a search elsewhere) gives way to them all.
  const scope = project !== ALL && projects.some((p) => p.cwd === project) ? project : ALL;
  const inScope = useMemo(() => (scope === ALL ? filtered : filtered.filter((it) => it.cwd === scope)), [filtered, scope]);
  const branches = useMemo(() => (scope === ALL ? []
    : [...new Set(inScope.map((it) => it.branch).filter(Boolean))]), [inScope, scope]);
  const shownBranch = branch && branches.includes(branch) ? branch : null;
  const shown = useMemo(() => (shownBranch ? inScope.filter((it) => it.branch === shownBranch) : inScope), [inScope, shownBranch]);
  const leafCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of projects) c.set(leaf(p.cwd), (c.get(leaf(p.cwd)) ?? 0) + 1);
    return c;
  }, [projects]);

  const curItem = useMemo(() => items.find((it) => it.key === cur) ?? null, [items, cur]);
  useEffect(() => { if (open && !curItem) setOpen(false); }, [open, curItem]);

  // ── Preview ───────────────────────────────────────────────────────────────
  const canPreview = (it: ResumeItem) => !index.legacy && !!it.nativeId && INDEXED.includes(it.kind);
  const loadPreview = useCallback((it: ResumeItem, turns: number) => {
    if (!it.nativeId) return;
    const key = it.key;
    setPreviews((p) => ({ ...p, [key]: { turns, loading: true, data: p[key]?.data } }));
    api.historyPreview(vpsId, it.kind, it.nativeId, turns)
      .then((data) => setPreviews((p) => ({ ...p, [key]: { turns, loading: false, data } })))
      .catch((e) => setPreviews((p) => ({ ...p, [key]: { turns, loading: false, data: { ok: false, reason: 'offline', error: errText(e) } } })));
  }, [vpsId]);
  useEffect(() => {
    if (!open || !curItem || !canPreview(curItem)) return;
    if (!previews[curItem.key]) loadPreview(curItem, TURNS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, curItem?.key, index.legacy]);

  // ── Accounts (import only: an archived session keeps its own) ────────────
  const profiles = useAccountProfiles(vpsId);
  const [profile, setProfile] = useState('default');
  const choices = curItem ? profiles.filter((p) => p.provider === curItem.kind) : [];
  useEffect(() => { setProfile('default'); }, [curItem?.kind, vpsId]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const act = useCallback(async (it: ResumeItem, mode: 'primary' | 'secondary' = 'primary') => {
    setActionErr(null);
    setBusy(it.key);
    try {
      if (it.state === 'new') {
        if (!it.nativeId) throw new Error('this session has no native id to import');
        const r = await api.importSession({
          vpsId, kind: it.kind, accountProfile: profile, nativeSessionId: it.nativeId, cwd: it.cwd,
          name: it.title ? it.title.slice(0, 60) : null,
        });
        // An archived Codex thread: import the transcript first (the route
        // needs a DB row), then restore the native thread.
        if (it.archivedNative) await api.unarchiveSession(r.id);
        if (mode === 'primary') { onImported({ id: r.id, vpsId, cwd: it.cwd }); return; }
        setImported((m) => new Set(m).add(it.key));
        setOpen(false);
        setNote(`Imported “${it.title.slice(0, 60)}” — it waits in the sidebar`);
        return;
      }
      const id = it.session?.id;
      if (!id) return;
      await api.unarchiveSession(id);
      setArchivedDb((rows) => rows.filter((s) => s.id !== id));
      if (mode === 'primary') onResumed(id); else (onOpen ?? onResumed)(id);
    } catch (e) {
      setActionErr(errText(e));
    } finally {
      setBusy(null);
    }
  }, [vpsId, profile, onImported, onResumed, onOpen]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const step = useCallback((d: number) => {
    if (!shown.length) return;
    const i = shown.findIndex((it) => it.key === cur);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i < 0 ? 0 : i + d))];
    setCur(next.key);
    requestAnimationFrame(() => cardsRef.current
      ?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [shown, cur]);
  const stateRef = useRef({ open, cur, curItem, step, act });
  stateRef.current = { open, cur, curItem, step, act };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = stateRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (s.open) setOpen(false); else onClose();
        return;
      }
      const t = e.target as HTMLElement | null;
      const inSearch = t === searchRef.current;
      if (t && !inSearch && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        s.step(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' && (inSearch || t === document.body || t?.classList.contains('rsm-card'))) {
        e.preventDefault();
        if (!s.cur) { s.step(1); return; }
        if (!s.open) { setOpen(true); return; }
        if (s.curItem) void s.act(s.curItem);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    // A phone would pop its keyboard over the list.
    if (!window.matchMedia?.('(pointer: coarse)').matches) searchRef.current?.focus();
  }, []);

  const selectVps = (id: string) => {
    setVpsId(id); setProject(ALL); setBranch(null); setCur(null); setOpen(false); setPreviews({}); setImported(new Set());
  };
  const openItem = (it: ResumeItem) => { setCur(it.key); setOpen(true); setActionErr(null); };
  const toggleKind = (k: AgentKind) => setOffKinds((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    // Never every provider off: the list would just be empty.
    return n.size >= kindsPresent.size ? s : n;
  });

  // ── Render ────────────────────────────────────────────────────────────────
  const status = index.error ? <span className="rsm-idx err" title={index.error}>could not read the history</span>
    : index.loading ? (
      <span className="rsm-idx">
        {index.total ? <>indexing transcripts <span className="rsm-bar"><i style={{ width: `${Math.round(100 * (index.total - index.pending) / index.total)}%` }} /></span> {index.total - index.pending}/{index.total} · newest first</>
          : 'reading the history…'}
      </span>
    ) : (
      <span className="rsm-idx">
        <span className="ok">●</span> {items.length} sessions{index.legacy ? ' · update the agent for previews' : ''}
        <button type="button" className="rsm-x small" onClick={() => setReload((n) => n + 1)} title="Read the history again (only what changed)">⟳</button>
      </span>
    );

  const chip = (on: boolean, label: ReactNode, onClick: () => void, n?: number, title?: string) => (
    <button type="button" className={`rsm-chip${on ? ' on' : ''}`} onClick={onClick} title={title}>
      {label}{n != null && <span className="n">{n}</span>}
    </button>
  );

  const card = (it: ResumeItem) => {
    const count = countText(it);
    return (
      <div key={it.key} data-key={it.key} tabIndex={-1} role="button"
           className={`rsm-card${cur === it.key ? ' cur' : ''}`}
           onClick={() => openItem(it)}>
        <div className="l1">
          <AgentLogo kind={it.kind} size={15} title={agentKindLabel(it.kind)} />
          <span className="t" title={it.title}>{it.title}</span>
          <span className={`rsm-st ${it.state}`}><i />{it.archivedNative ? 'archived on VPS' : STATE_LABEL[it.state]}</span>
        </div>
        <div className="q">{it.lastPrompt
          ? <><b>last</b>{it.lastPrompt}</>
          : it.firstPrompt ? <><b>first</b>{it.firstPrompt}</> : <span className="faint">no prompt</span>}
        </div>
        <div className="l3">
          {scope === ALL && <span className="rsm-proj" title={it.cwd}>{leaf(it.cwd)}</span>}
          {it.branch && <span className="rsm-meta" title="git branch">⎇ {it.branch}</span>}
          {count && <span className="rsm-meta">{count}</span>}
          {it.model && <span className="rsm-meta">{shortModel(it.model)}</span>}
          <span className="rsm-meta" title={new Date(it.mtimeMs).toLocaleString()}>{ago(it.mtimeMs)}</span>
          <span className="sp" />
          <button type="button" className={`rsm-act${it.state === 'new' ? '' : ' prim'}`} disabled={busy === it.key}
                  onClick={(e) => { e.stopPropagation(); void act(it); }}>
            {busy === it.key ? '…' : actionLabel(it)}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="rsm-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rsm" role="dialog" aria-modal="true" aria-label="Resume a session">
        <header className="rsm-head">
          <h2>Resume a session</h2>
          <PickerControl className="rsm-vps" value={vpsId} onValueChange={selectVps}>
            {vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </PickerControl>
          {status}
          <span className="sp" />
          <button type="button" className="rsm-x" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        <div className="rsm-body">
          <aside className="rsm-rail">
            <label className="rsm-search">
              <IconSearch />
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Search title, prompt, folder, branch…" spellCheck={false} autoComplete="off" />
            </label>
            <div className="rsm-pjs">
              <button type="button" className={`rsm-pj${scope === ALL ? ' on' : ''}`} onClick={() => { setProject(ALL); setBranch(null); }}>
                <span className="sw all" />
                <span className="nm"><b>All projects</b><small>{q ? 'matching the search' : 'newest first'}</small></span>
                <span className="cnt"><span>{filtered.length}</span>
                  {filtered.some((it) => it.state === 'new') && <span className="fresh">{filtered.filter((it) => it.state === 'new').length} on VPS</span>}</span>
              </button>
              <div className="rsm-sep" />
              {projects.map((p) => (
                <button type="button" key={p.cwd} className={`rsm-pj${scope === p.cwd ? ' on' : ''}`} title={p.cwd}
                        onClick={() => { setProject(p.cwd); setBranch(null); }}>
                  <span className="sw" />
                  <span className="nm"><b>{(leafCounts.get(leaf(p.cwd)) ?? 0) > 1 ? p.cwd : leaf(p.cwd)}</b><small>{p.cwd}</small></span>
                  <span className="cnt"><span>{p.count} · {ago(p.latestMs)}</span>{p.fresh > 0 && <span className="fresh">{p.fresh} on VPS</span>}</span>
                </button>
              ))}
              {index.loading && <div className="rsm-skel" />}
            </div>
          </aside>

          <section className="rsm-pane">
            <div className="rsm-scope">
              <div className="ttl">
                {scope === ALL ? <b>All projects</b> : <><b>{leaf(scope)}</b><span>{scope}</span></>}
                <span className="sp" />
                <span>{shown.length} session{shown.length === 1 ? '' : 's'}</span>
              </div>
              {branches.length > 0 && (
                <div className="rsm-chips">
                  {chip(!shownBranch, 'all branches', () => setBranch(null))}
                  {branches.map((b) => <span key={b}>{chip(shownBranch === b, `⎇ ${b}`, () => setBranch(b))}</span>)}
                </div>
              )}
              <div className="rsm-chips">
                {[...kindsPresent.entries()].map(([k, n]) => (
                  <span key={k}>{chip(!offKinds.has(k), <><AgentLogo kind={k} size={12} title="" />{agentKindLabel(k)}</>, () => toggleKind(k), n)}</span>
                ))}
                {kindsPresent.size > 0 && <span className="rsm-chip-sep" />}
                {archivedCount > 0 && <>
                  {chip(showArchived, 'Archived', () => setShowArchived((v) => !v), archivedCount,
                    'Charon sessions you archived — unarchive one to get it back in the sidebar')}
                  <span className="rsm-chip-sep" />
                </>}
                {chip(hideNoise, 'Hide noise', () => setHideNoise((v) => !v), noiseCount,
                  'Hides transcripts with no prompt and sessions started under /tmp')}
              </div>
            </div>
            {note && <div className="rsm-note" onClick={() => setNote(null)}>{note}</div>}
            <div className="rsm-cards" ref={cardsRef}>
              {shown.map(card)}
              {index.loading && <><div className="rsm-skel" /><div className="rsm-skel" /></>}
              {!index.loading && !shown.length && (
                <div className="rsm-empty">{index.error ?? (q ? 'No session matches this search.' : 'No session here.')}</div>
              )}
            </div>
          </section>

          {open && curItem && (
            <>
              <div className="rsm-scrim" onClick={() => setOpen(false)} />
              <Drawer
                it={curItem} vps={vps} preview={previews[curItem.key]} canPreview={canPreview(curItem)} legacy={index.legacy}
                busy={busy === curItem.key} error={actionErr}
                accounts={choices.length > 1 ? (
                  <PickerControl className="rsm-acct" value={profile} onValueChange={setProfile} title="The account the imported session runs on">
                    {choices.map((p) => <option key={p.id} value={p.id}>{profileLabel(agentKindLabel(curItem.kind), p)}</option>)}
                  </PickerControl>
                ) : null}
                onMore={() => loadPreview(curItem, TURNS_MORE)}
                onAct={(mode) => void act(curItem, mode)}
                onStep={step}
                onClose={() => setOpen(false)}
              />
            </>
          )}
        </div>

        <footer className="rsm-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> session</span>
          <span><kbd>↵</kbd> show the exchanges, then {curItem ? actionLabel(curItem).toLowerCase() : 'resume / import'}</span>
          <span><kbd>esc</kbd> {open ? 'close the panel' : 'close'}</span>
          <span className="sp" />
          {hideNoise && noiseCount > 0 && <span>{noiseCount} empty or /tmp sessions hidden</span>}
        </footer>
      </div>
    </div>
  );
}

function Drawer({ it, vps, preview, canPreview, legacy, busy, error, accounts, onMore, onAct, onStep, onClose }: {
  it: ResumeItem;
  vps?: Vps;
  preview?: Preview;
  canPreview: boolean;
  legacy: boolean;
  busy: boolean;
  error: string | null;
  accounts: ReactNode;
  onMore: () => void;
  onAct: (mode: 'primary' | 'secondary') => void;
  onStep: (d: number) => void;
  onClose: () => void;
}) {
  const data = preview?.data;
  const turns = data?.ok ? data.turns ?? [] : [];
  const first = (data?.ok ? data.first : '') || it.firstPrompt;
  const earlier = it.prompts != null && !it.approx ? Math.max(0, it.prompts - 1 - turns.length) : null;
  const more = preview && preview.turns < TURNS_MORE && (earlier == null ? turns.length >= TURNS : earlier > 0);
  const avail = vps ? backendAvailability(vps, it.kind) : null;
  const unusable = avail && !avail.ok ? avail.reason : null;
  const fresh = it.state === 'new';
  const count = countText(it);
  const last = new Date(it.mtimeMs);

  return (
    <aside className="rsm-drawer" aria-label={it.title}>
      <div className="rsm-ph">
        <div className="nav">
          <button type="button" className="rsm-x" onClick={() => onStep(-1)} title="Previous session (↑)">↑</button>
          <button type="button" className="rsm-x" onClick={() => onStep(1)} title="Next session (↓)">↓</button>
          <button type="button" className="rsm-x" onClick={onClose} title="Close the panel (Esc)">✕</button>
        </div>
        <h3>
          <AgentLogo kind={it.kind} size={16} title={agentKindLabel(it.kind)} />
          <span className="t" title={it.title}>{it.title}</span>
          <span className={`rsm-st ${it.state}`}><i />{it.archivedNative ? 'archived on VPS' : STATE_LABEL[it.state]}</span>
        </h3>
        <dl className="rsm-grid">
          <div><dt>project</dt><dd title={it.cwd}>{it.cwd}</dd></div>
          <div><dt>branch</dt><dd>{it.branch ? `⎇ ${it.branch}` : '—'}</dd></div>
          <div><dt>model</dt><dd>{it.model ? shortModel(it.model) : '—'}{it.effort ? ` · ${it.effort}` : ''}</dd></div>
          <div><dt>prompts</dt><dd>{it.prompts == null ? '—' : it.approx ? `${it.prompts}+ (big transcript)` : count}</dd></div>
          <div><dt>transcript</dt><dd>{it.size != null ? fmtSize(it.size) : '—'}</dd></div>
          <div><dt>last active</dt><dd title={last.toLocaleString()}>{last.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · {last.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ({ago(it.mtimeMs)} ago)</dd></div>
        </dl>
      </div>

      <div className="rsm-conv">
        {unusable && (
          <div className="rsm-warn">
            {agentKindLabel(it.kind)} is {unusable} on this VPS — {fresh ? 'importing works (the transcript is read over ssh), but resuming' : 'resuming'} will fail until it is fixed.
          </div>
        )}
        {first && <div className="rsm-bub u first"><small>first request</small>{first}</div>}
        {canPreview ? (
          <>
            {preview?.loading && !data && <div className="rsm-skel" />}
            {data && !data.ok && (
              <div className="rsm-empty small">
                {data.reason === 'missing' ? 'No transcript for this session on the VPS any more.' : data.error || 'Could not read the exchanges.'}
              </div>
            )}
            {more && (
              <div className="rsm-gap">
                {earlier != null ? `${earlier} earlier prompt${earlier === 1 ? '' : 's'}` : 'earlier exchanges'}
                <button type="button" onClick={onMore} disabled={preview?.loading}>{preview?.loading ? '…' : 'show more'}</button>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={`${t.at ?? ''}:${i}`} className="rsm-turn">
                <div className="rsm-bub u"><small>you{t.at ? ` · ${timeOf(t.at)}` : ''}</small>{t.user}</div>
                {(t.answer || t.tools.length > 0) && (
                  <div className="rsm-bub a">
                    <small>{agentKindLabel(it.kind)}{it.model ? ` · ${shortModel(it.model)}` : ''}</small>
                    {t.tools.length > 0 && (
                      <div className="rsm-tools">
                        {t.more_tools > 0 && <span className="faint">… {t.more_tools} earlier actions</span>}
                        {t.tools.map((x, j) => (
                          <span key={j} title={x.t}><b>{TOOL_MARK[x.k] ?? '·'}</b>{x.t}{x.n ? <em> ×{x.n}</em> : null}</span>
                        ))}
                      </div>
                    )}
                    {t.answer}
                  </div>
                )}
              </div>
            ))}
          </>
        ) : (
          <>
            {it.lastPrompt && it.lastPrompt !== first && <div className="rsm-bub u"><small>last prompt</small>{it.lastPrompt}</div>}
            <div className="rsm-empty small">
              {legacy ? 'Update the agent on this VPS to see the last exchanges here.'
                : 'No transcript file to preview for this session.'}
            </div>
          </>
        )}
      </div>

      <div className="rsm-pa">
        {error && <div className="rsm-err">{error}</div>}
        <div className="row">
          {fresh ? (
            <>
              <button type="button" className="rsm-act prim big" disabled={busy} onClick={() => onAct('primary')}>
                {busy ? 'importing…' : it.archivedNative ? 'Import, unarchive & open' : 'Import & open'}
              </button>
              <button type="button" className="rsm-act big" disabled={busy} onClick={() => onAct('secondary')}
                      title="Import it into the sidebar and keep browsing">Import only</button>
              {accounts}
            </>
          ) : (
            <>
              <button type="button" className="rsm-act prim big" disabled={busy} onClick={() => onAct('primary')}>
                Unarchive &amp; resume
              </button>
              <button type="button" className="rsm-act big" disabled={busy} onClick={() => onAct('secondary')}
                      title="Back in the sidebar, asleep">Unarchive only</button>
            </>
          )}
          <span className="sp" />
          <span className="rsm-meta">{agentKindLabel(it.kind)}{fresh ? ' · not in Charon yet' : ''}</span>
        </div>
      </div>
    </aside>
  );
}
