'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FsEntry } from '@/lib/types/api';
import { buildGitDecorations, fileStatusLabel, useGitStatus } from './gitStore';
import { openTab as openWorkspaceTab } from './tabStore';
import { IconForKind, fileKind } from './fileIcons';

type Props = { vpsId: string | null; cwd: string | null };

type Menu = { x: number; y: number; row: Row | null };

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
 * Clicking a file opens it in the MAIN pane as a tab (§14.78) — single click
 * is a preview, double click keeps it. The tree itself never writes: the save
 * path, its sha precondition and its conflict handling all live in FileEditor,
 * so there is exactly one place that can modify a file from the browser.
 */
export default function TreeTab({ vpsId, cwd }: Props) {
  const { status } = useGitStatus(vpsId, cwd);
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  // Single click previews (italic tab, replaced by the next preview in this
  // folder); double click keeps it. Same contract as the sidebar. §14.78
  const openFile = useCallback((rel: string, pin: boolean) => {
    if (!vpsId || !cwd) return;
    void openWorkspaceTab({ vpsId, path: cwd, kind: 'file', ref: rel, pin });
  }, [vpsId, cwd]);
  const inflight = useRef<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

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

  /** Directory a menu action should act in: the row's folder, or the row's
   *  own path when it IS a folder. */
  const dirOf = (row: Row | null): string => {
    if (!row) return '';
    if (row.dir) return row.path;
    const cut = row.path.lastIndexOf('/');
    return cut === -1 ? '' : row.path.slice(0, cut);
  };
  const reload = (dir: string) => {
    void load(dir, true);
    if (dir) void load('', true);
  };

  async function runOp(fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>, dir: string) {
    if (!vpsId || !cwd) return;
    setBusy(true);
    setOpError(null);
    try {
      const r = await fn();
      if (!r.ok) setOpError(r.error ?? 'failed');
      else reload(dir);
    } catch (e: unknown) {
      setOpError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setMenu(null);
    }
  }

  function newFile(row: Row | null) {
    if (!vpsId || !cwd) return;
    const dir = dirOf(row);
    const name = window.prompt(`New file in ${dir || '.'}`, '');
    if (!name) { setMenu(null); return; }
    const rel = dir ? `${dir}/${name}` : name;
    // expectedSha256:'' means "this must not exist yet" — creating a file must
    // never silently truncate one an agent just wrote.
    void runOp(() => api.writeFsFile(vpsId, { root: cwd, path: rel, content: '', expectedSha256: '' })
      .then((r) => (r.reason === 'stale' ? { ok: false, error: 'a file with that name already exists' } : r)),
      dir);
  }
  function newFolder(row: Row | null) {
    if (!vpsId || !cwd) return;
    const dir = dirOf(row);
    const name = window.prompt(`New folder in ${dir || '.'}`, '');
    if (!name) { setMenu(null); return; }
    void runOp(() => api.fsOp(vpsId, { root: cwd, op: 'mkdir', path: dir ? `${dir}/${name}` : name }), dir);
  }
  function rename(row: Row) {
    if (!vpsId || !cwd) return;
    const dir = dirOf(row.dir ? { ...row, dir: false } : row);
    const next = window.prompt(`Rename "${row.name}" to`, row.name);
    if (!next || next === row.name) { setMenu(null); return; }
    void runOp(() => api.fsOp(vpsId, { root: cwd, op: 'rename', path: row.path, to: dir ? `${dir}/${next}` : next }), dir);
  }
  function remove(row: Row) {
    if (!vpsId || !cwd) return;
    const dir = dirOf(row.dir ? { ...row, dir: false } : row);
    const what = row.dir ? `the folder "${row.name}" AND EVERYTHING IN IT` : `"${row.name}"`;
    if (!window.confirm(`Delete ${what} on the VPS?\n\nThis is not undoable from here, and an agent may be working in this tree.`)) {
      setMenu(null); return;
    }
    void runOp(() => api.fsOp(vpsId, { root: cwd, op: 'delete', path: row.path, recursive: row.dir }), dir);
  }
  async function copyPath(row: Row, absolute: boolean) {
    const text = absolute ? `${cwd}/${row.path}` : row.path;
    try { await navigator.clipboard.writeText(text); } catch { window.prompt('Copy:', text); }
    setMenu(null);
  }

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
    <div className="tree-tab"
         onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row: null }); }}>
      <div className="tt-head">
        <span className="tt-root" title={cwd}>{cwd.split('/').filter(Boolean).pop() ?? cwd}</span>
        <span className="gt-spacer" />
        <button className="gt-mini" onClick={() => { setChildren(new Map()); void load('', true); }}
          title="reload the tree">↻</button>
      </div>

      {opError && <div className="gt-note err">{opError}</div>}

      {menu && (
        <>
          <div className="tt-menu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="tt-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 230) }}>
            <button disabled={busy} onClick={() => newFile(menu.row)}>new file…</button>
            <button disabled={busy} onClick={() => newFolder(menu.row)}>new folder…</button>
            {menu.row && <>
              <div className="tt-menu-sep" />
              <button onClick={() => copyPath(menu.row!, false)}>copy relative path</button>
              <button onClick={() => copyPath(menu.row!, true)}>copy full path</button>
              <div className="tt-menu-sep" />
              <button disabled={busy} onClick={() => rename(menu.row!)}>rename…</button>
              <button className="danger" disabled={busy} onClick={() => remove(menu.row!)}>delete</button>
            </>}
          </div>
        </>
      )}

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
                  onClick={() => (r.dir ? toggle(r.path) : openFile(r.path, false))}
                  onDoubleClick={() => { if (!r.dir) openFile(r.path, true); }}
                  onContextMenu={(e) => {
                    // stopPropagation, or the container's handler below runs
                    // straight after and replaces this with a row-less menu.
                    e.preventDefault(); e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, row: r });
                  }}
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

    </div>
  );
}
