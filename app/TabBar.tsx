'use client';
import { useMemo } from 'react';
import type { Vps, VpsFolder } from '@/lib/db/schema';
import type { SessionListItem, ShellInfo, InstallInfo } from '@/lib/types/api';
import type { PermissionRequest, PendingQuestion, PendingExitPlan } from './sessionTypes';
import { IconRobot, IconTerminal, IconTools } from './icons';

// TabBar
// ─────────────────────────────────────────────────────────────────────────────
// VSCode/Chrome-inspired 2-row tab strip above the main column.
//
//   Row 1 (top):    one tab per VPS that currently has at least one
//                   open entity. Click → switch the "active VPS".
//                   Border color = aggregated state of the VPS's entities
//                   (waiting > thinking > active > sleeping).
//
//   Row 2 (bottom): tabs of the active VPS's entities (Claude sessions,
//                   SSH shells, installs). Same color semantics as row 1
//                   but per individual entity.
//
// Per the spec, only "active" entities (any non-sleeping state) are
// permanent in the bar — sleeping/exited/finished entities gain a × to
// close them locally (without deleting the underlying entity). Closing
// is tracked by `keptOpenIds` in ClaudePanel.
//
// No drag-and-drop reordering — order follows the sidebar:
//   - VPSes: folder.position → VPS.position
//   - entities inside a VPS: createdAt asc

export type TabState = 'active' | 'thinking' | 'waiting' | 'starting' | 'sleeping';

export type EntityTab =
  | { kind: 'session'; id: string; vpsId: string; label: string; state: TabState; closable: boolean }
  | { kind: 'shell';   id: string; vpsId: string; label: string; state: TabState; closable: boolean }
  | { kind: 'install'; id: string; vpsId: string; label: string; state: TabState; closable: boolean };

export type VpsTab = {
  vps: Vps;
  state: TabState;
  count: number;
  // For VPS tabs we don't expose `closable` — closing happens per-entity in row 2.
};

const ACTIVE_SESSION_STATUSES = new Set(['active', 'thinking', 'starting']);

// Priority used to roll up a VPS's state from its entities' states.
// Higher number = more important (will dominate the aggregation).
const STATE_PRIORITY: Record<TabState, number> = {
  waiting: 4,
  thinking: 3,
  starting: 2,
  active: 1,
  sleeping: 0,
};

type Args = {
  sessions: SessionListItem[];
  shells: ShellInfo[];
  installs: InstallInfo[];
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  // Locally-kept-open ids (so a sleeping entity stays in the bar with × until user closes it).
  keptOpenIds: Set<string>;
  // Cross-session pending interaction queues — needed to mark "waiting" tabs.
  permQueue: PermissionRequest[];
  questionQueue: PendingQuestion[];
  exitPlanQueue: PendingExitPlan[];
};

/**
 * Builds the 2-row tab structure: VPS tabs (top) and per-VPS entity lists
 * (used to populate the second row for the active VPS).
 *
 * Pure function — kept exportable for unit-testing and reuse by
 * ClaudePanel for auto-jump-on-close logic.
 */
export function computeTabs({
  sessions, shells, installs, vpsList, vpsFolders,
  keptOpenIds, permQueue, questionQueue, exitPlanQueue,
}: Args): {
  vpsTabs: VpsTab[];                              // row 1, in sidebar order
  entitiesByVps: Map<string, EntityTab[]>;        // row 2 source, keyed by vpsId
  flat: EntityTab[];                              // all entities, in sidebar order
} {
  // Build the per-session "has pending" lookup (cross-session feed).
  const pendingSessionIds = new Set<string>();
  for (const p of permQueue) pendingSessionIds.add(p.sessionId);
  for (const q of questionQueue) pendingSessionIds.add(q.sessionId);
  for (const ep of exitPlanQueue) pendingSessionIds.add(ep.sessionId);

  // Sort VPSes in the same order as the sidebar:
  //   1. Folder position (default folder forced last)
  //   2. VPS position inside the folder
  // Orphan VPSes (unknown folderId) go at the very end.
  const foldersSorted = [...vpsFolders].sort((a, b) => {
    if (a.id === 'default') return 1;
    if (b.id === 'default') return -1;
    return a.position - b.position;
  });
  const knownFolderIds = new Set(foldersSorted.map((f) => f.id));
  const vpsOrdered: Vps[] = [];
  for (const f of foldersSorted) {
    const inFolder = vpsList
      .filter((v) => v.folderId === f.id)
      .sort((a, b) => a.position - b.position);
    vpsOrdered.push(...inFolder);
  }
  for (const v of vpsList) {
    if (!knownFolderIds.has(v.folderId)) vpsOrdered.push(v);
  }

  // Build per-VPS entity tabs.
  const entitiesByVps = new Map<string, EntityTab[]>();
  const flat: EntityTab[] = [];
  const vpsTabs: VpsTab[] = [];

  for (const v of vpsOrdered) {
    const entities: EntityTab[] = [];

    // ── Claude sessions ──
    const vpsSessions = sessions
      .filter((s) => s.vpsId === v.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const s of vpsSessions) {
      const baseStatus = s.liveStatus ?? s.status;
      const isActive = ACTIVE_SESSION_STATUSES.has(baseStatus);
      const isSleepingLike =
        baseStatus === 'sleeping' || baseStatus === 'error' || baseStatus === 'killed';
      if (!isActive && !keptOpenIds.has(s.id)) continue;
      let state: TabState;
      if (isSleepingLike) state = 'sleeping';
      else if (pendingSessionIds.has(s.id)) state = 'waiting';
      else if (baseStatus === 'thinking') state = 'thinking';
      else if (baseStatus === 'starting') state = 'starting';
      else state = 'active';
      const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
      const label =
        s.name?.trim()
        || (preview ? preview.slice(0, 40) : s.cwd.split('/').slice(-2).join('/'));
      entities.push({
        kind: 'session', id: s.id, vpsId: v.id, label, state,
        closable: state === 'sleeping',
      });
    }

    // ── SSH shells ──
    const vpsShells = shells
      .filter((sh) => sh.vpsId === v.id)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const sh of vpsShells) {
      const isLive = !sh.exited;
      if (!isLive && !keptOpenIds.has(sh.id)) continue;
      const cwdLabel = sh.cwd
        ? sh.cwd.split('/').filter(Boolean).slice(-1)[0] || sh.cwd
        : '~';
      const label = sh.name?.trim() || `shell · ${cwdLabel}`;
      entities.push({
        kind: 'shell', id: sh.id, vpsId: v.id, label,
        // Live 'busy' (PTY streaming output) reuses the Claude 'thinking'
        // tab state → blue/amber-pulse border, exactly like a session that's
        // thinking (agent >= 0.9.0). See §14 gotcha 42.
        state: !isLive ? 'sleeping' : (sh.liveStatus === 'busy' ? 'thinking' : 'active'),
        closable: !isLive,
      });
    }

    // ── Agent install (max 1 per VPS) ──
    const vpsInstall = installs.find((i) => i.vpsId === v.id);
    if (vpsInstall) {
      const isRunning = vpsInstall.status === 'running';
      if (isRunning || keptOpenIds.has(vpsInstall.id)) {
        entities.push({
          kind: 'install', id: vpsInstall.id, vpsId: v.id,
          label: isRunning
            ? `install · ${vpsInstall.currentPhase ?? 'init'}`
            : vpsInstall.status === 'success' ? 'install · OK' : 'install · failed',
          state: isRunning ? 'active' : 'sleeping',
          closable: !isRunning,
        });
      }
    }

    if (entities.length === 0) continue;

    // Roll up the VPS-level state from its entities (highest priority wins).
    let vpsState: TabState = 'sleeping';
    for (const e of entities) {
      if (STATE_PRIORITY[e.state] > STATE_PRIORITY[vpsState]) vpsState = e.state;
    }

    entitiesByVps.set(v.id, entities);
    flat.push(...entities);
    vpsTabs.push({ vps: v, state: vpsState, count: entities.length });
  }

  return { vpsTabs, entitiesByVps, flat };
}

// ── Component ───────────────────────────────────────────────────────────────

type Props = {
  vpsTabs: VpsTab[];
  entitiesByVps: Map<string, EntityTab[]>;
  // VPS currently shown in row 2. Derived in ClaudePanel from the selected
  // entity (its vpsId), or chosen explicitly by clicking a VPS tab.
  activeVpsId: string | null;
  selectedSessionId: string | null;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  onVpsClick: (vps: Vps) => void;
  onEntitySelect: (tab: EntityTab) => void;
  onEntityClose: (tab: EntityTab) => void;
  // "+ Claude" / "+ shell" buttons appended to row 2. ClaudePanel decides
  // the default cwd (typically: cwd of the rightmost tab, falling back to
  // VPS.defaultPath).
  onNewSession: (vpsId: string) => void;
  onNewShell: (vpsId: string) => void;
  // Reason to disable the "+ Claude" button (e.g. "agent missing"). The
  // "+ shell" button is always enabled — SSH shells don't need the agent.
  // Null/undefined = enabled.
  newSessionDisabledReason?: string | null;
  // Right-click on a tab → ClaudePanel resolves the entity (session /
  // shell / install) and opens the SAME `SessionContextMenu` as the
  // sidebar's right-click. The menu's state + rendering lives in
  // ClaudePanel, so there is zero duplication of menu logic between
  // the sidebar and the tab bar (single source of truth: ClaudePanel's
  // `ctxMenu` state machine).
  onTabContext: (tab: EntityTab, x: number, y: number) => void;
};

export default function TabBar({
  vpsTabs, entitiesByVps, activeVpsId,
  selectedSessionId, selectedShellId, selectedInstallId,
  onVpsClick, onEntitySelect, onEntityClose,
  onNewSession, onNewShell, newSessionDisabledReason,
  onTabContext,
}: Props) {
  // Render nothing when no VPS has any open entity (keeps the layout slim).
  const isEmpty = useMemo(() => vpsTabs.length === 0, [vpsTabs]);
  if (isEmpty) return null;

  const entities = activeVpsId ? entitiesByVps.get(activeVpsId) ?? [] : [];

  return (
    <div className="claude-tabbar" role="tablist" aria-label="open chats">
      {/* ── Row 1: VPS tabs ── */}
      <div className="tab-row tab-row-vps">
        {vpsTabs.map((v) => {
          const isActive = v.vps.id === activeVpsId;
          return (
            <button
              key={v.vps.id}
              type="button"
              className={`vps-tab tab-${v.state}${isActive ? ' selected' : ''}`}
              onClick={() => onVpsClick(v.vps)}
              role="tab"
              aria-selected={isActive}
              title={`${v.vps.name} — ${v.count} open`}
            >
              <span className="vps-tab-glyph" aria-hidden>▣</span>
              <span className="vps-tab-name">{v.vps.name}</span>
              <span className="vps-tab-count" title={`${v.count} open`}>{v.count}</span>
              {v.state === 'waiting' && <span className="tab-state-dot" aria-label="awaiting your response" />}
              {v.state === 'thinking' && <span className="tab-state-dot" aria-label="thinking" />}
            </button>
          );
        })}
      </div>

      {/* ── Row 2: entities of the active VPS ── */}
      <div className="tab-row tab-row-entities">
        {entities.length === 0 ? (
          <span className="tab-row-empty">— no open chat —</span>
        ) : entities.map((t) => {
          const isSelected =
            (t.kind === 'session' && t.id === selectedSessionId)
            || (t.kind === 'shell' && t.id === selectedShellId)
            || (t.kind === 'install' && t.id === selectedInstallId);
          return (
            <div
              key={`${t.kind}-${t.id}`}
              className={`tab tab-${t.state}${isSelected ? ' selected' : ''}`}
              role="tab"
              aria-selected={isSelected}
              onContextMenu={(e) => {
                e.preventDefault();
                onTabContext(t, e.clientX, e.clientY);
              }}
            >
              <button
                type="button"
                className="tab-main"
                onClick={() => onEntitySelect(t)}
                title={t.label}
              >
                <span className="tab-glyph" aria-hidden>
                  {t.kind === 'session' ? <IconRobot />
                    : t.kind === 'shell' ? <IconTerminal />
                    : <IconTools />}
                </span>
                <span className="tab-label">{t.label}</span>
                {t.state === 'waiting' && <span className="tab-state-dot" aria-label="awaiting your response" />}
                {t.state === 'thinking' && <span className="tab-state-dot" aria-label="thinking" />}
              </button>
              {t.closable && (
                <button
                  type="button"
                  className="tab-close"
                  onClick={(e) => { e.stopPropagation(); onEntityClose(t); }}
                  title="close this tab (does not delete the session)"
                  aria-label="close tab"
                >×</button>
              )}
            </div>
          );
        })}
        {activeVpsId && (
          <div className="tab-row-actions">
            <button
              type="button"
              className="tab-new-btn tab-new-session"
              onClick={() => onNewSession(activeVpsId)}
              disabled={!!newSessionDisabledReason}
              title={newSessionDisabledReason
                ? `new Claude session unavailable — ${newSessionDisabledReason}`
                : 'new Claude session in the same path as the last tab'}
              aria-label="new Claude session"
            >
              <span className="tab-new-glyph"><IconRobot /></span>
              <span className="tab-new-plus" aria-hidden>+</span>
            </button>
            <button
              type="button"
              className="tab-new-btn tab-new-shell"
              onClick={() => onNewShell(activeVpsId)}
              title="new SSH shell in the same path as the last tab"
              aria-label="new SSH shell"
            >
              <span className="tab-new-glyph"><IconTerminal /></span>
              <span className="tab-new-plus" aria-hidden>+</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
