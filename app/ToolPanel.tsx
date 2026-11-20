'use client';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from '@/app/dynamic';
import { createPatch } from 'diff';
import { api } from '@/lib/api';
import type { AgentKind, SessionAttachment, ToolCallSummary } from '@/lib/types/api';
import type { TranscriptView } from '@/lib/transcriptRows';
import type { SessionContextUsage } from './sessionInsightState';
import SplitDiffModal from './SplitDiffModal';
import { fmtSize } from './sessionAttachments';
import GitTab from './GitTab';
import InsightSection from './InsightSection';
import TreeTab from './TreeTab';
import ExplorerRootTabs from './ExplorerRootTabs';
import { carryExplorerRoots, useExplorerRoots } from './explorerRoots';
import SearchTab from './SearchTab';
import { peekGitWorkspace, useGitDirtyCount, workspaceRepos } from './gitStore';
import { IconTree } from './fileIcons';
import { workspaceScopeKey } from './workspaceScope';
import {
  readWorkspacePanelScroll,
  readWorkspacePanelTab,
  writeWorkspacePanelScroll,
  writeWorkspacePanelTab,
  type WorkspacePanelTab,
} from './workspacePanelState';
import {
  IconClipboard, IconDiff, IconDownload, IconEye, IconFileEarmark, IconGitBranch,
  IconPaperclip, IconPlusSquare, IconSearch, IconTools, IconTrash,
} from './icons';
import { PROVIDERS } from '@/lib/sessionCapabilities';
import { providerText } from '@/lib/providerText';
import { isOsFileDrag, useOsFileDrag } from './fileDropZones';
import PanelResizer from './PanelResizer';
import { readPanelLayout, usePanelLayout, writePanelLayout } from './panelLayoutStore';
import { PANEL_BOUNDS, isPanelClosed } from './panelLayout';
import { useHoverTip, type HoverTipContent } from './HoverTip';

/** A file dragged over the "files" tab switches to the explorer after this. */
const TAB_SPRING_MS = 500;

// Shared desktop/mobile types defined in `./sessionTypes`. Re-exported here
// to preserve historical imports (`import { ToolCallEntry, EditSnapshot }
// from './ToolPanel'`).
export type { ToolCallEntry, EditSnapshot } from './sessionTypes';
import type { ToolCallEntry, EditSnapshot } from './sessionTypes';

type Props = {
  sessionId: string | null;
  /** Workspace-only surface for SSH shells: Files, Search and Git need only
   *  `(vpsId, cwd)`. Session edits, attachments and provider telemetry have
   *  no meaning without an agent session, so do not show empty tabs for them. */
  workspaceOnly?: boolean;
  // Backend of the session. Codex ships a ready-made UNIFIED DIFF (in the edit
  // snapshot's `after`, before=null) instead of a before/after pair — rendered
  // as a raw patch. cf. CLAUDE.md §14.59.
  kind?: AgentKind;
  toolCalls: ToolCallEntry[];
  /** `tool_use` rows of the whole session (window GET; null: unknown). */
  toolCallCount?: number | null;
  /** The transcript view: in `conversation` no tool row was fetched, so the
   *  calls tab pages `GET …/tool-calls` itself when it opens (§14.107). */
  transcriptView?: TranscriptView | null;
  edits: Map<string, EditSnapshot>;
  /** Edited files whose content the hub could not give. */
  editsMissing?: ReadonlySet<string>;
  /** The edits tab asks for the diff content of the cards it draws (§14.41). */
  onNeedEdits?: (paths: string[]) => void;
  onRevert: () => void; // refresh signal
  // Files the user attached to this session (drag & drop / paperclip). The
  // list is owned by SessionView so this panel and the input bar always
  // show the same thing. cf. app/sessionAttachments.ts.
  attachments?: SessionAttachment[];
  onRemoveAttachment?: (id: string) => void;
  // Re-insert a path into the message being composed.
  onInsertPath?: (path: string) => void;
  /** Jump to the session touching a file, from the explorer (§14.88). */
  onOpenSession?: (sessionId: string) => void;
  /** The explorer strip's ＋: ask for a folder of this VPS to open as a tab
   *  of the workspace `(vpsId, cwd)` (`explorerRoots.ts`). */
  onOpenFolder?: (vpsId: string, cwd: string) => void;
  /** The explorer's "New Session Here…": the wizard on that VPS and folder. */
  onNewSessionIn?: (vpsId: string, cwd: string) => void;
  // Source control (§14.76). Scoped to the REPO containing `cwd`, not to the
  // session — which is why it takes (vpsId, cwd) and not sessionId.
  vpsId?: string | null;
  cwd?: string | null;
  /** A session is mid-turn in this repo: warn before committing, never block. */
  repoBusy?: boolean;
  /** One-shot "open on this tab" request (from the header's dirty chip). */
  requestedTab?: Tab | null;
  onTabConsumed?: () => void;
  /** Reveal the panel — it is a drawer below 1100px, where switching a tab
   *  nobody can see is the same as doing nothing. */
  onReveal?: () => void;
  /** One provider-neutral context snapshot shared with the chat header. */
  context?: SessionContextUsage | null;
  contextLoaded?: boolean;
  contextLoading?: boolean;
  onRefreshContext?: () => Promise<void>;
  onCompact?: () => void | Promise<void>;
  compacting?: boolean;
  compactDisabled?: boolean;
  compactError?: string | null;
  /** What drives usage beyond the context (lib/usageDrivers.ts, §14.119). */
  usage?: import('./SessionInsight').InsightUsage | null;
  /** The conversation is still downloading: hold the inspector's requests
   *  (one inventory can weigh a megabyte) until it lands, unless the user
   *  opens the Tools tab meanwhile. */
  deferInsight?: boolean;
};

const SessionInsight = dynamic(() => import('./SessionInsight'), {
  ssr: false,
  loading: () => <div className="si-bootstrap" role="status">loading session details…</div>,
});

export type Tab = WorkspacePanelTab;

// On a desktop the tabs are a vertical ACTIVITY BAR on the panel's outer edge
// (app.css § SIDE COLUMNS): icons, counts as corner dots, each explained by
// its own tooltip (`tabTip`). In the drawer (<=1100px, touch) they stay a
// horizontal strip where only the ACTIVE tab is labelled — tooltips don't exist
// there, so icon-only-everywhere would be undiscoverable; the active label is
// the legend, which is why every label has to stay SHORT: five icons plus one
// long label is what fits in 340px. `edits` is the SESSION's edits — what an agent changed
// in this conversation — and `git` is the working tree; they were both called
// some flavour of "diff" and got confused for each other constantly.
// `files` is the project explorer and `attach` is the session's attachments —
// the paperclip tab was labelled "files" before the tree existed, and keeping
// that name for the smaller of the two would have made the new one unfindable.
const TABS: { id: Tab; label: string; Icon: (p: { className?: string }) => React.ReactElement }[] = [
  { id: 'tree', label: 'files', Icon: IconTree },
  { id: 'search', label: 'search', Icon: IconSearch },
  { id: 'git', label: 'git', Icon: IconGitBranch },
  { id: 'edits', label: 'edits', Icon: IconDiff },
  { id: 'files', label: 'attach', Icon: IconPaperclip },
  { id: 'calls', label: 'tools', Icon: IconTools },
];

/** The width at which the tabs are the desktop activity bar (app.css). */
const DESKTOP_BAR_QUERY = '(min-width: 1101px)';
const isDesktopBar = () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_BAR_QUERY).matches;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each activity-bar icon says on hover: what it is, what it holds now. */
function tabTip(id: Tab, n: number, git: 'repo' | 'none' | 'unknown'): HoverTipContent {
  switch (id) {
    case 'tree':
      return { title: 'Explorer', detail: 'Browse and open the workspace files; drop a file on a folder to upload it' };
    case 'search': {
      const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
      return { title: 'Search', detail: 'Text and file names across the workspace', keys: mac ? ['⌘', '⇧', 'F'] : ['Ctrl', 'Shift', 'F'] };
    }
    case 'git':
      return {
        title: 'Source control', count: n,
        detail: n > 0 ? `${plural(n, 'changed file')} in the working tree`
          : git === 'repo' ? 'Working tree clean — branches, commit, history'
          : git === 'none' ? 'This folder is not a git repository'
          : 'Branches, changes, commit and history',
      };
    case 'edits':
      return {
        title: 'Session edits', count: n,
        detail: n > 0 ? `${plural(n, 'file')} changed by the agent in this session` : 'Files the agent changes in this session, as diffs',
      };
    case 'files':
      return {
        title: 'Attachments', count: n,
        detail: n > 0 ? `${plural(n, 'file')} attached to this session` : 'Files you attach to this session',
      };
    case 'calls':
      return {
        title: 'Session details', count: n,
        detail: n > 0 ? `Context, MCP servers and ${plural(n, 'tool call')}` : 'Context, MCP servers and tool calls',
      };
  }
}

const NO_PATHS: ReadonlySet<string> = new Set();

function ToolPanel({
  sessionId, workspaceOnly = false, kind = 'claude', toolCalls: liveToolCalls, toolCallCount = null,
  transcriptView = null, edits, editsMissing = NO_PATHS, onNeedEdits, onRevert,
  attachments = [], onRemoveAttachment, onInsertPath, onOpenSession, onOpenFolder, onNewSessionIn,
  vpsId = null, cwd = null, repoBusy = false, requestedTab = null, onTabConsumed,
  onReveal, context = null, contextLoaded = false, contextLoading = false,
  onRefreshContext, onCompact, compacting = false, compactDisabled = true,
  compactError = null, deferInsight = false, usage = null,
}: Props) {
  // The right sidebar belongs to the tab-row GROUP `(vpsId, cwd)`, not to the
  // entity currently filling the main pane. SessionView is keyed by
  // session and file/shell views live in other branches, so this small shared
  // store is what makes their remounted ToolPanels resume the same surface.
  const panelScope = workspaceScopeKey(vpsId, cwd);
  const [tabState, setTabState] = useState<{ scope: string; tab: Tab }>(() => ({
    scope: panelScope,
    tab: readWorkspacePanelTab(vpsId, cwd),
  }));
  // Derive synchronously on a workspace prop change, so React cannot paint
  // workspace B once with workspace A's selected tab before the effect runs.
  const tab = tabState.scope === panelScope ? tabState.tab : readWorkspacePanelTab(vpsId, cwd);
  const setTab = useCallback((next: Tab) => {
    writeWorkspacePanelTab(vpsId, cwd, next);
    setTabState({ scope: panelScope, tab: next });
  }, [vpsId, cwd, panelScope]);
  // Desktop (app/panelLayout.ts): VS Code's activity bar. Closed = the panel
  // at its minimum width, the bar alone. Asking for a tab — its icon, the
  // header's dirty chip, Ctrl+Shift+F, a file held over "files" — reopens it
  // at its last width; clicking the tab already open closes it. The body stays
  // mounted underneath, so reopening resumes where it was. The drawer
  // (<=1100px) ignores all of it: its width is not this one.
  const toolsW = usePanelLayout()?.toolsW ?? null;
  const closed = toolsW != null && isPanelClosed('tools', toolsW);
  // A ref: the key and request effects below hold an older `openTab`.
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const openTab = useCallback((next: Tab) => {
    setTab(next);
    if (closedRef.current && isDesktopBar()) writePanelLayout({ toolsW: readPanelLayout().toolsLast });
  }, [setTab]);
  const tip = useHoverTip('left');
  const activeTab: Tab = workspaceOnly && tab !== 'tree' && tab !== 'search' && tab !== 'git'
    ? 'tree'
    : tab;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const visibleTabs = workspaceOnly
    ? TABS.filter(({ id }) => id === 'tree' || id === 'search' || id === 'git')
    : TABS;
  // Conversation view: the calls tab's history comes from `GET …/tool-calls`,
  // fetched lazily the first time the tab opens; live calls are merged on top.
  const pagedCalls = useConversationToolCalls(
    sessionId, !workspaceOnly && transcriptView === 'conversation' && activeTab === 'calls');
  const toolCalls = useMemo(
    () => pagedCalls.calls.length ? mergeToolCalls(pagedCalls.calls, liveToolCalls) : liveToolCalls,
    [pagedCalls.calls, liveToolCalls],
  );
  // Every edited file: a card without content asks for it when it nears the
  // viewport (`onNeedEdits`), never the whole session at once.
  const editArr = useMemo(() => Array.from(edits.values()), [edits]);

  // The dirty chip in the chat header opens this panel ON the git tab. It's a
  // one-shot request rather than a controlled prop so the user can switch tabs
  // afterwards without the parent yanking them back.
  useEffect(() => {
    if (!requestedTab) return;
    if (workspaceOnly && requestedTab !== 'tree' && requestedTab !== 'search' && requestedTab !== 'git') return;
    openTab(requestedTab);
    onTabConsumed?.();
  }, [requestedTab, onTabConsumed, workspaceOnly]);

  // React can also reuse a ToolPanel while its actual workspace changes.
  // Restore that folder's own tab; do not carry state across tab-row groups.
  useEffect(() => {
    setTabState({ scope: panelScope, tab: readWorkspacePanelTab(vpsId, cwd) });
  }, [vpsId, cwd, panelScope]);

  // Scroll is part of "same place" too. Save it under the visible tab before
  // an entity unmounts, and restore it before paint in the replacement.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = readWorkspacePanelScroll(vpsId, cwd, activeTab);
  }, [vpsId, cwd, activeTab]);

  // Ctrl/Cmd+Shift+F — search across files. Bound here rather than in either
  // parent because this component is the only thing both call sites have in
  // common, and it already owns the active tab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      openTab('search');
      onReveal?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onReveal]);

  // Same poll the chip and the git tab already share — keyed on (vpsId, cwd),
  // so asking for it here costs nothing extra (§14.76).
  // The folder tabs (`explorerRoots.ts`): the workspace's own folder, or
  // another one of this VPS opened with the strip's ＋. The one shown is THE
  // folder of the three workspace tabs — explorer, search and git — and of
  // the git badge, so they always describe the same place.
  const roots = useExplorerRoots(vpsId, cwd);
  const treeRoot = roots.active ?? cwd;
  /** Elsewhere than the workspace's own folder: what is the SESSION's (its
   *  review, its busy turn) does not apply to what is shown. */
  const away = roots.active != null;
  // The badge's NUMBER only: the panel keeps the inspector mounted (hidden),
  // so a re-render per git poll cost tens of ms on a long session (§14.38).
  const gitDirty = useGitDirtyCount(vpsId, treeRoot);
  const newSessionIn = useMemo(
    () => (onNewSessionIn && vpsId ? (dir: string) => onNewSessionIn(vpsId, dir) : undefined),
    [onNewSessionIn, vpsId],
  );
  // A file from another root opens in that folder's tab group: its panel
  // inherits these tabs, so the way back to this folder is still one click.
  const willOpenFile = useMemo(
    () => (vpsId && cwd && treeRoot && away ? () => carryExplorerRoots(vpsId, cwd, treeRoot) : undefined),
    [vpsId, cwd, treeRoot, away],
  );
  const rootTabsShown = !!vpsId && !!cwd && (activeTab === 'tree' || activeTab === 'search' || activeTab === 'git');
  // Another folder, another height: start it at its top, not at the scroll
  // the previous one left.
  const shownRoot = useRef(treeRoot);
  useLayoutEffect(() => {
    if (shownRoot.current === treeRoot) return;
    shownRoot.current = treeRoot;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [treeRoot]);

  // The explorer is where a dragged OS file can be uploaded into a folder
  // (app/fileDropZones.ts). When another tab is showing, its button says so
  // and, held under the pointer, opens it — the drop can then go on.
  const osDrag = useOsFileDrag();
  const tabSpring = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTabSpring = () => {
    if (tabSpring.current) clearTimeout(tabSpring.current);
    tabSpring.current = null;
  };
  useEffect(() => { if (!osDrag.active) clearTabSpring(); }, [osDrag.active]);
  useEffect(() => clearTabSpring, []);

  const counts: Record<Tab, number> = {
    edits: editArr.length,
    // The working tree's dirty count, same badge as the others — the chip in
    // the header is only visible next to a chat, and this panel also renders
    // beside a file editor.
    git: gitDirty,
    tree: 0,   // a file count would be meaningless on a lazily-expanded tree
    search: 0, // the hit count is the answer, and it belongs above the results
    files: attachments.length,
    calls: Math.max(toolCallCount ?? 0, toolCalls.length),
  };

  return (
    <>
    <PanelResizer panel="tools" />
    <aside className="tool-panel" data-tip-region>
      <nav className="tp-tabs">
        {visibleTabs.map(({ id, label, Icon }) => {
          const on = activeTab === id;
          const n = counts[id];
          return (
            <button
              key={id}
              className={`${on ? 'on' : ''}${n > 0 ? ' has-badge' : ''}${id === 'tree' && (!on || closed) && osDrag.active ? ' drop-armed' : ''}`}
              onClick={() => {
                if (on && !closed && isDesktopBar()) {
                  writePanelLayout({ toolsW: PANEL_BOUNDS.tools.min });
                  return;
                }
                openTab(id);
              }}
              onMouseEnter={(e) => {
                if (!isDesktopBar()) return;
                const workspace = peekGitWorkspace(vpsId, treeRoot);
                const content = tabTip(id, n, workspaceRepos(workspace).length > 0 ? 'repo'
                  : workspace?.ok && workspace.mode === 'none' ? 'none' : 'unknown');
                tip.show(e.currentTarget, {
                  ...content,
                  actions: [['Click', closed ? 'open the panel' : on ? 'close the panel' : 'show']],
                }, id);
              }}
              onMouseLeave={tip.hide}
              onMouseDown={tip.hide}
              onDragOver={id === 'tree' ? (e) => {
                if ((on && !closed) || tabSpring.current || !isOsFileDrag(e.dataTransfer)) return;
                tabSpring.current = setTimeout(() => { tabSpring.current = null; openTab('tree'); }, TAB_SPRING_MS);
              } : undefined}
              onDragLeave={id === 'tree' ? (e) => {
                // Moving onto the icon inside the button is not leaving it.
                if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
                clearTabSpring();
              } : undefined}
              aria-label={label}
              aria-describedby={tip.describedBy(id)}
              aria-current={on ? 'page' : undefined}
            >
              <Icon className="tp-ico" />
              {on && <span className="tp-label">{label}</span>}
              {n > 0 && <span className="badge">{n}</span>}
            </button>
          );
        })}
      </nav>
      {tip.node}
      <div className="tp-main">
      {rootTabsShown && (
        <ExplorerRootTabs vpsId={vpsId!} cwd={cwd!} roots={roots}
          onAdd={onOpenFolder ? () => onOpenFolder(vpsId!, cwd!) : undefined} />
      )}
      <div
        ref={bodyRef}
        className="tp-body"
        onScroll={(event) => writeWorkspacePanelScroll(vpsId, cwd, activeTab, event.currentTarget.scrollTop)}
      >
        {!workspaceOnly && activeTab === 'edits' && <EditsTab sessionId={sessionId} kind={kind} edits={editArr} missing={editsMissing} onNeed={onNeedEdits} onRevert={onRevert} />}
        {activeTab === 'git' && (
          <GitTab
            key={`git:${panelScope}:${treeRoot ?? ''}`}
            sessionId={away ? null : sessionId}
            kind={kind}
            vpsId={vpsId}
            cwd={treeRoot}
            busy={away ? false : repoBusy}
            onOpenSession={onOpenSession}
          />
        )}
        {activeTab === 'tree' && (
          <TreeTab
            key={`tree:${panelScope}:${treeRoot ?? ''}`}
            vpsId={vpsId}
            cwd={treeRoot}
            sessionId={sessionId}
            onInsertPath={onInsertPath}
            onOpenSession={onOpenSession}
            onNewSessionIn={newSessionIn}
            onWillOpenFile={willOpenFile}
          />
        )}
        {activeTab === 'search' && (
          <SearchTab
            key={`search:${panelScope}:${treeRoot ?? ''}`}
            vpsId={vpsId}
            cwd={treeRoot}
            onInsertPath={onInsertPath}
            onWillOpenFile={willOpenFile}
          />
        )}
        {/* Keep the inspector mounted while another tab is visible. Its four
            panel-only requests therefore start with the session (right after
            its transcript, `deferInsight`), not on the first Tools click;
            context is the header's shared request.
            `hidden` avoids layout/paint cost, and the key prevents one
            session's last-known data flashing in the next. */}
        {!workspaceOnly && <div className="tp-calls-pane" hidden={activeTab !== 'calls'}>
          {sessionId && <SessionInsight
            key={`${sessionId}:${kind}`}
            sessionId={sessionId}
            kind={kind}
            context={context}
            contextLoaded={contextLoaded}
            contextLoading={contextLoading}
            onRefreshContext={onRefreshContext ?? (async () => {})}
            onCompact={onCompact ?? (() => {})}
            compacting={compacting}
            compactDisabled={compactDisabled}
            compactError={compactError}
            usage={usage}
            deferLoad={deferInsight && activeTab !== 'calls'}
          />}
          <InsightSection
            title="tool calls"
            meta={`${Math.max(toolCallCount ?? 0, toolCalls.length)} recorded`}
          >
            <CallsTab calls={toolCalls} />
            {pagedCalls.hasMore && (
              <button type="button" className="tp-more" disabled={pagedCalls.loading} onClick={pagedCalls.loadOlder}>
                {pagedCalls.loading ? 'loading…' : 'older calls'}
              </button>
            )}
          </InsightSection>
        </div>}
        {!workspaceOnly && activeTab === 'files' && (
          <FilesTab
            sessionId={sessionId}
            attachments={attachments}
            onRemove={onRemoveAttachment}
            onInsert={onInsertPath}
          />
        )}
      </div>
      </div>
    </aside>
    </>
  );
}

export default memo(ToolPanel);

function EditsTab({ sessionId, kind, edits, missing, onNeed, onRevert }: {
  sessionId: string | null; kind: AgentKind; edits: EditSnapshot[];
  missing: ReadonlySet<string>; onNeed?: (paths: string[]) => void; onRevert: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<EditSnapshot | null>(null);

  // WHAT an edit snapshot contains is declared by the registry, not inferred
  // from the id (§14.102): one backend hands us a ready-made unified diff in
  // `after`, another a before/after pair we diff ourselves, and a third reports
  // no snapshots at all. Side-by-side split + revert only make sense for the
  // pair — a bare patch has no clean "before" to restore. Read as
  // `kind === 'codex'`, the third backend was silently given the pair renderer
  // and a revert button for a pre-image it never sends.
  const shape = PROVIDERS[kind].editSnapshot;
  const isPair = shape === 'contents';
  // Cards mount by pages (a long session holds a thousand): the next page
  // when the end of the list nears.
  const [shown, setShown] = useState(EDIT_CARDS_PAGE);
  const showMore = useCallback(() => setShown((n) => n + EDIT_CARDS_PAGE), []);

  const revert = useCallback(async (filePath: string) => {
    if (!sessionId) return;
    if (!confirm(`Restore "${filePath}" to its initial state?`)) return;
    setBusy(filePath);
    try {
      await api.revertSessionEdit(sessionId, filePath);
      onRevert();
    } catch (e: any) {
      alert('revert: ' + (e?.message ?? e));
    } finally { setBusy(null); }
  }, [sessionId, onRevert]);

  if (shape === 'none') {
    return <div className="tp-empty">{providerText.noEditSnapshots(kind)}</div>;
  }
  if (edits.length === 0) return <div className="tp-empty">no files modified in this session</div>;

  return (
    <>
      <div className="tp-edits">
        {edits.slice(0, shown).map((e) => (
          <EditCard key={e.toolUseId + e.filePath} edit={e} isPair={isPair}
            missing={missing.has(e.filePath)} onNeed={onNeed}
            busy={busy === e.filePath} onSplit={setOpen} onRevert={revert} />
        ))}
        {edits.length > shown && (
          // Keyed by page: a fresh observer reports at once if the end is still near.
          <MoreWhenNear key={shown} onMore={showMore}>{edits.length - shown} more edits</MoreWhenNear>
        )}
      </div>
      {open && (
        <SplitDiffModal
          filePath={open.filePath}
          before={open.before}
          after={open.after}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** A diff past this is computed off the click (`callback` mode, sliced by the
 *  library) instead of in one go. */
const QUICK_DIFF_MS = 40;
/** Lines drawn per card until asked: the box shows ~25 of them anyway. */
const DIFF_LINES_SHOWN = 400;
const EDIT_CARDS_PAGE = 40;

/** Calls `onMore` when it comes within reach of the panel's viewport; a
 *  button too, for a click or an engine without IntersectionObserver. */
function MoreWhenNear({ onMore, children }: { onMore: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) onMore();
    }, { root: el.closest('.tp-body'), rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return <button ref={ref} type="button" className="tp-more" onClick={onMore}>{children}</button>;
}

// One card's diff per task, in the order they come into view: a tab opened on
// a session with dozens of edits used to diff and lay out every one of them
// inside the click (§14.38).
const diffJobs: Array<{ run: () => void; dead: boolean }> = [];
let diffPumping = false;
function pumpDiffs() {
  diffPumping = true;
  setTimeout(() => {
    const job = diffJobs.shift();
    if (job && !job.dead) job.run();
    if (diffJobs.length) pumpDiffs(); else diffPumping = false;
  }, 0);
}
function scheduleDiff(run: () => void): () => void {
  const job = { run, dead: false };
  diffJobs.push(job);
  if (!diffPumping) pumpDiffs();
  return () => { job.dead = true; };
}

/** A computed diff per snapshot (the objects live as long as the session's
 *  state): reopening the tab draws, it does not diff again. */
const patchCache = new WeakMap<EditSnapshot, string>();

// A diff past QUICK_DIFF_MS finishes in a worker (app/diffWorker.ts), at full
// speed and off the page's thread. No worker (it failed to load): the
// library's own sliced mode, slow but never blocking.
let diffWorker: Worker | null | undefined;
let diffAskId = 0;
const diffAsks = new Map<number, { ask: { filePath: string; before: string; after: string }; done: (patch: string) => void }>();
function slicedDiff(filePath: string, before: string, after: string, done: (patch: string) => void) {
  createPatch(filePath, before, after, '', '', { context: 3, callback: (patch: string | undefined) => done(patch ?? '') });
}
function diffOffThread(filePath: string, before: string, after: string, done: (patch: string) => void) {
  if (diffWorker === undefined) {
    try {
      diffWorker = new Worker(new URL('./diffWorker.ts', import.meta.url), { type: 'module' });
      diffWorker.onmessage = (ev: MessageEvent<{ id: number; patch: string }>) => {
        const ask = diffAsks.get(ev.data.id);
        diffAsks.delete(ev.data.id);
        ask?.done(ev.data.patch);
      };
      diffWorker.onerror = () => {
        diffWorker?.terminate();
        diffWorker = null;
        const waiting = [...diffAsks.values()];
        diffAsks.clear();
        for (const { ask, done } of waiting) slicedDiff(ask.filePath, ask.before, ask.after, done);
      };
    } catch { diffWorker = null; }
  }
  if (!diffWorker) { slicedDiff(filePath, before, after, done); return; }
  const id = ++diffAskId;
  diffAsks.set(id, { ask: { filePath, before, after }, done });
  diffWorker.postMessage({ id, filePath, before, after });
}

/** One edit: its diff is computed and drawn once the card nears the panel's
 *  viewport, so opening the tab costs what is on screen. */
const EditCard = memo(function EditCard({ edit: e, isPair, missing, onNeed, busy, onSplit, onRevert }: {
  edit: EditSnapshot;
  isPair: boolean;
  /** The hub had no content for it. */
  missing: boolean;
  onNeed?: (paths: string[]) => void;
  busy: boolean;
  onSplit: (edit: EditSnapshot) => void;
  onRevert: (filePath: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const [diffed, setDiffed] = useState<string | null>(() => (isPair ? patchCache.get(e) ?? null : null));
  const [allLines, setAllLines] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    // Root = the panel's scroller: a margin on the window would not reach
    // the cards its overflow clips.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { root: el.closest('.tp-body'), rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  // Content is fetched when the card nears the viewport, a batch per tick.
  const hasContent = e.before != null || e.after != null;
  useEffect(() => {
    if (near && !hasContent && !missing) onNeed?.([e.filePath]);
  }, [near, hasContent, missing, onNeed, e.filePath]);

  useEffect(() => {
    if (!near || !isPair || diffed != null || !hasContent) return;
    let live = true;
    const before = e.before ?? '';
    const after = e.after ?? '';
    const done = (patch: string) => {
      patchCache.set(e, patch);
      if (live) setDiffed(patch);
    };
    const cancel = scheduleDiff(() => {
      const quick = createPatch(e.filePath, before, after, '', '', { context: 3, timeout: QUICK_DIFF_MS });
      if (quick !== undefined) done(quick);
      else diffOffThread(e.filePath, before, after, done);
    });
    return () => { live = false; cancel(); };
  }, [near, isPair, diffed, e, hasContent]);

  // A backend's own patch needs no diffing, only drawing. A cached diff gives
  // the counts at once; the lines wait for the card to near the viewport.
  const patch = !hasContent ? null : isPair ? diffed : (near ? (e.after ?? '') : null);
  const stats = useMemo(() => (patch == null ? null : countDiff(patch)), [patch]);
  const body = useMemo(() => {
    if (patch == null || !near) return null;
    const lines = isPair ? patch.split('\n').slice(4) : patch.split('\n'); // createPatch's 4-line header
    const shown = allLines ? lines : lines.slice(0, DIFF_LINES_SHOWN);
    return { nodes: isPair ? renderDiffLines(shown) : renderRawPatchLines(shown), hidden: lines.length - shown.length };
  }, [patch, near, isPair, allLines]);

  return (
    <div ref={ref} className="diff-card">
      <div className="diff-head">
        <div className="diff-path-row">
          <span className="path">{e.filePath}</span>
        </div>
        <div className="diff-meta-row">
          <span className="stats">
            <span className="add">+{stats ? stats.add : '…'}</span>
            <span className="del">−{stats ? stats.del : '…'}</span>
          </span>
          {isPair && (
            <>
              <button className="compare" disabled={!hasContent} onClick={() => onSplit(e)} title="compare side by side">⇄ split</button>
              <button className="revert" disabled={busy || e.truncated || !hasContent}
                title={e.truncated ? 'Cannot safely restore a truncated snapshot' : 'Restore this exact snapshot if the file has not changed since'}
                onClick={() => onRevert(e.filePath)}>
                {busy ? '…' : 'revert'}
              </button>
            </>
          )}
        </div>
      </div>
      {e.truncated && <div className="warn">⚠ truncated snapshot (file &gt; 256KB)</div>}
      {isPair && hasContent && e.before == null && <div className="note">new file (Write)</div>}
      <pre className="diff-body" aria-busy={body || missing ? undefined : true}>
        {body ? body.nodes : <span className="dline ctx">{missing ? 'no diff available' : '…'}</span>}
      </pre>
      {body && body.hidden > 0 && (
        <button type="button" className="tp-more" onClick={() => setAllLines(true)}>
          {body.hidden} more lines
        </button>
      )}
    </div>
  );
});

/**
 * Files attached to the session.
 *
 * The point of this tab is continuity: within one session the user can see
 * which files are actually in play on the VPS, get them back, and re-attach one
 * to a later message without hunting through the transcript for the path.
 *
 * Three actions per file, in order of how often they're wanted:
 *  - `+`  re-insert the path into the message being composed (the whole reason
 *         the tab exists — a file uploaded 40 messages ago is one click away).
 *  - copy the path (for a shell, or to paste into another session).
 *  - download the hub-side copy.
 * Removal is deliberately last and unlabelled-by-default: it drops the entry and
 * best-effort deletes the remote file, which would strand any earlier message
 * that references it.
 */
function FilesTab({ sessionId, attachments, onRemove, onInsert }: {
  sessionId: string | null;
  attachments: SessionAttachment[];
  onRemove?: (id: string) => void;
  onInsert?: (path: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copyPath(a: SessionAttachment) {
    try {
      await navigator.clipboard.writeText(a.remotePath);
      setCopied(a.id);
      setTimeout(() => setCopied((c) => (c === a.id ? null : c)), 1200);
    } catch {
      // Clipboard API needs a secure context (https / localhost). On plain
      // http the path is still selectable in the DOM — don't pretend it worked.
      alert(a.remotePath);
    }
  }

  if (attachments.length === 0) {
    return (
      <div className="tp-empty">
        no files attached yet
        <br />
        <span className="tp-empty-hint">drop a file anywhere on the page, or use the 📎 button</span>
      </div>
    );
  }

  return (
    <ul className="files-list">
      {attachments.map((a) => (
        <li key={a.id}>
          <div className="f-head">
            <IconFileEarmark className="f-icon" />
            <span className="f-name" title={a.name}>{a.name}</span>
            <span className="f-size">{fmtSize(a.size)}</span>
          </div>
          <div className="f-path" title={a.remotePath}>{a.remotePath}</div>
          <div className="f-actions">
            {/* Open in a new tab and let the browser render it natively —
                image, PDF, audio, video, text. Shown only when the SERVER says
                it will serve this file inline (`previewMime`), so the button
                can never promise a preview the route would refuse.
                `rel=noopener` because the new tab is a sandboxed document we
                don't want holding a handle on `window.opener`. */}
            {sessionId && a.previewMime && (
              <a
                className="f-open"
                href={api.sessionAttachmentUrl(sessionId, a.id, { inline: true })}
                target="_blank"
                rel="noopener noreferrer"
                title={`open in a new tab (${a.previewMime})`}
              >
                <IconEye /> open
              </a>
            )}
            <button type="button" onClick={() => onInsert?.(a.remotePath)} title="insert this path into the message">
              <IconPlusSquare /> Insert path
            </button>
            <button type="button" onClick={() => copyPath(a)} title="copy the path on the VPS">
              <IconClipboard /> {copied === a.id ? 'Copied' : 'Copy path'}
            </button>
            {sessionId && (
              <a
                className="f-dl"
                href={api.sessionAttachmentUrl(sessionId, a.id)}
                download={a.name}
                title="download the copy kept by Charon"
              >
                <IconDownload /> Download
              </a>
            )}
            <button
              type="button"
              className="f-rm"
              onClick={() => {
                if (confirm(`Remove "${a.name}" from this session?\n\nThe copy on the VPS is deleted too — any earlier message pointing at this path will stop resolving.`)) {
                  onRemove?.(a.id);
                }
              }}
              title="remove from the session (deletes the file on the VPS)"
            >
              <IconTrash />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Compact calls (`GET …/tool-calls`) as the calls tab's entries. */
function summaryToEntry(c: ToolCallSummary): ToolCallEntry {
  return {
    id: c.id, name: c.name, input: c.input, startedAt: c.startedAt,
    ...(c.result ? { result: { content: c.result.preview, isError: c.result.isError } } : {}),
  };
}

/** Paged history first, then the live calls (a live entry replaces its page
 *  twin: it carries the full result). */
function mergeToolCalls(paged: ToolCallEntry[], live: ToolCallEntry[]): ToolCallEntry[] {
  const liveIds = new Set(live.map((c) => c.id));
  return [...paged.filter((c) => !liveIds.has(c.id)), ...live];
}

/** The conversation view's calls history, fetched once `enabled` (the tab is
 *  open), newest page first; `loadOlder` prepends the next page. */
function useConversationToolCalls(sessionId: string | null, enabled: boolean): {
  calls: ToolCallEntry[]; hasMore: boolean; loading: boolean; loadOlder: () => void;
} {
  const [pages, setPages] = useState<{ sid: string | null; calls: ToolCallEntry[]; before: number | null; hasMore: boolean }>(
    { sid: null, calls: [], before: null, hasMore: false });
  const [loading, setLoading] = useState(false);
  const startedRef = useRef<string | null>(null);
  const fetchPage = useCallback(async (sid: string, before: number | null) => {
    setLoading(true);
    try {
      const r = await api.getSessionToolCalls(sid, before != null ? { before, limit: 200 } : { limit: 200 });
      setPages((cur) => {
        const base = cur.sid === sid ? cur.calls : [];
        return {
          sid, calls: [...r.calls.map(summaryToEntry), ...base],
          before: r.calls.length ? r.calls[0].rowId : before, hasMore: r.hasMore,
        };
      });
    } catch {
      // The tab still shows the live calls; reopening retries.
      if (startedRef.current === sid && before == null) startedRef.current = null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!enabled || !sessionId || startedRef.current === sessionId) return;
    startedRef.current = sessionId;
    void fetchPage(sessionId, null);
  }, [enabled, sessionId, fetchPage]);
  const current = pages.sid === sessionId ? pages : { calls: [], before: null, hasMore: false };
  const loadOlder = useCallback(() => {
    if (!sessionId || loading || current.before == null) return;
    void fetchPage(sessionId, current.before);
  }, [sessionId, loading, current.before, fetchPage]);
  return { calls: current.calls, hasMore: current.hasMore, loading, loadOlder };
}

function CallsTab({ calls }: { calls: ToolCallEntry[] }) {
  if (calls.length === 0) return <div className="tp-empty">no tool calls</div>;
  return (
    <ul className="calls-list">
      {calls.slice().reverse().map((c) => (
        <li key={c.id} className={c.result?.isError ? 'err' : ''}>
          <div className="head">
            <span className="name">{c.name}</span>
            <span className="time">{fmtTime(c.startedAt)}</span>
          </div>
          <div className="input">{summarizeInput(c.name, c.input)}</div>
          {c.result && (
            <div className="result">
              {c.result.isError ? '✗ ' : '✓ '}
              {c.result.content.slice(0, 80)}{c.result.content.length > 80 ? '…' : ''}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function countDiff(patch: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

function renderDiffLines(lines: string[]): React.ReactNode {
  return lines.map((l, i) => {
    let cls = 'ctx';
    if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    else if (l.startsWith('@@')) cls = 'hunk';
    return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
  });
}

// Render a Codex-supplied unified diff verbatim (Codex already produces the
// patch — we must NOT re-diff it). Classifies every line: file/patch headers
// dimmed, @@ hunks highlighted, +/− add/del. No fixed header slice (Codex
// patches don't share createPatch's exact 4-line preamble).
function renderRawPatchLines(lines: string[]): React.ReactNode {
  return lines.map((l, i) => {
    let cls = 'ctx';
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('*** ')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    return <span key={i} className={`dline ${cls}`}>{l + '\n'}</span>;
  });
}

function summarizeInput(name: string, input: any): string {
  if (!input) return '';
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit':
      return String(input.file_path ?? '').slice(0, 60);
    case 'Bash':
      return String(input.command ?? '').slice(0, 60);
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

// ONE formatter for the whole list (toLocaleTimeString builds one per call).
let callTimeFormat: Intl.DateTimeFormat | null = null;
function fmtTime(ts: number): string {
  callTimeFormat ??= new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return callTimeFormat.format(new Date(ts * 1000));
}
