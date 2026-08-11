'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import type { GitCommit, GitFileEntry } from '@/lib/types/api';
import SplitDiffView from './SplitDiffView';
import { rowsFromPatch } from './diffRows';
import { fileStatusLabel, gitReasonHint } from './gitStore';

type Props = {
  vpsId: string;
  /** The session's folder — what every git route is keyed on. */
  cwd: string;
  /** The checkout being read (a cwd can hold several, §14.83). */
  repo: string | null;
  /** Repo-relative path to scope the history to, or null for the whole repo. */
  path?: string | null;
  label: string;
  onClose: () => void;
};

const PAGE = 40;

/**
 * Commit history — for a repository, or for one file (§14.87).
 *
 * Three panes, left to right: the commits, the files that commit touched, and
 * the diff. The diff is the SAME renderer as the working-tree reader and the
 * session-edit reader (`SplitDiffView` over `diffRows`, §14.86), so "read a
 * change" looks identical wherever the change came from.
 *
 * The patch is fetched per commit and, when the history is scoped to one file,
 * narrowed to that file server-side — reading the history of one file in a
 * commit that touched sixty of them should not ship the other fifty-nine.
 */
export default function HistoryModal({ vpsId, cwd, repo, path, label, onClose }: Props) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFileEntry[]>([]);
  const [patch, setPatch] = useState<string>('');
  const [meta, setMeta] = useState<GitCommit | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [showErr, setShowErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const reqRef = useRef(0);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.getGitLog(vpsId, cwd, { repo, path, limit: PAGE });
        if (!alive.current) return;
        if (!r.ok) { setErr(gitReasonHint(r.reason, repo) ?? r.error ?? 'could not read the history'); return; }
        setCommits(r.commits);
        setHasMore(!!r.hasMore);
        if (r.commits[0]) setSel(r.commits[0].sha);
      } catch (e: unknown) {
        if (alive.current) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [vpsId, cwd, repo, path]);

  // The selected commit's patch. Guarded against a slow answer for commit A
  // landing after the user has already clicked commit B.
  useEffect(() => {
    if (!sel) return;
    const seq = ++reqRef.current;
    setBusy(true);
    setShowErr(null);
    (async () => {
      try {
        const r = await api.getGitShow(vpsId, cwd, sel, { repo, path });
        if (!alive.current || seq !== reqRef.current) return;
        if (!r.ok) { setShowErr(r.error ?? 'could not read this commit'); setPatch(''); setFiles([]); return; }
        setFiles(r.files);
        setPatch(r.patch ?? '');
        setMeta(r.commit ?? null);
        // Scoped history: there is only ever one file, so pre-select it.
        setFilePath(path ? (r.files[0]?.path ?? null) : null);
      } catch (e: unknown) {
        if (alive.current && seq === reqRef.current) setShowErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current && seq === reqRef.current) setBusy(false);
      }
    })();
  }, [vpsId, cwd, repo, path, sel]);

  const loadMore = useCallback(async () => {
    if (!commits || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.getGitLog(vpsId, cwd, { repo, path, limit: PAGE, skip: commits.length });
      if (!alive.current) return;
      if (r.ok) { setCommits([...commits, ...r.commits]); setHasMore(!!r.hasMore); }
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }, [vpsId, cwd, repo, path, commits, loadingMore]);

  const move = useCallback((delta: number) => {
    if (!commits?.length) return;
    const i = commits.findIndex((c) => c.sha === sel);
    const next = commits[Math.min(commits.length - 1, Math.max(0, i + delta))];
    if (next) setSel(next.sha);
  }, [commits, sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Alt+arrows belong to the diff's change stepper (§14.86).
      if (e.altKey) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, move]);

  // One file's slice of the commit patch, or the whole thing.
  const shownPatch = useMemo(() => {
    if (!filePath || !patch) return patch;
    return sliceFileFromPatch(patch, filePath) || patch;
  }, [patch, filePath]);
  const rows = useMemo(() => rowsFromPatch(shownPatch), [shownPatch]);

  return createPortal(
    <div className="split-diff-modal-backdrop" onClick={onClose}>
      <div className="split-diff-modal hm" onClick={(e) => e.stopPropagation()}>
        <header className="sdm-head">
          <span className="sdm-path">
            History <span className="hm-scope">{path ? `· ${path}` : `· ${label}`}</span>
          </span>
          {meta && (
            <span className="hm-meta" title={meta.body || ''}>
              <span className="hm-sha">{meta.short}</span>
              <span className="hm-author">{meta.author}</span>
              <span className="hm-age">{relAge(meta.at)}</span>
            </span>
          )}
          <button className="sdm-close" onClick={onClose} title="close (Esc)">✕</button>
        </header>

        <div className="sdm-body hm-body">
          <nav className="hm-rail">
            {err && <div className="dvm-note err">{err}</div>}
            {!commits && !err && <div className="dvm-note">reading history…</div>}
            {commits?.length === 0 && <div className="dvm-note">no commits here yet</div>}
            {commits?.map((c) => (
              <button
                key={c.sha}
                className={`hm-commit${c.sha === sel ? ' on' : ''}`}
                onClick={() => setSel(c.sha)}
                title={`${c.sha}\n${c.author} · ${fullDate(c.at)}\n\n${c.subject}${c.body ? `\n\n${c.body}` : ''}`}
              >
                <span className="hm-line1">
                  <span className="hm-sha">{c.short}</span>
                  <span className="hm-subject">{c.subject}</span>
                </span>
                <span className="hm-line2">
                  <span className="hm-author">{c.author}</span>
                  <span className="hm-age">{relAge(c.at)}</span>
                  {c.refs?.slice(0, 2).map((r) => (
                    <span key={r} className={`hm-ref${r.startsWith('tag:') ? ' tag' : ''}`}>
                      {r.replace(/^HEAD -> /, '')}
                    </span>
                  ))}
                </span>
              </button>
            ))}
            {hasMore && (
              <button className="hm-more" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? '…' : 'load more'}
              </button>
            )}
          </nav>

          <div className="hm-main">
            {/* Only worth a file strip when the commit touched several and the
                history isn't already scoped to one. */}
            {!path && files.length > 1 && (
              <div className="hm-files">
                <button className={`hm-file${filePath === null ? ' on' : ''}`} onClick={() => setFilePath(null)}>
                  all <span className="hm-n">{files.length}</span>
                </button>
                {files.map((f) => {
                  const st = fileStatusLabel(f.status);
                  return (
                    <button
                      key={f.path}
                      className={`hm-file${filePath === f.path ? ' on' : ''}`}
                      onClick={() => setFilePath(f.path)}
                      title={f.path}
                    >
                      <span className={`gt-st ${st.cls}`}>{f.status}</span>
                      <span className="hm-fname">{f.path.split('/').pop()}</span>
                      {f.added != null && <span className="add">+{f.added}</span>}
                      {f.deleted != null && <span className="del">−{f.deleted}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {busy && <div className="dvm-note">loading commit…</div>}
            {showErr && <div className="dvm-note err">{showErr}</div>}
            {!busy && !showErr && rows.length === 0 && (
              <div className="dvm-note">
                {patch ? 'no textual diff in this commit' : 'nothing to show'}
              </div>
            )}
            {!busy && !showErr && rows.length > 0 && (
              <SplitDiffView
                rows={rows}
                resetKey={`${sel}:${filePath ?? ''}`}
                leftLabel={`before ${meta?.short ?? ''}`}
                rightLabel={`after ${meta?.short ?? ''}`}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The slice of a multi-file patch that belongs to one path.
 *
 * `git show` gives one patch for the whole commit; the file strip needs a
 * piece of it. Cutting on the `diff --git` boundaries is exact — no re-parsing
 * and no second call to the VPS.
 */
export function sliceFileFromPatch(patch: string, path: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  let inFile = false;
  for (const ln of lines) {
    if (ln.startsWith('diff --git ')) {
      // `diff --git a/<p> b/<p>`; a path with spaces still ends the line with
      // ` b/<path>`, which is the unambiguous half.
      inFile = ln.endsWith(` b/${path}`);
      if (inFile) out.push(ln);
      continue;
    }
    if (inFile) out.push(ln);
  }
  return out.join('\n');
}

function relAge(at?: number | null): string {
  if (!at) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - at));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}
function fullDate(at?: number | null): string {
  return at ? new Date(at * 1000).toLocaleString() : '';
}
