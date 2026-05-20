'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { SessionListItem, InstallInfo } from '@/lib/types/api';
import { IconClockHistory, IconRobot, IconServers, IconTerminal, IconTools } from './icons';
import { colorToCss } from './SessionContextMenu';

// SessionListItem is defined in `lib/types/api.ts` (source of truth,
// aligned with the GET /api/claude/sessions response). We re-export it
// here so we don't break the historical `import { SessionListItem }
// from './Sidebar'` imports.
export type { SessionListItem };

// Re-export for consumers (ClaudePanel) that pass installs.
export type { InstallInfo };

const COLLAPSED_KEY = 'hub.claude.collapsedVps.v2';
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

// cwd → path matching heuristic: we pick the longest path that is a
// prefix of (or equal to) the session's cwd.
function bestPathFor(cwd: string, paths: VpsPath[]): VpsPath | null {
  let best: VpsPath | null = null;
  for (const p of paths) {
    if (cwd === p.path || cwd.startsWith(p.path.endsWith('/') ? p.path : p.path + '/')) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

// Displayable label for a path: its custom `label`, otherwise the last
// non-empty segment of the path (e.g. /srv/charon → "charon"). "/" becomes "(root)".
function labelOf(p: VpsPath): string {
  if (p.label) return p.label;
  const segs = p.path.split('/').filter(Boolean);
  return segs.length === 0 ? '(root)' : segs[segs.length - 1];
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
};

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  sessions: SessionListItem[];
  shells: ShellListItem[];
  // Agent install sessions. In-memory only, like the shells. Listed per
  // VPS. An install session appears above the paths when active OR
  // recently finished (max 1 per VPS, cf. installSession.ts).
  installs: InstallInfo[];
  selectedId: string | null;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  onSelect: (id: string) => void;
  onSelectShell: (id: string) => void;
  onSelectInstall: (id: string) => void;
  onNew: (opts: { vpsId: string; cwd?: string }) => void;
  onNewShell: (opts: { vpsId: string; cwd?: string | null }) => void;
  onScan: (vpsId: string) => void;
  // "Manage VPS & folders" button in the sidebar toolbar (replaces the
  // old "global history" button which was redundant with the per-VPS
  // "history" button on each card).
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
  // Toggle a folder's collapsed state (persisted in DB via PATCH /api/vps-folders/[id]).
  onToggleFolderCollapsed?: (folderId: string, collapsed: boolean) => void;
  // SHA of the .pyz embedded in the dashboard (used to detect agent out-of-date)
  builtPyzSha?: string | null;
  // VPSes for which an update is in progress (UI loading)
  updatingAgentVpsIds?: Set<string>;
};

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:       { glyph: '●', label: 'agent operational' },
  missing:  { glyph: '○', label: 'agent not installed' },
  error:    { glyph: '◐', label: 'agent in error' },
  unknown:  { glyph: '?', label: 'agent never tested' },
};


export default function Sidebar({
  vpsList, vpsFolders, vpsPaths, sessions, shells, installs,
  selectedId, selectedShellId, selectedInstallId,
  onSelect, onSelectShell, onSelectInstall,
  onNew, onNewShell, onScan, onOpenData,
  onContext, onContextShell, onContextInstall,
  editingId, onRenameSubmit, onRenameCancel,
  onInstallAgent, onLoginAgent, onUpdateAgent, onToggleFolderCollapsed,
  builtPyzSha, updatingAgentVpsIds,
}: Props) {

  // Collapsed VPS sections (persisted in localStorage) — per-VPS, per-device.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw)));
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

  // Precompute: paths per VPS, sorted by decreasing length (best-match)
  const pathsByVps = useMemo(() => {
    const m = new Map<string, VpsPath[]>();
    for (const p of vpsPaths) {
      const arr = m.get(p.vpsId) ?? [];
      arr.push(p);
      m.set(p.vpsId, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    }
    return m;
  }, [vpsPaths]);

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

  // Folders sorted by position, with the "default last" rule: the 'default'
  // folder (Unfiled) is forced to the bottom regardless of its stored
  // `position`. We also keep a fallback: if a VPS points to an unknown
  // folderId (theoretically impossible, but data drift), we create a
  // virtual "(orphans)" folder at the bottom of the sidebar.
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
      // Synthetic: won't be persisted, just so we don't forget a VPS.
      sorted.push({
        id: '__orphans__',
        name: '(orphans)',
        position: 999999,
        collapsed: 0,
        createdAt: 0,
      } as VpsFolder);
    }
    return sorted;
  }, [vpsFolders, vpsList]);

  return (
    <aside className="claude-sidebar">
      <div className="sidebar-toolbar">
        <span className="sidebar-title">SESSIONS</span>
        <button
          className="sidebar-tb-btn"
          onClick={onOpenData}
          title="manage VPS, folders and paths"
          aria-label="manage VPS and folders"
        ><IconServers /></button>
      </div>

      {sortedFolders.map((folder) => {
        let folderVps: Vps[];
        if (folder.id === '__orphans__') {
          const known = new Set(vpsFolders.map((f) => f.id));
          folderVps = vpsList.filter((v) => !known.has(v.folderId));
        } else {
          folderVps = vpsByFolder.get(folder.id) ?? [];
        }
        // Aggregate counter: active sessions across all VPSes of the folder
        const folderActiveCount = sessions.filter(
          (s) => folderVps.some((v) => v.id === s.vpsId) && ACTIVE_STATUSES.has(s.liveStatus ?? s.status),
        ).length;
        const folderCollapsed = folder.collapsed === 1;

        // The "default" folder typically doesn't need a visible header if
        // it's the only folder — but the user has explicitly asked for
        // folder-based organization, so we always display it. If you want
        // to hide it when empty+alone, this is where to short-circuit.
        return (
          <section key={folder.id} className={`folder-section${folderCollapsed ? ' folder-collapsed' : ''}`}>
            <div
              className="folder-head"
              onClick={() => {
                if (folder.id === '__orphans__') return;
                onToggleFolderCollapsed?.(folder.id, !folderCollapsed);
              }}
              role="button"
              title={folderCollapsed ? 'click to expand the folder' : 'click to collapse the folder'}
            >
              <span className="folder-caret">{folderCollapsed ? '▸' : '▾'}</span>
              <span className="folder-glyph">▤</span>
              <span className="folder-name">{folder.name}</span>
              <span className="folder-count" title={`${folderVps.length} VPS in this folder`}>{folderVps.length}</span>
              {folderActiveCount > 0 && (
                <span className="folder-active-count" title={`${folderActiveCount} active session(s) in this folder`}>
                  {folderActiveCount}
                </span>
              )}
            </div>
            {!folderCollapsed && folderVps.map((v) => renderVpsCard(v, {
              vpsSessions: sessions.filter((s) => s.vpsId === v.id),
              vpsShells: shells.filter((sh) => sh.vpsId === v.id),
              vpsInstall: installs.find((i) => i.vpsId === v.id) ?? null,
              paths: pathsByVps.get(v.id) ?? [],
              isCollapsed: collapsed.has(v.id),
              onToggle: () => toggleCollapsed(v.id),
              selectedId, selectedShellId, selectedInstallId,
              onSelect, onSelectShell, onSelectInstall,
              onNew, onNewShell, onScan,
              onContext, onContextShell, onContextInstall,
              editingId, onRenameSubmit, onRenameCancel,
              onInstallAgent, onLoginAgent, onUpdateAgent,
              builtPyzSha, updatingAgentVpsIds,
            }))}
            {!folderCollapsed && folderVps.length === 0 && folder.id !== '__orphans__' && (
              <div className="folder-empty">no VPS in this folder — drag one here from the config modal</div>
            )}
          </section>
        );
      })}
    </aside>
  );
}

// Render a VPS card (extracted from the main component body to keep
// readability after introducing folder wrapping).
type VpsRenderOpts = {
  vpsSessions: SessionListItem[];
  vpsShells: ShellListItem[];
  vpsInstall: InstallInfo | null;
  paths: VpsPath[];
  isCollapsed: boolean;
  onToggle: () => void;
  selectedId: string | null;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  onSelect: (id: string) => void;
  onSelectShell: (id: string) => void;
  onSelectInstall: (id: string) => void;
  onNew: (opts: { vpsId: string; cwd?: string }) => void;
  onNewShell: (opts: { vpsId: string; cwd?: string | null }) => void;
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
  builtPyzSha?: string | null;
  updatingAgentVpsIds?: Set<string>;
};

function renderVpsCard(v: Vps, opts: VpsRenderOpts) {
  const {
    vpsSessions, vpsShells, vpsInstall, paths, isCollapsed, onToggle,
    selectedId, selectedShellId, selectedInstallId,
    onSelect, onSelectShell, onSelectInstall,
    onNew, onNewShell, onScan,
    onContext, onContextShell, onContextInstall,
    editingId, onRenameSubmit, onRenameCancel,
    onInstallAgent, onLoginAgent, onUpdateAgent, builtPyzSha, updatingAgentVpsIds,
  } = opts;

  // Groupe sessions + shells par best-matching path
  const groups = new Map<number | null, {
    path: VpsPath | null; sessions: SessionListItem[]; shells: ShellListItem[];
  }>();
  for (const p of paths) {
    groups.set(p.id, { path: p, sessions: [], shells: [] });
  }
  for (const s of vpsSessions) {
    const best = bestPathFor(s.cwd, paths);
    const key = best ? best.id : null;
    if (!groups.has(key)) groups.set(key, { path: best, sessions: [], shells: [] });
    groups.get(key)!.sessions.push(s);
  }
  for (const sh of vpsShells) {
    const best = sh.cwd ? bestPathFor(sh.cwd, paths) : null;
    const key = best ? best.id : null;
    if (!groups.has(key)) groups.set(key, { path: best, sessions: [], shells: [] });
    groups.get(key)!.shells.push(sh);
  }
  // For a given route (path), we list sessions in chronological order of
  // appearance: oldest at the top, newest at the bottom. So a new session
  // always appears at the tail of the list and is never re-ranked (no
  // "bubble up the most active session") — this is explicitly the intended
  // behavior.
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  const activeCount = vpsSessions.filter((s) =>
    ACTIVE_STATUSES.has(s.liveStatus ?? s.status)
  ).length;
  const agentStatus = (v as any).agentStatus ?? 'unknown';
  const agentVersion = (v as any).agentVersion as string | undefined;
  const agentPyzSha = (v as any).agentPyzSha as string | undefined;
  const agentOutOfDate =
    agentStatus === 'ok' &&
    !!builtPyzSha &&
    (agentPyzSha == null || agentPyzSha !== builtPyzSha);
  const agentUpdating = !!updatingAgentVpsIds?.has(v.id);
  const agentMeta = AGENT_BADGE[agentStatus] ?? AGENT_BADGE.unknown;
  const agentTip = `${agentMeta.label}${agentVersion ? ` (v${agentVersion})` : ''}${agentOutOfDate ? ' — update available' : ''}`;
  // If the agent isn't OK, the buttons that need the agent (new Claude
  // session, history = scan of Claude sessions on disk) are disabled.
  // The SSH shell still works because it doesn't need the agent.
  const agentReady = agentStatus === 'ok';
  const noAgentReason = agentStatus === 'missing'
    ? "install the agent first"
    : agentStatus === 'error'
    ? "the agent is in error — reinstall it"
    : "agent not yet verified — click \"install agent\"";
  return (
    <section key={v.id} className={`vps-section vps-card${isCollapsed ? ' collapsed' : ''} agent-${agentStatus}`}>
      <div
        className="vps-head"
        onClick={onToggle}
        role="button"
        title={isCollapsed ? 'click to expand' : 'click to collapse'}
      >
        <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
        <span className="g">▣</span>
        <span className="n">{v.name}</span>
        <span
          className={`vps-agent-dot agent-${agentStatus}${agentOutOfDate ? ' outdated' : ''}`}
          title={agentTip}
        >{agentMeta.glyph}</span>
        {activeCount > 0 ? (
          <span className="active-count" title={`${activeCount} active session(s)`}>{activeCount}</span>
        ) : (
          <span className="active-count zero" title="no active session">0</span>
        )}
      </div>
      {!isCollapsed && (
        <div className="vps-meta">
          <span className="vps-host">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
          <span className="vps-sep">·</span>
          <span className={`vps-agent-text agent-${agentStatus}`}>
            {agentStatus === 'ok'      ? `agent ${agentVersion ? `v${agentVersion}` : 'ok'}`
            : agentStatus === 'missing' ? 'agent not installed'
            : agentStatus === 'error'   ? 'agent in error'
            : 'agent untested'}
          </span>
        </div>
      )}
      {!isCollapsed && (
        <div className="vps-actions">
          {agentStatus !== 'ok' && onInstallAgent && (
            <button
              className="vps-act-btn primary"
              onClick={(e) => { e.stopPropagation(); onInstallAgent(v); }}
              title="install / repair the agent on this VPS"
            >▸ install agent</button>
          )}
          {agentOutOfDate && onUpdateAgent && (
            <button
              className="vps-act-btn agent-update"
              disabled={agentUpdating}
              onClick={(e) => { e.stopPropagation(); onUpdateAgent(v); }}
              title={`update the agent (deployed: ${agentPyzSha ?? 'unknown'}, available: ${builtPyzSha})`}
            >{agentUpdating ? '⟳ updating…' : '⇪ update agent'}</button>
          )}
          {/* "claude login" button: hidden if we've already checked and an
              account is logged in (`claudeLoggedIn === 1`). Shown if not
              logged in OR if we never checked (`null`, the default value
              for pre-migration or not-yet-bootstrapped VPSes). */}
          {onLoginAgent && agentReady && (v as any).claudeLoggedIn !== 1 && (
            <button
              className="vps-act-btn"
              onClick={(e) => { e.stopPropagation(); onLoginAgent(v); }}
              title={
                (v as any).claudeLoggedIn === 0
                  ? "interactive claude login (OAuth) on this VPS — not signed in"
                  : "interactive claude login (OAuth) on this VPS"
              }
            ><span className="btn-icon"><IconRobot /></span> claude login</button>
          )}
          <button
            className="vps-act-btn"
            onClick={(e) => { e.stopPropagation(); onNewShell({ vpsId: v.id, cwd: null }); }}
            title="open an SSH shell on this VPS (user home)"
          ><span className="btn-icon"><IconTerminal /></span> shell</button>
          <button
            className="vps-act-btn"
            onClick={(e) => { e.stopPropagation(); onScan(v.id); }}
            disabled={!agentReady}
            title={agentReady ? "scan existing Claude sessions on this VPS" : `history unavailable — ${noAgentReason}`}
          ><span className="btn-icon"><IconClockHistory /></span> history</button>
        </div>
      )}
      {/* Install session if present — above the paths, below the buttons.
          Also visible when the install is finished (success/error) so that
          the user can reopen the log. Close via right-click → Close. */}
      {!isCollapsed && vpsInstall && (
        <button
          type="button"
          className={`session-row install-row ${vpsInstall.status}${vpsInstall.id === selectedInstallId ? ' selected' : ''}`}
          onClick={() => onSelectInstall(vpsInstall.id)}
          onContextMenu={(e) => {
            if (!onContextInstall) return;
            e.preventDefault();
            onContextInstall(vpsInstall, e.clientX, e.clientY);
          }}
          title={`agent installation · ${vpsInstall.status === 'running' ? 'running' : vpsInstall.status === 'success' ? 'done' : 'failed'}`}
        >
          <div className="row-head">
            <span className="dot" />
            <span className="label">⚙ installation</span>
            <span className="install-row-tag">
              {vpsInstall.status === 'running'
                ? (vpsInstall.currentPhase ?? 'init')
                : vpsInstall.status === 'success'
                  ? 'OK'
                  : 'failed'}
            </span>
          </div>
        </button>
      )}
      {!isCollapsed && (
        <>
          {/* Declared paths, with their matched sessions */}
          {paths.map((p) => {
            const g = groups.get(p.id);
            return (
              <div key={p.id} className="proj-block">
                <div className="proj-head">
                  <span className="g">▤</span>
                  <span className="n">{labelOf(p)}</span>
                  <span className="cwd" title={p.path}>{p.path}</span>
                  <button
                    className="proj-action"
                    onClick={() => onNew({ vpsId: v.id, cwd: p.path })}
                    disabled={!agentReady}
                    title={agentReady ? "new Claude session on this path" : `new session unavailable — ${noAgentReason}`}
                    aria-label="new Claude session"
                  ><IconRobot /></button>
                  <button
                    className="proj-action proj-shell"
                    onClick={() => onNewShell({ vpsId: v.id, cwd: p.path })}
                    title="open an SSH shell in this path"
                    aria-label="new shell"
                  ><IconTerminal /></button>
                </div>
                {g?.sessions.map((s) => (
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
                {g?.shells.map((sh) => (
                  <ShellRow
                    key={sh.id} sh={sh}
                    selected={sh.id === selectedShellId}
                    onSelect={onSelectShell}
                    onContext={onContextShell}
                  />
                ))}
              </div>
            );
          })}
          {(() => {
            const orphSessions = groups.get(null)?.sessions ?? [];
            const orphShells = groups.get(null)?.shells ?? [];
            if (orphSessions.length === 0 && orphShells.length === 0 && paths.length > 0) return null;
            return (
              <div className="proj-block orphans">
                <div className="proj-head">
                  <span className="g">○</span>
                  <span className="n">{paths.length === 0 ? 'no registered path' : 'others'}</span>
                  <button
                    className="proj-action"
                    onClick={() => onNew({ vpsId: v.id })}
                    disabled={!agentReady}
                    title={agentReady ? "new free Claude session" : `new session unavailable — ${noAgentReason}`}
                    aria-label="new Claude session"
                  ><IconRobot /></button>
                  <button
                    className="proj-action proj-shell"
                    onClick={() => onNewShell({ vpsId: v.id, cwd: null })}
                    title="SSH shell at user home"
                    aria-label="new shell"
                  ><IconTerminal /></button>
                </div>
                {orphSessions.map((s) => (
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
                {orphShells.map((sh) => (
                  <ShellRow
                    key={sh.id} sh={sh}
                    selected={sh.id === selectedShellId}
                    onSelect={onSelectShell}
                    onContext={onContextShell}
                  />
                ))}
              </div>
            );
          })()}
        </>
      )}
    </section>
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

function SessionRow({ s, selected, onSelect, onContext, editing, onRenameSubmit, onRenameCancel }: {
  s: SessionListItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  editing?: boolean;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
}) {
  const baseStatus = s.liveStatus ?? s.status;
  const effective = (s.pendingPermissions ?? 0) > 0 && baseStatus === 'active'
    ? 'waiting'
    : baseStatus;
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
  const cwdTail = s.cwd.length > 38 ? '…' + s.cwd.slice(-37) : s.cwd;
  const age = formatAge(s.createdAt);
  const showPreview = !!preview && preview !== headline && !headline.startsWith(preview.slice(0, 30));
  const needsAttention = (s.pendingPermissions ?? 0) > 0;
  const colorToken = (s as any).color as string | null | undefined;
  return (
    <button
      type="button"
      className={`session-row${selected ? ' selected' : ''}${needsAttention ? ' attention' : ''}${colorToken ? ' has-color' : ''}${effective === 'sleeping' ? ' is-sleeping' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        if (!onContext) return;
        e.preventDefault();
        onContext(s, e.clientX, e.clientY);
      }}
      title={`${s.cwd}\nCreated: ${age || '?'}${preview ? '\n\n' + preview : ''}`}
      style={colorToken ? { ['--row-color' as any]: colorToCss(colorToken) } : undefined}
    >
      <span className="row-color-stripe" />
      <div className="row-head">
        <span className={`dot ${dotClass}`} />
        <span className="label">{headline}</span>
        {!!s.pendingPermissions && (
          <span className="perm-badge" title={`${s.pendingPermissions} pending permission(s)`}>🔒{s.pendingPermissions}</span>
        )}
        {!!s.subscribers && s.subscribers > 1 && (
          <span className="multi" title={`${s.subscribers} connected clients`}>×{s.subscribers}</span>
        )}
      </div>
      {showPreview && (
        <div className="row-preview">{preview}</div>
      )}
      <div className="row-meta">
        <span className="meta-cwd">{cwdTail}</span>
        {age && <span className="meta-age">· {age}</span>}
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
  const age = formatAge(Math.floor(sh.startedAt / 1000));
  const cwdTail = sh.cwd
    ? (sh.cwd.length > 38 ? '…' + sh.cwd.slice(-37) : sh.cwd)
    : '~';
  const headline = sh.name ?? `⌨ ${cwdTail}`;
  return (
    <button
      type="button"
      className={`session-row shell-row${selected ? ' selected' : ''}${sh.exited ? ' exited' : ''}${sh.color ? ' has-color' : ''}`}
      onClick={() => onSelect(sh.id)}
      onContextMenu={(e) => {
        if (!onContext) return;
        e.preventDefault();
        onContext(sh, e.clientX, e.clientY);
      }}
      title={`SSH shell${sh.cwd ? ` · ${sh.cwd}` : ''}\nStarted ${age}${sh.exited ? '\n(ended)' : ''}`}
      style={sh.color ? { ['--row-color' as any]: colorToCss(sh.color) } : undefined}
    >
      <span className="row-color-stripe" />
      <div className="row-head">
        <span className={`dot ${sh.exited ? 'dot-gray' : 'dot-cyan'}`} />
        <span className="label">{headline}</span>
        {sh.exited && <span className="shell-exit-tag">ended</span>}
      </div>
      <div className="row-meta">
        <span className="meta-cwd">shell · {sh.cwd ? cwdTail + ' · ' : ''}{age}</span>
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
    <div className="session-row rename-row">
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
