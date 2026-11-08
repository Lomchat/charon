'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import type { FsLinkInfo, FsReadResponse } from '@/lib/types/api';
import { fmtSize } from './sessionAttachments';
import { setTabDirty } from './tabStore';
import { gitDiffTargetForPath, refreshGit, repoForPath, useGitStatus } from './gitStore';
import { subscribeReveal, subscribeView } from './revealLine';
import { lspLabel, useLsp } from './useLsp';
import {
  flattenSymbols, requestFormat, requestRename, type FlatSymbol,
} from './lspClient';
import LspPicker from './LspPicker';
import HistoryModal from './HistoryModal';
import DiffViewerModal from './DiffViewerModal';
import {
  IconBoxArrowUpRight, IconClockHistory, IconDiff, IconDownload, IconFullscreen, IconFullscreenExit,
} from './icons';
import PromptModal from './PromptModal';
import { subscribeFsChanged } from './fsChangeBus';
import type { LspDiagnostic, LspLocation } from '@/lib/types/api';
import CsvViewer from './CsvViewer';
import HtmlLiveView from './HtmlLiveView';
import { BytesView, HexViewer, LogViewer, TextView } from './FileViewers';
import { hasStandaloneView, standaloneViewUrl, viewerFor, type ViewerKind } from './fileViews';

// ~200KB and touches `document` at construction — never in the main chunk,
// never on the server. A failed lazy import after a deploy is caught by
// ChunkReloadGuard (§14.57).
const CodeEditor = dynamic(() => import('./CodeEditor'), {
  ssr: false,
  loading: () => <div className="dvm-note">loading editor…</div>,
});

/** What each rendered view's toggle says it does. */
const VIEW_TITLES: Partial<Record<ViewerKind, string>> = {
  live: 'Render the page like a browser: styles, scripts, images',
  markdown: 'Read the document rendered: headings, tables, images, diagrams',
  svg: 'Show the drawing', mermaid: 'Draw the diagram', graphviz: 'Draw the graph',
  json: 'Browse the structure: fold, filter, copy paths',
  notebook: 'Read the notebook: cells and their outputs',
  geo: 'Show it on a map',
  log: 'The end of the file, following new lines',
};

type FileView = 'table' | 'text' | 'rendered';
// A file's View/Code choice (HTML's Live, Markdown's View, JSON's Tree…)
// outlives the pane: a reload restarts it, and coming back to a page you were
// reading should not show its source. Browser-local and per file — like
// focus, not like the shared tab set (§14.78). `view` or `code` (`live` is the
// older spelling of `view`); the newest 100 files.
const HTML_VIEW_STORAGE_KEY = 'hub.fileView.v1';
function readHtmlViews(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(HTML_VIEW_STORAGE_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function rememberHtmlView(key: string, view: FileView): void {
  const views = readHtmlViews();
  delete views[key];
  views[key] = view === 'rendered' ? 'view' : 'code';
  const keys = Object.keys(views);
  for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete views[k];
  try { localStorage.setItem(HTML_VIEW_STORAGE_KEY, JSON.stringify(views)); } catch { /* private mode */ }
}

type Props = {
  tabId: string;
  vpsId: string;
  /** Containment root — the tab's group path. */
  root: string;
  /** Path relative to `root`. */
  path: string;
  /** Called on the first edit and on a save: both mean "this is not a preview". */
  onInteract: () => void;
  /** Go-to-definition landed in another file: open it there (§14.89). */
  onOpenLocation?: (absPath: string, line: number) => void;
  /**
   * The pane is the one on screen. Hidden panes stay MOUNTED (§14.111) — the
   * page, the PDF, the zoom, the scroll and the playback position survive a
   * tab switch — but go quiet: no shortcuts, no polling, no language server,
   * media paused.
   */
  active?: boolean;
};

type Conflict = { serverSha: string | null };

/** Stable identity: a fresh [] every render would re-dispatch on every render. */
const EMPTY_DIAGS: LspDiagnostic[] = [];

/**
 * The file pane: read, edit, Ctrl+S.
 *
 * The save is gated on the sha the read returned. That is not belt-and-braces
 * on these boxes — a coding agent may be writing this very file, and an
 * unconditional write would silently discard whichever side was slower. On a
 * mismatch the user gets the choice explicitly (reload / overwrite) instead of
 * one of the two losing quietly.
 *
 * Media and binaries stay read-only: an editor for bytes is a different
 * feature, and pretending otherwise would let someone corrupt a PNG by typing.
 */
export default function FileEditor({ tabId, vpsId, root, path, onInteract, onOpenLocation, active = true }: Props) {
  const [res, setRes] = useState<FsReadResponse | null>(null);
  // Kept apart from `res`: a media file never goes through fs_read, and the
  // header still owes the reader "these bytes live somewhere else".
  const [link, setLink] = useState<FsLinkInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [dirty, setDirty] = useState(false);
  // `docKey` identifies the buffer the editor was built from; bumping it is
  // what makes CodeMirror take a new document (after a reload or a save).
  const [docKey, setDocKey] = useState(0);
  // Where a search hit wants the caret. The nonce is what lets the same line
  // be asked for twice — clicking one result, scrolling away, clicking it
  // again has to move the editor the second time too.
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  // Where the last jump landed — the problem stepper needs a cursor.
  const stepProblemRef = useRef<(d: number) => void>(() => {});
  const revealRef = useRef<number>(0);
  revealRef.current = reveal?.line ?? 0;

  const name = path.split('/').pop() || path;
  // Which viewer this file has (§14.112): a BYTES viewer replaces the editor
  // (no fs_read at all), a TEXT one sits beside it behind View/Code.
  const spec = viewerFor(name);
  const bytesKind = spec?.source === 'bytes' ? spec.kind : null;
  const media = !!bytesKind;
  const tabular = /\.(csv|tsv)$/i.test(name);
  const textView = spec?.source === 'text' ? spec : null;
  const html = textView?.kind === 'live';
  const viewKey = `${vpsId}:${root}:${path}`;
  const defaultView: FileView = tabular ? 'table' : textView?.startInView ? 'rendered' : 'text';
  const [fileView, setFileViewState] = useState<FileView>(() => defaultView);
  // Before paint, never in the initializer: storage does not exist on the
  // server, and a remembered view must not flash the source first.
  useLayoutEffect(() => {
    if (!textView) return;
    const stored = readHtmlViews()[viewKey];
    if (stored === 'view' || stored === 'live') setFileViewState('rendered');
    else if (stored === 'code') setFileViewState('text');
  }, [textView, viewKey]);
  const setFileView = useCallback((v: FileView) => {
    if (textView) rememberHtmlView(viewKey, v);
    setFileViewState(v);
  }, [textView, viewKey]);
  // The view the open gesture asked for wins over the remembered one: a chat
  // link renders, the explorer shows the format's default. A layout effect
  // declared AFTER the storage read, so a parked request lands before paint.
  useLayoutEffect(() => {
    if (media) return;
    return subscribeView(vpsId, root, path, (want) => {
      if (!tabular && !textView) return;
      setFileView(want === 'rendered' ? (tabular ? 'table' : 'rendered') : defaultView);
    });
  }, [media, tabular, textView, defaultView, setFileView, vpsId, root, path]);
  // ── Full screen: THIS pane lifted over the hub, almost edge to edge ───────
  // Offered where New tab is (a rendered document), and like New tab it shows
  // the document, never its source: the rendered view is FORCED while open
  // only — closing gives back the view the pane had, the remembered choice
  // untouched. The same element restyled, never a copy in a portal: the live
  // page, the PDF's zoom and place, the playback and the unsaved edits all
  // stay (a moved iframe would reload, §14.111).
  const standalone = hasStandaloneView(name);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!active || !standalone) setExpanded(false); }, [active, standalone]);
  const shownView: FileView = expanded ? (tabular ? 'table' : 'rendered') : fileView;
  const showingRendered = !!textView && shownView === 'rendered';
  // A text view needs the text — except Live (the route serves the file) and
  // the log view (it reads ranges): those work past the editor's 2 MB cap.
  const renderable = !!textView && !!res && !res.binary
    && (textView.kind === 'live' || textView.kind === 'log' || (!res.tooLarge && res.content != null));
  const rendered = showingRendered && renderable;
  // Bumped on every read or save of the HTML: the live page reloads with it.
  const [liveRev, setLiveRev] = useState(0);
  // Bumped when a media file changed on the VPS: its element re-fetches.
  const [mediaRev, setMediaRev] = useState(0);
  // Live buffer. A ref, not state: the editor already owns the text, and
  // re-rendering this component on every keystroke is exactly the lag §14.38
  // is about.
  const buf = useRef('');
  const shaRef = useRef<string | null>(null);
  const versionRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const statInflightRef = useRef(false);
  const statSupportedRef = useRef(true);
  const externalSeenRef = useRef<string | null>(null);
  const inlineUrl = api.fsFileUrl(vpsId, root, path, { inline: true });
  const rawUrl = api.fsFileUrl(vpsId, root, path);
  // The route ignores `v`; the browser does not, so a change re-fetches.
  const mediaSrc = mediaRev ? `${inlineUrl}&v=${mediaRev}` : inlineUrl;

  const markDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirty(v);
    setTabDirty(tabId, v);
  }, [tabId]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setNote(null);
    // Cleared up front: this pane switches files without remounting, and a
    // header naming the PREVIOUS file's link target is worse than no subtext.
    setLink(null);
    try {
      const r = await api.readFsFile(vpsId, root, path);
      if (!r.ok) { setErr(r.error ?? 'could not read this file'); setRes(null); return; }
      setRes(r);
      setLink(r.symlink ? r : null);
      buf.current = r.content ?? '';
      shaRef.current = r.sha256 ?? null;
      versionRef.current = r.version ?? null;
      externalSeenRef.current = null;
      markDirty(false);
      setDocKey((k) => k + 1);
      setLiveRev((n) => n + 1);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [vpsId, root, path, markDirty]);

  useEffect(() => { if (!media) void load(); else setLoading(false); }, [load, media]);
  // Media skips fs_read entirely, so the one cheap probe is what tells the
  // header this PNG is a link into another tree. Failures stay silent: the
  // subtext is a courtesy, never a reason to fail opening a file.
  useEffect(() => {
    if (!media) return;
    let alive = true;
    setLink(null);
    void api.statFsFile(vpsId, root, path)
      .then((s) => {
        if (!alive || !s.ok) return;
        if (s.symlink) setLink(s);
        // The baseline the change probe compares against (media never reads).
        if (versionRef.current == null && s.version) versionRef.current = s.version;
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [media, vpsId, root, path]);
  useEffect(() => {
    statSupportedRef.current = true;
    versionRef.current = null;
    externalSeenRef.current = null;
  }, [vpsId, root, path]);
  // Leaving the file behind must clear its badge, or a closed editor keeps a
  // dot on a tab nobody can save.
  useEffect(() => () => setTabDirty(tabId, false), [tabId]);

  // "Open at line 412" from a search hit (§14.84). Subscribing rather than
  // reading a prop is what makes the already-open case work: the pane does not
  // remount when the file is already the active tab, so a click on a second
  // result in the same file has to arrive as an event.
  useEffect(() => {
    if (media) return;
    return subscribeReveal(vpsId, root, path, (line) => {
      if (tabular || textView) setFileView('text');
      setReveal({ line, nonce: Date.now() });
    });
  }, [media, tabular, textView, setFileView, vpsId, root, path]);

  const save = useCallback(async (force = false) => {
    if (saving || media) return;
    setSaving(true);
    setNote(null);
    try {
      const r = await api.writeFsFile(vpsId, {
        root, path, content: buf.current,
        ...(force ? {} : { expectedSha256: shaRef.current ?? '' }),
      });
      if (r.ok) {
        shaRef.current = r.sha256 ?? null;
        versionRef.current = r.version ?? versionRef.current;
        externalSeenRef.current = null;
        markDirty(false);
        setConflict(null);
        setNote({ kind: 'ok', text: 'saved' });
        setLiveRev((n) => n + 1);
        // Saving is a real interaction: the tab stops being a preview, and the
        // repo just got dirtier (or cleaner) so the chip must not wait.
        onInteract();
        refreshGit(vpsId, root);
      } else if (r.reason === 'stale') {
        setConflict({ serverSha: r.sha256 ?? null });
      } else {
        setNote({ kind: 'err', text: r.error ?? 'could not save' });
      }
    } catch (e: unknown) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [vpsId, root, path, saving, media, markDirty, onInteract]);

  // Cheap external-change synchronization. The agent returns only a stat
  // token (device/inode/size/mtime_ns), never the file body or a recomputed
  // hash. A clean buffer follows the VPS automatically; a dirty one surfaces
  // the existing explicit conflict UI and never overwrites either side.
  const probeExternalChange = useCallback(async () => {
    if (statInflightRef.current || !statSupportedRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    statInflightRef.current = true;
    try {
      const r = await api.statFsFile(vpsId, root, path);
      if (!r.ok) {
        if (r.reason === 'unsupported') statSupportedRef.current = false;
        return;
      }
      const token = r.exists === false ? '__missing__' : (r.version ?? null);
      if (!token) return;
      if (versionRef.current == null) { versionRef.current = token; return; }
      if (token === versionRef.current) return;
      // A binary viewer that edits (a workbook) owns its conflict: it gets
      // the `rev` bump below and decides with its unsaved cells in hand.
      if (dirtyRef.current && !media) {
        if (externalSeenRef.current !== token) {
          externalSeenRef.current = token;
          setConflict({ serverSha: null });
        }
        return;
      }
      if (r.exists === false) {
        versionRef.current = token;
        setRes(null);
        setErr('this file was deleted on the VPS');
        setNote({ kind: 'err', text: 'the open file no longer exists' });
        return;
      }
      if (media) {
        // An image re-rendered, a PDF recompiled: show the new bytes.
        versionRef.current = token;
        setErr(null);
        setMediaRev((n) => n + 1);
        setNote({ kind: 'ok', text: 'reloaded — the file changed on the VPS' });
        return;
      }
      await load();
      setNote({ kind: 'ok', text: 'reloaded — the file changed on the VPS' });
    } catch {
      // Connectivity is already represented by the VPS badge. A stat probe is
      // advisory and must not turn a temporarily-offline editor into an error.
    } finally {
      statInflightRef.current = false;
    }
  }, [media, vpsId, root, path, load]);

  // Only the pane on screen polls; a pane coming back checks at once.
  useEffect(() => {
    if (!active) return;
    void probeExternalChange();
    const timer = window.setInterval(() => { void probeExternalChange(); }, 10_000);
    const wake = () => { void probeExternalChange(); };
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [active, probeExternalChange]);

  // Codex app-server fs/watch supplies the fast path; the 10s stat poll above
  // remains the provider-neutral/missed-event safety net.
  useEffect(() => {
    if (!active) return;
    return subscribeFsChanged((changedVpsId, paths) => {
      if (changedVpsId !== vpsId) return;
      const absolute = `${root.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      if (paths.includes(absolute)) void probeExternalChange();
    });
  }, [active, vpsId, root, path, probeExternalChange]);

  // Ctrl+S also works when focus is outside CodeMirror (the header, a button)
  // — the shortcut belongs to the pane, not to the text area. Only the pane
  // on screen listens: hidden ones are mounted too (§14.111).
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
        return;
      }
      // F8 walks the problems, like every editor. Pane-level for the same
      // reason as Ctrl+S: it must work with the header focused.
      if (e.key === 'F8') {
        e.preventDefault();
        stepProblemRef.current(e.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, save]);

  // A version counter, not the text: the buffer lives in a ref so typing never
  // goes through React (§14.79). One tick per quiet 600ms is what the language
  // server needs, and nothing more. §14.89
  const [textVersion, setTextVersion] = useState(0);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (tickTimer.current) clearTimeout(tickTimer.current); }, []);

  const onChange = useCallback((next: string) => {
    buf.current = next;
    if (!dirty) { markDirty(true); onInteract(); }
    if (tickTimer.current) clearTimeout(tickTimer.current);
    tickTimer.current = setTimeout(() => setTextVersion((n) => n + 1), 600);
  }, [dirty, markDirty, onInteract]);

  // ── History for THIS file (§14.87) ────────────────────────────────────────
  // The tree's right-click had it; the pane it opens into did not, which is
  // the one place you are actually reading the file. The owning checkout comes
  // from the workspace snapshot the panel already polls: with several repos
  // under one cwd (§14.83) the file belongs to whichever root contains it, and
  // `git log` has to run there.
  const { workspace } = useGitStatus(vpsId, root);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const history = useMemo(
    () => repoForPath(workspace, `${root.replace(/\/+$/, '')}/${path}`, root),
    [workspace, root, path],
  );
  const diffTarget = useMemo(
    () => gitDiffTargetForPath(workspace, `${root.replace(/\/+$/, '')}/${path}`, root),
    [workspace, root, path],
  );
  useEffect(() => { if (!diffTarget) setDiffOpen(false); }, [diffTarget]);

  const canLsp = !!res && !res.binary && !res.tooLarge && !res.truncated && res.content != null
    && !media && shownView === 'text';
  const absPath = `${root.replace(/\/+$/, '')}/${path}`;
  const lsp = useLsp({
    vpsId: canLsp ? vpsId : null,
    root: canLsp ? root : null,
    path: canLsp ? absPath : null,
    // One long poll per open document; browsers allow six connections per
    // host (the SSE holds one). Hidden panes give theirs back.
    enabled: canLsp && active,
    getText: () => buf.current,
    textVersion,
  });
  const lspTarget = useMemo(
    () => (canLsp && active && lsp.live ? { vpsId, root, path: absPath } : null),
    [canLsp, active, lsp.live, vpsId, root, absPath],
  );
  const lspText = lspLabel(lsp.status, lsp.live, lsp.diagnostics.length);

  // ── Code-intelligence interactions (§14.90) ───────────────────────────────
  const [picker, setPicker] = useState<
    | { kind: 'locations'; title: string; locations: LspLocation[] }
    | { kind: 'symbols'; title: string; symbols: FlatSymbol[] }
    | null
  >(null);
  const [rename, setRename] = useState<
    { word: string; pos: { line: number; character: number } } | null
  >(null);
  const [busyLsp, setBusyLsp] = useState<string | null>(null);

  /** One result: go. Several: let the user choose — that is the whole point. */
  const showLocations = useCallback((locs: LspLocation[], title: string) => {
    if (locs.length === 1) { goTo(locs[0]); return; }
    setPicker({ kind: 'locations', title, locations: locs });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = useCallback((loc: LspLocation) => {
    setPicker(null);
    if (loc.path === absPath) { setReveal({ line: loc.line, nonce: Date.now() }); return; }
    onOpenLocation?.(loc.path, loc.line);
  }, [absPath, onOpenLocation]);

  const askRename = useCallback((pos: { line: number; character: number }, word: string) => {
    setRename({ word, pos });
  }, []);

  /** Rename across the project, then reload — the buffer on screen is stale. */
  const doRename = useCallback(async (next: string) => {
    if (!rename || !lspTarget) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === rename.word) { setRename(null); return; }
    setBusyLsp('rename');
    try {
      const r = await requestRename(lspTarget, rename.pos, trimmed);
      if (!r.ok || !r.changes) throw new Error(r.error ?? 'rename failed');
      const applied = await api.lspApplyEdit(vpsId, root, r.changes as Record<string, unknown[]>);
      if (!applied.ok) throw new Error(applied.error ?? 'could not write the changes');
      const n = applied.changed?.length ?? 0;
      setNote({ kind: 'ok', text: `renamed to ${trimmed} in ${n} file${n === 1 ? '' : 's'}` });
      setRename(null);
      await load();                    // our own buffer is now out of date
    } catch (e: unknown) {
      // Thrown, so PromptModal keeps the dialog open with the reason (§14.80).
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      setBusyLsp(null);
    }
  }, [rename, lspTarget, vpsId, root]);   // eslint-disable-line react-hooks/exhaustive-deps

  const doFormat = useCallback(async () => {
    if (!lspTarget) return;
    setBusyLsp('format');
    try {
      const r = await requestFormat(lspTarget);
      if (!r.ok) { setNote({ kind: 'err', text: r.error ?? 'format failed' }); return; }
      if (!r.edits?.length) { setNote({ kind: 'ok', text: 'already formatted' }); return; }
      const applied = await api.lspApplyEdit(vpsId, root, { [`file://${absPath}`]: r.edits });
      if (!applied.ok) { setNote({ kind: 'err', text: applied.error ?? 'could not write' }); return; }
      setNote({ kind: 'ok', text: 'formatted' });
      await load();
    } finally {
      setBusyLsp(null);
    }
  }, [lspTarget, vpsId, root, absPath]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Walk the problems, F8 style. */
  const stepProblem = useCallback((delta: number) => {
    const list = [...lsp.diagnostics].sort((a3, b3) => a3.range.start.line - b3.range.start.line);
    if (!list.length) return;
    const cur = revealRef.current;
    const idx = list.findIndex((d) => d.range.start.line + 1 === cur);
    const next = list[((idx < 0 ? (delta > 0 ? -1 : 0) : idx) + delta + list.length) % list.length];
    if (next) setReveal({ line: next.range.start.line + 1, nonce: Date.now() });
  }, [lsp.diagnostics]);
  stepProblemRef.current = stepProblem;


  const readOnly = !!res?.tooLarge || !!res?.binary;

  // Full screen (state above): Esc or the scrim puts it back; a dialog the
  // pane opened on top (diff, history, picker) takes Esc first.
  const overlayOpen = historyOpen || diffOpen || !!picker || !!rename;
  useEffect(() => {
    if (!expanded || !active || overlayOpen) return;
    function onKey(e: KeyboardEvent) {
      // Taken already: CodeMirror's find, a cell being edited, a page's own Esc.
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      setExpanded(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded, active, overlayOpen]);

  return (
    <>
    {expanded && <div className="fe-scrim" onClick={() => setExpanded(false)} aria-hidden />}
    <div className={`file-editor${expanded ? ' expanded' : ''}`}
         role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined}
         aria-label={expanded ? name : undefined}>
      <header className="fe-head">
        <span className="fe-title">
          <span className="fe-path" title={`${root}/${path}`}>{path}</span>
          {/* Editing a link edits the file behind it — say which one, or the
              save lands somewhere the reader never agreed to. */}
          {link && (
            <span className="fe-link" title={link.linkResolved ?? link.linkTarget ?? undefined}>
              ↗ symlink → {link.linkTarget ?? 'unknown target'}
            </span>
          )}
        </span>
        {dirty && <span className="fe-dirty" title="unsaved changes">●</span>}
        {res?.size != null && <span className="fe-size">{fmtSize(res.size)}</span>}
        {/* Full screen is the rendered document only: no source to switch to. */}
        {!expanded && tabular && res?.content != null && !res.binary && !res.tooLarge && (
          <span className="fe-view-toggle" role="group" aria-label="CSV view">
            <button type="button" className={fileView === 'table' ? 'on' : ''}
                    onClick={() => setFileView('table')}>Table</button>
            <button type="button" className={fileView === 'text' ? 'on' : ''}
                    onClick={() => setFileView('text')}>Text</button>
          </span>
        )}
        {!expanded && textView && renderable && (
          <span className="fe-view-toggle" role="group" aria-label="View">
            <button type="button" className={fileView === 'rendered' ? 'on' : ''}
                    onClick={() => setFileView('rendered')} title={VIEW_TITLES[textView.kind]}>{textView.label}</button>
            <button type="button" className={fileView === 'text' ? 'on' : ''} disabled={!!res?.tooLarge}
                    onClick={() => setFileView('text')}
                    title={res?.tooLarge ? 'Too large for the editor' : 'Read and edit the source'}>Code</button>
          </span>
        )}
        {diffTarget && (
          <button className="fe-diff" onClick={() => setDiffOpen(true)}
                  title={`Open Git diff for ${diffTarget.file.path}`}>
            <IconDiff /> Diff
          </button>
        )}
        {/* Only when a checkout actually owns this file — a button that can
            only answer "not tracked" is worse than no button. */}
        {history && (
          <button className="fe-hist" onClick={() => setHistoryOpen(true)}
                  title={`Git commit history for ${history.rel}`}>
            <IconClockHistory /> Git history
          </button>
        )}
        {!media && !readOnly && (
          <button className="fe-save" onClick={() => save()} disabled={saving || !dirty}
                  title="save to the VPS (Ctrl+S)">
            {saving ? 'saving…' : 'save'}
          </button>
        )}
        {/* The rendered document alone, two ways, one split button: over the
            hub (this pane, live — unsaved edits included where the view shows
            them), or in a browser tab of its own (`/view`: what is on disk;
            an HTML page goes to its sandboxed live page, §14.110). */}
        {standalone && (
          <span className="fe-split" role="group" aria-label="Open the document alone">
            <button type="button" onClick={() => setExpanded((v) => !v)} aria-pressed={expanded}
                    title={expanded
                      ? 'Back to the pane (Esc)'
                      : `The ${html ? 'live page' : 'document'} almost full screen, over Charon — Esc closes`}>
              {expanded ? <IconFullscreenExit /> : <IconFullscreen />}
              <span>{expanded ? 'Close' : 'Full screen'}</span>
            </button>
            <a href={standaloneViewUrl(vpsId, root, path)} target="_blank" rel="noopener"
               title={`The ${html ? 'live page' : 'document'} full window, in a new browser tab`}>
              <IconBoxArrowUpRight />
              <span>New tab</span>
            </a>
          </span>
        )}
        <a className="fe-dl" href={rawUrl} download={name} title={`download ${name}`}>
          <IconDownload /> Download
        </a>
      </header>

      {note && <div className={`fe-note ${note.kind}`}>{note.text}</div>}

      {conflict && (
        <div className="fe-conflict">
          <b>This file changed on the VPS since you opened it.</b>
          <span>
            Something else — most likely an agent working in this repo — wrote to
            it. Reloading discards your edits; overwriting discards theirs.
          </span>
          <div className="fe-conflict-actions">
            <button onClick={() => { setConflict(null); void load(); }}>reload from the VPS</button>
            <button className="danger" onClick={() => { setConflict(null); void save(true); }}>
              overwrite with my version
            </button>
            <button onClick={() => setConflict(null)}>keep editing</button>
          </div>
        </div>
      )}

      <div className="fe-body">
        {loading && <div className="dvm-note">loading…</div>}
        {err && <div className="dvm-note err">{err}</div>}

        {bytesKind && (
          <BytesView
            kind={bytesKind}
            props={{ vpsId, root, path, name, url: rawUrl, rev: mediaRev, active, onDirtyChange: markDirty }}
            mediaSrc={mediaSrc}
          />
        )}

        {rendered && textView?.kind === 'live' && (
          <HtmlLiveView
            vpsId={vpsId}
            root={root}
            path={path}
            rev={liveRev}
            dirty={dirty}
            saving={saving}
            onSave={() => void save()}
            active={active}
          />
        )}
        {rendered && textView?.kind === 'log' && (
          <LogViewer vpsId={vpsId} root={root} path={path} follow active={active} />
        )}
        {rendered && textView && textView.kind !== 'live' && textView.kind !== 'log' && (
          <TextView kind={textView.kind} props={{ vpsId, root, path, name, text: buf.current, active }} />
        )}

        {/* Past the editor's cap: the end of the file, like a log (§14.112). */}
        {!media && res?.tooLarge && !res.binary && !rendered && (
          <LogViewer vpsId={vpsId} root={root} path={path} active={active} />
        )}
        {/* A binary nothing else claims: its bytes, and what they look like. */}
        {!media && res?.binary && <HexViewer vpsId={vpsId} root={root} path={path} rev={liveRev} />}
        {!media && res && !res.binary && !res.tooLarge && res.content != null && !rendered && (
          <>
            {res.truncated && (
              <div className="dvm-note warn">
                ⚠ only the first part of this file is shown — saving would truncate it, so it is read-only
              </div>
            )}
            {tabular && shownView === 'table' ? (
              <CsvViewer text={buf.current} filename={name} storageKey={viewKey}
                         onChange={res.truncated ? undefined : onChange} />
            ) : (
              <CodeEditor
                doc={buf.current}
                docKey={`${vpsId}:${root}:${path}:${docKey}`}
                filename={name}
                readOnly={!!res.truncated}
                onChange={onChange}
                onSave={() => void save()}
                reveal={reveal}
                lsp={lspTarget}
                diagnostics={lsp.live ? lsp.diagnostics : EMPTY_DIAGS}
                onLocations={showLocations}
                onRename={askRename}
                onSymbols={(r) => {
                  const list = flattenSymbols(r);
                  if (list.length) setPicker({ kind: 'symbols', title: 'Go to symbol', symbols: list });
                }}
              />
            )}
            {(!tabular || shownView === 'text') && lspText && (
              <div className={`fe-lsp${lsp.live ? ' on' : ''}`} title={lsp.status?.install ?? undefined}>
                <span className="fe-lsp-text">{lspText}</span>
                {lsp.live && lsp.diagnostics.length > 0 && (
                  <>
                    <button className="fe-lsp-btn" onClick={() => stepProblem(-1)}
                      title="previous problem (Shift+F8)">Previous problem</button>
                    <button className="fe-lsp-btn" onClick={() => stepProblem(1)}
                      title="next problem (F8)">Next problem</button>
                  </>
                )}
                <span className="gt-spacer" />
                {lsp.live && (
                  <button className="fe-lsp-btn wide" disabled={!!busyLsp || readOnly}
                    onClick={() => void doFormat()} title="format this file with the language server">
                    {busyLsp === 'format' ? '…' : 'Format file'}
                  </button>
                )}
                {lsp.live && <span className="fe-lsp-hint">⌘/Ctrl+click → definition · Shift → references · F2 rename</span>}
              </div>
            )}
          </>
        )}
      </div>

      {historyOpen && history && (
        <HistoryModal
          vpsId={vpsId}
          cwd={root}
          repo={history.repo}
          path={history.rel}
          label={history.rel}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {diffOpen && diffTarget && (
        <DiffViewerModal
          vpsId={vpsId}
          cwd={root}
          repo={diffTarget.repo.root}
          root={diffTarget.repo.root}
          files={diffTarget.repo.files}
          initialPath={diffTarget.file.path}
          onClose={() => setDiffOpen(false)}
        />
      )}

      {picker?.kind === 'locations' && (
        <LspPicker
          kind="locations"
          title={picker.title}
          items={picker.locations}
          currentPath={absPath}
          onPick={goTo}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'symbols' && (
        <LspPicker
          kind="symbols"
          title={picker.title}
          items={picker.symbols}
          currentPath={absPath}
          onPick={(sym) => { setPicker(null); setReveal({ line: sym.line, nonce: Date.now() }); }}
          onClose={() => setPicker(null)}
        />
      )}
      {rename && (
        <PromptModal
          title="Rename symbol"
          hint={`Every reference to ${rename.word} in this project is rewritten on the VPS. There is no undo — commit or stash first if you want one.`}
          initial={rename.word}
          confirmLabel="Rename"
          busyLabel="renaming…"
          onSubmit={doRename}
          onClose={() => setRename(null)}
        />
      )}
    </div>
    </>
  );
}
