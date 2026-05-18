'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Vps, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';

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

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  sessions: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: (opts: { vpsId: string; cwd?: string }) => void;
  onScan: (vpsId: string) => void;
  onOpenResumeModal: () => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
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

export default function Sidebar({
  vpsList, vpsPaths, sessions, selectedId, onSelect, onNew, onScan, onOpenResumeModal,
  onContext, editingId, onRenameSubmit, onRenameCancel,
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
        const paths = pathsByVps.get(v.id) ?? [];
        // Groupe sessions par best-matching path (clé = path.id, ou null pour "autres")
        const groups = new Map<number | null, { path: VpsPath | null; sessions: SessionListItem[] }>();
        for (const p of paths) {
          groups.set(p.id, { path: p, sessions: [] });
        }
        for (const s of vpsSessions) {
          const best = bestPathFor(s.cwd, paths);
          const key = best ? best.id : null;
          if (!groups.has(key)) groups.set(key, { path: best, sessions: [] });
          groups.get(key)!.sessions.push(s);
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
                  >claude login</button>
                )}
                <button
                  className="vps-act-btn icon-only"
                  onClick={(e) => { e.stopPropagation(); onScan(v.id); }}
                  title="scanner les sessions Claude existantes sur ce VPS"
                >⟳</button>
              </div>
            )}
            {!isCollapsed && (
              <>
                {/* Paths déclarés, avec leurs sessions matchées */}
                {paths.map((p) => {
                  const g = groups.get(p.id);
                  return (
                    <div key={p.id} className="path-block">
                      <div className="path-head">
                        <span className="g">▤</span>
                        <span className="n">{labelOf(p)}</span>
                        <span className="cwd" title={p.path}>{p.path}</span>
                        <button
                          className="path-action"
                          onClick={() => onNew({ vpsId: v.id, cwd: p.path })}
                          title="nouvelle session sur ce path"
                        >+</button>
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
                    </div>
                  );
                })}
                {/* Sessions sans match (cwd inconnu pour ce VPS) */}
                {(() => {
                  const orphans = groups.get(null)?.sessions ?? [];
                  if (orphans.length === 0 && paths.length > 0) return null;
                  return (
                    <div className="path-block orphans">
                      <div className="path-head">
                        <span className="g">○</span>
                        <span className="n">{paths.length === 0 ? 'sans path enregistré' : 'autres'}</span>
                        <button
                          className="path-action"
                          onClick={() => onNew({ vpsId: v.id })}
                          title="nouvelle session libre (cwd à entrer)"
                        >+</button>
                      </div>
                      {orphans.map((s) => (
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
  return (
    <button
      type="button"
      className={`session-row${selected ? ' selected' : ''}${needsAttention ? ' attention' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        if (!onContext) return;
        e.preventDefault();
        onContext(s, e.clientX, e.clientY);
      }}
      title={`${s.cwd}\nCréée: ${age || '?'}${preview ? '\n\n' + preview : ''}`}
    >
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
