'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { SessionListItem, InstallInfo } from '@/lib/types/api';
import { IconClockHistory, IconRobot, IconServers, IconTerminal, IconTools } from './icons';
import { colorToCss } from './SessionContextMenu';

// SessionListItem est défini dans `lib/types/api.ts` (source de vérité,
// alignée avec la réponse de GET /api/claude/sessions). On le réexporte
// pour ne pas casser les imports historiques `import { SessionListItem }
// from './Sidebar'`.
export type { SessionListItem };

// Re-export pour les consommateurs (ClaudePanel) qui passent des installs.
export type { InstallInfo };

const COLLAPSED_KEY = 'hub.claude.collapsedVps.v2';
const ACTIVE_STATUSES = new Set(['active', 'thinking', 'starting']);

function formatAge(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return 'à l’instant';
  if (diff < 3600) return Math.floor(diff / 60) + 'min';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'j';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

// Heuristique de matching cwd → path : on choisit le path le plus long
// qui est préfixe (ou égal) au cwd de la session.
function bestPathFor(cwd: string, paths: VpsPath[]): VpsPath | null {
  let best: VpsPath | null = null;
  for (const p of paths) {
    if (cwd === p.path || cwd.startsWith(p.path.endsWith('/') ? p.path : p.path + '/')) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

// Label affichable pour un path : son `label` custom, sinon le dernier
// segment non vide du path (ex: /srv/charon → "charon"). "/" devient "(root)".
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
  // Sessions d'installation d'agent. Mémoire seulement, comme les shells.
  // Listées par VPS. Une session install apparaît au-dessus des paths quand
  // active OU récemment terminée (au max 1 par VPS, cf. installSession.ts).
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
  // Bouton "gérer VPS & dossiers" dans le toolbar de la sidebar (remplace
  // l'ancien bouton "historique global" qui était redondant avec le bouton
  // par-VPS "historique" présent sur chaque carte).
  onOpenData: () => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  onContextInstall?: (install: InstallInfo, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  // Ouvre une session install pour ce VPS (crée si pas existante, focus
  // l'existante sinon).
  onInstallAgent?: (vps: Vps) => void;
  onLoginAgent?: (vps: Vps) => void;
  onUpdateAgent?: (vps: Vps) => void;
  // Toggle collapsed d'un dossier (persisté en DB via PATCH /api/vps-folders/[id]).
  onToggleFolderCollapsed?: (folderId: string, collapsed: boolean) => void;
  // SHA du .pyz embarqué dans le dashboard (sert à détecter agent out-of-date)
  builtPyzSha?: string | null;
  // VPS pour lesquels une mise à jour est en cours (UI loading)
  updatingAgentVpsIds?: Set<string>;
};

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:       { glyph: '●', label: 'agent opérationnel' },
  missing:  { glyph: '○', label: 'agent non installé' },
  error:    { glyph: '◐', label: 'agent en erreur' },
  unknown:  { glyph: '?', label: 'agent jamais testé' },
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

  // Sections de VPS collapsées (persistant en localStorage) — par-VPS, par-device.
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

  // Précalcule : paths par VPS, triés par longueur décroissante (best-match)
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

  // Groupe les VPS par folderId, en respectant l'ordre `position` intra-folder.
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

  // Folders triés par position, avec règle "default last" : le dossier
  // 'default' (Sans dossier) est forcé en bas, peu importe sa `position`
  // stockée. On garde aussi un fallback : si un VPS pointe vers un
  // folderId inconnu (théoriquement impossible, mais data drift), on crée
  // un dossier virtuel "(orphelins)" en bas de la sidebar.
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
      // Synthétique : ne sera pas persisté, juste pour qu'on n'oublie pas un VPS.
      sorted.push({
        id: '__orphans__',
        name: '(orphelins)',
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
          title="gérer les VPS, dossiers et paths"
          aria-label="gérer les VPS et dossiers"
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
        // Compteur agrégé : sessions actives à travers tous les VPS du dossier
        const folderActiveCount = sessions.filter(
          (s) => folderVps.some((v) => v.id === s.vpsId) && ACTIVE_STATUSES.has(s.liveStatus ?? s.status),
        ).length;
        const folderCollapsed = folder.collapsed === 1;

        // Le dossier "default" n'a typiquement pas besoin d'header visible si
        // c'est le seul dossier — mais le user a explicitement demandé une
        // organisation en dossiers, donc on l'affiche toujours. Si tu veux le
        // masquer quand vide+seul, c'est ici qu'il faudrait court-circuiter.
        return (
          <section key={folder.id} className={`folder-section${folderCollapsed ? ' folder-collapsed' : ''}`}>
            <div
              className="folder-head"
              onClick={() => {
                if (folder.id === '__orphans__') return;
                onToggleFolderCollapsed?.(folder.id, !folderCollapsed);
              }}
              role="button"
              title={folderCollapsed ? 'cliquer pour déplier le dossier' : 'cliquer pour replier le dossier'}
            >
              <span className="folder-caret">{folderCollapsed ? '▸' : '▾'}</span>
              <span className="folder-glyph">▤</span>
              <span className="folder-name">{folder.name}</span>
              <span className="folder-count" title={`${folderVps.length} VPS dans ce dossier`}>{folderVps.length}</span>
              {folderActiveCount > 0 && (
                <span className="folder-active-count" title={`${folderActiveCount} session(s) active(s) dans ce dossier`}>
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
              <div className="folder-empty">aucun VPS dans ce dossier — glisse-en un ici depuis le modal de config</div>
            )}
          </section>
        );
      })}
    </aside>
  );
}

// Rendu d'une carte VPS (extrait du body du composant principal pour garder la
// lisibilité après l'introduction du wrapping par folder).
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
  // Pour une même route (path), on liste les sessions dans l'ordre
  // chronologique d'apparition : la plus ancienne en haut, la plus récente
  // en bas. Une nouvelle session apparaît donc systématiquement en queue
  // de liste et n'est jamais re-rangée (pas de "remonter la session la
  // plus active") — c'est explicitement le comportement voulu.
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
  const agentTip = `${agentMeta.label}${agentVersion ? ` (v${agentVersion})` : ''}${agentOutOfDate ? ' — mise à jour dispo' : ''}`;
  // Si l'agent n'est pas OK, les boutons qui nécessitent l'agent (new claude
  // session, historique = scan des sessions Claude sur disque) sont disabled.
  // Le shell SSH reste OK car il n'a pas besoin de l'agent.
  const agentReady = agentStatus === 'ok';
  const noAgentReason = agentStatus === 'missing'
    ? "installe l'agent d'abord"
    : agentStatus === 'error'
    ? "l'agent est en erreur — réinstalle-le"
    : "agent pas encore vérifié — clique \"install agent\"";
  return (
    <section key={v.id} className={`vps-section vps-card${isCollapsed ? ' collapsed' : ''} agent-${agentStatus}`}>
      <div
        className="vps-head"
        onClick={onToggle}
        role="button"
        title={isCollapsed ? 'cliquer pour déplier' : 'cliquer pour replier'}
      >
        <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
        <span className="g">▣</span>
        <span className="n">{v.name}</span>
        <span
          className={`vps-agent-dot agent-${agentStatus}${agentOutOfDate ? ' outdated' : ''}`}
          title={agentTip}
        >{agentMeta.glyph}</span>
        {activeCount > 0 ? (
          <span className="active-count" title={`${activeCount} session(s) active(s)`}>{activeCount}</span>
        ) : (
          <span className="active-count zero" title="aucune session active">0</span>
        )}
      </div>
      {!isCollapsed && (
        <div className="vps-meta">
          <span className="vps-host">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
          <span className="vps-sep">·</span>
          <span className={`vps-agent-text agent-${agentStatus}`}>
            {agentStatus === 'ok'      ? `agent ${agentVersion ? `v${agentVersion}` : 'ok'}`
            : agentStatus === 'missing' ? 'agent non installé'
            : agentStatus === 'error'   ? 'agent en erreur'
            : 'agent non testé'}
          </span>
        </div>
      )}
      {!isCollapsed && (
        <div className="vps-actions">
          {agentStatus !== 'ok' && onInstallAgent && (
            <button
              className="vps-act-btn primary"
              onClick={(e) => { e.stopPropagation(); onInstallAgent(v); }}
              title="installer / réparer l'agent sur ce VPS"
            >▸ install agent</button>
          )}
          {agentOutOfDate && onUpdateAgent && (
            <button
              className="vps-act-btn agent-update"
              disabled={agentUpdating}
              onClick={(e) => { e.stopPropagation(); onUpdateAgent(v); }}
              title={`mettre à jour l'agent (déployé: ${agentPyzSha ?? 'inconnu'}, dispo: ${builtPyzSha})`}
            >{agentUpdating ? '⟳ mise à jour…' : '⇪ update agent'}</button>
          )}
          {/* Bouton "claude login" : masqué si on a déjà vérifié et qu'un
              compte est connecté (`claudeLoggedIn === 1`). Affiché si pas
              connecté OU si on n'a jamais vérifié (`null`, valeur par défaut
              pour les VPS pré-migration ou pas encore bootstrap-és). */}
          {onLoginAgent && agentReady && (v as any).claudeLoggedIn !== 1 && (
            <button
              className="vps-act-btn"
              onClick={(e) => { e.stopPropagation(); onLoginAgent(v); }}
              title={
                (v as any).claudeLoggedIn === 0
                  ? "claude login interactif (OAuth) sur ce VPS — pas connecté"
                  : "claude login interactif (OAuth) sur ce VPS"
              }
            ><span className="btn-icon"><IconRobot /></span> claude login</button>
          )}
          <button
            className="vps-act-btn"
            onClick={(e) => { e.stopPropagation(); onNewShell({ vpsId: v.id, cwd: null }); }}
            title="ouvrir un shell SSH sur ce VPS (home du user)"
          ><span className="btn-icon"><IconTerminal /></span> shell</button>
          <button
            className="vps-act-btn"
            onClick={(e) => { e.stopPropagation(); onScan(v.id); }}
            disabled={!agentReady}
            title={agentReady ? "scanner les sessions Claude existantes sur ce VPS" : `historique indisponible — ${noAgentReason}`}
          ><span className="btn-icon"><IconClockHistory /></span> historique</button>
        </div>
      )}
      {/* Session install si présente — au-dessus des paths, sous les boutons.
          Visible aussi quand l'install est terminée (success/error) pour que
          l'user puisse rouvrir le log. Fermeture via clic-droit → Fermer. */}
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
          title={`installation agent · ${vpsInstall.status === 'running' ? 'en cours' : vpsInstall.status === 'success' ? 'terminée' : 'échec'}`}
        >
          <div className="row-head">
            <span className="dot" />
            <span className="label">⚙ installation</span>
            <span className="install-row-tag">
              {vpsInstall.status === 'running'
                ? (vpsInstall.currentPhase ?? 'init')
                : vpsInstall.status === 'success'
                  ? 'OK'
                  : 'échec'}
            </span>
          </div>
        </button>
      )}
      {!isCollapsed && (
        <>
          {/* Paths déclarés, avec leurs sessions matchées */}
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
                    title={agentReady ? "nouvelle session Claude sur ce path" : `nouvelle session indisponible — ${noAgentReason}`}
                    aria-label="nouvelle session Claude"
                  ><IconRobot /></button>
                  <button
                    className="proj-action proj-shell"
                    onClick={() => onNewShell({ vpsId: v.id, cwd: p.path })}
                    title="ouvrir un shell SSH dans ce path"
                    aria-label="nouveau shell"
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
                  <span className="n">{paths.length === 0 ? 'sans path enregistré' : 'autres'}</span>
                  <button
                    className="proj-action"
                    onClick={() => onNew({ vpsId: v.id })}
                    disabled={!agentReady}
                    title={agentReady ? "nouvelle session Claude libre" : `nouvelle session indisponible — ${noAgentReason}`}
                    aria-label="nouvelle session Claude"
                  ><IconRobot /></button>
                  <button
                    className="proj-action proj-shell"
                    onClick={() => onNewShell({ vpsId: v.id, cwd: null })}
                    title="shell SSH au home du user"
                    aria-label="nouveau shell"
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
      className={`session-row${selected ? ' selected' : ''}${needsAttention ? ' attention' : ''}${colorToken ? ' has-color' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        if (!onContext) return;
        e.preventDefault();
        onContext(s, e.clientX, e.clientY);
      }}
      title={`${s.cwd}\nCréée: ${age || '?'}${preview ? '\n\n' + preview : ''}`}
      style={colorToken ? { ['--row-color' as any]: colorToCss(colorToken) } : undefined}
    >
      <span className="row-color-stripe" />
      <div className="row-head">
        <span className={`dot ${dotClass}`} />
        <span className="label">{headline}</span>
        {!!s.pendingPermissions && (
          <span className="perm-badge" title={`${s.pendingPermissions} permission(s) en attente`}>🔒{s.pendingPermissions}</span>
        )}
        {!!s.subscribers && s.subscribers > 1 && (
          <span className="multi" title={`${s.subscribers} clients connectés`}>×{s.subscribers}</span>
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
      title={`shell SSH${sh.cwd ? ` · ${sh.cwd}` : ''}\nDémarré ${age}${sh.exited ? '\n(terminé)' : ''}`}
      style={sh.color ? { ['--row-color' as any]: colorToCss(sh.color) } : undefined}
    >
      <span className="row-color-stripe" />
      <div className="row-head">
        <span className={`dot ${sh.exited ? 'dot-gray' : 'dot-cyan'}`} />
        <span className="label">{headline}</span>
        {sh.exited && <span className="shell-exit-tag">terminé</span>}
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
