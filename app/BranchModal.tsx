'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import type { GitBranch } from '@/lib/types/api';
import { gitReasonHint, refreshGit } from './gitStore';

type Props = {
  vpsId: string;
  /** The session's folder — the cache key for the panel behind us. */
  cwd: string;
  /** The checkout being acted on (a cwd can hold several, §14.83). */
  repo: string | null;
  /** For the title: which project this is. */
  label: string;
  onClose: () => void;
};

/**
 * Branch switcher (§14.85).
 *
 * The panel used to show a branch NAME and nothing else — you could see you
 * were on `main`, not what else existed, how far it had drifted, or how to
 * move. This is that missing half.
 *
 * Two numbers per branch, because they answer different questions: drift vs
 * its UPSTREAM (is it in sync with the remote) and drift vs the branch you are
 * ON (what switching would cost you). The second is what makes a branch list a
 * navigation tool instead of a list of names.
 *
 * It FETCHES on open, non-blocking: ahead/behind compare a local ref to its
 * tracking ref, and that ref only moves on a fetch, so on a VPS nobody fetches
 * on the numbers were frozen at clone time — and the pull button, which keys
 * off `behind`, never appeared at all.
 *
 * Portaled to <body> like the other dialogs: `.tool-panel` is a `transform`ed
 * drawer under 1100px, and a transform is the containing block for
 * `position: fixed` (§14.80).
 */
export default function BranchModal({ vpsId, cwd, repo, label, onClose }: Props) {
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [publish, setPublish] = useState(true);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const newRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.getGitBranches(vpsId, cwd, repo);
      if (!alive.current) return;
      if (!r.ok) { setErr(gitReasonHint(r.reason, repo) ?? r.error ?? 'could not list branches'); return; }
      setErr(null);
      setBranches(r.branches);
      setCurrent(r.current ?? null);
      setDetached(!!r.detached);
    } catch (e: unknown) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    }
  }, [vpsId, cwd, repo]);

  const fetchRemote = useCallback(async (silent: boolean) => {
    setFetching(true);
    try {
      const r = await api.gitFetch(vpsId, cwd, repo);
      if (!alive.current) return;
      if (!r.ok && !silent) setNote({ kind: 'err', text: gitReasonHint(r.reason, repo) ?? r.error ?? 'fetch failed' });
      await load();
      refreshGit(vpsId, cwd);
    } catch (e: unknown) {
      if (alive.current && !silent) setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      if (alive.current) setFetching(false);
    }
  }, [vpsId, cwd, repo, load]);

  // Local list first (instant), then the network refresh behind it. A modal
  // that spins for two seconds before showing anything reads as broken.
  useEffect(() => {
    void load().then(() => { void fetchRemote(true); });
  }, [load, fetchRemote]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => { if (creating) newRef.current?.focus(); }, [creating]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = branches ?? [];
    const filtered = needle
      ? list.filter((b) => b.short.toLowerCase().includes(needle) || (b.subject ?? '').toLowerCase().includes(needle))
      : list;
    // Current first, then local, then remote-only — the order you reach for.
    return [...filtered].sort((a, b) =>
      Number(b.current) - Number(a.current)
      || Number(a.remote) - Number(b.remote)
      || (b.committedAt ?? 0) - (a.committedAt ?? 0));
  }, [branches, q]);

  async function run(label2: string, fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>, okText: string) {
    setBusy(label2);
    setNote(null);
    try {
      const r = await fn();
      if (r.ok) {
        setNote({ kind: 'ok', text: okText });
        await load();
        refreshGit(vpsId, cwd);
      } else {
        setNote({ kind: 'err', text: gitReasonHint(r.reason, repo) ?? r.error ?? 'failed' });
      }
      return r;
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      return { ok: false };
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function switchTo(b: GitBranch) {
    if (b.current) return;
    const r = await run(`switch:${b.short}`, () => api.gitCheckout(vpsId, {
      cwd, repo, branch: b.remote ? b.name : b.short,
    }), `switched to ${b.short}`);
    // A refused switch is the interesting case: say WHICH files stood in the
    // way, because "local changes would be overwritten" without the list is
    // the least actionable message git produces.
    const conflicts = (r as { conflicts?: string[] }).conflicts;
    if (!r.ok && conflicts?.length) {
      setNote({
        kind: 'err',
        text: `switching would overwrite local changes:\n${conflicts.slice(0, 8).join('\n')}`
          + (conflicts.length > 8 ? `\n…and ${conflicts.length - 8} more` : '')
          + '\n\nCommit or discard them first — nothing was forced.',
      });
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const r = await run('create', () => api.gitCheckout(vpsId, {
      cwd, repo, branch: name, create: true, push: publish,
    }), publish ? `created and published ${name}` : `created ${name}`);
    if (r.ok) {
      setCreating(false);
      setNewName('');
      const pushed = (r as { pushed?: boolean }).pushed;
      const pushErr = (r as { pushError?: string }).pushError;
      if (publish && !pushed) {
        setNote({ kind: 'err', text: `created ${name}, but publishing failed — ${pushErr ?? 'unknown error'}` });
      }
    }
  }

  function remove(b: GitBranch) {
    if (!confirm(`Delete the branch "${b.short}"?\n\nOnly a branch whose commits live somewhere else can be deleted from here — git refuses the rest, and nothing here forces it.`)) return;
    void run(`del:${b.short}`, () => api.gitDeleteBranch(vpsId, cwd, b.short, repo), `deleted ${b.short}`);
  }

  return createPortal(
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal branches" role="dialog" aria-modal="true" aria-label="Branches">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="bm-head">
          <span className="bm-title">Branches</span>
          <span className="bm-repo" title={repo ?? cwd}>{label}</span>
          <span className="gt-spacer" />
          <button className="gt-mini" disabled={fetching} onClick={() => void fetchRemote(false)}
            title="git fetch --all — refreshes how far ahead/behind every branch is">
            {fetching ? '…' : '↻ fetch'}
          </button>
        </div>

        {detached && (
          <div className="gt-warn">
            HEAD is detached — you are on a commit, not a branch. Switching below reattaches it.
          </div>
        )}

        <div className="bm-tools">
          <input
            ref={searchRef}
            className="bm-search"
            placeholder="filter branches…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
          />
          <button className="gt-mini" onClick={() => setCreating((v) => !v)}>
            {creating ? 'cancel' : '+ new branch'}
          </button>
        </div>

        {creating && (
          <div className="bm-create">
            <input
              ref={newRef}
              className="bm-search"
              placeholder={`new branch from ${current ?? 'HEAD'}…`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
            <label className="bm-publish" title="git push -u origin <branch> right after creating it">
              <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
              <span>publish</span>
            </label>
            <button className="gt-commit-btn primary" disabled={!newName.trim() || busy === 'create'}
              onClick={() => void create()}>
              {busy === 'create' ? '…' : 'create & switch'}
            </button>
          </div>
        )}

        {err && <div className="gt-warn err">{err}</div>}
        {note && <div className={`gt-note ${note.kind}`}>{note.text}</div>}

        {branches === null && !err ? (
          <div className="tp-empty">reading branches…</div>
        ) : shown.length === 0 ? (
          <div className="tp-empty">{q ? `no branch matches « ${q} »` : 'no branches'}</div>
        ) : (
          <ul className="bm-list">
            {shown.map((b) => {
              // Checked out in ANOTHER worktree: git will refuse, so say so
              // here rather than after the click.
              const locked = !!b.worktree && !b.current;
              return (
                <li key={b.name} className={`${b.current ? 'current' : ''}${b.remote ? ' remote' : ''}`}>
                  <button
                    className="bm-pick"
                    disabled={b.current || locked || !!busy}
                    onClick={() => void switchTo(b)}
                    title={locked
                      ? `checked out in another worktree (${b.worktree}) — git will not check it out twice`
                      : b.current ? 'you are here' : `git switch ${b.short}`}
                  >
                    <span className="bm-mark">{b.current ? '●' : b.remote ? '☁' : '○'}</span>
                    <span className="bm-name">{b.short}</span>
                    {b.remote && <span className="bm-tag">remote</span>}
                    {b.gone && <span className="bm-tag gone" title="its upstream was deleted">gone</span>}
                    {locked && <span className="bm-tag" title={b.worktree ?? ''}>worktree</span>}
                    <span className="gt-spacer" />
                    {/* vs the branch you are on — what switching brings. */}
                    {!b.current && (b.aheadHead != null || b.behindHead != null) && (
                      <span className="bm-drift" title="commits this branch has that you don't / that you have and it doesn't">
                        {!!b.aheadHead && <span className="up">+{b.aheadHead}</span>}
                        {!!b.behindHead && <span className="down">−{b.behindHead}</span>}
                        {!b.aheadHead && !b.behindHead && <span className="same">same</span>}
                      </span>
                    )}
                    {/* vs its own upstream — what push/pull would do. */}
                    {(!!b.ahead || !!b.behind) && (
                      <span className="bm-up" title={`${b.ahead} to push / ${b.behind} to pull on ${b.upstream ?? 'its upstream'}`}>
                        {!!b.ahead && <span className="up">↑{b.ahead}</span>}
                        {!!b.behind && <span className="down">↓{b.behind}</span>}
                      </span>
                    )}
                  </button>
                  {!b.current && !b.remote && (
                    <button className="gt-rm" disabled={!!busy} onClick={() => remove(b)}
                      title="delete this branch (refused unless its commits live somewhere else)">✕</button>
                  )}
                  {b.subject && <div className="bm-sub" title={b.subject}>{b.subject}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
