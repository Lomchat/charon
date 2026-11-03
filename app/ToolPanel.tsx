'use client';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
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
import { useGitStatus, workspaceDirtyCount, workspaceRepos } from './gitStore';
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
  onRevert: () => void; // refresh signal
  // Files the user attached to this session (drag & drop / paperclip). The
  // list is owned by ClaudeSessionView so this panel and the input bar always
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
// (claude.css § SIDE COLUMNS): icons, counts as corner dots, each explained by
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

/** The width at which the tabs are the desktop activity bar (claude.css). */
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

function ToolPanel({
  sessionId, workspaceOnly = false, kind = 'claude', toolCalls: liveToolCalls, toolCallCount = null,
  transcriptView = null, edits, onRevert,
  attachments = [], onRemoveAttachment, onInsertPath, onOpenSession, onOpenFolder, onNewSessionIn,
  vpsId = null, cwd = null, repoBusy = false, requestedTab = null, onTabConsumed,
  onReveal, context = null, contextLoaded = false, contextLoading = false,
  onRefreshContext, onCompact, compacting = false, compactDisabled = true,
  compactError = null, deferInsight = false,
}: Props) {
  // The right sidebar belongs to the tab-row GROUP `(vpsId, cwd)`, not to the
  // entity currently filling the main pane. ClaudeSessionView is keyed by
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
  // Hide content-less skeleton entries (edit_snapshot content is stripped by
  // the GET and refilled lazily — CLAUDE.md §14 gotcha 41). A both-null entry
  // has no diff to show; it appears once loadEdits fills its content.
  // Conversation view: the calls tab's history comes from `GET …/tool-calls`,
  // fetched lazily the first time the tab opens; live calls are merged on top.
  const pagedCalls = useConversationToolCalls(
    sessionId, !workspaceOnly && transcriptView === 'conversation' && activeTab === 'calls');
  const toolCalls = useMemo(
    () => pagedCalls.calls.length ? mergeToolCalls(pagedCalls.calls, liveToolCalls) : liveToolCalls,
    [pagedCalls.calls, liveToolCalls],
  );
  const editArr = useMemo(
    () => Array.from(edits.values()).filter((e) => e.before != null || e.after != null),
    [edits],
  );

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
  const { workspace } = useGitStatus(vpsId, treeRoot);
  const gitDirty = workspaceDirtyCount(workspace);
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
        {!workspaceOnly && activeTab === 'edits' && <EditsTab sessionId={sessionId} kind={kind} edits={editArr} onRevert={onRevert} />}
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

function EditsTab({ sessionId, kind, edits, onRevert }: { sessionId: string | null; kind: AgentKind; edits: EditSnapshot[]; onRevert: () => void }) {
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
  const prepared = useMemo(() => edits.map((edit) => {
    const patch = isPair
      ? makeUnifiedDiff(edit.filePath, edit.before ?? '', edit.after ?? '')
      : (edit.after ?? '');
    return { edit, patch, stats: countDiff(patch) };
  }), [edits, isPair]);

  if (shape === 'none') {
    return <div className="tp-empty">{providerText.noEditSnapshots(kind)}</div>;
  }
  if (edits.length === 0) return <div className="tp-empty">no files modified in this session</div>;

  async function revert(filePath: string) {
    if (!sessionId) return;
    if (!confirm(`Restore "${filePath}" to its initial state?`)) return;
    setBusy(filePath);
    try {
      await api.revertClaudeEdit(sessionId, filePath);
      onRevert();
    } catch (e: any) {
      alert('revert: ' + (e?.message ?? e));
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="tp-edits">
        {prepared.map(({ edit: e, patch, stats }) => {
          return (
            <div key={e.toolUseId + e.filePath} className="diff-card">
              <div className="diff-head">
                <div className="diff-path-row">
                  <span className="path">{e.filePath}</span>
                </div>
                <div className="diff-meta-row">
                  <span className="stats">
                    <span className="add">+{stats.add}</span>
                    <span className="del">−{stats.del}</span>
                  </span>
                  {isPair && (
                    <>
                      <button className="compare" onClick={() => setOpen(e)} title="compare side by side">⇄ split</button>
                      <button className="revert" disabled={busy === e.filePath || e.truncated}
                        title={e.truncated ? 'Cannot safely restore a truncated snapshot' : 'Restore this exact snapshot if the file has not changed since'}
                        onClick={() => revert(e.filePath)}>
                        {busy === e.filePath ? '…' : 'revert'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {e.truncated && <div className="warn">⚠ truncated snapshot (file &gt; 256KB)</div>}
              {isPair && e.before == null && <div className="note">new file (Write)</div>}
              <pre className="diff-body">{isPair ? renderDiffHtml(patch) : renderRawPatch(patch)}</pre>
            </div>
          );
        })}
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
      const r = await api.getClaudeSessionToolCalls(sid, before != null ? { before, limit: 200 } : { limit: 200 });
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
function makeUnifiedDiff(filePath: string, before: string, after: string): string {
  return createPatch(filePath, before, after, '', '', { context: 3 });
}

function countDiff(patch: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

function renderDiffHtml(patch: string): React.ReactNode {
  const lines = patch.split('\n').slice(4); // strip header
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
function renderRawPatch(patch: string): React.ReactNode {
  const lines = patch.split('\n');
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

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
