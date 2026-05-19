'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { Vps, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';
import type { RowColor } from '../../SessionContextMenu';
import NewSessionSheet from '../NewSessionSheet';
import MobileContextSheet from '../MobileContextSheet';
import { useLongPress } from '../useLongPress';
import { prefetchAll } from '../chatCache';

type SessionListItem = ClaudeSession & {
  liveStatus?: WorkerStatus;
  subscribers?: number;
  pendingPermissions?: number;
  firstUserMessage?: string | null;
};

type ShellListItem = {
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

const ACTIVE_STATUSES = new Set(['active', 'thinking', 'starting']);
const DOT_CLASS: Record<string, string> = {
  active: 'dot-green',
  starting: 'dot-amber',
  thinking: 'dot-amber-pulse',
  sleeping: 'dot-gray',
  killed: 'dot-gray',
  error: 'dot-red',
  waiting: 'dot-orange-pulse',
};
const COLLAPSED_KEY = 'm.hub.claude.collapsedVps';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  initialSessions: ClaudeSession[];
};

function bestPathFor(cwd: string, paths: VpsPath[]): VpsPath | null {
  let best: VpsPath | null = null;
  for (const p of paths) {
    if (cwd === p.path || cwd.startsWith(p.path.endsWith('/') ? p.path : p.path + '/')) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

function labelOf(p: VpsPath): string {
  if (p.label) return p.label;
  const segs = p.path.split('/').filter(Boolean);
  return segs.length === 0 ? '(root)' : segs[segs.length - 1];
}

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

export default function MobileSelect({ vpsList, vpsPaths, initialSessions }: Props) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions as SessionListItem[]);
  const [shells, setShells] = useState<ShellListItem[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [newSheet, setNewSheet] = useState<null | { vpsId?: string; cwd?: string }>(null);
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; session: SessionListItem }
    | { kind: 'shell'; shell: ShellListItem }
    | null
  >(null);

  // Persiste l'état collapse
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

  // Poll sessions toutes les 5s
  const refresh = useCallback(async () => {
    try {
      const r = (await api.listClaudeSessions()) as { sessions: SessionListItem[] };
      setSessions(r.sessions);
    } catch {}
    try {
      const r = await api.listShells();
      setShells(r?.shells ?? []);
    } catch {}
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Prefetch les historiques de tous les chats en background. Quand l'user
  // tap un chat, /m/chat lit le cache et render instant, sans round-trip.
  // Re-prefetch quand la liste des sessions change (un nouveau chat
  // apparaît) ou périodiquement (cache marqué stale après 15s, refetch).
  useEffect(() => {
    prefetchAll(sessions.map((s) => s.id));
    const t = setInterval(() => prefetchAll(sessions.map((s) => s.id)), 10_000);
    return () => clearInterval(t);
  }, [sessions]);

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

  function openSession(id: string) {
    router.push(`/m/chat?id=${encodeURIComponent(id)}`);
  }
  function openShell(id: string) {
    router.push(`/m/shell?id=${encodeURIComponent(id)}`);
  }

  // ── Actions context menu (sessions) ─────────────────────────────────────
  async function patchSession(id: string, body: { name?: string | null; color?: string | null; cwd?: string }) {
    try {
      const res = await fetch(`/api/claude/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH session: HTTP ${res.status}`);
      const updated = await res.json();
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) {
      alert('erreur : ' + (e?.message ?? e));
    }
  }
  async function renameSession(id: string, name: string) {
    try {
      await api.renameClaudeSession(id, name || null);
      refresh();
    } catch (e: any) { alert('rename : ' + (e?.message ?? e)); }
  }
  async function editSessionCwd(s: SessionListItem) {
    const newCwd = prompt('Nouveau dossier (cwd) pour cette session ?\n(la session sera recréée au prochain resume)', s.cwd);
    if (newCwd == null || newCwd.trim() === '' || newCwd.trim() === s.cwd) return;
    await patchSession(s.id, { cwd: newCwd.trim() });
    refresh();
  }
  async function killSession(id: string) {
    try { await api.killClaudeSession(id); refresh(); }
    catch (e: any) { alert('kill : ' + (e?.message ?? e)); }
  }
  async function hardDeleteSession(id: string) {
    if (!confirm('Supprimer définitivement cette session et tout son historique ?')) return;
    try { await api.hardDeleteClaudeSession(id); refresh(); }
    catch (e: any) { alert('supprimer : ' + (e?.message ?? e)); }
  }

  // ── Actions context menu (shells) ───────────────────────────────────────
  async function patchShell(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const updated = await api.updateShell(id, body);
      setShells((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) { alert('shell : ' + (e?.message ?? e)); }
  }
  async function killShell(id: string) {
    try {
      await api.killShell(id);
      setShells((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) { alert('kill shell : ' + (e?.message ?? e)); }
  }

  async function startNewShell(vpsId: string, cwd: string | null) {
    try {
      const sh = await api.startShell(vpsId, cwd ?? null);
      router.push(`/m/shell?id=${encodeURIComponent(sh.id)}`);
    } catch (e: any) {
      alert('shell: ' + (e?.message ?? e));
    }
  }

  return (
    <>
      <header className="m-topbar">
        <svg className="brand-logo" viewBox="12 32 236 196" aria-hidden width={28} height={28} style={{ color: 'var(--gold)' }}>
          <path d="M 18 120 Q 32 114 46 120 T 74 120 T 100 120" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 22 140 Q 36 134 50 140 T 78 140 T 100 140" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 26 160 Q 40 154 54 160 T 82 160 T 100 160" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 120 Q 174 114 188 120 T 216 120 T 242 120" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 140 Q 174 134 188 140 T 216 140 T 238 140" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 160 Q 174 154 188 160 T 216 160 T 234 160" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 130 40 Q 100 75 96 140 Q 94 188 130 220 Q 166 188 164 140 Q 160 75 130 40 Z" fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round"/>
          <circle cx="130" cy="145" r="17" fill="none" stroke="currentColor" strokeWidth="7"/>
          <circle cx="130" cy="145" r="11" fill="currentColor"/>
        </svg>
        <div className="m-title-block">
          <span className="m-title">Charon</span>
          <span className="m-subtitle">{sessions.length} sessions · {vpsList.length} VPS</span>
        </div>
        <a className="m-logout" href="/logout">↗</a>
      </header>

      <div className="m-select-body">
        {vpsList.length === 0 && (
          <div className="m-empty-vps">
            <p>Aucun VPS configuré.</p>
            <a href="/">Configurer (desktop)</a>
          </div>
        )}

        {vpsList.map((v) => {
          const vpsSessions = sessions.filter((s) => s.vpsId === v.id);
          const vpsShells = shells.filter((sh) => sh.vpsId === v.id);
          const paths = pathsByVps.get(v.id) ?? [];

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

          return (
            <section key={v.id} className={`m-vps-card agent-${agentStatus}${isCollapsed ? ' collapsed' : ''}`}>
              <div className="m-vps-head" onClick={() => toggleCollapsed(v.id)}>
                <span className="m-vps-caret">{isCollapsed ? '▸' : '▾'}</span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="m-vps-name">{v.name}</span>
                  <span className="m-vps-host">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
                </div>
                <span className={`m-vps-count${activeCount === 0 ? ' zero' : ''}`}>
                  {activeCount}/{vpsSessions.length}
                </span>
              </div>

              {!isCollapsed && (
                <div className="m-vps-body">
                  {paths.map((p) => {
                    const g = groups.get(p.id);
                    return (
                      <div key={p.id} className="m-path-block">
                        <div className="m-path-head">
                          <span className="m-path-label">{labelOf(p)}</span>
                          <span className="m-path-cwd">{p.path}</span>
                          <button
                            className="m-path-action"
                            onClick={() => setNewSheet({ vpsId: v.id, cwd: p.path })}
                            title="nouvelle session"
                            aria-label="nouvelle session"
                          >+</button>
                          <button
                            className="m-path-action"
                            onClick={() => startNewShell(v.id, p.path)}
                            title="nouveau shell"
                            aria-label="nouveau shell"
                            style={{ fontFamily: 'var(--mono)', fontSize: 14 }}
                          >⌨</button>
                        </div>
                        <div className="m-path-sessions">
                          {g?.sessions.map((s) => (
                            <SessionRow
                              key={s.id} s={s}
                              onTap={() => openSession(s.id)}
                              onLongPress={() => setCtxMenu({ kind: 'session', session: s })}
                            />
                          ))}
                          {g?.shells.map((sh) => (
                            <ShellRow
                              key={sh.id} sh={sh}
                              onTap={() => openShell(sh.id)}
                              onLongPress={() => setCtxMenu({ kind: 'shell', shell: sh })}
                            />
                          ))}
                          {(g?.sessions.length ?? 0) === 0 && (g?.shells.length ?? 0) === 0 && (
                            <div style={{ fontSize: 12, color: 'var(--parchment-soft)', fontStyle: 'italic', padding: '6px 0' }}>
                              aucune session
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {(() => {
                    const orphSessions = groups.get(null)?.sessions ?? [];
                    const orphShells = groups.get(null)?.shells ?? [];
                    if (orphSessions.length === 0 && orphShells.length === 0 && paths.length > 0) return null;
                    return (
                      <div className="m-path-block">
                        <div className="m-path-head">
                          <span className="m-path-label">{paths.length === 0 ? 'sans path enregistré' : 'autres'}</span>
                          <button
                            className="m-path-action"
                            onClick={() => setNewSheet({ vpsId: v.id })}
                            title="nouvelle session"
                            aria-label="nouvelle session"
                          >+</button>
                          <button
                            className="m-path-action"
                            onClick={() => startNewShell(v.id, null)}
                            title="nouveau shell"
                            style={{ fontFamily: 'var(--mono)', fontSize: 14 }}
                          >⌨</button>
                        </div>
                        <div className="m-path-sessions">
                          {orphSessions.map((s) => (
                            <SessionRow
                              key={s.id} s={s}
                              onTap={() => openSession(s.id)}
                              onLongPress={() => setCtxMenu({ kind: 'session', session: s })}
                            />
                          ))}
                          {orphShells.map((sh) => (
                            <ShellRow
                              key={sh.id} sh={sh}
                              onTap={() => openShell(sh.id)}
                              onLongPress={() => setCtxMenu({ kind: 'shell', shell: sh })}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {newSheet && (
        <NewSessionSheet
          vpsList={vpsList}
          vpsPaths={vpsPaths}
          initial={newSheet}
          onClose={() => setNewSheet(null)}
          onCreated={(id) => { setNewSheet(null); router.push(`/m/chat?id=${encodeURIComponent(id)}`); }}
        />
      )}

      {ctxMenu?.kind === 'session' && (
        <MobileContextSheet
          title={ctxMenu.session.name || ctxMenu.session.cwd.split('/').slice(-2).join('/')}
          subtitle={ctxMenu.session.cwd}
          initialName={ctxMenu.session.name ?? ''}
          currentColor={(ctxMenu.session as any).color}
          canKill={ctxMenu.session.status !== 'killed'}
          killDisabledReason={ctxMenu.session.status === 'killed' ? 'déjà tuée' : undefined}
          onRename={(name) => renameSession(ctxMenu.session.id, name)}
          onEditCwd={() => editSessionCwd(ctxMenu.session)}
          onColor={(color: RowColor) => patchSession(ctxMenu.session.id, { color })}
          onKill={() => killSession(ctxMenu.session.id)}
          onDelete={() => hardDeleteSession(ctxMenu.session.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {ctxMenu?.kind === 'shell' && (
        <MobileContextSheet
          title={ctxMenu.shell.name || `⌨ ${ctxMenu.shell.cwd ?? '~'}`}
          subtitle={ctxMenu.shell.cwd ?? undefined}
          initialName={ctxMenu.shell.name ?? ''}
          currentColor={ctxMenu.shell.color}
          canKill={!ctxMenu.shell.exited}
          killLabel="Fermer"
          killDisabledReason={ctxMenu.shell.exited ? 'déjà terminé' : undefined}
          showDelete={false}
          onRename={(name) => patchShell(ctxMenu.shell.id, { name: name || null })}
          onColor={(color: RowColor) => patchShell(ctxMenu.shell.id, { color })}
          onKill={() => killShell(ctxMenu.shell.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

function SessionRow({ s, onTap, onLongPress }: { s: SessionListItem; onTap: () => void; onLongPress: () => void }) {
  const lp = useLongPress(onLongPress, { ms: 500 });
  const baseStatus = s.liveStatus ?? s.status;
  const effective = (s.pendingPermissions ?? 0) > 0 && baseStatus === 'active'
    ? 'waiting'
    : baseStatus;
  const dotClass = DOT_CLASS[effective] ?? 'dot-gray';
  const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  const headline = s.name || (preview ? preview.slice(0, 60) : s.cwd.split('/').slice(-2).join('/'));
  const cwdTail = s.cwd.length > 38 ? '…' + s.cwd.slice(-37) : s.cwd;
  const age = formatAge(s.createdAt);
  const showPreview = !!preview && preview !== headline && !headline.startsWith(preview.slice(0, 30));
  const needsAttention = (s.pendingPermissions ?? 0) > 0;
  return (
    <button
      type="button"
      className={`m-session-row${needsAttention ? ' attention' : ''}`}
      {...lp.handlers}
      onContextMenu={lp.onContextMenu}
      onClick={() => { if (!lp.consume()) onTap(); }}
    >
      <div className="m-row-head">
        <span className={`m-row-dot ${dotClass}`} />
        <span className="m-row-label">{headline}</span>
        {!!s.pendingPermissions && (
          <span className="m-row-perm">🔒{s.pendingPermissions}</span>
        )}
      </div>
      {showPreview && (
        <div className="m-row-preview">{preview}</div>
      )}
      <div className="m-row-meta">
        <span className="m-meta-cwd">{cwdTail}</span>
        {age && <span>· {age}</span>}
      </div>
    </button>
  );
}

function ShellRow({ sh, onTap, onLongPress }: { sh: ShellListItem; onTap: () => void; onLongPress: () => void }) {
  const lp = useLongPress(onLongPress, { ms: 500 });
  const age = formatAge(Math.floor(sh.startedAt / 1000));
  const cwdTail = sh.cwd
    ? (sh.cwd.length > 38 ? '…' + sh.cwd.slice(-37) : sh.cwd)
    : '~';
  const headline = sh.name ?? cwdTail;
  return (
    <button
      type="button"
      className={`m-session-row shell${sh.exited ? ' exited' : ''}`}
      {...lp.handlers}
      onContextMenu={lp.onContextMenu}
      onClick={() => { if (!lp.consume()) onTap(); }}
    >
      <div className="m-row-head">
        <span className={`m-row-dot ${sh.exited ? 'dot-gray' : 'dot-cyan'}`} />
        <span className="m-row-label">{headline}</span>
      </div>
      <div className="m-row-meta">
        <span className="m-meta-cwd">shell · {sh.cwd ? cwdTail + ' · ' : ''}{age}</span>
      </div>
    </button>
  );
}
