'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { SessionListItem, InstallInfo } from '@/lib/types/api';
import { IconClockHistory, IconRobot, IconServers, IconTerminal } from './icons';
import { colorToCss } from './SessionContextMenu';
import { useLongPress } from './useLongPress';

// SessionListItem is defined in `lib/types/api.ts` (source of truth,
// aligned with the GET /api/claude/sessions response). We re-export it
// here so we don't break the historical `import { SessionListItem }
// from './Sidebar'` imports.
export type { SessionListItem };

// Re-export for consumers (ClaudePanel) that pass installs.
export type { InstallInfo };

const COLLAPSED_KEY = 'hub.claude.collapsedVps.v2';
const PAUSED_KEY = 'hub.claude.showPaused.v1';
const ACTIVE_STATUSES = new Set(['active', 'thinking', 'starting']);

function formatAge(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'min';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
}

function cwdTail(cwd: string, max = 34): string {
  return cwd.length > max ? '…' + cwd.slice(-(max - 1)) : cwd;
}

export type ShellListItem = {
  id: string;
  vpsId: string;
  vpsName: string;
  cwd: string | null;
  name: string | null;
  color: string | null;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  // Live activity (agent >= 0.9.0): 'busy' while the PTY streams output →
  // amber-pulse dot, like a "thinking" Claude session. Fed by the global SSE
  // bus in ClaudePanel; undefined = idle/at-prompt. Structurally mirrors
  // ShellInfo so the two stay assignable.
  liveStatus?: 'active' | 'busy';
};

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  sessions: SessionListItem[];
  shells: ShellListItem[];
  // Agent install sessions. In-memory only, like the shells. Listed per
  // VPS. An install session appears above the cards when active OR
  // recently finished (max 1 per VPS, cf. installSession.ts).
  installs: InstallInfo[];
  selectedId: string | null;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  onSelect: (id: string) => void;
  onSelectShell: (id: string) => void;
  onSelectInstall: (id: string) => void;
  onNew: (opts: { vpsId?: string; cwd?: string }) => void;
  onNewShell: (opts: { vpsId?: string; cwd?: string | null }) => void;
  onScan: (vpsId: string) => void;
  // "Manage VPS & folders" button in the sidebar toolbar.
  onOpenData: () => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  onContextInstall?: (install: InstallInfo, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  // Opens an install session for this VPS (creates one if it doesn't
  // exist, focuses the existing one otherwise).
  onInstallAgent?: (vps: Vps) => void;
  onLoginAgent?: (vps: Vps) => void;
  onUpdateAgent?: (vps: Vps) => void;
  // Re-establish the agent connection (for a VPS shown as 'error' that is
  // actually healthy — the SSH transport just dropped). See
  // /api/vps/[id]/agent/refresh.
  onRefreshAgent?: (vps: Vps) => void;
  // Toggle a folder's collapsed state (persisted in DB via PATCH /api/vps-folders/[id]).
  onToggleFolderCollapsed?: (folderId: string, collapsed: boolean) => void;
  // SHA of the .pyz embedded in the dashboard (used to detect agent out-of-date)
  builtPyzSha?: string | null;
  // VPSes for which an update is in progress (UI loading)
  updatingAgentVpsIds?: Set<string>;
  // VPSes for which a refresh (reconnect) is in progress (UI loading)
  refreshingAgentVpsIds?: Set<string>;
};

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:       { glyph: '●', label: 'agent operational' },
  missing:  { glyph: '○', label: 'agent not installed' },
  error:    { glyph: '◐', label: 'agent unreachable — connection dropped' },
  unknown:  { glyph: '?', label: 'agent never tested' },
};

export default function Sidebar({
  vpsList, vpsFolders, sessions, shells, installs,
  selectedId, selectedShellId, selectedInstallId,
  onSelect, onSelectShell, onSelectInstall,
  onNew, onNewShell, onScan, onOpenData,
  onContext, onContextShell, onContextInstall,
  editingId, onRenameSubmit, onRenameCancel,
  onInstallAgent, onLoginAgent, onUpdateAgent, onRefreshAgent, onToggleFolderCollapsed,
  builtPyzSha, updatingAgentVpsIds, refreshingAgentVpsIds,
}: Props) {

  // Collapsed VPS sections (persisted in localStorage) — per-VPS, per-device.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Show / hide paused (sleeping) sessions. Default ON (= show everything).
  const [showPaused, setShowPaused] = useState(true);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw)));
      if (localStorage.getItem(PAUSED_KEY) === '0') setShowPaused(false);
    } catch {}
  }, []);
  function toggleCollapsed(vpsId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(vpsId)) next.delete(vpsId);
      else next.add(vpsId);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }
  function uncollapseVps(vpsId: string) {
    setCollapsed((prev) => {
      if (!prev.has(vpsId)) return prev;
      const next = new Set(prev);
      next.delete(vpsId);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }
  function toggleShowPaused() {
    setShowPaused((v) => {
      const next = !v;
      try { localStorage.setItem(PAUSED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // ── Auto-scroll to the selected entity (VSCode-style "reveal in
  // explorer"). On any change to the selection, expand the parent VPS +
  // folder if collapsed, then scroll the row into view. 2-pass (expand →
  // re-run → scrollIntoView). See the previous implementation's notes.
  const asideRef = useRef<HTMLElement | null>(null);
  const activeTabId = selectedId ?? selectedShellId ?? selectedInstallId ?? null;
  const parentVpsId = useMemo(() => {
    if (!activeTabId) return null;
    return (
      sessions.find((s) => s.id === activeTabId)?.vpsId
      ?? shells.find((sh) => sh.id === activeTabId)?.vpsId
      ?? installs.find((i) => i.id === activeTabId)?.vpsId
      ?? null
    );
  }, [activeTabId, sessions, shells, installs]);
  const parentFolderId = useMemo(() => {
    if (!parentVpsId) return null;
    return vpsList.find((v) => v.id === parentVpsId)?.folderId ?? null;
  }, [parentVpsId, vpsList]);

  useEffect(() => {
    if (!parentVpsId) return;
    if (collapsed.has(parentVpsId)) uncollapseVps(parentVpsId);
    if (parentFolderId) {
      const f = vpsFolders.find((ff) => ff.id === parentFolderId);
      if (f && f.collapsed === 1) onToggleFolderCollapsed?.(parentFolderId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, parentVpsId, parentFolderId]);

  useEffect(() => {
    if (!activeTabId) return;
    const aside = asideRef.current;
    if (!aside) return;
    const raf = requestAnimationFrame(() => {
      const row = aside.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
      if (!row) return;
      const aRect = aside.getBoundingClientRect();
      const rRect = row.getBoundingClientRect();
      const isFullyVisible = rRect.top >= aRect.top && rRect.bottom <= aRect.bottom;
      if (isFullyVisible) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTabId, collapsed, vpsFolders]);

  // Group VPSes by folderId, respecting the intra-folder `position` order.
  const vpsByFolder = useMemo(() => {
    const m = new Map<string, Vps[]>();
    for (const v of vpsList) {
      const arr = m.get(v.folderId) ?? [];
      arr.push(v);
      m.set(v.folderId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [vpsList]);

  // Folders sorted by position, "default last", + a synthetic "(orphans)"
  // folder if a VPS points at an unknown folderId (data drift).
  const sortedFolders = useMemo(() => {
    const sorted = [...vpsFolders].sort((a, b) => {
      if (a.id === 'default') return 1;
      if (b.id === 'default') return -1;
      return a.position - b.position;
    });
    const known = new Set(sorted.map((f) => f.id));
    const orphanedFolderIds = new Set<string>();
    for (const v of vpsList) if (!known.has(v.folderId)) orphanedFolderIds.add(v.folderId);
    if (orphanedFolderIds.size > 0) {
      sorted.push({ id: '__orphans__', name: '(orphans)', position: 999999, collapsed: 0, createdAt: 0 } as VpsFolder);
    }
    return sorted;
  }, [vpsFolders, vpsList]);

  // Sessions / shells per VPS (sessions filtered by the paused switch).
  function sessionsFor(vpsId: string): SessionListItem[] {
    return sessions
      .filter((s) => s.vpsId === vpsId)
      .filter((s) => showPaused || (s.liveStatus ?? s.status) !== 'sleeping')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  function shellsFor(vpsId: string): ShellListItem[] {
    return shells
      .filter((sh) => sh.vpsId === vpsId)
      .filter((sh) => showPaused || !sh.exited)
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }

  function agentOutOfDateOf(v: Vps): boolean {
    const agentStatus = (v as any).agentStatus ?? 'unknown';
    const agentPyzSha = (v as any).agentPyzSha as string | undefined;
    return agentStatus === 'ok' && !!builtPyzSha && (agentPyzSha == null || agentPyzSha !== builtPyzSha);
  }

  const totalSleeping = sessions.filter((s) => (s.liveStatus ?? s.status) === 'sleeping').length;

  return (
    <aside className="claude-sidebar" ref={asideRef}>
      <div className="cs-top">
        <div className="cs-top-row">
          <span className="cs-title">SESSIONS</span>
          <button
            className="cs-manage"
            onClick={onOpenData}
            title="manage VPS, folders and paths"
            aria-label="manage VPS and folders"
          ><IconServers /></button>
        </div>
        <div className="cs-add full">
          <button className="cs-add-btn agent" onClick={() => onNew({})} title="new Claude agent">
            <IconRobot /><span>Agent</span>
          </button>
          <button className="cs-add-btn shell" onClick={() => onNewShell({})} title="new SSH shell">
            <IconTerminal /><span>Shell</span>
          </button>
        </div>
        <label className="cs-switch" title="show or hide paused (sleeping) sessions">
          <input type="checkbox" checked={showPaused} onChange={toggleShowPaused} />
          <span className="cs-switch-track"><span className="cs-switch-thumb" /></span>
          <span className="cs-switch-label">
            show paused{totalSleeping > 0 ? <span className="cs-switch-count">{totalSleeping}</span> : null}
          </span>
        </label>
      </div>

      {sortedFolders.map((folder) => {
        let folderVps: Vps[];
        if (folder.id === '__orphans__') {
          const known = new Set(vpsFolders.map((f) => f.id));
          folderVps = vpsList.filter((v) => !known.has(v.folderId));
        } else {
          folderVps = vpsByFolder.get(folder.id) ?? [];
        }

        // Resolve, per VPS, its visible content + whether to show it at all.
        const visibleVps = folderVps
          .map((v) => {
            const install = installs.find((i) => i.vpsId === v.id) ?? null;
            return {
              vps: v,
              vpsSessions: sessionsFor(v.id),
              vpsShells: shellsFor(v.id),
              install,
            };
          })
          // A VPS shows ONLY when it has a visible session/shell (the paused
          // switch decides via sessionsFor/shellsFor), with one exception: a
          // running install — otherwise a just-launched install would vanish
          // from the sidebar. Folders with no visible VPS are hidden below.
          .filter((x) => x.vpsSessions.length + x.vpsShells.length > 0 || x.install?.status === 'running');

        if (visibleVps.length === 0) return null;

        const folderActiveCount = visibleVps.reduce(
          (acc, x) => acc + x.vpsSessions.filter((s) => ACTIVE_STATUSES.has(s.liveStatus ?? s.status)).length,
          0,
        );
        const folderCollapsed = folder.collapsed === 1;

        return (
          <section key={folder.id} className={`cs-folder${folderCollapsed ? ' collapsed' : ''}`}>
            <div
              className="cs-folder-head"
              onClick={() => { if (folder.id !== '__orphans__') onToggleFolderCollapsed?.(folder.id, !folderCollapsed); }}
              role="button"
              title={folderCollapsed ? 'click to expand the folder' : 'click to collapse the folder'}
            >
              <span className="cs-caret">{folderCollapsed ? '▸' : '▾'}</span>
              <span className="cs-folder-glyph">▤</span>
              <span className="cs-folder-name">{folder.name}</span>
              <span className="cs-count" title={`${visibleVps.length} VPS shown`}>{visibleVps.length}</span>
              {folderActiveCount > 0 && (
                <span className="cs-folder-active" title={`${folderActiveCount} active session(s)`}>{folderActiveCount}</span>
              )}
            </div>
            {!folderCollapsed && (
              <div className="cs-folder-body">
                {visibleVps.map((x) => renderVpsBox(x.vps, {
                  vpsSessions: x.vpsSessions,
                  vpsShells: x.vpsShells,
                  vpsInstall: x.install,
                  isCollapsed: collapsed.has(x.vps.id),
                  onToggle: () => toggleCollapsed(x.vps.id),
                  agentOutOfDate: agentOutOfDateOf(x.vps),
                  selectedId, selectedShellId, selectedInstallId,
                  onSelect, onSelectShell, onSelectInstall,
                  onNew, onNewShell, onScan,
                  onContext, onContextShell, onContextInstall,
                  editingId, onRenameSubmit, onRenameCancel,
                  onInstallAgent, onLoginAgent, onUpdateAgent, onRefreshAgent,
                  updatingAgentVpsIds, refreshingAgentVpsIds,
                }))}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
}

// ── VPS box (the V1 "boxed VPS" design) ───────────────────────────────────
type VpsRenderOpts = {
  vpsSessions: SessionListItem[];
  vpsShells: ShellListItem[];
  vpsInstall: InstallInfo | null;
  isCollapsed: boolean;
  onToggle: () => void;
  agentOutOfDate: boolean;
  selectedId: string | null;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  onSelect: (id: string) => void;
  onSelectShell: (id: string) => void;
  onSelectInstall: (id: string) => void;
  onNew: (opts: { vpsId?: string; cwd?: string }) => void;
  onNewShell: (opts: { vpsId?: string; cwd?: string | null }) => void;
  onScan: (vpsId: string) => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  onContextInstall?: (install: InstallInfo, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onInstallAgent?: (vps: Vps) => void;
  onLoginAgent?: (vps: Vps) => void;
  onUpdateAgent?: (vps: Vps) => void;
  onRefreshAgent?: (vps: Vps) => void;
  updatingAgentVpsIds?: Set<string>;
  refreshingAgentVpsIds?: Set<string>;
};

function renderVpsBox(v: Vps, opts: VpsRenderOpts) {
  const {
    vpsSessions, vpsShells, vpsInstall, isCollapsed, onToggle, agentOutOfDate,
    selectedId, selectedShellId, selectedInstallId,
    onSelect, onSelectShell, onSelectInstall,
    onNew, onNewShell, onScan,
    onContext, onContextShell, onContextInstall,
    editingId, onRenameSubmit, onRenameCancel,
    onInstallAgent, onLoginAgent, onUpdateAgent, onRefreshAgent,
    updatingAgentVpsIds, refreshingAgentVpsIds,
  } = opts;

  const agentStatus = (v as any).agentStatus ?? 'unknown';
  const agentVersion = (v as any).agentVersion as string | undefined;
  const agentPyzSha = (v as any).agentPyzSha as string | undefined;
  const agentReady = agentStatus === 'ok';
  const agentUpdating = !!updatingAgentVpsIds?.has(v.id);
  const agentRefreshing = !!refreshingAgentVpsIds?.has(v.id);
  const agentMeta = AGENT_BADGE[agentStatus] ?? AGENT_BADGE.unknown;
  const agentTip = `${agentMeta.label}${agentVersion ? ` (v${agentVersion})` : ''}${agentOutOfDate ? ' — update available' : ''}`;
  const noAgentReason = agentStatus === 'missing'
    ? 'install the agent first'
    : agentStatus === 'error'
    ? 'the agent connection dropped — click "refresh agent"'
    : 'agent not yet verified — click "install agent"';
  const installRunning = vpsInstall?.status === 'running';

  return (
    <section key={v.id} className={`cs-vps agent-${agentStatus}${isCollapsed ? ' collapsed' : ''}`}>
      <div className="cs-vps-head">
        <button className="cs-caret btn" onClick={onToggle} title={isCollapsed ? 'expand' : 'collapse'}>
          {isCollapsed ? '▸' : '▾'}
        </button>
        <span className={`cs-vps-dot agent-${agentStatus}${agentOutOfDate ? ' outdated' : ''}`} title={agentTip}>
          {agentMeta.glyph}
        </span>
        <span className="cs-vps-id">
          <span className="cs-vps-name">{v.name}</span>
          <span className="cs-vps-ip">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
        </span>
        <button
          className="cs-icon-btn"
          onClick={(e) => { e.stopPropagation(); onScan(v.id); }}
          disabled={!agentReady}
          title={agentReady ? 'scan existing Claude sessions (import)' : `history unavailable — ${noAgentReason}`}
          aria-label="history"
        ><IconClockHistory /></button>
        <div className="cs-add">
          <button
            className="cs-add-btn agent"
            onClick={(e) => { e.stopPropagation(); onNew({ vpsId: v.id }); }}
            disabled={!agentReady}
            title={agentReady ? 'new Claude agent on this VPS' : `new session unavailable — ${noAgentReason}`}
            aria-label="new Claude agent"
          ><IconRobot /></button>
          <button
            className="cs-add-btn shell"
            onClick={(e) => { e.stopPropagation(); onNewShell({ vpsId: v.id, cwd: null }); }}
            title="new SSH shell on this VPS"
            aria-label="new shell"
          ><IconTerminal /></button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="cs-vps-body">
          {/* Agent status / action bar — only when there's something to do. */}
          {installRunning ? null : agentStatus === 'missing' || agentStatus === 'unknown' ? (
            <div className="cs-agent-bar warn">
              <span className="cs-agent-meta">{agentStatus === 'missing' ? 'agent not installed' : 'agent not verified'}</span>
              {onInstallAgent && (
                <button className="cs-agent-btn primary" onClick={() => onInstallAgent(v)}>▸ install agent</button>
              )}
            </div>
          ) : agentStatus === 'error' ? (
            <div className="cs-agent-bar err">
              <span className="cs-agent-meta">agent unreachable</span>
              {onRefreshAgent && (
                <button className="cs-agent-btn primary" disabled={agentRefreshing} onClick={() => onRefreshAgent(v)}>
                  {agentRefreshing ? '⟳ refreshing…' : '↻ refresh'}
                </button>
              )}
              {onInstallAgent && (
                <button className="cs-agent-btn" disabled={agentRefreshing} onClick={() => onInstallAgent(v)}>reinstall</button>
              )}
            </div>
          ) : agentOutOfDate ? (
            <div className="cs-agent-bar update">
              <span className="cs-agent-meta">{agentVersion ? `v${agentVersion} · ` : ''}update available</span>
              {onUpdateAgent && (
                <button className="cs-agent-btn update" disabled={agentUpdating} onClick={() => onUpdateAgent(v)}>
                  {agentUpdating ? '⟳ updating…' : '⇪ update'}
                </button>
              )}
            </div>
          ) : (v as any).claudeLoggedIn !== 1 && onLoginAgent ? (
            <div className="cs-agent-bar warn">
              <span className="cs-agent-meta">{agentVersion ? `v${agentVersion} · ` : ''}not signed in</span>
              <button className="cs-agent-btn" onClick={() => onLoginAgent(v)}>
                <span className="cs-btn-ico"><IconRobot /></span> claude login
              </button>
            </div>
          ) : null}

          {/* Install session row (running / finished, reopenable). */}
          {vpsInstall && (
            <InstallRow
              install={vpsInstall}
              selected={vpsInstall.id === selectedInstallId}
              onSelect={onSelectInstall}
              onContext={onContextInstall}
            />
          )}

          {vpsSessions.map((s) => (
            <SessionRow
              key={s.id} s={s}
              selected={s.id === selectedId}
              onSelect={onSelect}
              onContext={onContext}
              editing={editingId === s.id}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
            />
          ))}
          {vpsShells.map((sh) => (
            <ShellRow
              key={sh.id} sh={sh}
              selected={sh.id === selectedShellId}
              onSelect={onSelectShell}
              onContext={onContextShell}
            />
          ))}

          {vpsSessions.length === 0 && vpsShells.length === 0 && !installRunning && (
            <div className="cs-empty">no session — use ＋ to start one</div>
          )}
        </div>
      )}
    </section>
  );
}

function InstallRow({ install, selected, onSelect, onContext }: {
  install: InstallInfo;
  selected: boolean;
  onSelect: (id: string) => void;
  onContext?: (install: InstallInfo, x: number, y: number) => void;
}) {
  const lp = useLongPress((c) => { onContext?.(install, c.x, c.y); });
  return (
    <button
      type="button"
      data-tab-id={install.id}
      className={`cs-install-row ${install.status}${selected ? ' selected' : ''}`}
      onClick={() => { if (lp.consume()) return; onSelect(install.id); }}
      onContextMenu={(e) => { if (!onContext) return; e.preventDefault(); onContext(install, e.clientX, e.clientY); }}
      {...lp.handlers}
      title={`agent installation · ${install.status}`}
    >
      <span className="cs-install-dot" />
      <span className="cs-install-label">⚙ installation</span>
      <span className="cs-install-tag">
        {install.status === 'running'
          ? (install.currentPhase ?? 'init')
          : install.status === 'success' ? 'OK' : 'failed'}
      </span>
    </button>
  );
}

const DOT_CLASS: Record<string, string> = {
  active: 'dot-green',
  starting: 'dot-amber',
  thinking: 'dot-amber-pulse',
  sleeping: 'dot-gray',
  killed: 'dot-gray',
  error: 'dot-red',
  waiting: 'dot-orange-pulse',
};

const STATUS_TEXT: Record<string, string> = {
  active: 'ready',
  thinking: 'working',
  starting: 'starting',
  sleeping: 'paused',
  waiting: 'needs you',
  error: 'error',
};

function SessionRow({ s, selected, onSelect, onContext, editing, onRenameSubmit, onRenameCancel }: {
  s: SessionListItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  editing?: boolean;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
}) {
  // Touch long-press → context menu (mobile has no right-click). Must run
  // before the `editing` early-return to keep hook order stable. §11.
  const lp = useLongPress((c) => { onContext?.(s, c.x, c.y); });
  const baseStatus = s.liveStatus ?? s.status;
  const effective = (s.pendingPermissions ?? 0) > 0 && baseStatus === 'active' ? 'waiting' : baseStatus;
  const dotClass = DOT_CLASS[effective] ?? 'dot-gray';
  if (editing) {
    return (
      <RenameInput
        initial={s.name ?? ''}
        onSubmit={(name) => onRenameSubmit?.(s.id, name)}
        onCancel={() => onRenameCancel?.()}
      />
    );
  }
  const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  const headline = s.name || (preview ? preview.slice(0, 60) : s.cwd.split('/').slice(-2).join('/'));
  const age = formatAge(s.createdAt);
  const showPreview = !!preview && preview !== headline && !headline.startsWith(preview.slice(0, 30));
  const needsAttention = (s.pendingPermissions ?? 0) > 0;
  // "Finished, unread": the session ended a turn while you weren't looking and
  // you haven't opened it since (DB: unread_stop). Suppressed on the selected
  // card (you're reading it), when it already needs attention (a pending
  // question is the more urgent, orange cue), and while the session is actively
  // WORKING (thinking/starting) — a turn in progress isn't "finished, unread"
  // even if the DB marker hasn't been cleared yet. cf. CLAUDE.md §14.47.
  const working = baseStatus === 'thinking' || baseStatus === 'starting';
  const unread = !!s.unreadStop && !selected && !needsAttention && !working;
  const colorToken = (s as any).color as string | null | undefined;
  return (
    <button
      type="button"
      data-tab-id={s.id}
      className={`cs-card${selected ? ' selected' : ''}${needsAttention ? ' attention' : ''}${unread ? ' finished-unread' : ''}${effective === 'sleeping' ? ' is-sleeping' : ''}`}
      onClick={() => { if (lp.consume()) return; onSelect(s.id); }}
      onContextMenu={(e) => { if (!onContext) return; e.preventDefault(); onContext(s, e.clientX, e.clientY); }}
      {...lp.handlers}
      title={`${s.cwd}\nCreated: ${age || '?'}${preview ? '\n\n' + preview : ''}`}
      suppressHydrationWarning
      style={colorToken ? { ['--c' as any]: colorToCss(colorToken) } : undefined}
    >
      <span className="cs-card-stripe" />
      <div className="cs-card-top">
        <span className={`dot ${dotClass}`} />
        <span className="cs-card-glyph"><IconRobot /></span>
        <span className="cs-card-name">{headline}</span>
        {unread && (
          <span className="cs-unread" title="finished — unread (open to clear)">✓</span>
        )}
        {!!s.pendingPermissions && (
          <span className="cs-perm" title={`${s.pendingPermissions} pending permission(s)`}>🔒{s.pendingPermissions}</span>
        )}
        {!!s.subscribers && s.subscribers > 1 && (
          <span className="cs-multi" title={`${s.subscribers} connected clients`}>×{s.subscribers}</span>
        )}
        <span className={`cs-state ${effective}`}>{STATUS_TEXT[effective] ?? effective}</span>
      </div>
      {showPreview && <div className="cs-card-preview">{preview}</div>}
      <div className="cs-card-foot">
        <span className="cs-card-cwd">{cwdTail(s.cwd, 30)}</span>
        {age && <span className="cs-card-age" suppressHydrationWarning>{age}</span>}
      </div>
    </button>
  );
}

function ShellRow({ sh, selected, onSelect, onContext }: {
  sh: ShellListItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onContext?: (sh: ShellListItem, x: number, y: number) => void;
}) {
  const lp = useLongPress((c) => { onContext?.(sh, c.x, c.y); });
  const age = formatAge(Math.floor(sh.startedAt / 1000));
  const cwdShort = sh.cwd ? cwdTail(sh.cwd, 30) : '~';
  const headline = sh.name ?? `shell · ${sh.cwd ? cwdTail(sh.cwd, 16) : '~'}`;
  const dotClass = sh.exited ? 'dot-gray' : (sh.liveStatus === 'busy' ? 'dot-amber-pulse' : 'dot-green');
  return (
    <button
      type="button"
      data-tab-id={sh.id}
      className={`cs-card shell${selected ? ' selected' : ''}${sh.exited ? ' is-sleeping' : ''}`}
      onClick={() => { if (lp.consume()) return; onSelect(sh.id); }}
      onContextMenu={(e) => { if (!onContext) return; e.preventDefault(); onContext(sh, e.clientX, e.clientY); }}
      {...lp.handlers}
      title={`SSH shell${sh.cwd ? ` · ${sh.cwd}` : ''}\nStarted ${age}${sh.exited ? '\n(ended)' : ''}`}
      style={sh.color ? { ['--c' as any]: colorToCss(sh.color) } : undefined}
    >
      <span className="cs-card-stripe" />
      <div className="cs-card-top">
        <span className={`dot ${dotClass}`} />
        <span className="cs-card-glyph shell"><IconTerminal /></span>
        <span className="cs-card-name">{headline}</span>
        <span className={`cs-state ${sh.exited ? 'sleeping' : sh.liveStatus === 'busy' ? 'thinking' : 'active'}`}>
          {sh.exited ? 'ended' : sh.liveStatus === 'busy' ? 'busy' : 'idle'}
        </span>
      </div>
      <div className="cs-card-foot">
        <span className="cs-card-cwd">{cwdShort}</span>
        {age && <span className="cs-card-age">{age}</span>}
      </div>
    </button>
  );
}

function RenameInput({ initial, onSubmit, onCancel }: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="cs-card rename-row">
      <input
        autoFocus
        defaultValue={initial}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit((e.target as HTMLInputElement).value.trim());
          else if (e.key === 'Escape') onCancel();
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== initial) onSubmit(v);
          else onCancel();
        }}
      />
    </div>
  );
}
