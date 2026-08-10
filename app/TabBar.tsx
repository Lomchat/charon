'use client';
import { useMemo } from 'react';
import type { Vps, VpsFolder } from '@/lib/db/schema';
import type { SessionListItem, ShellInfo, InstallInfo, AgentKind, TabDTO } from '@/lib/types/api';
import type { PermissionRequest, PendingQuestion, PendingExitPlan } from './sessionTypes';
import { IconTerminal, IconTools } from './icons';
import { IconForKind, fileKind } from './fileIcons';
import AgentLogo from './AgentLogo';

// TabBar — the workspace strip above the main column. §14.78
// ─────────────────────────────────────────────────────────────────────────────
// Three rows, because a tab now has three coordinates:
//
//   Row 1  VPS        — the machines with something open
//   Row 2  path       — the folders open on that machine. THE new level: a VPS
//                       routinely holds several projects, and a flat list of
//                       "everything open on chalco" tells you nothing about
//                       which one you're in.
//   Row 3  tabs       — what is open in that folder: sessions, shells, files.
//
// The set of tabs comes from the DB (shared across devices) instead of being
// derived from "every non-sleeping session", which is what it used to be. So a
// tab can be closed without touching the session, and a session can run with
// no tab at all — the sidebar remains its home.
//
// Temporary tabs are ITALIC and there is at most one per folder: opening
// something is a preview, and the next preview in that folder replaces it.
// Double-click (or any real interaction) pins.

export type TabState = 'active' | 'thinking' | 'waiting' | 'starting' | 'failed' | 'sleeping';

const STATE_PRIORITY: Record<TabState, number> = {
  waiting: 5, failed: 4, thinking: 3, starting: 2, active: 1, sleeping: 0,
};

/** A tab plus everything the strip needs to draw it. */
export type ResolvedTab = TabDTO & {
  label: string;
  title: string;
  state: TabState;
  agentKind?: AgentKind;
  dirty: boolean;
  /** The thing is gone (a file that was deleted, a session mid-removal). */
  orphan: boolean;
};

type Args = {
  tabs: TabDTO[];
  sessions: SessionListItem[];
  shells: ShellInfo[];
  installs: InstallInfo[];
  permQueue: PermissionRequest[];
  questionQueue: PendingQuestion[];
  exitPlanQueue: PendingExitPlan[];
  dirtyIds: ReadonlySet<string>;
};

/**
 * Resolve every tab against the live entity lists.
 *
 * Pure and exported so ClaudePanel can reuse the same resolution for the main
 * pane — two different answers to "what is this tab" is how a bar and a pane
 * end up disagreeing.
 */
export function resolveTabs({
  tabs, sessions, shells, installs, permQueue, questionQueue, exitPlanQueue, dirtyIds,
}: Args): ResolvedTab[] {
  const waiting = new Set<string>([
    ...permQueue.map((p) => p.sessionId),
    ...questionQueue.map((q) => q.sessionId),
    ...exitPlanQueue.map((e) => e.sessionId),
  ]);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const shellById = new Map(shells.map((s) => [s.id, s]));
  const installById = new Map(installs.map((i) => [i.id, i]));

  return tabs.map((t): ResolvedTab => {
    const dirty = dirtyIds.has(t.id);
    if (t.kind === 'session') {
      const s = sessionById.get(t.ref);
      const state: TabState = !s ? 'sleeping'
        : waiting.has(s.id) ? 'waiting'
        : (s.status as TabState) ?? 'active';
      return {
        ...t, dirty, orphan: !s,
        label: s?.name || '(unnamed)',
        title: `${s?.name || '(unnamed)'}\n${t.path}`,
        state: STATE_PRIORITY[state] === undefined ? 'active' : state,
        agentKind: (s?.kind as AgentKind) ?? 'claude',
      };
    }
    if (t.kind === 'shell') {
      const sh = shellById.get(t.ref);
      return {
        ...t, dirty, orphan: !sh,
        label: sh?.name || 'shell',
        title: `shell\n${t.path}`,
        state: sh ? 'active' : 'sleeping',
      };
    }
    if (t.kind === 'install') {
      const i = installById.get(t.ref);
      return {
        ...t, dirty, orphan: !i,
        label: 'install',
        title: `agent install\n${i?.vpsName ?? ''}`,
        state: i?.status === 'running' ? 'thinking' : i?.status === 'error' ? 'failed' : 'active',
      };
    }
    const name = t.ref.split('/').pop() || t.ref;
    return {
      ...t, dirty, orphan: false,
      label: name,
      title: `${t.path}/${t.ref}${dirty ? '\nunsaved changes' : ''}`,
      state: 'active',
    };
  });
}

function rollUp(list: { state: TabState }[]): TabState {
  let best: TabState = 'sleeping';
  for (const x of list) if (STATE_PRIORITY[x.state] > STATE_PRIORITY[best]) best = x.state;
  return best;
}

export type PathGroup = { vpsId: string; path: string; tabs: ResolvedTab[]; state: TabState };

type Props = {
  resolved: ResolvedTab[];
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  activeVpsId: string | null;
  activePath: string | null;
  activeTabId: string | null;
  onVpsClick: (vpsId: string) => void;
  onPathClick: (vpsId: string, path: string) => void;
  onTabClick: (tab: ResolvedTab) => void;
  onTabDoubleClick: (tab: ResolvedTab) => void;
  onTabClose: (tab: ResolvedTab) => void;
  onTabContext: (e: React.MouseEvent, tab: ResolvedTab) => void;
  onNewSession: (vpsId: string, path: string) => void;
  onNewShell: (vpsId: string, path: string) => void;
  newSessionDisabledReason: string | null;
};

export default function TabBar({
  resolved, vpsList, vpsFolders, activeVpsId, activePath, activeTabId,
  onVpsClick, onPathClick, onTabClick, onTabDoubleClick, onTabClose, onTabContext,
  onNewSession, onNewShell, newSessionDisabledReason,
}: Props) {
  const { vpsRows, pathRows, tabRows } = useMemo(() => {
    // Order follows the sidebar: folder.position → vps.position. A tab strip
    // that sorts differently from the tree beside it is a small, constant tax.
    const folderPos = new Map(vpsFolders.map((f) => [f.id, f.position]));
    const vpsOrder = new Map(
      [...vpsList].sort((a, b) =>
        (folderPos.get(a.folderId ?? 'default') ?? 99) - (folderPos.get(b.folderId ?? 'default') ?? 99)
        || (a.position ?? 0) - (b.position ?? 0)).map((v, i) => [v.id, i]),
    );

    const byVps = new Map<string, ResolvedTab[]>();
    for (const t of resolved) {
      const arr = byVps.get(t.vpsId) ?? [];
      arr.push(t);
      byVps.set(t.vpsId, arr);
    }
    const vpsRows = [...byVps.entries()]
      .map(([vpsId, list]) => ({
        vps: vpsList.find((v) => v.id === vpsId) ?? null,
        vpsId, count: list.length, state: rollUp(list),
      }))
      .filter((r) => r.vps)
      .sort((a, b) => (vpsOrder.get(a.vpsId) ?? 99) - (vpsOrder.get(b.vpsId) ?? 99));

    const here = byVps.get(activeVpsId ?? '') ?? [];
    const byPath = new Map<string, ResolvedTab[]>();
    for (const t of here) {
      const arr = byPath.get(t.path) ?? [];
      arr.push(t);
      byPath.set(t.path, arr);
    }
    const pathRows: PathGroup[] = [...byPath.entries()]
      .map(([path, list]) => ({ vpsId: activeVpsId!, path, tabs: list, state: rollUp(list) }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const tabRows = (byPath.get(activePath ?? '') ?? [])
      .slice().sort((a, b) => a.position - b.position);
    return { vpsRows, pathRows, tabRows };
  }, [resolved, vpsList, vpsFolders, activeVpsId, activePath]);

  if (vpsRows.length === 0) return <div className="claude-tabbar" />;

  return (
    <div className="claude-tabbar">
      <div className="tab-row tab-row-vps">
        {vpsRows.map((r) => (
          <button
            key={r.vpsId}
            className={`vps-tab${r.vpsId === activeVpsId ? ' selected' : ''} state-${r.state}`}
            onClick={() => onVpsClick(r.vpsId)}
            title={r.vps!.name}
          >
            <span className="vps-tab-glyph"><IconTools /></span>
            <span className="vps-tab-name">{r.vps!.name}</span>
            <span className="vps-tab-count">{r.count}</span>
          </button>
        ))}
      </div>

      {/* Row 2 — the folders open on this machine. Shown even when there is
          only one: its absence would make the row jump as soon as a second
          project opens, and the label is the fastest "where am I" cue. */}
      <div className="tab-row tab-row-paths">
        {pathRows.map((g) => (
          <button
            key={g.path}
            className={`path-tab${g.path === activePath ? ' selected' : ''} state-${g.state}`}
            onClick={() => onPathClick(g.vpsId, g.path)}
            title={g.path || 'no folder'}
          >
            <span className="path-tab-name">{g.path ? (g.path.split('/').filter(Boolean).pop() || g.path) : '—'}</span>
            <span className="path-tab-count">{g.tabs.length}</span>
          </button>
        ))}
      </div>

      <div className="tab-row tab-row-entities">
        {tabRows.length === 0 ? (
          <span className="tab-row-empty">nothing open in this folder</span>
        ) : tabRows.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === activeTabId ? ' selected' : ''}${t.pinned ? '' : ' temporary'}`
              + ` state-${t.state}${t.orphan ? ' orphan' : ''}`}
            onContextMenu={(e) => onTabContext(e, t)}
          >
            <button
              className="tab-main"
              onClick={() => onTabClick(t)}
              onDoubleClick={() => onTabDoubleClick(t)}
              title={`${t.title}${t.pinned ? '' : '\n(preview — double-click to keep it open)'}`}
            >
              <span className="tab-state-dot" />
              <span className="tab-glyph">
                {t.kind === 'session' ? <AgentLogo kind={t.agentKind ?? 'claude'} size={12} />
                  : t.kind === 'shell' ? <IconTerminal />
                  : t.kind === 'install' ? <IconTools />
                  : <IconForKind kind={fileKind(t.label, false)} />}
              </span>
              <span className="tab-label">{t.label}</span>
              {t.dirty && <span className="tab-dirty" title="unsaved changes">●</span>}
            </button>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onTabClose(t); }}
              title="close this tab (the session keeps running)"
            >✕</button>
          </div>
        ))}

        {activeVpsId && (
          <span className="tab-row-actions">
            <button
              className="tab-new-btn tab-new-session"
              onClick={() => onNewSession(activeVpsId, activePath ?? '')}
              disabled={!!newSessionDisabledReason}
              title={newSessionDisabledReason ?? 'new session in this folder'}
            >
              <span className="tab-new-plus">+</span>
              <span className="tab-new-glyph"><AgentLogo kind="claude" size={12} /></span>
            </button>
            <button
              className="tab-new-btn tab-new-shell"
              onClick={() => onNewShell(activeVpsId, activePath ?? '')}
              title="new shell in this folder"
            >
              <span className="tab-new-plus">+</span>
              <span className="tab-new-glyph"><IconTerminal /></span>
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
