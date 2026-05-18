'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Vps, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';
import { colorToCss } from './SessionContextMenu';

const COLLAPSED_KEY = 'hub.claude.collapsedVps.v2';
const ACTIVE_STATUSES = new Set(['active', 'thinking', 'starting']);

export type SessionListItem = ClaudeSession & {
  liveStatus?: WorkerStatus;
  subscribers?: number;
  pendingPermissions?: number;
  firstUserMessage?: string | null;
};

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
  vpsPaths: VpsPath[];
  sessions: SessionListItem[];
  shells: ShellListItem[];
  selectedId: string | null;
  selectedShellId: string | null;
  onSelect: (id: string) => void;
  onSelectShell: (id: string) => void;
  onNew: (opts: { vpsId: string; cwd?: string }) => void;
  onNewShell: (opts: { vpsId: string; cwd?: string | null }) => void;
  onScan: (vpsId: string) => void;
  onOpenResumeModal: () => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onInstallAgent?: (vps: Vps) => void;
  onLoginAgent?: (vps: Vps) => void;
};

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:       { glyph: '●', label: 'agent opérationnel' },
  missing:  { glyph: '○', label: 'agent non installé' },
  error:    { glyph: '◐', label: 'agent en erreur' },
  unknown:  { glyph: '?', label: 'agent jamais testé' },
};

// Icônes — bootstrap-icons, fill=currentColor pour s'adapter au thème
const IconTerminal = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 9a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3A.5.5 0 0 1 6 9M3.854 4.146a.5.5 0 1 0-.708.708L4.793 6.5 3.146 8.146a.5.5 0 1 0 .708.708l2-2a.5.5 0 0 0 0-.708z"/>
    <path d="M2 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2zm12 1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
  </svg>
);
const IconRobot = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 12.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5M3 8.062C3 6.76 4.235 5.765 5.53 5.886a26.6 26.6 0 0 0 4.94 0C11.765 5.765 13 6.76 13 8.062v1.157a.93.93 0 0 1-.765.935c-.845.147-2.34.346-4.235.346s-3.39-.2-4.235-.346A.93.93 0 0 1 3 9.219zm4.542-.827a.25.25 0 0 0-.217.068l-.92.9a25 25 0 0 1-1.871-.183.25.25 0 0 0-.068.495c.55.076 1.232.149 2.02.193a.25.25 0 0 0 .189-.071l.754-.736.847 1.71a.25.25 0 0 0 .404.062l.932-.97a25 25 0 0 0 1.922-.188.25.25 0 0 0-.068-.495c-.538.074-1.207.145-1.98.189a.25.25 0 0 0-.166.076l-.754.785-.842-1.7a.25.25 0 0 0-.182-.135"/>
    <path d="M8.5 1.866a1 1 0 1 0-1 0V3h-2A4.5 4.5 0 0 0 1 7.5V8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1v-.5A4.5 4.5 0 0 0 10.5 3h-2zM14 7.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.5A3.5 3.5 0 0 1 5.5 4h5A3.5 3.5 0 0 1 14 7.5"/>
  </svg>
);

export default function Sidebar({
  vpsList, vpsPaths, sessions, shells,
  selectedId, selectedShellId,
  onSelect, onSelectShell, onNew, onNewShell, onScan, onOpenResumeModal,
  onContext, onContextShell, editingId, onRenameSubmit, onRenameCancel,
  onInstallAgent, onLoginAgent,
}: Props) {

  // Sections de VPS collapsées (persistant en localStorage)
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

  return (
    <aside className="claude-sidebar">
      <div className="sidebar-toolbar">
        <span className="sidebar-title">SESSIONS</span>
        <button onClick={onOpenResumeModal} title="sessions resume-ables / import">⋮</button>
      </div>

      {vpsList.map((v) => {
        const vpsSessions = sessions.filter((s) => s.vpsId === v.id);
        const vpsShells = shells.filter((sh) => sh.vpsId === v.id);
        const paths = pathsByVps.get(v.id) ?? [];
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
        const isCollapsed = collapsed.has(v.id);
        const activeCount = vpsSessions.filter((s) =>
          ACTIVE_STATUSES.has(s.liveStatus ?? s.status)
        ).length;
        const agentStatus = (v as any).agentStatus ?? 'unknown';
        const agentVersion = (v as any).agentVersion as string | undefined;
        const agentMeta = AGENT_BADGE[agentStatus] ?? AGENT_BADGE.unknown;
        const agentTip = `${agentMeta.label}${agentVersion ? ` (v${agentVersion})` : ''}`;
        return (
          <section key={v.id} className={`vps-section vps-card${isCollapsed ? ' collapsed' : ''} agent-${agentStatus}`}>
            <div
              className="vps-head"
              onClick={() => toggleCollapsed(v.id)}
              role="button"
              title={isCollapsed ? 'cliquer pour déplier' : 'cliquer pour replier'}
            >
              <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="g">▣</span>
              <span className="n">{v.name}</span>
              <span className={`vps-agent-dot agent-${agentStatus}`} title={agentTip}>{agentMeta.glyph}</span>
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
                {onLoginAgent && (
                  <button
                    className="vps-act-btn"
                    onClick={(e) => { e.stopPropagation(); onLoginAgent(v); }}
                    title="claude login interactif (OAuth) sur ce VPS"
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
                  title="scanner les sessions Claude existantes sur ce VPS"
                ><span className="btn-emoji">🕘</span> historique</button>
              </div>
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
                          title="nouvelle session Claude sur ce path"
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
                {/* Sessions/shells sans match (cwd inconnu) */}
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
                          title="nouvelle session Claude libre"
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
      })}
    </aside>
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
