'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { AgentKind, GitFileEntry, GitStatusResponse } from '@/lib/types/api';
import DiffViewerModal from './DiffViewerModal';
import BranchModal from './BranchModal';
import HistoryModal from './HistoryModal';
import ReviewModal from './ReviewModal';
import { fileStatusLabel, gitReasonHint, refreshGit, useGitStatus, workspaceDirtyCount } from './gitStore';
import { IconSparkle } from './icons';
import { IconExternal } from './fileIcons';

type Props = {
  sessionId?: string | null;
  kind?: AgentKind;
  vpsId: string | null;
  cwd: string | null;
  /** Set when a session is mid-turn in this folder — a warning, never a block. */
  busy?: boolean;
};

/**
 * Source control for everything a session can see.
 *
 * Usually that is one checkout. But a session is just as often opened on a
 * folder OF projects (`/srv`, `/var/www/html`), and `--show-toplevel` only
 * walks up, so that case used to render "not a git repository" with ten repos
 * underneath it. The panel now shows one section per checkout (§14.83); with a
 * single repo it collapses to exactly what it always was.
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
export default function GitTab({ sessionId = null, kind = 'claude', vpsId, cwd, busy }: Props) {
  const { workspace, loading, error } = useGitStatus(vpsId, cwd);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // EXPLICIT fold choices, by repo root — a Map rather than a Set because the
  // default is computed (clean repos start folded, see below) and "the user
  // opened this one" has to outrank it. Browser-side: which project you are
  // working in today is not a thing to sync to your phone.
  const [folds, setFolds] = useState<Map<string, boolean>>(() => new Map());
  const toggle = (root: string, isCollapsed: boolean) => setFolds((cur) => {
    const next = new Map(cur);
    next.set(root, !isCollapsed);
    return next;
  });

  const doReview = useCallback(async (target: Record<string, unknown>) => {
    if (!sessionId || reviewing || busy) return;
    setReviewing(true);
    setReviewError(null);
    try {
      const response = await fetch(`/api/claude/sessions/${sessionId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, delivery: 'inline' }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || 'review failed');
      setReviewOpen(false);
    } catch (error: unknown) {
      setReviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewing(false);
    }
  }, [sessionId, reviewing, busy]);

  if (!vpsId || !cwd) return <div className="tp-empty">no repository for this session</div>;

  if (!workspace && loading) return <div className="tp-empty">reading git status…</div>;
  if (workspace && !workspace.ok) {
    const hint = gitReasonHint(workspace.reason);
    return (
      <div className="tp-empty">
        {hint ?? workspace.error ?? 'git is unavailable on this VPS'}
        <br />
        <button className="gt-retry" onClick={() => refreshGit(vpsId, cwd)}>↻ retry</button>
      </div>
    );
  }
  if (!workspace) return <div className="tp-empty">{error ?? 'no git data'}</div>;

  // No checkout at or below the cwd. Say nothing loud: a plain folder is a
  // perfectly normal place to work and must not look like a failure.
  if (workspace.mode === 'none' || workspace.repos.length === 0) {
    return (
      <div className="tp-empty">
        no git repository in this folder
        <br />
        <button className="gt-retry" onClick={() => refreshGit(vpsId, cwd)}>↻ rescan</button>
      </div>
    );
  }

  const multi = workspace.mode === 'multi';
  const total = workspaceDirtyCount(workspace);

  return (
    <div className={`git-tab${multi ? ' multi' : ''}`}>
      {kind === 'codex' && sessionId && (
        <div className="gt-reviewbar">
          <span>Review this working tree with Codex</span>
          <button type="button" onClick={() => { setReviewError(null); setReviewOpen(true); }}
            disabled={reviewing || busy} title="Run Codex code review">
            <IconSparkle className="gt-sparkle" /> {reviewing ? 'starting…' : 'review'}
          </button>
        </div>
      )}
      {multi && (
        <div className="gt-wshead">
          <span className="gt-wscount">
            {workspace.repos.length} repositor{workspace.repos.length > 1 ? 'ies' : 'y'}
          </span>
          {total > 0 && <span className="gt-wsdirty">{total} changed</span>}
          <span className="gt-spacer" />
          <button className="gt-mini" onClick={() => refreshGit(vpsId, cwd)}
            disabled={loading} title="rescan this folder for repositories">{loading ? '…' : '↻'}</button>
        </div>
      )}
      {multi && workspace.truncated && (
        <div className="gt-warn">
          the scan stopped at its limit — some repositories under this folder may be missing
        </div>
      )}

      {workspace.repos.map((repo) => {
        const root = repo.root ?? '';
        // A clean checkout among eight is a header, not a panel: fold it by
        // default so the column shows where the work actually is. Anything
        // dirty stays open, and an explicit click always wins.
        const dirty = repo.fileCount ?? repo.files.length;
        const collapsed = folds.get(root) ?? (multi && dirty === 0 && repo.ok);
        return (
          <RepoPanel
            key={root || repo.name}
            vpsId={vpsId}
            cwd={cwd}
            repo={repo}
            busy={busy}
            multi={multi}
            loading={loading}
            collapsed={collapsed}
            onToggle={() => toggle(root, collapsed)}
          />
        );
      })}
      {reviewOpen && (
        <ReviewModal busy={reviewing} error={reviewError}
          onConfirm={(target) => { void doReview(target); }}
          onClose={() => { if (!reviewing) setReviewOpen(false); }} />
      )}
    </div>
  );
}

/**
 * One checkout: its branch row, its files, its commit box.
 *
 * A component rather than a loop body because every piece of state here is
 * PER REPO — the selection, the message, the in-flight action, the note. Two
 * projects being committed in one panel must not share a message box, and a
 * failed push in one must not paint an error over the other.
 */
function RepoPanel({
  vpsId, cwd, repo, busy, multi, loading, collapsed, onToggle,
}: {
  vpsId: string;
  cwd: string;
  repo: GitStatusResponse;
  busy?: boolean;
  multi: boolean;
  loading: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const msgRef = useRef<HTMLTextAreaElement | null>(null);
  // The repo this section acts on. `cwd` stays the cache key (one workspace,
  // one poll) while `root` is the git target — see §14.83.
  const root = repo.root ?? null;

  const files: GitFileEntry[] = useMemo(() => repo.files ?? [], [repo]);
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
  const toggleOne = (p: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(paths));

  const run = useCallback(async (
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>,
    okText: string,
  ) => {
    setWorking(label);
    setNote(null);
    try {
      const r = await fn();
      if (r.ok) setNote({ kind: 'ok', text: okText });
      else setNote({ kind: 'err', text: gitReasonHint(r.reason, root) ?? r.error ?? 'failed' });
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setWorking(null);
      refreshGit(vpsId, cwd);
    }
  }, [vpsId, cwd, root]);

  async function doCommit(push: boolean) {
    if (busy && !confirm('A session is working in this folder right now.\n\nCommit anyway?')) return;
    setWorking(push ? 'push' : 'commit');
    setNote(null);
    try {
      // `all` rather than 1500 paths: the agent's RPC socket caps one inbound
      // line at 64 KiB (§14.73), and it says what the user meant anyway.
      const sel = allSelected ? { all: true } : { paths: [...selected] };
      const r = await api.gitCommit(vpsId, { cwd, repo: root, message: message.trim(), push, ...sel });
      if (!r.ok) {
        setNote({ kind: 'err', text: gitReasonHint(r.reason, root) ?? r.error ?? 'commit failed' });
      } else {
        // The commit landed even if the push didn't — say so precisely, or the
        // user commits again.
        setMessage('');
        setSelected(new Set());
        setNote(push && !r.pushed
          ? { kind: 'err', text: `committed ${r.sha ?? ''} but the push failed — ${gitReasonHint(r.pushReason, root) ?? r.pushError ?? 'unknown error'}` }
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
    if (selected.size === 0) return;
    setWorking('draft');
    setNote(null);
    try {
      const sel = allSelected ? { all: true } : { paths: [...selected] };
      const r = await api.gitMessage(vpsId, cwd, sel, root);
      if (r.ok && r.message) { setMessage(r.message); msgRef.current?.focus(); }
      else setNote({ kind: 'err', text: r.error ?? 'could not draft a message' });
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setWorking(null); }
  }

  function discard(f: GitFileEntry) {
    const what = f.untracked ? `delete the untracked file "${f.path}"` : `restore "${f.path}" to HEAD`;
    if (!confirm(`This will ${what}.\n\nLocal changes to it are lost — and an agent may be writing to this repo right now. Continue?`)) return;
    void run('discard', () => api.gitDiscard(vpsId, cwd, [f.path], root), 'discarded');
  }

  // A checkout that git itself refused to read (dubious ownership is the
  // common one). Its own section says why, so the other repos keep working.
  if (!repo.ok || !repo.isRepo) {
    return (
      <section className="gt-repo broken">
        <div className="gt-repohead"><span className="gt-reponame">{repo.rel || repo.name}</span></div>
        <div className="gt-warn err">{gitReasonHint(repo.reason, root) ?? repo.error ?? 'git could not read this repository'}</div>
      </section>
    );
  }

  const canCommit = selected.size > 0 && message.trim().length > 0 && !working;
  const dirty = repo.fileCount ?? files.length;

  return (
    <section className={`gt-repo${multi ? ' sectioned' : ''}${collapsed ? ' collapsed' : ''}`}>
      {multi && (
        // The header doubles as the fold control: with eight projects open you
        // want the two you are working in, not a wall of file lists.
        <button type="button" className="gt-repohead" onClick={onToggle} title={repo.root ?? ''}>
          <span className="gt-caret">{collapsed ? '▸' : '▾'}</span>
          <span className="gt-reponame">{repo.rel || repo.name}</span>
          <span
            className="gt-repobranch as-button"
            role="button"
            tabIndex={0}
            title="switch or create a branch"
            onClick={(e) => { e.stopPropagation(); setBranchesOpen(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setBranchesOpen(true); } }}
          >{repo.detached ? (repo.head ?? 'detached') : (repo.branch ?? '?')}</span>
          <span className="gt-spacer" />
          {dirty > 0 && <span className="gt-repodirty">{dirty}</span>}
          {!!repo.ahead && <span className="gt-ab up">↑{repo.ahead}</span>}
          {!!repo.behind && <span className="gt-ab down">↓{repo.behind}</span>}
        </button>
      )}

      {!collapsed && (
        <>
          <div className="gt-branch">
            {!multi && (
              // The branch name is the door to the branch list: switching is
              // the thing you want from a panel that shows you a branch name.
              <button className="gt-ref as-button" onClick={() => setBranchesOpen(true)}
                title={`${repo.root ?? ''}\nswitch or create a branch`}>
                ⎇ {repo.detached ? `detached @ ${repo.head ?? '?'}` : (repo.branch ?? '(no branch)')}
              </button>
            )}
            {!multi && !!repo.ahead && <span className="gt-ab up" title={`${repo.ahead} commit(s) to push`}>↑{repo.ahead}</span>}
            {!multi && !!repo.behind && <span className="gt-ab down" title={`${repo.behind} commit(s) to pull`}>↓{repo.behind}</span>}
            <span className="gt-spacer" />
            {repo.remoteWebUrl && (
              <a className="gt-mini gt-remote" href={repo.remoteWebUrl} target="_blank" rel="noopener noreferrer"
                 title={`open on ${repo.remoteWebUrl.replace(/^https:\/\//, '').split('/')[0]}`}>
                <IconExternal className="gt-ext" />
              </a>
            )}
            <button className="gt-mini" onClick={() => setHistoryOpen(true)}
              title="commit history for this repository">log</button>
            <button className="gt-mini" disabled={!!working}
              onClick={() => run('fetch', () => api.gitFetch(vpsId, cwd, root), 'fetched')}
              title="git fetch --all — refreshes how far ahead/behind this branch is">
              {working === 'fetch' ? '…' : 'fetch'}
            </button>
            {!!repo.behind && (
              <button className="gt-mini primary" disabled={!!working}
                onClick={() => run('pull', () => api.gitPull(vpsId, cwd, root), 'pulled')}
                title={`git pull --rebase --autostash — ${repo.behind} commit(s) behind`}>
                {working === 'pull' ? '…' : `pull ${repo.behind}`}
              </button>
            )}
            {!!repo.ahead && (
              <button className="gt-mini" disabled={!!working}
                onClick={() => run('push', () => api.gitPush(vpsId, cwd, root), 'pushed')}
                title="git push">push</button>
            )}
            {!multi && (
              <button className="gt-mini" onClick={() => refreshGit(vpsId, cwd)}
                disabled={loading} title="refresh">{loading ? '…' : '↻'}</button>
            )}
          </div>

          {busy && !multi && <div className="gt-warn">a session is writing in this repo right now</div>}
          {!!repo.conflicts && <div className="gt-warn err">{repo.conflicts} file(s) in conflict — resolve them before committing</div>}
          {repo.truncated && <div className="gt-warn">showing the first {files.length} of {repo.fileCount} changed files</div>}

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
                  <span className="add">+{repo.added ?? 0}</span>
                  <span className="del">−{repo.deleted ?? 0}</span>
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
                        onChange={() => toggleOne(f.path)}
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

              {(!multi || selected.size > 0) && (
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
              )}
            </>
          )}

          {note && <div className={`gt-note ${note.kind}`}>{note.text}</div>}
        </>
      )}

      {historyOpen && (
        <HistoryModal
          vpsId={vpsId}
          cwd={cwd}
          repo={root}
          label={repo.rel || repo.name || (repo.root ?? '')}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {branchesOpen && (
        <BranchModal
          vpsId={vpsId}
          cwd={cwd}
          repo={root}
          label={repo.rel || repo.name || (repo.root ?? '')}
          onClose={() => setBranchesOpen(false)}
        />
      )}

      {openPath && (
        <DiffViewerModal
          vpsId={vpsId}
          cwd={cwd}
          repo={root}
          root={repo.root}
          files={files}
          initialPath={openPath}
          onClose={() => setOpenPath(null)}
        />
      )}
    </section>
  );
}
