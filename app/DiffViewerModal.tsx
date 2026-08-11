'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { GitFileEntry } from '@/lib/types/api';
import { fileStatusLabel } from './gitStore';
import SplitDiffView from './SplitDiffView';
import { rowsFromPatch } from './diffRows';

type Props = {
  vpsId: string;
  cwd: string;
  /** Repo to read from, when the cwd holds several (§14.83). */
  repo?: string | null;
  root: string | null | undefined;
  files: GitFileEntry[];
  /** File to open first. */
  initialPath: string;
  onClose: () => void;
};

/**
 * Full-screen changeset reader.
 *
 * The git tab is 340px wide — an index, not a reader. This is where the diff
 * is actually read: a file rail on the left, the unified patch on the right,
 * ↑/↓ (or j/k) to walk the changeset without going back to the panel.
 *
 * SPLIT by default — HEAD on the left, the working tree on the right, with the
 * ▲/▼ between the panes stepping change by change. It is the same renderer as
 * the session-edit reader (`SplitDiffView` over `diffRows`, §14.86): git hands
 * us a unified patch rather than a before/after pair, so the patch is
 * re-shaped into the shared rows instead of being re-diffed — git already
 * decided what changed, and a second opinion computed in the browser would
 * disagree with the numbers shown everywhere else. The raw patch stays one
 * click away for the things only it shows (renames, mode changes, binaries).
 *
 * Patches are fetched ONE FILE AT A TIME, on demand: a whole-changeset payload
 * is the egress trap of §14.41, and here the list behind it is polled.
 */
export default function DiffViewerModal({ vpsId, cwd, repo, root, files, initialPath, onClose }: Props) {
  const [path, setPath] = useState(initialPath);
  const [patch, setPatch] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [unified, setUnified] = useState(false);
  // Guards against a slow fetch for file A landing after the user has already
  // moved to file B and overwriting its patch.
  const reqRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const idx = Math.max(0, files.findIndex((f) => f.path === path));
  const current = files[idx];
  const rows = useMemo(() => (patch ? rowsFromPatch(patch) : []), [patch]);

  const load = useCallback(async (p: string) => {
    const seq = ++reqRef.current;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.getGitDiff(vpsId, cwd, p, repo);
      if (seq !== reqRef.current) return;
      if (!r.ok) { setErr(r.error || 'could not read this diff'); setPatch(null); }
      else { setPatch(r.patch ?? ''); setTruncated(!!r.truncated); }
    } catch (e: unknown) {
      if (seq !== reqRef.current) return;
      setErr(e instanceof Error ? e.message : String(e));
      setPatch(null);
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [vpsId, cwd, repo]);

  useEffect(() => { void load(path); }, [path, load]);
  // A new file starts at the top; keeping the old scroll offset lands the
  // reader in the middle of an unrelated patch.
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [path]);

  const move = useCallback((delta: number) => {
    setPath((cur) => {
      const i = files.findIndex((f) => f.path === cur);
      const next = files[Math.min(files.length - 1, Math.max(0, i + delta))];
      return next ? next.path : cur;
    });
  }, [files]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      // Don't hijack arrows while the user is in a field somewhere behind us.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, move]);

  const rel = (p: string) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);

  return (
    <div className="split-diff-modal-backdrop" onClick={onClose}>
      <div className="split-diff-modal dvm" onClick={(e) => e.stopPropagation()}>
        <header className="sdm-head">
          <span className="sdm-path" title={current ? `${root ?? ''}/${current.path}` : ''}>
            {current?.path ?? path}
          </span>
          {current && (current.added != null || current.deleted != null) && (
            <span className="sdm-stats">
              <span className="add">+{current.added ?? 0}</span>
              <span className="del">−{current.deleted ?? 0}</span>
            </span>
          )}
          <button className="dvm-nav wide" onClick={() => setUnified((v) => !v)}
            title={unified ? 'show the two sides' : 'show the raw unified patch'}>
            {unified ? 'split' : 'unified'}
          </button>
          <span className="dvm-pos">{idx + 1}/{files.length}</span>
          <button className="dvm-nav" onClick={() => move(-1)} disabled={idx <= 0} title="previous file (↑)">▲</button>
          <button className="dvm-nav" onClick={() => move(1)} disabled={idx >= files.length - 1} title="next file (↓)">▼</button>
          <button className="sdm-close" onClick={onClose} title="close (Esc)">✕</button>
        </header>
        <div className="sdm-body dvm-body">
          <nav className="dvm-rail">
            {files.map((f) => {
              const st = fileStatusLabel(f.status);
              return (
                <button
                  key={f.path}
                  className={`dvm-file${f.path === path ? ' on' : ''}`}
                  onClick={() => setPath(f.path)}
                  title={`${st.label} · ${f.path}`}
                >
                  <span className={`dvm-st ${st.cls}`}>{f.status}</span>
                  <span className="dvm-name">{rel(f.path)}</span>
                </button>
              );
            })}
          </nav>
          <div className="dvm-patch" ref={bodyRef}>
            {loading && <div className="dvm-note">loading diff…</div>}
            {err && <div className="dvm-note err">{err}</div>}
            {!loading && !err && patch === '' && (
              <div className="dvm-note">
                no textual diff{current?.binary ? ' (binary file)' : ''}
              </div>
            )}
            {truncated && <div className="dvm-note warn">⚠ diff truncated (file too large)</div>}
            {patch && unified && <pre className="diff-body dvm-pre">{renderPatch(patch)}</pre>}
            {patch && !unified && rows.length > 0 && (
              <SplitDiffView
                rows={rows}
                resetKey={path}
                leftLabel={current?.untracked ? 'HEAD (new file)' : 'HEAD'}
                rightLabel="working tree"
              />
            )}
            {patch && !unified && rows.length === 0 && (
              // A patch with no hunks at all: a pure rename, a mode change, a
              // binary. The raw text is the only thing that says what happened.
              <pre className="diff-body dvm-pre">{renderPatch(patch)}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Render a git patch verbatim. Same classification as ToolPanel's Codex
 * renderer — we must NOT re-diff a patch git already produced.
 */
export function renderPatch(patch: string): React.ReactNode {
  return patch.split('\n').map((l, i) => {
    let cls = 'ctx';
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')
      || l.startsWith('index ') || l.startsWith('new file') || l.startsWith('deleted file')
      || l.startsWith('similarity ') || l.startsWith('rename ') || l.startsWith('Binary files')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
  });
}
