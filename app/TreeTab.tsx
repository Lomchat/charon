'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FsEntry } from '@/lib/types/api';
import FileViewerModal from './FileViewerModal';
import { buildGitDecorations, fileStatusLabel, useGitStatus } from './gitStore';
import { IconForKind, fileKind } from './fileIcons';

type Props = { vpsId: string | null; cwd: string | null };

type Row = { path: string; name: string; dir: boolean; depth: number; entry: FsEntry };

/**
 * Read-only project explorer, rooted at the session's cwd.
 *
 * Modelled on the VS Code tree because that is the thing people already know:
 * lazy expansion, directories first, a per-type glyph, and git decoration —
 * the status letter and colour on changed files, the same colour folded up
 * onto the folders that contain them, and ignored entries dimmed.
 *
 * Expansion is lazy per directory. A whole-tree walk would mean shipping a
 * node_modules across the ssh pipe to render six visible rows, and the tree
 * only ever shows what someone opened.
 *
 * Nothing here writes. Opening a file is a read into a viewer; editing on the
 * VPS stays the agent's job, and a half-built editor that can silently
 * conflict with a session writing the same file would be worse than none.
 */
export default function TreeTab({ vpsId, cwd }: Props) {
  const { status } = useGitStatus(vpsId, cwd);
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [open, setOpen] = useState<{ path: string; name: string; size: number } | null>(null);
  const inflight = useRef<Set<string>>(new Set());

  const isRepo = !!status?.ok && !!status.isRepo;
  const decorations = useMemo(() => buildGitDecorations(status, cwd), [status, cwd]);

  const load = useCallback(async (path: string, force = false) => {
    if (!vpsId || !cwd) return;
    if (inflight.current.has(path)) return;
    if (!force && children.has(path)) return;
    inflight.current.add(path);
    setLoading((s) => new Set(s).add(path));
    try {
      const r = await api.listFsTree(vpsId, cwd, path, isRepo);
      if (r.ok) {
        // `.git` is the only entry filtered out. It is an implementation detail
        // of the thing decorating this tree, it is never useful to browse, and
        // every editor hides it — anything else stays visible, including
        // dotfiles and gitignored entries (dimmed rather than hidden, so
        // "why is this file missing?" never becomes a question).
        setChildren((m) => new Map(m).set(path, r.entries.filter((e) => !(e.dir && e.name === '.git'))));
        setErrors((m) => { if (!m.has(path)) return m; const n = new Map(m); n.delete(path); return n; });
      } else {
        setErrors((m) => new Map(m).set(path, r.error ?? 'could not read this directory'));
      }
    } catch (e: unknown) {
      setErrors((m) => new Map(m).set(path, e instanceof Error ? e.message : String(e)));
    } finally {
      inflight.current.delete(path);
      setLoading((s) => { const n = new Set(s); n.delete(path); return n; });
    }
  }, [vpsId, cwd, isRepo, children]);

  // Root listing. Keyed on (vps, cwd) so switching session resets the tree.
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set(['']));
    setErrors(new Map());
    inflight.current.clear();
  }, [vpsId, cwd]);
  useEffect(() => { void load(''); }, [load]);

  // Something changed on disk (an agent finished a turn, a commit landed) —
  // re-list only the directories currently OPEN. Keyed on the changed-file
  // signature rather than a timer: the tree is a view of the filesystem, and
  // the git status is the cheapest change signal we already pay for.
  const changeSig = useMemo(
    () => (status?.files ?? []).map((f) => f.status + f.path).join('|'),
    [status],
  );
  const firstSig = useRef(true);
  useEffect(() => {
    if (firstSig.current) { firstSig.current = false; return; }
    for (const p of expanded) if (children.has(p)) void load(p, true);
    // `expanded`/`children` are read, not tracked: this must fire on a disk
    // change, not every time a folder is opened (which loads itself anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeSig]);

  const toggle = (path: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else { n.add(path); void load(path); }
      return n;
    });
  };

  // Flatten the open subtree into rows. A flat list keeps the render cheap and
  // the indentation explicit, which is also how VS Code does it.
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const kids = children.get(dir);
      if (!kids) return;
      for (const e of kids) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        out.push({ path, name: e.name, dir: e.dir, depth, entry: e });
        if (e.dir && expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [children, expanded]);

  if (!vpsId || !cwd) return <div className="tp-empty">no folder for this session</div>;

  const rootErr = errors.get('');
  if (rootErr && rows.length === 0) {
    return (
      <div className="tp-empty">
        {rootErr}
        <br />
        <button className="gt-retry" onClick={() => load('', true)}>↻ retry</button>
      </div>
    );
  }
  if (rows.length === 0 && loading.has('')) return <div className="tp-empty">reading {cwd}…</div>;

  return (
    <div className="tree-tab">
      <div className="tt-head">
        <span className="tt-root" title={cwd}>{cwd.split('/').filter(Boolean).pop() ?? cwd}</span>
        <span className="gt-spacer" />
        <button className="gt-mini" onClick={() => { setChildren(new Map()); void load('', true); }}
          title="reload the tree">↻</button>
      </div>

      {rows.length === 0 ? (
        <div className="tp-empty">this folder is empty</div>
      ) : (
        <ul className="tt-rows">
          {rows.map((r) => {
            const deco = decorations.get(r.path);
            const st = deco ? fileStatusLabel(deco) : null;
            const kind = fileKind(r.name, r.dir);
            const isOpen = r.dir && expanded.has(r.path);
            const busy = loading.has(r.path);
            const err = errors.get(r.path);
            return (
              <li key={r.path}>
                <button
                  className={`tt-row ${r.dir ? 'is-dir' : 'is-file'}${r.entry.ignored ? ' ignored' : ''}${st ? ' g-' + st.cls : ''}`}
                  style={{ paddingLeft: 4 + r.depth * 11 }}
                  onClick={() => (r.dir ? toggle(r.path) : setOpen({ path: r.path, name: r.name, size: r.entry.size }))}
                  title={err ? `${r.path} — ${err}` : `${r.path}${st ? ` · ${st.label}` : ''}${r.entry.ignored ? ' · git-ignored' : ''}`}
                >
                  <span className="tt-caret">{r.dir ? (busy ? '·' : isOpen ? '▾' : '▸') : ''}</span>
                  <IconForKind kind={kind} open={isOpen} className="tt-ico" />
                  <span className="tt-name">{r.name}</span>
                  {r.entry.symlink && <span className="tt-link" title="symlink">↗</span>}
                  {/* Files carry the letter; folders carry only the colour, so
                      the gutter stays a single column of real changes. */}
                  {st && !r.dir && <span className="tt-st">{deco}</span>}
                  {err && <span className="tt-err" title={err}>!</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <FileViewerModal
          vpsId={vpsId}
          root={cwd}
          path={open.path}
          name={open.name}
          size={open.size}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
