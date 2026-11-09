'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import type { FileSearchResponse, SearchSessionsResult, SessionListItem } from '@/lib/types/api';
import { attentionForRow, rowStatus } from '@/lib/sessionAttention';
import type { ShellListItem } from './Sidebar';
import { IconSearch } from './icons';
import { openTab as openWorkspaceTab } from './tabStore';
import {
  PICKS_STORAGE_KEY, QUERY_PICK_BONUS, basename, dotClassFor, highlightRanges, lastPickedFor, parsePicks,
  pathTail, pickBonus, queryTerms, recencyBonus, recordPick, scoreFields, type Picks,
} from './searchRank';

/** A palette action (HubPanel builds the registry from setters that exist). */
export type SearchAction = { id: string; label: string; keywords?: string; run: () => void };

type Props = {
  onClose: () => void;
  /** Open a session (a session row, or a message hit); `pin` = Ctrl/Cmd+Enter. */
  onPick: (sessionId: string, pin: boolean) => void;
  onOpenShell: (shellId: string, pin: boolean) => void;
  /** A project row: focus its tab group, else start a session there. */
  onOpenProject: (vpsId: string, path: string) => void;
  sessions: SessionListItem[];
  shells: ShellListItem[];
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  actions: SearchAction[];
};

const CAP = { sessions: 8, projects: 5, files: 10, messages: 8, shells: 5, actions: 6 } as const;
const DEBOUNCE_MS = 120;

type FileHit = FileSearchResponse['files'][number];
type Data =
  | { t: 'session'; s: SessionListItem; parent: string | null }
  | { t: 'project'; vpsId: string; vpsName: string; path: string; label: string | null }
  | { t: 'file'; f: FileHit }
  | { t: 'message'; sessionId: string; name: string; vpsName: string | null; snippet: string; hits: number }
  | { t: 'shell'; sh: ShellListItem }
  | { t: 'action'; a: SearchAction };
type Item = { key: string; pick: string | null; section: string; data: Data; run: (pin: boolean) => void };
type Section = { id: string; title: string; items: Item[]; note?: string };

function Hl({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  const ranges = highlightRanges(text, terms);
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function sessionTitle(s: SessionListItem): string {
  if (s.name) return s.name;
  const first = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  return first ? first.slice(0, 60) : pathTail(s.cwd);
}

const lc = (v: string | null | undefined, max = 400) => (v ?? '').slice(0, max).toLowerCase();

export default function SearchModal({
  onClose, onPick, onOpenShell, onOpenProject, sessions, shells, vpsList, vpsPaths, actions,
}: Props) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [picks, setPicks] = useState<Picks>(() => {
    try { return parsePicks(localStorage.getItem(PICKS_STORAGE_KEY)); } catch { return parsePicks(null); }
  });
  const [files, setFiles] = useState<FileSearchResponse | null>(null);
  const [msgs, setMsgs] = useState<SearchSessionsResult[] | null>(null);
  const [filesBusy, setFilesBusy] = useState(false);
  const [msgsBusy, setMsgsBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const qTrim = q.trim();
  const actionsOnly = qTrim.startsWith('>');
  const terms = useMemo(() => queryTerms(actionsOnly ? qTrim.slice(1) : qTrim), [qTrim, actionsOnly]);
  const remote = !actionsOnly && qTrim.length >= 2;

  // ── Async sections: debounce, abort, stale guard; the previous list stays
  // visible while the next one loads. ──
  useEffect(() => {
    if (!remote) { setFiles(null); setFilesBusy(false); return; }
    let stale = false;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setFilesBusy(true);
      api.searchFiles(qTrim, ac.signal)
        .then((r) => { if (!stale) setFiles(r); })
        .catch(() => {})
        .finally(() => { if (!stale) setFilesBusy(false); });
    }, DEBOUNCE_MS);
    return () => { stale = true; clearTimeout(t); ac.abort(); };
  }, [qTrim, remote]);
  useEffect(() => {
    if (!remote) { setMsgs(null); setMsgsBusy(false); return; }
    let stale = false;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setMsgsBusy(true);
      api.searchSessions(qTrim, ac.signal)
        .then((r) => { if (!stale) setMsgs(r.results ?? []); })
        .catch(() => {})
        .finally(() => { if (!stale) setMsgsBusy(false); });
    }, DEBOUNCE_MS);
    return () => { stale = true; clearTimeout(t); ac.abort(); };
  }, [qTrim, remote]);

  // ── Haystacks: lower-cased once per list, never per keystroke. ──
  const vpsName = useMemo(() => new Map(vpsList.map((v) => [v.id, v.name] as const)), [vpsList]);
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions]);
  const sessionHay = useMemo(() => sessions.filter((s) => !s.archived).map((s) => {
    const vn = vpsName.get(s.vpsId) ?? '';
    return {
      s,
      f: [lc(s.name), s.handle ? `@${s.handle.toLowerCase()}` : '', lc(s.cwd), lc(vn), lc(s.kind), lc(s.model), lc(s.firstUserMessage)],
    };
  }), [sessions, vpsName]);
  const projectHay = useMemo(() => {
    const m = new Map<string, { vpsId: string; vpsName: string; path: string; label: string | null; lastMs: number }>();
    for (const p of vpsPaths) {
      m.set(`${p.vpsId}\0${p.path}`, { vpsId: p.vpsId, vpsName: vpsName.get(p.vpsId) ?? p.vpsId, path: p.path, label: p.label, lastMs: 0 });
    }
    for (const s of sessions) {
      if (s.archived || !s.cwd) continue;
      const key = `${s.vpsId}\0${s.cwd}`;
      const last = s.lastActivityMs ?? (s.lastUsedAt ?? s.createdAt) * 1000;
      const cur = m.get(key);
      if (cur) cur.lastMs = Math.max(cur.lastMs, last);
      else m.set(key, { vpsId: s.vpsId, vpsName: vpsName.get(s.vpsId) ?? s.vpsId, path: s.cwd, label: null, lastMs: last });
    }
    return [...m.values()].map((p) => ({ p, f: [lc(p.label), lc(basename(p.path)), lc(p.path), lc(p.vpsName)] }));
  }, [vpsPaths, sessions, vpsName]);
  const shellHay = useMemo(() => shells.filter((x) => !x.exited).map((sh) => ({
    sh, f: [lc(sh.name), lc(sh.cwd), lc(sh.vpsName)],
  })), [shells]);
  const actionHay = useMemo(() => actions.map((a) => ({ a, f: [lc(a.label), lc(a.keywords)] })), [actions]);

  const sections = useMemo<Section[]>(() => {
    const now = Date.now();
    const bonus = (pick: string | null, favored: string | null) =>
      pick ? pickBonus(picks, pick, now) + (pick === favored ? QUERY_PICK_BONUS : 0) : 0;
    const favored = lastPickedFor(picks, qTrim);
    const out: Section[] = [];
    const take = <T,>(rows: Array<{ v: T; score: number }>, n: number) =>
      rows.sort((a, b) => b.score - a.score).slice(0, n).map((r) => r.v);

    const actionItems = (list: typeof actionHay, n: number): Item[] => {
      const rows: Array<{ v: Item; score: number }> = [];
      for (const { a, f } of list) {
        const sc = scoreFields(f, terms, 1);
        if (sc == null) continue;
        const pick = `action:${a.id}`;
        rows.push({ v: { key: pick, pick, section: 'actions', data: { t: 'action', a }, run: () => a.run() }, score: sc + bonus(pick, favored) });
      }
      return take(rows, n);
    };
    if (actionsOnly) {
      const items = actionItems(actionHay, 40);
      return items.length ? [{ id: 'actions', title: 'Actions', items }] : [];
    }

    const sessRows: Array<{ v: Item; score: number }> = [];
    for (const { s, f } of sessionHay) {
      const sc = scoreFields(f, terms, 2);
      if (sc == null) continue;
      const pick = `session:${s.id}`;
      const parent = s.parentSessionId ? sessionById.get(s.parentSessionId) : undefined;
      sessRows.push({
        v: {
          key: pick, pick, section: 'sessions',
          data: { t: 'session', s, parent: parent ? (parent.handle ? `@${parent.handle}` : sessionTitle(parent)) : null },
          run: (pin) => onPick(s.id, pin),
        },
        score: sc + recencyBonus(s.lastActivityMs, now) + bonus(pick, favored),
      });
    }
    const sessItems = take(sessRows, CAP.sessions);
    if (sessItems.length) out.push({ id: 'sessions', title: terms.length ? 'Sessions' : 'Recent sessions', items: sessItems });
    if (!terms.length) {
      const acts = actionItems(actionHay, CAP.actions + 2);
      if (acts.length) out.push({ id: 'actions', title: 'Actions', items: acts });
      return out;
    }

    const projRows: Array<{ v: Item; score: number }> = [];
    for (const { p, f } of projectHay) {
      const sc = scoreFields(f, terms, 2);
      if (sc == null) continue;
      const pick = `project:${p.vpsId}:${p.path}`;
      projRows.push({
        v: { key: pick, pick, section: 'projects', data: { t: 'project', vpsId: p.vpsId, vpsName: p.vpsName, path: p.path, label: p.label }, run: () => onOpenProject(p.vpsId, p.path) },
        score: sc + recencyBonus(p.lastMs, now) + bonus(pick, favored),
      });
    }
    const projItems = take(projRows, CAP.projects);
    if (projItems.length) out.push({ id: 'projects', title: 'Projects', items: projItems });

    if (files) {
      const rows: Array<{ v: Item; score: number }> = [];
      files.files.forEach((f, i) => {
        // The list may describe an earlier keystroke: keep only what still matches.
        const sc = scoreFields([lc(basename(f.path)), lc(f.path)], terms, 1);
        if (sc == null) return;
        const pick = `file:${f.vpsId}:${f.root}:${f.path}`;
        rows.push({
          v: {
            key: pick, pick, section: 'files', data: { t: 'file', f },
            run: (pin) => { void openWorkspaceTab({ vpsId: f.vpsId, path: f.root, kind: 'file', ref: f.path, pin }); },
          },
          score: sc - i * 0.01 + bonus(pick, favored),
        });
      });
      const items = take(rows, CAP.files);
      const note = files.rootsSkipped > 0 || files.truncated ? 'some projects were not fully searched' : undefined;
      if (items.length || note) out.push({ id: 'files', title: 'Files', items, note: items.length ? note : undefined });
    }

    if (msgs?.length) {
      const bySession = new Map<string, Data & { t: 'message'; prose: boolean }>();
      for (const r of msgs) {
        // The snippet a human reads is prose: a user/assistant hit replaces a
        // tool row's JSON as the session's snippet (rank order kept otherwise).
        const prose = r.role === 'user' || r.role === 'assistant';
        const cur = bySession.get(r.sessionId);
        if (cur) {
          cur.hits++;
          if (prose && !cur.prose) { cur.snippet = r.snippet; cur.prose = true; }
          continue;
        }
        bySession.set(r.sessionId, {
          t: 'message', sessionId: r.sessionId,
          name: r.session?.name ?? pathTail(r.session?.cwd ?? r.sessionId.slice(0, 8)),
          vpsName: r.session?.vpsName ?? null, snippet: r.snippet, hits: 1, prose,
        });
      }
      const items: Item[] = [...bySession.values()].slice(0, CAP.messages).map((d) => ({
        key: `message:${d.sessionId}`, pick: null, section: 'messages', data: d, run: (pin) => onPick(d.sessionId, pin),
      }));
      out.push({ id: 'messages', title: 'Messages', items });
    }

    const shellRows: Array<{ v: Item; score: number }> = [];
    for (const { sh, f } of shellHay) {
      const sc = scoreFields(f, terms, 1);
      if (sc == null) continue;
      const pick = `shell:${sh.id}`;
      shellRows.push({
        v: { key: pick, pick, section: 'shells', data: { t: 'shell', sh }, run: (pin) => onOpenShell(sh.id, pin) },
        score: sc + recencyBonus(sh.lastActivityMs, now) + bonus(pick, favored),
      });
    }
    const shellItems = take(shellRows, CAP.shells);
    if (shellItems.length) out.push({ id: 'shells', title: 'Shells', items: shellItems });

    const acts = actionItems(actionHay, CAP.actions);
    if (acts.length) out.push({ id: 'actions', title: 'Actions', items: acts });
    return out;
  }, [terms, qTrim, actionsOnly, picks, sessionHay, projectHay, shellHay, actionHay, sessionById, files, msgs, onPick, onOpenShell, onOpenProject]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const selIdx = flat.length ? Math.min(sel, flat.length - 1) : 0;

  const choose = useCallback((it: Item, pin: boolean) => {
    if (it.pick) {
      const next = recordPick(picks, it.pick, qTrim, Date.now());
      try { localStorage.setItem(PICKS_STORAGE_KEY, JSON.stringify(next)); } catch {}
    }
    onClose();
    it.run(pin);
  }, [picks, qTrim, onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selIdx}"]`);
    if (selIdx === 0) listRef.current?.scrollTo({ top: 0 });
    el?.scrollIntoView({ block: 'nearest' });
  }, [selIdx, sections]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault(); if (n) setSel((selIdx + 1) % n);
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault(); if (n) setSel((selIdx - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = flat[selIdx];
      if (it) choose(it, e.ctrlKey || e.metaKey);
    }
  };

  const busy = filesBusy || msgsBusy;
  let idx = -1;
  return (
    <div className="app-modal-bg sp-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-modal search sp" role="dialog" aria-label="search" onKeyDown={onKeyDown}>
        <div className="sp-field">
          <IconSearch />
          <input
            autoFocus
            className="sp-input"
            placeholder="sessions, projects, files, messages…  (> for actions)"
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="sp-list"
          />
          {busy && <span className="sp-busy">searching…</span>}
          <button type="button" className="sp-close" aria-label="close search" onClick={onClose}>✕</button>
        </div>
        <div className="sp-list" id="sp-list" role="listbox" ref={listRef}>
          {sections.map((sec) => (
            <Fragment key={sec.id}>
              <div className="sp-sec">{sec.title}</div>
              {sec.items.map((it) => {
                idx++;
                const i = idx;
                return (
                  <div
                    key={it.key}
                    data-idx={i}
                    role="option"
                    aria-selected={i === selIdx}
                    className={`sp-row${i === selIdx ? ' sel' : ''}`}
                    onMouseMove={() => { if (i !== selIdx) setSel(i); }}
                    onClick={(e) => choose(it, e.ctrlKey || e.metaKey)}
                  >
                    <RowView d={it.data} terms={terms} vpsName={vpsName} />
                  </div>
                );
              })}
              {sec.note && <div className="sp-note">{sec.note}</div>}
            </Fragment>
          ))}
          {flat.length === 0 && qTrim && !busy && <div className="sp-empty">no results</div>}
        </div>
        <div className="sp-foot">
          <span>↑↓ move</span><span>↵ open</span><span>Ctrl/⌘ ↵ pin</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}

function RowView({ d, terms, vpsName }: { d: Data; terms: readonly string[]; vpsName: Map<string, string> }) {
  switch (d.t) {
    case 'session': {
      const s = d.s;
      const att = attentionForRow(s);
      const vn = vpsName.get(s.vpsId);
      return (
        <>
          <span className={`sp-dot ${dotClassFor(rowStatus(s), att)}`} />
          <span className="sp-main">
            <span className="sp-line">
              <span className="sp-title"><Hl text={sessionTitle(s)} terms={terms} /></span>
              {s.handle && <span className="sp-handle"><Hl text={`@${s.handle}`} terms={terms} /></span>}
              {d.parent && <span className="sp-parent">↳ {d.parent}</span>}
            </span>
            <span className="sp-sub">{vn ? `${vn} · ` : ''}{pathTail(s.cwd)}</span>
          </span>
        </>
      );
    }
    case 'project':
      return (
        <>
          <span className="sp-ico">▸</span>
          <span className="sp-main">
            <span className="sp-line"><span className="sp-title"><Hl text={d.label || basename(d.path)} terms={terms} /></span></span>
            <span className="sp-sub">{d.vpsName} · <Hl text={d.path} terms={terms} /></span>
          </span>
        </>
      );
    case 'file': {
      const base = basename(d.f.path);
      const dir = d.f.path.slice(0, d.f.path.length - base.length).replace(/\/$/, '');
      return (
        <>
          <span className="sp-ico">≡</span>
          <span className="sp-main">
            <span className="sp-line">
              <span className="sp-title"><Hl text={base} terms={terms} /></span>
              {dir && <span className="sp-sub"><Hl text={dir} terms={terms} /></span>}
            </span>
          </span>
          <span className="sp-tag">{d.f.vpsName}</span>
        </>
      );
    }
    case 'message':
      return (
        <>
          <span className="sp-ico">“</span>
          <span className="sp-main">
            <span className="sp-line">
              <span className="sp-title">{d.name}</span>
              {d.vpsName && <span className="sp-sub">{d.vpsName}</span>}
            </span>
            <span className="sp-snip"><Hl text={d.snippet} terms={terms} /></span>
          </span>
          {d.hits > 1 && <span className="sp-tag">{d.hits} hits</span>}
        </>
      );
    case 'shell': {
      const sh = d.sh;
      return (
        <>
          <span className="sp-ico">$</span>
          <span className="sp-main">
            <span className="sp-line"><span className="sp-title"><Hl text={sh.name || (sh.cwd ? basename(sh.cwd) : 'shell')} terms={terms} /></span></span>
            <span className="sp-sub">{sh.vpsName}{sh.cwd ? ` · ${sh.cwd}` : ''}</span>
          </span>
        </>
      );
    }
    case 'action':
      return (
        <>
          <span className="sp-ico">⌘</span>
          <span className="sp-main"><span className="sp-line"><span className="sp-title"><Hl text={d.a.label} terms={terms} /></span></span></span>
        </>
      );
  }
}
