'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Vps, Project, ClaudeSession } from '@/lib/db/schema';
import type { VpsProjectLink } from './page';
import type { WorkerStatus } from '@/lib/server/claude/types';

const COLLAPSED_KEY = 'hub.claude.collapsedVps.v1';
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

type Props = {
  vpsList: Vps[];
  projects: Project[];
  vpsLinks: Record<string, VpsProjectLink[]>;
  sessions: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: (opts: { vpsId: string; cwd?: string; projectId?: string | null }) => void;
  onScan: (vpsId: string) => void;
  onOpenResumeModal: () => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
};

const DOT_CLASS: Record<string, string> = {
  active: 'dot-green',
  starting: 'dot-amber',
  thinking: 'dot-amber-pulse',
  sleeping: 'dot-gray',
  killed: 'dot-gray',
  error: 'dot-red',
  waiting: 'dot-orange-pulse',  // attend une réponse user (perm/question)
};

export default function Sidebar({
  vpsList, projects, vpsLinks, sessions, selectedId, onSelect, onNew, onScan, onOpenResumeModal,
  onContext, editingId, onRenameSubmit, onRenameCancel,
}: Props) {
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p] as const)), [projects]);

  // Sections de VPS collapsées (persistant en localStorage)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Init depuis localStorage (côté client uniquement)
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

  return (
    <aside className="claude-sidebar">
      <div className="sidebar-toolbar">
        <span className="sidebar-title">SESSIONS</span>
        <button onClick={onOpenResumeModal} title="sessions resume-ables / import">⋮</button>
      </div>

      {vpsList.map((v) => {
        const vpsSessions = sessions.filter((s) => s.vpsId === v.id);
        const linkedProjects = (vpsLinks[v.id] ?? []);
        // Unique project ids attached to this VPS
        const linkedProjectIds = Array.from(new Set(linkedProjects.map((l) => l.projectId)));
        // Sessions par projectId
        const sessionsByProject = new Map<string | null, SessionListItem[]>();
        for (const s of vpsSessions) {
          const key = s.projectId ?? null;
          const arr = sessionsByProject.get(key) ?? [];
          arr.push(s);
          sessionsByProject.set(key, arr);
        }
        const isCollapsed = collapsed.has(v.id);
        const activeCount = vpsSessions.filter((s) =>
          ACTIVE_STATUSES.has(s.liveStatus ?? s.status)
        ).length;
        return (
          <section key={v.id} className={`vps-section${isCollapsed ? ' collapsed' : ''}`}>
            <div
              className="vps-head"
              onClick={() => toggleCollapsed(v.id)}
              role="button"
              title={isCollapsed ? 'cliquer pour déplier' : 'cliquer pour replier'}
            >
              <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="g">▣</span>
              <span className="n">{v.name}</span>
              {activeCount > 0 ? (
                <span className="active-count" title={`${activeCount} session(s) active(s)`}>{activeCount}</span>
              ) : (
                <span className="active-count zero" title="aucune session active">0</span>
              )}
              <button
                className="vps-action"
                onClick={(e) => { e.stopPropagation(); onScan(v.id); }}
                title="scanner les sessions Claude existantes"
              >⟳</button>
            </div>
            {!isCollapsed && (<>
            {linkedProjectIds.map((pid) => {
              const p = projectById.get(pid);
              if (!p) return null;
              const paths = linkedProjects.filter((l) => l.projectId === pid).map((l) => l.path).filter(Boolean) as string[];
              const projectSessions = sessionsByProject.get(pid) ?? [];
              sessionsByProject.delete(pid);
              const firstPath = paths[0];
              return (
                <div key={pid} className="proj-block">
                  <div className="proj-head">
                    <span className="g">{p.glyph}</span>
                    <span className="n">{p.name}</span>
                    {firstPath && <span className="cwd">{firstPath}</span>}
                    <button className="proj-action" onClick={() => onNew({ vpsId: v.id, cwd: firstPath, projectId: pid })} title="nouvelle session sur ce projet">+</button>
                  </div>
                  {projectSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
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
            {/* Sessions sans projet attaché */}
            {(sessionsByProject.get(null) ?? []).length > 0 && (
              <div className="proj-block orphans">
                <div className="proj-head">
                  <span className="g">○</span>
                  <span className="n">sans projet</span>
                  <button className="proj-action" onClick={() => onNew({ vpsId: v.id })} title="nouvelle session libre">+</button>
                </div>
                {sessionsByProject.get(null)!.map((s) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    selected={s.id === selectedId}
                    onSelect={onSelect}
                    onContext={onContext}
                    editing={editingId === s.id}
                    onRenameSubmit={onRenameSubmit}
                    onRenameCancel={onRenameCancel}
                  />
                ))}
              </div>
            )}
            {/* Aucun projet lié ET aucune session orpheline → bouton "nouvelle session" générique */}
            {linkedProjectIds.length === 0 && (sessionsByProject.get(null) ?? []).length === 0 && (
              <div className="proj-block empty">
                <button className="proj-action proj-add" onClick={() => onNew({ vpsId: v.id })}>+ nouvelle session</button>
              </div>
            )}
            {/* Sessions liées à un projet qui n'apparaît pas dans linkedProjectIds (projet supprimé / non-lié au VPS) */}
            {Array.from(sessionsByProject.entries()).filter(([pid]) => pid !== null && !linkedProjectIds.includes(pid)).map(([pid, arr]) => {
              const p = pid ? projectById.get(pid) : null;
              return (
                <div key={'extra-' + pid} className="proj-block">
                  <div className="proj-head">
                    <span className="g">{p?.glyph ?? '?'}</span>
                    <span className="n">{p?.name ?? '(projet inconnu)'}</span>
                  </div>
                  {arr.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
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
            </>)}
          </section>
        );
      })}
    </aside>
  );
}

function SessionRow({ s, selected, onSelect, onContext, editing, onRenameSubmit, onRenameCancel }: {
  s: SessionListItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  editing?: boolean;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
}) {
  // Si une interaction est en attente (pending), on override le dot en
  // "waiting" (orange pulse) — visible immédiatement dans la sidebar.
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
  // Si pas de nom user-défini : on prend le début du premier message comme
  // titre (plus parlant que le cwd, qui s'affiche déjà en row-meta). Fallback
  // ultime sur le cwd-tail quand la session n'a encore aucun message.
  const headline = s.name || (preview ? preview.slice(0, 60) : s.cwd.split('/').slice(-2).join('/'));
  const cwdTail = s.cwd.length > 38 ? '…' + s.cwd.slice(-37) : s.cwd;
  const age = formatAge(s.createdAt);
  // Quand le headline reprend déjà le preview, on évite de répéter la même
  // chose dans la ligne suivante.
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
