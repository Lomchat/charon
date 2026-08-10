'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { GitFileEntry } from '@/lib/types/api';
import DiffViewerModal from './DiffViewerModal';
import { fileStatusLabel, gitReasonHint, refreshGit, useGitStatus } from './gitStore';
import { IconSparkle } from './icons';
import { IconExternal } from './fileIcons';

type Props = {
  vpsId: string | null;
  cwd: string | null;
  /** Set when a session is mid-turn in this repo — a warning, never a block. */
  busy?: boolean;
};

/**
 * Source control for the repo containing the session's cwd.
 *
 * This panel is a CONTROL SURFACE, not a reader: 340px is enough for a file
 * list, checkboxes and a message box, and clicking a file opens the
 * full-screen reader instead of trying to show a patch in a column.
 *
 * There is deliberately no staging area. The checkboxes are a path selection
 * passed straight to `commit -- <paths>`; partial-hunk staging is a rabbit
 * hole, and an index left half-populated between sessions is a trap on a
 * working tree that several agents write to. For the same reason nothing is
 * selected by default — on these VPSes the dirty files are frequently another
 * session's in-flight work, and a pre-ticked "everything" is how you commit it
 * by accident.
 */
export default function GitTab({ vpsId, cwd, busy }: Props) {
  const { status, loading, error } = useGitStatus(vpsId, cwd);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const msgRef = useRef<HTMLTextAreaElement | null>(null);

  const files: GitFileEntry[] = useMemo(() => status?.files ?? [], [status]);
  const paths = useMemo(() => files.map((f) => f.path), [files]);

  // Prune a selection whose files have gone (committed elsewhere, discarded,
  // or reverted by an agent) — otherwise the commit would fail on a pathspec
  // that no longer matches anything.
  useEffect(() => {
    setSelected((cur) => {
      if (cur.size === 0) return cur;
      const live = new Set(paths);
      let changed = false;
      const next = new Set<string>();
      for (const p of cur) { if (live.has(p)) next.add(p); else changed = true; }
      return changed ? next : cur;
    });
  }, [paths]);

  const allSelected = files.length > 0 && selected.size === files.length;
  const toggle = (p: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(paths));

  const run = useCallback(async (label: string, fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>, okText: string) => {
    if (!vpsId || !cwd) return;
    setWorking(label);
    setNote(null);
    try {
      const r = await fn();
      if (r.ok) setNote({ kind: 'ok', text: okText });
      else setNote({ kind: 'err', text: gitReasonHint(r.reason, status?.root) ?? r.error ?? 'failed' });
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setWorking(null);
      refreshGit(vpsId, cwd);
    }
  }, [vpsId, cwd, status?.root]);

  async function doCommit(push: boolean) {
    if (!vpsId || !cwd) return;
    if (busy && !confirm('A session is working in this repo right now.\n\nCommit anyway?')) return;
    setWorking(push ? 'push' : 'commit');
    setNote(null);
    try {
      // `all` rather than 1500 paths: the agent's RPC socket caps one inbound
      // line at 64 KiB (§14.73), and it says what the user meant anyway.
      const sel = allSelected ? { all: true } : { paths: [...selected] };
      const r = await api.gitCommit(vpsId, { cwd, message: message.trim(), push, ...sel });
      if (!r.ok) {
        setNote({ kind: 'err', text: gitReasonHint(r.reason, status?.root) ?? r.error ?? 'commit failed' });
      } else {
        // The commit landed even if the push didn't — say so precisely, or the
        // user commits again.
        setMessage('');
        setSelected(new Set());
        setNote(push && !r.pushed
          ? { kind: 'err', text: `committed ${r.sha ?? ''} but the push failed — ${gitReasonHint(r.pushReason, status?.root) ?? r.pushError ?? 'unknown error'}` }
          : { kind: 'ok', text: `committed ${r.sha ?? ''}${r.pushed ? ' and pushed' : ''}` });
      }
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setWorking(null);
      refreshGit(vpsId, cwd);
    }
  }

  async function draftMessage() {
    if (!vpsId || !cwd || selected.size === 0) return;
    setWorking('draft');
    setNote(null);
    try {
      const sel = allSelected ? { all: true } : { paths: [...selected] };
      const r = await api.gitMessage(vpsId, cwd, sel);
      if (r.ok && r.message) { setMessage(r.message); msgRef.current?.focus(); }
      else setNote({ kind: 'err', text: r.error ?? 'could not draft a message' });
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setWorking(null); }
  }

  function discard(f: GitFileEntry) {
    if (!vpsId || !cwd) return;
    const what = f.untracked ? `delete the untracked file "${f.path}"` : `restore "${f.path}" to HEAD`;
    if (!confirm(`This will ${what}.\n\nLocal changes to it are lost — and an agent may be writing to this repo right now. Continue?`)) return;
    void run('discard', () => api.gitDiscard(vpsId, cwd, [f.path]), 'discarded');
  }

  if (!vpsId || !cwd) return <div className="tp-empty">no repository for this session</div>;

  // Not a repo: say nothing loud. A plain folder is a perfectly normal cwd and
  // must not look like a failure.
  if (status && status.ok && !status.isRepo) {
    return <div className="tp-empty">this folder is not a git repository</div>;
  }
  if (!status && loading) return <div className="tp-empty">reading git status…</div>;
  if (status && !status.ok) {
    const hint = gitReasonHint(status.reason, status.root);
    return (
      <div className="tp-empty">
        {hint ?? status.error ?? 'git is unavailable on this VPS'}
        <br />
        <button className="gt-retry" onClick={() => refreshGit(vpsId, cwd)}>↻ retry</button>
      </div>
    );
  }
  if (!status) return <div className="tp-empty">{error ?? 'no git data'}</div>;

  const canCommit = selected.size > 0 && message.trim().length > 0 && !working;

  return (
    <div className="git-tab">
      <div className="gt-branch">
        <span className="gt-ref" title={status.root ?? ''}>
          ⎇ {status.detached ? `detached @ ${status.head ?? '?'}` : (status.branch ?? '(no branch)')}
        </span>
        {!!status.ahead && <span className="gt-ab up" title={`${status.ahead} commit(s) to push`}>↑{status.ahead}</span>}
        {!!status.behind && <span className="gt-ab down" title={`${status.behind} commit(s) to pull`}>↓{status.behind}</span>}
        <span className="gt-spacer" />
        {status.remoteWebUrl && (
          <a className="gt-mini gt-remote" href={status.remoteWebUrl} target="_blank" rel="noopener noreferrer"
             title={`open on ${status.remoteWebUrl.replace(/^https:\/\//, '').split('/')[0]}`}>
            <IconExternal className="gt-ext" />
          </a>
        )}
        {(!!status.ahead || !!status.behind) && (
          <>
            {!!status.behind && (
              <button className="gt-mini" disabled={!!working}
                onClick={() => run('pull', () => api.gitPull(vpsId, cwd), 'pulled')}
                title="git pull --rebase --autostash">pull</button>
            )}
            {!!status.ahead && (
              <button className="gt-mini" disabled={!!working}
                onClick={() => run('push', () => api.gitPush(vpsId, cwd), 'pushed')}
                title="git push">push</button>
            )}
          </>
        )}
        <button className="gt-mini" onClick={() => refreshGit(vpsId, cwd)}
          disabled={loading} title="refresh">{loading ? '…' : '↻'}</button>
      </div>

      {busy && <div className="gt-warn">a session is writing in this repo right now</div>}
      {!!status.conflicts && <div className="gt-warn err">{status.conflicts} file(s) in conflict — resolve them before committing</div>}
      {status.truncated && <div className="gt-warn">showing the first {files.length} of {status.fileCount} changed files</div>}

      {files.length === 0 ? (
        <div className="tp-empty">working tree clean</div>
      ) : (
        <>
          <div className="gt-listhead">
            <label className="gt-all">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span>{selected.size > 0 ? `${selected.size} selected` : `${files.length} changed`}</span>
            </label>
            <span className="gt-stats">
              <span className="add">+{status.added ?? 0}</span>
              <span className="del">−{status.deleted ?? 0}</span>
            </span>
          </div>

          <ul className="gt-files">
            {files.map((f) => {
              const st = fileStatusLabel(f.status);
              return (
                <li key={f.path} className={selected.has(f.path) ? 'on' : ''}>
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggle(f.path)}
                    title="include in the commit"
                  />
                  <button className="gt-open" onClick={() => setOpenPath(f.path)} title={`${st.label} · ${f.path}\nclick to read the diff`}>
                    <span className={`gt-st ${st.cls}`}>{f.status}</span>
                    <span className="gt-path">{f.path}</span>
                    {(f.added != null || f.deleted != null) && (
                      <span className="gt-num">
                        {f.added != null && <span className="add">+{f.added}</span>}
                        {f.deleted != null && <span className="del">−{f.deleted}</span>}
                      </span>
                    )}
                    {f.binary && <span className="gt-num bin">bin</span>}
                  </button>
                  <button className="gt-rm" onClick={() => discard(f)} disabled={!!working} title="discard changes to this file">✕</button>
                </li>
              );
            })}
          </ul>

          <div className="gt-commit">
            <textarea
              ref={msgRef}
              className="gt-msg"
              placeholder={selected.size === 0 ? 'select files to commit…' : 'commit message…'}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              disabled={selected.size === 0}
            />
            <div className="gt-actions">
              <button
                className="gt-draft"
                onClick={draftMessage}
                disabled={selected.size === 0 || !!working}
                title="draft a commit message from the selected diff"
              >{working === 'draft' ? '…' : <><IconSparkle className="gt-sparkle" /> draft</>}</button>
              <span className="gt-spacer" />
              <button className="gt-commit-btn" onClick={() => doCommit(false)} disabled={!canCommit}>
                {working === 'commit' ? '…' : 'commit'}
              </button>
              <button className="gt-commit-btn primary" onClick={() => doCommit(true)} disabled={!canCommit}>
                {working === 'push' ? '…' : 'commit & push'}
              </button>
            </div>
          </div>
        </>
      )}

      {note && <div className={`gt-note ${note.kind}`}>{note.text}</div>}

      {openPath && (
        <DiffViewerModal
          vpsId={vpsId}
          cwd={cwd}
          root={status.root}
          files={files}
          initialPath={openPath}
          onClose={() => setOpenPath(null)}
        />
      )}
    </div>
  );
}
