'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FsEntry, GitFileEntry } from '@/lib/types/api';
import { buildGitDecorations, fileStatusLabel, repoForPath, useGitStatus } from './gitStore';
import HistoryModal from './HistoryModal';
import { IconClockHistory, IconDownload, IconEye, IconUpload } from './icons';
import { activityLabel, useFileActivity } from './fileActivityStore';
import { openTab as openWorkspaceTab, useTabs } from './tabStore';
import {
  IconForKind, fileKind, IconFolder,
  IconFilePlus, IconFolderPlus, IconCopy, IconRename, IconDelete, IconInsert, IconSymlink,
} from './fileIcons';
import { IconClipboard, IconFileEarmark, IconPencil } from './icons';
import ConfirmModal from './ConfirmModal';
import PromptModal from './PromptModal';
import { setPathDrag } from './pathDrag';
import { readExpanded, treeScope, writeExpanded } from './treeExpansion';
import { subscribeFsChanged } from './fsChangeBus';
import {
  collapseTreeDeletePaths, isTreeSelectionOnly, readTreeSelection, selectTreeRow,
  treeSelectionScope, writeTreeSelection,
} from './treeSelection';
import { missingInstructionSymlink } from './instructionSymlink';
import { positionContextMenu } from './contextMenuPosition';
import {
  UPLOAD_ZONE_ATTR, captureDrop, isOsFileDrag, planDrop, useOsFileDrag,
  type DroppedRoot, type UploadPlan,
} from './fileDropZones';
import {
  cancelUploadJob, dismissUploadJob, enqueueUpload, useUploadJobs, type UploadJob,
} from './fsUploadStore';
import { joinRel } from '@/lib/fsUpload';

type Props = {
  vpsId: string | null;
  cwd: string | null;
  /** Kept for session-aware actions; tree browsing state itself is shared by
   *  every entity in the `(vpsId, cwd)` workspace (§14.77/78). */
  sessionId?: string | null;
  /** Splice a path into the chat message. Absent when no chat is open (the
   *  explorer also renders beside the file editor) — which is exactly the
   *  signal for whether a row is draggable at all. */
  onInsertPath?: (text: string) => void;
  /** Jump to the session that is touching a file (§14.88). */
  onOpenSession?: (sessionId: string) => void;
};

type Menu = { x: number; y: number; row: Row | null; rows: Row[] };

type Row = { path: string; name: string; dir: boolean; depth: number; entry: FsEntry };

/** Hovering a collapsed folder with a dragged file opens it after this long —
 *  VS Code's spring-loading, so a drop can reach any depth. */
const SPRING_OPEN_MS = 500;
/** Uploads whose landed items were already selected — module-level so a
 *  remount (opening a file) does not re-select them over the user's choice. */
const revealedUploads = new Set<string>();

type ListingMemory = { children: Map<string, FsEntry[]>; errors: Map<string, string> };
const listingMemory = new Map<string, ListingMemory>();
const MAX_LISTING_WORKSPACES = 30;

function readListingMemory(scope: string): ListingMemory {
  const saved = listingMemory.get(scope) ?? { children: new Map(), errors: new Map() };
  listingMemory.delete(scope);
  listingMemory.set(scope, saved);
  while (listingMemory.size > MAX_LISTING_WORKSPACES) listingMemory.delete(listingMemory.keys().next().value!);
  return { children: new Map(saved.children), errors: new Map(saved.errors) };
}

function writeListingMemory(scope: string, children: Map<string, FsEntry[]>, errors: Map<string, string>): void {
  listingMemory.set(scope, { children: new Map(children), errors: new Map(errors) });
}

/**
 * The open dialog, if any. Every mutation the context menu offers goes through
 * one of these — never `prompt()`/`confirm()`, which cannot show the folder an
 * action lands in, cannot render the server's rejection next to the name that
 * caused it, and (Firefox, Safari) come with a "prevent this page from
 * creating more dialogs" checkbox that silently disables the feature.
 * `dir` is carried on the dialog rather than recomputed at submit time: the
 * tree re-lists under it while the dialog is open (§14.77's change signal).
 */
type Dialog =
  | { kind: 'create'; dir: string; folder: boolean }
  | { kind: 'rename'; row: Row; dir: string }
  | { kind: 'delete'; rows: Row[] }
  | { kind: 'copy'; text: string }
  | { kind: 'upload-conflict'; upload: PendingUpload; conflicts: string[] };

/** A drop that has been checked against the destination, not yet queued.
 *  Paths are relative to `targetDir`, except `errors` (root-relative). */
type PendingUpload = {
  targetDir: string;
  plan: UploadPlan;
  mkdirs: string[];
  skip: Set<string>;
  errors: { path: string; error: string }[];
};

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
export default function TreeTab({ vpsId, cwd, sessionId = null, onInsertPath, onOpenSession }: Props) {
  const { workspace } = useGitStatus(vpsId, cwd);
  // Who is reading/writing what on this machine, right now (§14.88).
  const activity = useFileActivity(vpsId);
  // Identity of this WORKSPACE tree. Sessions, files and SSH shells at this
  // path deliberately resolve to the same scope.
  const scope = treeScope(sessionId, vpsId ?? '', cwd ?? '');
  // Unlike expansion, selection follows the folder when opening a file swaps
  // the session ToolPanel for the editor ToolPanel (sessionId becomes null).
  const selectionScope = treeSelectionScope(vpsId, cwd);
  const initialListing = useMemo(() => readListingMemory(scope), [scope]);
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(() => initialListing.children);
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded(scope));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => initialListing.errors);
  const childrenRef = useRef(children);
  const errorsRef = useRef(errors);
  childrenRef.current = children;
  errorsRef.current = errors;
  // Single click previews (italic tab, replaced by the next preview in this
  // folder); double click keeps it. Same contract as the sidebar. §14.78
  const openFile = useCallback((rel: string, pin: boolean) => {
    if (!vpsId || !cwd) return;
    void openWorkspaceTab({ vpsId, path: cwd, kind: 'file', ref: rel, pin });
  }, [vpsId, cwd]);
  const inflight = useRef<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Keep the menu identity with its measured position. A newly opened menu
  // may have a different action count/height, so reusing the previous menu's
  // coordinates for even one paint would recreate the bottom-edge flash.
  const [menuPos, setMenuPos] = useState<{
    menu: Menu; left: number; top: number;
  } | null>(null);
  // Explorer selection is deliberately separate from `activeFile`: active is
  // the file shown in the editor, selected is the transient Ctrl/Shift set a
  // context-menu action will target. Paths remain stable as rows move.
  const [selected, setSelected] = useState<Set<string>>(
    () => readTreeSelection(selectionScope).selected,
  );
  const selectionAnchor = useRef<string | null>(readTreeSelection(selectionScope).anchor);
  // Capture modifiers at mouse-down, as desktop explorers do. Looking only at
  // `click` can miss a key released between press and release and accidentally
  // navigate on what began as a Ctrl/Shift selection gesture.
  const pressedSelection = useRef<{ path: string; toggle: boolean; range: boolean } | null>(null);
  const lastClickWasSelectionOnly = useRef(false);
  const replaceSelection = useCallback((next: Set<string>, anchor: string | null) => {
    // Persist BEFORE setState: opening a file synchronously unmounts this tree,
    // so an effect cannot be responsible for handing state to its replacement.
    writeTreeSelection(selectionScope, next, anchor);
    selectionAnchor.current = anchor;
    setSelected(next);
  }, [selectionScope]);
  // File history — the repo that owns the file is resolved from the workspace.
  const [history, setHistory] = useState<{ path: string; repo: string | null } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Row being dragged, for the dimmed styling only — the payload itself rides
  // in the dataTransfer, so nothing here is load-bearing for the drop.
  const [dragPath, setDragPath] = useState<string | null>(null);
  // Destructive RPCs can take seconds over SSH. The confirm closes immediately
  // and these paths remain in the tree, red + disabled, until the background
  // batch settles and the affected directories are re-listed.
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(() => new Set());
  const [opError, setOpError] = useState<string | null>(null);
  // ── OS files dropped onto the tree (app/fileDropZones.ts) ──
  // `osDrag` says a file is being dragged over the WINDOW, which is when the
  // tree announces itself as the server-side target; `overZone` narrows it to
  // the pointer being in THIS tree. `dropDir` is the folder a drop would land
  // in, `springPath` the collapsed folder about to open under the pointer.
  const osDrag = useOsFileDrag();
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const overZone = osDrag.zone != null && osDrag.zone === zoneRef.current;
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [springPath, setSpringPath] = useState<string | null>(null);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploads = useUploadJobs(vpsId, cwd);

  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const place = () => {
      const rect = el.getBoundingClientRect();
      const pos = positionContextMenu(
        menu.x, menu.y, rect.width, rect.height,
        window.innerWidth, window.innerHeight,
      );
      setMenuPos({ menu, ...pos });
    };
    // Measure before paint, then keep the box contained if a mobile viewport
    // rotates/resizes or an action changes its rendered dimensions.
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(place);
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [menu]);

  // The file the main pane is showing, when it belongs to THIS tree. Read from
  // the tab store rather than taken as a prop: the same panel renders beside
  // the chat and beside the editor, and the active tab is the one thing both
  // situations already agree on (§14.78).
  const { tabs } = useTabs();
  const activeFile = useMemo(() => {
    const t = tabs.find((x) => x.active);
    if (!t || t.kind !== 'file' || !vpsId || !cwd) return null;
    return t.vpsId === vpsId && t.path === cwd ? t.ref : null;
  }, [tabs, vpsId, cwd]);
  const revealedRef = useRef<string | null>(null);
  /** The file whose ancestors have already been opened. Separate from
   *  `revealedRef` (which tracks the SCROLL): the expansion happens as soon as
   *  the file is known, the scroll only once its row exists. */
  const expandedForRef = useRef<string | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  // Ask for the gitignore flags whenever ANY checkout is in play — with a
  // folder of projects the cwd itself is not a repo but its children are
  // (§14.83), and `fs_list` resolves the owning repo per directory anyway.
  const isRepo = !!workspace?.ok && workspace.mode !== 'none';
  const decorations = useMemo(() => buildGitDecorations(workspace, cwd), [workspace, cwd]);

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
        setChildren((m) => {
          const next = new Map(m).set(path, r.entries.filter((e) => !(e.dir && e.name === '.git')));
          childrenRef.current = next;
          writeListingMemory(scope, next, errorsRef.current);
          return next;
        });
        setErrors((m) => {
          if (!m.has(path)) return m;
          const next = new Map(m); next.delete(path);
          errorsRef.current = next;
          writeListingMemory(scope, childrenRef.current, next);
          return next;
        });
      } else {
        setErrors((m) => {
          const next = new Map(m).set(path, r.error ?? 'could not read this directory');
          errorsRef.current = next;
          writeListingMemory(scope, childrenRef.current, next);
          return next;
        });
      }
    } catch (e: unknown) {
      setErrors((m) => {
        const next = new Map(m).set(path, e instanceof Error ? e.message : String(e));
        errorsRef.current = next;
        writeListingMemory(scope, childrenRef.current, next);
        return next;
      });
    } finally {
      inflight.current.delete(path);
      setLoading((s) => { const n = new Set(s); n.delete(path); return n; });
    }
  }, [vpsId, cwd, isRepo, children, scope]);

  // Switching workspace restores both the opened paths and its already-read
  // directory listings. Entity switches within one workspace therefore do no
  // SSH round-trip and show no empty/loading flash.
  useEffect(() => {
    const saved = readListingMemory(scope);
    childrenRef.current = saved.children;
    errorsRef.current = saved.errors;
    setChildren(saved.children);
    setExpanded(readExpanded(scope));
    setErrors(saved.errors);
    inflight.current.clear();
    revealedRef.current = null;
    expandedForRef.current = null;
  }, [scope]);
  useEffect(() => {
    const restored = readTreeSelection(selectionScope);
    setSelected(restored.selected);
    selectionAnchor.current = restored.anchor;
  }, [selectionScope]);
  useEffect(() => { void load(''); }, [load]);

  useEffect(() => {
    if (!cwd) return;
    const base = cwd.replace(/\/$/, '');
    return subscribeFsChanged((changedVpsId, paths) => {
      if (changedVpsId !== vpsId) return;
      const dirs = new Set<string>();
      for (const absolute of paths) {
        if (absolute !== base && !absolute.startsWith(base + '/')) continue;
        const relative = absolute.slice(base.length).replace(/^\//, '');
        const slash = relative.lastIndexOf('/');
        dirs.add(slash < 0 ? '' : relative.slice(0, slash));
      }
      for (const dir of dirs) void load(dir, true);
    });
  }, [vpsId, cwd, load]);

  // List what was restored. Without this the tree would claim those folders
  // are open and show nothing under them until each was clicked again.
  // Converges: every listing adds a key to `children`, a failure adds one to
  // `errors`, and both are checked here.
  useEffect(() => {
    for (const p of expanded) {
      if (p && !children.has(p) && !errors.has(p)) void load(p);
    }
  }, [expanded, children, errors, load]);

  // Reveal the open file: every folder on the way to it opens, so the tree
  // always shows where you are instead of making you find it again. Each
  // ancestor is listed directly — `fs_list` takes any path under the root, so
  // there is no need to walk down one level at a time.
  //
  // ONCE per file, tracked in a ref. Re-running it on every listing would
  // re-open the ancestors of the open file a beat after someone collapsed
  // them, which makes that folder impossible to close.
  useEffect(() => {
    if (!activeFile || expandedForRef.current === activeFile) return;
    expandedForRef.current = activeFile;
    const parts = activeFile.split('/');
    parts.pop();
    if (!parts.length) return;
    const dirs: string[] = [];
    let acc = '';
    for (const p of parts) { acc = acc ? `${acc}/${p}` : p; dirs.push(acc); }
    setExpanded((s) => {
      let next = s;
      for (const d of dirs) {
        if (next.has(d)) continue;
        if (next === s) next = new Set(s);
        next.add(d);
      }
      // Same memory as a manual expansion: arriving from a search hit and
      // arriving by clicking through the tree leave the same trail.
      if (next !== s) writeExpanded(scope, next);
      return next;
    });
    for (const d of dirs) void load(d);
    // `load` is deliberately not a dependency — see the once-per-file guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, scope]);

  // Scroll to it — but only when the file CHANGES. Doing it on every render
  // would yank the tree back while someone is scrolling through it.
  useEffect(() => {
    if (!activeFile) { revealedRef.current = null; return; }
    if (revealedRef.current === activeFile) return;
    const el = activeRowRef.current;
    if (!el) return;  // its folders are still loading — a later render retries
    revealedRef.current = activeFile;
    el.scrollIntoView({ block: 'nearest' });
  });

  // Something changed on disk (an agent finished a turn, a commit landed) —
  // re-list only the directories currently OPEN. Keyed on the changed-file
  // signature rather than a timer: the tree is a view of the filesystem, and
  // the git status is the cheapest change signal we already pay for.
  const changeSig = useMemo(
    () => (workspace?.repos ?? [])
      .flatMap((r) => r.files.map((f: GitFileEntry) => r.root + f.status + f.path))
      .join('|'),
    [workspace],
  );
  const firstSig = useRef(true);
  useEffect(() => {
    if (firstSig.current) { firstSig.current = false; return; }
    for (const p of expanded) if (children.has(p)) void load(p, true);
    // `expanded`/`children` are read, not tracked: this must fire on a disk
    // change, not every time a folder is opened (which loads itself anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeSig]);

  // Not the updater form: this runs from a click, so `expanded` is current,
  // and the persistence belongs next to the decision rather than in an effect
  // that would also fire on the reset commit — where `expanded` is still the
  // PREVIOUS tree's and `scope` is already the new one.
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else { next.add(path); void load(path); }
    setExpanded(next);
    writeExpanded(scope, next);
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
  const visiblePaths = useMemo(() => rows.map((row) => row.path), [rows]);

  // A file opened from a restored tab is the natural first endpoint for a
  // Shift selection even before the user has clicked inside this tree.
  useEffect(() => {
    if (!activeFile) return;
    setSelected((current) => {
      if (current.size) return current;
      const next = new Set([activeFile]);
      writeTreeSelection(selectionScope, next, activeFile);
      selectionAnchor.current = activeFile;
      return next;
    });
  }, [activeFile, selectionScope]);

  /** The folder a row LIVES in. */
  const parentOf = (row: Row): string => {
    const cut = row.path.lastIndexOf('/');
    return cut === -1 ? '' : row.path.slice(0, cut);
  };
  /** Directory a create action should act in: the row's folder, or the row's
   *  own path when it IS a folder. */
  const dirOf = (row: Row | null): string => (!row ? '' : row.dir ? row.path : parentOf(row));
  const reload = (dir: string) => {
    void load(dir, true);
    if (dir) void load('', true);
  };
  /** Open a dialog. The menu closes first — it sits at z-index 400, above the
   *  modal backdrop, and would otherwise stay clickable over it. */
  const openDialog = (d: Dialog) => { setMenu(null); setDialog(d); };

  /**
   * Run one fs mutation, refresh the affected directory, close the dialog.
   * THROWS on a refused op (`ok:false`) so the dialog that called it stays
   * open and shows why — "already exists" is a correction, not a dead end.
   */
  async function runOp(fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>, dir: string) {
    const r = await fn();
    if (!r.ok) throw new Error(r.error ?? 'failed');
    reload(dir);
    setDialog(null);
  }

  async function submitCreate(dir: string, folder: boolean, name: string) {
    if (!vpsId || !cwd) return;
    const rel = dir ? `${dir}/${name}` : name;
    if (folder) {
      await runOp(() => api.fsOp(vpsId, { root: cwd, op: 'mkdir', path: rel }), dir);
    } else {
      // expectedSha256:'' means "this must not exist yet" — creating a file must
      // never silently truncate one an agent just wrote.
      await runOp(() => api.writeFsFile(vpsId, { root: cwd, path: rel, content: '', expectedSha256: '' })
        .then((r) => (r.reason === 'stale' ? { ok: false, error: 'a file with that name already exists' } : r)),
        dir);
    }
  }
  async function submitRename(row: Row, dir: string, next: string) {
    if (!vpsId || !cwd) return;
    if (next === row.name) { setDialog(null); return; }
    await runOp(() => api.fsOp(vpsId, { root: cwd, op: 'rename', path: row.path, to: dir ? `${dir}/${next}` : next }), dir);
  }
  async function createInstructionSymlink(row: Row, linkName: string) {
    if (!vpsId || !cwd) return;
    const dir = parentOf(row);
    const linkPath = dir ? `${dir}/${linkName}` : linkName;
    // This action is non-destructive and needs no confirmation. Close the menu
    // immediately, then surface a race/refusal inline above the tree; the agent
    // is authoritative and never replaces an existing counterpart.
    setMenu(null);
    setOpError(null);
    try {
      const result = await api.fsOp(vpsId, {
        root: cwd,
        op: 'symlink',
        path: row.path,
        to: linkPath,
      });
      if (!result.ok) throw new Error(result.error ?? 'could not create symlink');
      reload(dir);
    } catch (e: unknown) {
      setOpError(`${linkPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function startDelete(rowsToDelete: Row[]) {
    if (!vpsId || !cwd) return;
    // A selected folder subsumes selected descendants. Removing those calls is
    // important: otherwise the parent succeeds and every child falsely fails
    // as "missing" immediately afterwards.
    const targets = collapseTreeDeletePaths(rowsToDelete);
    if (!targets.length) return;
    setDialog(null);
    setOpError(null);
    setDeletingPaths((current) => new Set([...current, ...targets.map((row) => row.path)]));
    // It is no longer an actionable selection; the red pending state is the
    // visual ownership until completion.
    setSelected((current) => {
      const next = new Set([...current].filter((path) =>
        !targets.some((row) => path === row.path || path.startsWith(`${row.path}/`)),
      ));
      writeTreeSelection(selectionScope, next, selectionAnchor.current);
      return next;
    });

    void Promise.all(targets.map(async (row) => {
      try {
        const result = await api.fsOp(vpsId, {
          root: cwd, op: 'delete', path: row.path, recursive: row.dir,
        });
        return { row, result, error: result.ok ? null : (result.error ?? 'failed') };
      } catch (e: unknown) {
        return { row, result: null, error: e instanceof Error ? e.message : String(e) };
      }
    })).then((results) => {
      const failed = results.filter((result) => result.error != null);
      const affectedDirs = new Set(targets.map(parentOf));
      for (const dir of affectedDirs) reload(dir);
      if (failed.length) {
        const first = failed[0];
        setOpError(failed.length === 1
          ? `${first.row.path}: ${first.error}`
          : `${failed.length} items could not be deleted (first: ${first.row.path}: ${first.error})`);
      }
    }).finally(() => {
      setDeletingPaths((current) => {
        const next = new Set(current);
        for (const row of targets) next.delete(row.path);
        return next;
      });
    });
  }
  /** What the agent needs to act on this row: the path as it exists ON the VPS.
   *  `row.path` is relative to the session cwd. */
  const absPathOf = (row: Row): string => `${cwd}/${row.path}`;
  /**
   * Open one file's history. The repo is resolved from the workspace snapshot
   * we already poll: with several checkouts under one cwd (§14.83) the file
   * belongs to whichever root contains it, and `git log` has to run there.
   */
  const openHistory = (row: Row) => {
    const owner = repoForPath(workspace, absPathOf(row));
    if (!owner) return;
    setHistory({ path: owner.rel, repo: owner.repo });
  };

  async function copyPath(row: Row, absolute: boolean) {
    const text = absolute ? absPathOf(row) : row.path;
    // The clipboard API needs a secure context and a permission; when it is
    // refused, fall back to a dialog holding the preselected text rather than
    // to `prompt()`.
    try { await navigator.clipboard.writeText(text); setMenu(null); }
    catch { openDialog({ kind: 'copy', text }); }
  }

  // ── Dropping OS files onto the tree ───────────────────────────────────────
  // VS Code's gesture: the folder under the pointer is the destination (a
  // file row means ITS folder, the blank space the root), a collapsed folder
  // held under the pointer springs open, and the file keeps its own name.
  // Nothing reaches the chat: that is the other drop target (§14.73).
  const clearSpring = () => {
    if (springTimer.current) clearTimeout(springTimer.current);
    springTimer.current = null;
    setSpringPath(null);
  };
  /** Updater form: this runs from a timer, where `expanded` is stale. */
  const openFolder = (path: string) => {
    setExpanded((current) => {
      if (current.has(path)) return current;
      const next = new Set(current).add(path);
      writeExpanded(scope, next);
      return next;
    });
    void load(path);
  };
  // The pointer left this tree (or the drag ended): forget the target.
  useEffect(() => {
    if (overZone) return;
    setDropDir(null);
    if (springTimer.current) clearTimeout(springTimer.current);
    springTimer.current = null;
    setSpringPath(null);
  }, [overZone]);
  useEffect(() => () => { if (springTimer.current) clearTimeout(springTimer.current); }, []);

  const dropTargetOf = (target: EventTarget | null): { dir: string; spring: string | null } => {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-drop-dir]') : null;
    const row = el?.dataset.dropFolder === '1' ? el.dataset.dropRow ?? null : null;
    return { dir: el?.dataset.dropDir ?? '', spring: row && !expanded.has(row) ? row : null };
  };
  const onZoneDragOver = (e: React.DragEvent) => {
    if (!isOsFileDrag(e.dataTransfer)) return;
    // Mandatory for the drop to fire at all, as in the chat.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { dir, spring } = dropTargetOf(e.target);
    if (dir !== dropDir) setDropDir(dir);
    if (spring === springPath) return;
    if (springTimer.current) clearTimeout(springTimer.current);
    springTimer.current = null;
    setSpringPath(spring);
    if (spring) {
      springTimer.current = setTimeout(() => {
        springTimer.current = null;
        setSpringPath(null);
        openFolder(spring);
      }, SPRING_OPEN_MS);
    }
  };
  const onZoneDrop = (e: React.DragEvent) => {
    if (!isOsFileDrag(e.dataTransfer)) return;
    // No stopPropagation: the chat's window listener must still see the drop
    // to close its overlay — it ignores anything released over the panel.
    e.preventDefault();
    const { dir } = dropTargetOf(e.target);
    // Synchronously: the DataTransfer is emptied once this handler returns.
    const roots = captureDrop(e.dataTransfer);
    clearSpring();
    setDropDir(null);
    void prepareUpload(dir, roots);
  };

  /** Queue it, or — when nothing is left to send — just say why. */
  const queueUpload = (u: PendingUpload, overwrite?: Set<string>) => {
    if (!vpsId || !cwd) return;
    const sending = u.plan.files.filter((f) => !u.skip.has(f.rel)).length;
    if (!sending && !u.mkdirs.length) {
      if (u.errors.length) setOpError(`${u.errors[0].path}: ${u.errors[0].error}`);
      return;
    }
    enqueueUpload({ vpsId, root: cwd, ...u, overwrite });
  };

  /**
   * Walk the drop, then ask the VPS which names are taken — ONCE, before a
   * byte moves, so a conflict is a question and not a failure halfway through.
   * The agent re-checks atomically when each file commits, so a file created
   * in the meantime is still refused rather than clobbered.
   */
  async function prepareUpload(targetDir: string, roots: DroppedRoot[]) {
    if (!vpsId || !cwd || !roots.length) return;
    setOpError(null);
    // Show where it lands: the files appear inside as they arrive.
    if (targetDir) openFolder(targetDir);
    try {
      const plan = await planDrop(roots);
      if (!plan.files.length && !plan.dirs.length) return;
      const at = (rel: string) => joinRel(targetDir, rel);
      const check = await api.fsUpload(vpsId, {
        op: 'check', root: cwd, paths: [...plan.dirs, ...plan.files.map((f) => f.rel)].map(at),
      });
      if (!check.ok) { setOpError(check.error ?? 'could not check the destination'); return; }
      const existing = new Map((check.existing ?? []).map((x) => [x.path, x.dir]));
      const under = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);
      // A FILE sits where a dropped folder must go: that subtree cannot land.
      const blocked = plan.dirs.filter((d) => existing.get(at(d)) === false);
      const isBlocked = (rel: string) => blocked.some((d) => under(rel, d));
      const errors = blocked
        .filter((d) => !blocked.some((o) => o !== d && under(d, o)))
        .map((d) => ({ path: at(d), error: 'a file already has this name, so the folder was not uploaded' }));
      const skip = new Set<string>();
      const conflicts: string[] = [];
      for (const f of plan.files) {
        const ex = existing.get(at(f.rel));
        if (isBlocked(f.rel)) skip.add(f.rel);
        else if (ex === true) {
          skip.add(f.rel);
          errors.push({ path: at(f.rel), error: 'a folder already has this name' });
        } else if (ex === false) conflicts.push(f.rel);
      }
      const pending: PendingUpload = {
        targetDir, plan, skip, errors,
        mkdirs: plan.dirs.filter((d) => !existing.has(at(d)) && !isBlocked(d)),
      };
      if (conflicts.length) setDialog({ kind: 'upload-conflict', upload: pending, conflicts });
      else queueUpload(pending);
    } catch (e: unknown) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  // Select what landed, once per upload, like a paste in VS Code.
  useEffect(() => {
    for (const job of uploads) {
      if (job.status !== 'done' || revealedUploads.has(job.id)) continue;
      revealedUploads.add(job.id);
      if (job.landed.length) replaceSelection(new Set(job.landed), job.landed[job.landed.length - 1]);
    }
  }, [uploads, replaceSelection]);

  /** Keep it a NAME, not a path: the create/rename routes would happily take
   *  `../x`, and the agent would refuse it one round trip later. */
  const validName = (v: string): string | null => {
    if (v === '.' || v === '..') return 'that name is reserved';
    if (v.includes('/')) return 'a name cannot contain "/"';
    return null;
  };

  // A visible row's parent has necessarily been listed, so the same snapshot
  // tells us whether its conventional sibling already exists. A later race is
  // harmless: fs_symlink uses lexists and refuses to clobber it.
  const instructionSymlink = menu?.row && menu.rows.length === 1 && !menu.row.dir
    ? missingInstructionSymlink(
      menu.row.name,
      (children.get(parentOf(menu.row)) ?? []).map((entry) => entry.name),
    )
    : null;

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

  const rootName = cwd.split('/').filter(Boolean).pop() ?? cwd;
  return (
    <div ref={zoneRef}
         {...{ [UPLOAD_ZONE_ATTR]: '' }}
         className={`tree-tab${osDrag.active ? ' fs-drop-armed' : ''}${overZone ? ' fs-drop-over' : ''}`}
         onDragEnter={(e) => { if (isOsFileDrag(e.dataTransfer)) e.preventDefault(); }}
         onDragOver={onZoneDragOver}
         onDrop={onZoneDrop}
         onContextMenu={(e) => {
           e.preventDefault();
           replaceSelection(new Set(), null);
           setMenu({ x: e.clientX, y: e.clientY, row: null, rows: [] });
         }}>
      {/* While a file is dragged over the window the header becomes the
          legend of this drop target: laid OVER its usual content, which
          stays in the flow so no row moves under the pointer, and pinned
          while the tree scrolls. */}
      <div className="tt-head" data-drop-dir="">
        <span className="tt-root" title={cwd}>{rootName}</span>
        <span className="gt-spacer" />
        <button className="gt-mini" onClick={() => {
          const empty = new Map<string, FsEntry[]>();
          childrenRef.current = empty;
          setChildren(empty);
          writeListingMemory(scope, empty, errorsRef.current);
          void load('', true);
        }}
          title="reload the tree">↻</button>
        {osDrag.active && (
          <span className="tt-drop-legend">
            <IconUpload className="tt-drop-ico" />
            {overZone && dropDir != null ? (
              <>
                <span className="tt-drop-title">upload to <b>{dropDir || rootName}/</b></span>
                <span className="tt-drop-sub">{springPath ? 'opening…' : 'keeps its name'}</span>
              </>
            ) : (
              <>
                <span className="tt-drop-title">upload to the server</span>
                <span className="tt-drop-sub">drop on a folder</span>
              </>
            )}
          </span>
        )}
      </div>
      {opError && (
        <div className="tt-op-error" role="alert">
          <span>{opError}</span>
          <button type="button" onClick={() => setOpError(null)} aria-label="dismiss file operation error">×</button>
        </div>
      )}

      {menu && (
        <>
          <div className="tt-menu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            ref={menuRef}
            className="tt-menu"
            style={{
              left: menuPos?.menu === menu ? menuPos.left : menu.x,
              top: menuPos?.menu === menu ? menuPos.top : menu.y,
              visibility: menuPos?.menu === menu ? 'visible' : 'hidden',
            }}
          >
            {/* What the menu acts on. Without it the row-less menu (right-click
                on the empty space below the rows) gave no clue that "New File"
                lands in the ROOT and not in whatever was last clicked. */}
            <div className="tt-menu-head" title={menu.row ? menu.row.path : cwd}>
              <IconForKind kind={fileKind(menu.row?.name ?? '', menu.row ? menu.row.dir : true)} open={!menu.row} />
              <span>{menu.rows.length > 1
                ? `${menu.rows.length} items selected`
                : menu.row ? menu.row.name : (cwd.split('/').filter(Boolean).pop() ?? cwd)}</span>
            </div>
            {/* The instruction-file bridge is exceptional and intentionally
                first: it appears only on the one row it can act on, in its own
                section rather than buried among ordinary rename/delete ops. */}
            {instructionSymlink && menu.row && (
              <>
                <button
                  title={`${instructionSymlink} → ${menu.row.name}`}
                  onClick={() => void createInstructionSymlink(menu.row!, instructionSymlink)}
                >
                  <IconSymlink />Create {instructionSymlink} Symlink
                </button>
                <div className="tt-menu-sep" />
              </>
            )}
            {menu.rows.length <= 1 && (
              <>
                <a
                  href={api.fsFileUrl(vpsId, cwd, menu.row?.path ?? '.', {
                    archive: !menu.row || menu.row.dir ? 'zip' : undefined,
                  })}
                  download={!menu.row
                    ? `${cwd.split('/').filter(Boolean).pop() ?? 'folder'}.zip`
                    : menu.row.dir ? `${menu.row.name}.zip` : menu.row.name}
                  onClick={() => setMenu(null)}
                >
                  <IconDownload />{!menu.row || menu.row.dir ? 'Download as ZIP' : 'Download'}
                </a>
                <div className="tt-menu-sep" />
              </>
            )}
            {menu.rows.length <= 1 && <>
              <button onClick={() => openDialog({ kind: 'create', dir: dirOf(menu.row), folder: false })}>
                <IconFilePlus />New File…
              </button>
              <button onClick={() => openDialog({ kind: 'create', dir: dirOf(menu.row), folder: true })}>
                <IconFolderPlus />New Folder…
              </button>
            </>}
            {menu.row && menu.rows.length === 1 && <>
              <div className="tt-menu-sep" />
              {/* The drag gesture's equivalent for touch, where HTML5 drag and
                  drop does not exist at all — and the panel is a drawer over
                  the chat there, so there is nowhere to drag TO either. */}
              {onInsertPath && (
                <button onClick={() => { onInsertPath(absPathOf(menu.row!)); setMenu(null); }}>
                  <IconInsert />Insert Into Message
                </button>
              )}
              {!menu.row.dir && (
                <button onClick={() => { openHistory(menu.row!); setMenu(null); }}>
                  <IconClockHistory />File History…
                </button>
              )}
              <button onClick={() => copyPath(menu.row!, false)}><IconCopy />Copy Relative Path</button>
              <button onClick={() => copyPath(menu.row!, true)}><IconCopy />Copy Full Path</button>
              <div className="tt-menu-sep" />
              <button onClick={() => openDialog({ kind: 'rename', row: menu.row!, dir: parentOf(menu.row!) })}>
                <IconRename />Rename…
              </button>
              <button className="danger" onClick={() => openDialog({ kind: 'delete', rows: menu.rows })}>
                <IconDelete />Delete
              </button>
            </>}
            {menu.rows.length > 1 && (
              <button className="danger" onClick={() => openDialog({ kind: 'delete', rows: menu.rows })}>
                <IconDelete />Delete {menu.rows.length} Items
              </button>
            )}
          </div>
        </>
      )}

      {dialog?.kind === 'create' && (
        <PromptModal
          title={dialog.folder ? 'new folder' : 'new file'}
          icon={dialog.folder ? <IconFolder /> : <IconFileEarmark />}
          hint={<>in <b>{dialog.dir || (cwd.split('/').filter(Boolean).pop() ?? cwd)}</b></>}
          placeholder={dialog.folder ? 'components' : 'route.ts'}
          confirmLabel="create"
          busyLabel="creating…"
          validate={validName}
          onSubmit={(name) => submitCreate(dialog.dir, dialog.folder, name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <PromptModal
          title="rename"
          icon={<IconPencil />}
          hint={dialog.row.path}
          initial={dialog.row.name}
          // The extension is rarely what changes, and re-typing it is where a
          // rename goes wrong.
          select={dialog.row.dir ? 'all' : 'stem'}
          confirmLabel="rename"
          busyLabel="renaming…"
          validate={validName}
          onSubmit={(next) => submitRename(dialog.row, dialog.dir, next)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title={dialog.rows.length > 1
            ? `delete ${dialog.rows.length} items`
            : dialog.rows[0].dir ? 'delete folder' : 'delete file'}
          confirmLabel={dialog.rows.length > 1 ? `delete ${dialog.rows.length}` : 'delete'}
          busyLabel="deleting…"
          confirmOnEnter
          onConfirm={() => startDelete(dialog.rows)}
          onClose={() => setDialog(null)}
        >
          {dialog.rows.length === 1 ? (
            <div className="confirm-target">
              <span className="ct-name">{dialog.rows[0].name}</span>
              <span className="ct-sub">{cwd}/{dialog.rows[0].path}</span>
            </div>
          ) : (
            <ul className="confirm-list">
              {dialog.rows.map((row) => <li key={row.path} title={`${cwd}/${row.path}`}>{row.path}</li>)}
            </ul>
          )}
          <p className="confirm-text">
            {dialog.rows.some((row) => row.dir) ? 'Selected folders and everything in them will be deleted. ' : ''}
            It is not undoable from here, and an agent may be working in this tree.
          </p>
        </ConfirmModal>
      )}
      {dialog?.kind === 'upload-conflict' && (() => {
        const { upload, conflicts } = dialog;
        const at = (rel: string) => joinRel(upload.targetDir, rel);
        const sendable = upload.plan.files.filter((f) => !upload.skip.has(f.rel)).length;
        return (
          <ConfirmModal
            title={conflicts.length > 1 ? `${conflicts.length} files already exist` : 'file already exists'}
            icon={<IconUpload />}
            confirmLabel={conflicts.length > 1 ? `replace ${conflicts.length}` : 'replace'}
            // Only a real choice when something else would still go up.
            secondary={sendable > conflicts.length || upload.mkdirs.length
              ? {
                label: 'skip existing',
                onClick: () => {
                  queueUpload({ ...upload, skip: new Set([...upload.skip, ...conflicts]) });
                  setDialog(null);
                },
              }
              : undefined}
            onConfirm={() => { queueUpload(upload, new Set(conflicts)); setDialog(null); }}
            onClose={() => setDialog(null)}
          >
            {conflicts.length === 1 ? (
              <div className="confirm-target">
                <span className="ct-name">{conflicts[0].split('/').pop()}</span>
                <span className="ct-sub">{cwd}/{at(conflicts[0])}</span>
              </div>
            ) : (
              <ul className="confirm-list">
                {conflicts.map((rel) => <li key={rel} title={`${cwd}/${at(rel)}`}>{at(rel)}</li>)}
              </ul>
            )}
            <p className="confirm-text">
              Replacing overwrites {conflicts.length > 1 ? 'these files' : 'it'} on the server.
              It is not undoable from here, and an agent may be working in this tree.
            </p>
          </ConfirmModal>
        );
      })()}
      {dialog?.kind === 'copy' && (
        <PromptModal
          title="copy path"
          icon={<IconClipboard />}
          hint="the clipboard is not available here — copy it by hand"
          initial={dialog.text}
          readOnly
          confirmLabel="done"
          onSubmit={() => setDialog(null)}
          onClose={() => setDialog(null)}
        />
      )}

      {rows.length === 0 ? (
        <div className={`tp-empty${overZone && dropDir === '' ? ' drop-root' : ''}`}>this folder is empty</div>
      ) : (
        <ul className={`tt-rows${overZone && dropDir === '' ? ' drop-root' : ''}`}>
          {rows.map((r) => {
            const deco = decorations.get(r.path);
            const st = deco ? fileStatusLabel(deco) : null;
            const kind = fileKind(r.name, r.dir);
            const isOpen = r.dir && expanded.has(r.path);
            const busy = loading.has(r.path);
            const err = errors.get(r.path);
            // Absolute path: the activity map is per VPS, not per tree root.
            const act = r.dir ? undefined : activity.get(`${cwd}/${r.path}`);
            const isActive = !r.dir && r.path === activeFile;
            const isSelected = selected.has(r.path);
            const isDeleting = [...deletingPaths].some((path) =>
              r.path === path || r.path.startsWith(`${path}/`),
            );
            // The destination folder and everything shown inside it, as one
            // block — the "it goes in HERE" of VS Code's explorer.
            const inDrop = overZone && !!dropDir
              && (r.path === dropDir || r.path.startsWith(`${dropDir}/`));
            const dropCls = inDrop ? (r.path === dropDir ? ' drop-target' : ' drop-in') : '';
            return (
              <li key={r.path}>
                <button
                  ref={isActive ? activeRowRef : undefined}
                  aria-current={isActive ? 'true' : undefined}
                  aria-pressed={isSelected}
                  aria-busy={isDeleting || undefined}
                  disabled={isDeleting}
                  className={`tt-row ${r.dir ? 'is-dir' : 'is-file'}${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}${isDeleting ? ' deleting' : ''}${r.entry.ignored ? ' ignored' : ''}${st ? ' g-' + st.cls : ''}${dropCls}${springPath === r.path ? ' drop-spring' : ''}`}
                  style={{ paddingLeft: 4 + r.depth * 11 }}
                  // Where a file dropped on this row lands: the folder
                  // itself, or the folder a file row lives in.
                  data-drop-dir={r.dir ? r.path : parentOf(r)}
                  data-drop-row={r.path}
                  data-drop-folder={r.dir ? '1' : undefined}
                  // Drag a row into the chat to put its path in the message.
                  // Only when there IS a chat to drop on: beside the file
                  // editor the same panel renders without `onInsertPath`, and
                  // a drag that can land nowhere is worse than no drag.
                  // The click/double-click gestures above survive because the
                  // browser only starts a drag past its own move threshold,
                  // and a completed drag suppresses the click.
                  draggable={!!onInsertPath}
                  onDragStart={(e) => {
                    if (!onInsertPath) return;
                    setPathDrag(e.dataTransfer, absPathOf(r));
                    setDragPath(r.path);
                  }}
                  onDragEnd={() => setDragPath(null)}
                  data-dragging={dragPath === r.path ? '' : undefined}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    const toggleSelection = e.ctrlKey || e.metaKey;
                    const rangeSelection = e.shiftKey;
                    pressedSelection.current = isTreeSelectionOnly({
                      toggle: toggleSelection, range: rangeSelection,
                    }) ? { path: r.path, toggle: toggleSelection, range: rangeSelection } : null;
                  }}
                  onClick={(e) => {
                    const pressed = pressedSelection.current?.path === r.path
                      ? pressedSelection.current : null;
                    pressedSelection.current = null;
                    const toggleSelection = pressed?.toggle ?? (e.ctrlKey || e.metaKey);
                    const rangeSelection = pressed?.range ?? e.shiftKey;
                    const selectionOnly = isTreeSelectionOnly({
                      toggle: toggleSelection, range: rangeSelection,
                    });
                    lastClickWasSelectionOnly.current = selectionOnly;
                    const next = selectTreeRow(
                      visiblePaths, selected, selectionAnchor.current, r.path,
                      { toggle: toggleSelection, range: rangeSelection },
                    );
                    replaceSelection(next.selected, next.anchor);
                    // Modifier clicks are selection gestures, not navigation:
                    // in particular, Shift-clicking a folder inside a range
                    // must not collapse the rows that were just selected.
                    if (selectionOnly) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    if (r.dir) toggle(r.path);
                    else openFile(r.path, false);
                  }}
                  onDoubleClick={(e) => {
                    const selectionOnly = lastClickWasSelectionOnly.current
                      || isTreeSelectionOnly({
                        toggle: e.ctrlKey || e.metaKey, range: e.shiftKey,
                      });
                    lastClickWasSelectionOnly.current = false;
                    if (selectionOnly) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    if (!r.dir) openFile(r.path, true);
                  }}
                  onContextMenu={(e) => {
                    // stopPropagation, or the container's handler below runs
                    // straight after and replaces this with a row-less menu.
                    e.preventDefault(); e.stopPropagation();
                    const contextRows = selected.has(r.path)
                      ? rows.filter((row) => selected.has(row.path))
                      : [r];
                    if (!selected.has(r.path)) {
                      replaceSelection(new Set([r.path]), r.path);
                    }
                    setMenu({ x: e.clientX, y: e.clientY, row: r, rows: contextRows });
                  }}
                  title={err
                    ? `${r.path} — ${err}`
                    : `${r.path}${st ? ` · ${st.label}` : ''}${r.entry.ignored ? ' · git-ignored' : ''} · Ctrl/Cmd-click to add, Shift-click for a range`}
                >
                  <span className="tt-caret">{r.dir ? (busy ? '·' : isOpen ? '▾' : '▸') : ''}</span>
                  <IconForKind kind={kind} open={isOpen} className="tt-ico" />
                  <span className="tt-name">{r.name}</span>
                  {isDeleting && <span className="tt-deleting">deleting…</span>}
                  {/* Where it points, not just THAT it points: a link whose
                      destination needs an ssh session to read is one nobody
                      reads. `title` is the whole affordance — the icon is
                      10px wide and carries no other label. */}
                  {r.entry.symlink && (
                    <span className="tt-link"
                          title={r.entry.linkTarget ? `symlink → ${r.entry.linkTarget}` : 'symlink'}>↗</span>
                  )}
                  {/* Files carry the letter; folders carry only the colour, so
                      the gutter stays a single column of real changes. */}
                  {st && !r.dir && <span className="tt-st">{deco}</span>}
                  {/* An agent is in this file RIGHT NOW. A span, not a nested
                      <button> (invalid inside the row's button): the click is
                      intercepted before the row's own handler runs. */}
                  {act && (
                    <span
                      className={`tt-act ${act.kind}`}
                      role="button"
                      tabIndex={-1}
                      title={activityLabel(act)}
                      onClick={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (act.sessionId) onOpenSession?.(act.sessionId);
                      }}
                    >{act.kind === 'write' ? <IconPencil /> : <IconEye />}</span>
                  )}
                  {err && <span className="tt-err" title={err}>!</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Progress lives UNDER the rows: a line appearing or expiring above
          them would shift every row under a pointer that is mid-drag. */}
      {uploads.length > 0 && (
        <div className="tt-uploads">
          {uploads.map((job) => <UploadLine key={job.id} job={job} rootName={rootName} />)}
        </div>
      )}

      {history && (
        <HistoryModal
          vpsId={vpsId!}
          cwd={cwd!}
          repo={history.repo}
          path={history.path}
          label={history.path}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

/** One drop's progress, pinned at the foot of the tree until it settles. */
function UploadLine({ job, rootName }: { job: UploadJob; rootName: string }) {
  const live = job.status === 'running' || job.status === 'queued';
  const pct = job.totalBytes > 0
    ? Math.min(100, Math.floor((job.sentBytes / job.totalBytes) * 100))
    : job.fileCount ? Math.floor((job.filesDone / job.fileCount) * 100) : 0;
  const dest = `${job.targetDir || rootName}/`;
  const first = job.errors[0];
  let text: string;
  if (job.status === 'queued') text = `waiting — ${job.label} → ${dest}`;
  else if (job.status === 'running') {
    const name = job.current?.split('/').pop() ?? job.label;
    text = `${name} → ${dest}${job.fileCount > 1 ? ` · ${Math.min(job.filesDone + 1, job.fileCount)}/${job.fileCount}` : ''}`;
  } else if (job.status === 'cancelled') text = `upload of ${job.label} cancelled`;
  else if (first) {
    text = job.errors.length === 1
      ? `${first.path}: ${first.error}`
      : `${job.errors.length} items failed — ${first.path}: ${first.error}`;
  } else text = `uploaded ${job.label} to ${dest}${job.skipped ? ` · ${job.skipped} existing file${job.skipped > 1 ? 's' : ''} kept` : ''}`;
  return (
    <div className={`tt-upload is-${job.status}${first ? ' has-errors' : ''}`} role="status" title={text}>
      <IconUpload className="tt-upload-ico" />
      <span className="tt-upload-text">{text}</span>
      {live && <span className="tt-upload-pct">{pct}%</span>}
      <button
        type="button"
        onClick={() => (live ? cancelUploadJob(job.id) : dismissUploadJob(job.id))}
        title={live ? 'cancel the upload' : 'dismiss'}
        aria-label={live ? 'cancel the upload' : 'dismiss'}
      >×</button>
      {live && <span className="tt-upload-bar" style={{ width: `${pct}%` }} />}
    </div>
  );
}
