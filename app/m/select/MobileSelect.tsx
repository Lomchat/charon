'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';
import type { RowColor } from '../../SessionContextMenu';
import NewSessionSheet from '../NewSessionSheet';
import NewShellSheet from '../NewShellSheet';
import MobileContextSheet from '../MobileContextSheet';
import { useLongPress } from '../useLongPress';
import { prefetchAll } from '../chatCache';
import { computeQuickNavGroups, QuickNavChip, ACTIVE_STATUSES, DOT_CLASS } from '../quickNav';

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

// ACTIVE_STATUSES / DOT_CLASS now live in ../quickNav (shared with the chat
// overlay) — imported above.
const COLLAPSED_KEY = 'm.hub.claude.collapsedVps';

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
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
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'min';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
}

export default function MobileSelect({ vpsList, vpsFolders: initialFolders, vpsPaths, initialSessions }: Props) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions as SessionListItem[]);
  const [shells, setShells] = useState<ShellListItem[]>([]);
  // Per-VPS collapse: kept in localStorage (per-device, like desktop).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Folders list — synchronized periodically with the server so that a
  // desktop toggle reflects on mobile (collapsed is persisted in DB
  // via PATCH /api/vps-folders/[id], cf. CLAUDE.md §4 vps_folders).
  const [vpsFolders, setVpsFolders] = useState<VpsFolder[]>(initialFolders);
  const [newSheet, setNewSheet] = useState<null | { vpsId?: string; cwd?: string }>(null);
  // "new shell" now opens a small sheet (name + path) like the session sheet.
  const [newShellSheet, setNewShellSheet] = useState<null | { vpsId?: string; cwd?: string | null }>(null);
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; session: SessionListItem }
    | { kind: 'shell'; shell: ShellListItem }
    | null
  >(null);

  // Persists the per-VPS collapse state (localStorage only, per-device)
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

  // Toggle a folder's collapsed state — optimistic, persisted in DB (PATCH).
  // The rollback on failure reverts the local state. On desktop we have the
  // same approach in ClaudePanel.onToggleFolderCollapsed.
  async function toggleFolderCollapsed(folderId: string, collapsedNext: boolean) {
    setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsedNext ? 1 : 0 } : f));
    try {
      await api.updateVpsFolder(folderId, { collapsed: collapsedNext });
    } catch (e: any) {
      // Rollback: re-apply the inverse to stay consistent
      setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsedNext ? 0 : 1 } : f));
      alert('toggle folder: ' + (e?.message ?? e));
    }
  }

  // Poll sessions + folders every 5s. Folders are synced so a desktop toggle
  // (DB change) propagates to the mobile side without a refresh.
  const refresh = useCallback(async () => {
    try {
      const r = (await api.listClaudeSessions()) as { sessions: SessionListItem[] };
      setSessions(r.sessions);
    } catch {}
    try {
      const r = await api.listShells();
      setShells(r?.shells ?? []);
    } catch {}
    try {
      const r = await api.listVpsFolders();
      setVpsFolders(r.folders);
    } catch {}
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Prefetch the history of all chats in the background. When the user
  // taps a chat, /m/chat reads from the cache and renders instantly, no
  // round-trip. Re-prefetch when the sessions list changes (a new chat
  // appears) or periodically (cache marked stale after 15s, refetch).
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

  // Group VPSes by folderId, respecting intra-folder `position` order.
  // Same rules as Sidebar.tsx desktop.
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

  // Folders sorted by position, with the "default last" rule. If a VPS
  // points to an unknown folderId, we create a virtual "(orphans)" folder at the bottom.
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

  // Quick-nav strip — mobile equivalent of the desktop TabBar (mobile has no
  // tabs). Lists every "live" entity across all VPSes so the user can jump
  // straight to whatever is running without scrolling the folder tree. Now
  // grouped one row per VPS (clearer than a single flat scroller). Grouping +
  // labelling logic is shared with the chat overlay in ../quickNav.
  const quickNavGroups = useMemo(
    () => computeQuickNavGroups(sessions, shells, vpsList),
    [sessions, shells, vpsList],
  );

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
      alert('error: ' + (e?.message ?? e));
    }
  }
  async function renameSession(id: string, name: string) {
    try {
      await api.renameClaudeSession(id, name || null);
      refresh();
    } catch (e: any) { alert('rename: ' + (e?.message ?? e)); }
  }
  async function editSessionCwd(s: SessionListItem) {
    const newCwd = prompt('New folder (cwd) for this session?\n(the session will be recreated on next resume)', s.cwd);
    if (newCwd == null || newCwd.trim() === '' || newCwd.trim() === s.cwd) return;
    await patchSession(s.id, { cwd: newCwd.trim() });
    refresh();
  }
  // Cross-session sleep (from the mobile context menu). Reversible — the
  // session is resumable via the chat screen's resume button. No confirm,
  // non-destructive operation.
  async function sleepSessionOne(id: string) {
    try { await api.sleepClaudeSession(id); refresh(); }
    catch (e: any) { alert('sleep: ' + (e?.message ?? e)); }
  }

  // Permanent deletion (DB cascade on the server side). No more soft-kill —
  // the session disappears with its history. To pause without losing it,
  // use `doSleep` from the chat screen. Cf. CLAUDE.md §10.
  async function deleteSessionOne(id: string) {
    if (!confirm('Permanently delete this session and all its history?')) return;
    try { await api.deleteClaudeSession(id); refresh(); }
    catch (e: any) { alert('delete: ' + (e?.message ?? e)); }
  }

  // ── Actions context menu (shells) ───────────────────────────────────────
  async function patchShell(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const updated = await api.updateShell(id, body);
      setShells((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) { alert('shell: ' + (e?.message ?? e)); }
  }
  async function killShell(id: string) {
    try {
      await api.killShell(id);
      setShells((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) { alert('kill shell: ' + (e?.message ?? e)); }
  }

  // Opens the "new shell" sheet (name + path) pre-filled from the click
  // context. Actual creation happens inside <NewShellSheet>.
  function startNewShell(vpsId: string, cwd: string | null) {
    setNewShellSheet({ vpsId, cwd });
  }

  // Render a VPS card — extracted so it can be rendered from the folder
  // loop. All the groups/paths/sessions logic is here (identical to the
  // pre-folders code, just moved into a function).
  function renderVpsCard(v: Vps) {
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
    for (const g of groups.values()) {
      g.sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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
                      title="new session"
                      aria-label="new session"
                    >+</button>
                    <button
                      className="m-path-action"
                      onClick={() => startNewShell(v.id, p.path)}
                      title="new shell"
                      aria-label="new shell"
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
                        no session
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
                    <span className="m-path-label">{paths.length === 0 ? 'no saved path' : 'other'}</span>
                    <button
                      className="m-path-action"
                      onClick={() => setNewSheet({ vpsId: v.id })}
                      title="new session"
                      aria-label="new session"
                    >+</button>
                    <button
                      className="m-path-action"
                      onClick={() => startNewShell(v.id, null)}
                      title="new shell"
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

      {quickNavGroups.length > 0 && (
        <nav className="m-quicknav" aria-label="active sessions and shells">
          {quickNavGroups.map((g) => (
            <div key={g.vpsId} className={`m-quicknav-row${g.hasAttention ? ' attention' : ''}`}>
              <span className="m-quicknav-vps" title={g.vpsName}>{g.vpsName}</span>
              <div className="m-quicknav-chips">
                {g.items.map((it) => (
                  <QuickNavChip
                    key={`${it.kind}-${it.id}`}
                    item={it}
                    onClick={() => (it.kind === 'session' ? openSession(it.id) : openShell(it.id))}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>
      )}

      <div className="m-select-body">
        {vpsList.length === 0 && (
          <div className="m-empty-vps">
            <p>No VPS configured.</p>
            <a href="/">Configure (desktop)</a>
          </div>
        )}

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

          return (
            <section key={folder.id} className={`m-folder-section${folderCollapsed ? ' m-folder-collapsed' : ''}`}>
              <div
                className="m-folder-head"
                onClick={() => {
                  if (folder.id === '__orphans__') return;
                  toggleFolderCollapsed(folder.id, !folderCollapsed);
                }}
                role="button"
                aria-expanded={!folderCollapsed}
                title={folderCollapsed ? 'click to expand folder' : 'click to collapse folder'}
              >
                <span className="m-folder-caret">{folderCollapsed ? '▸' : '▾'}</span>
                <span className="m-folder-glyph">▤</span>
                <span className="m-folder-name">{folder.name}</span>
                <span className="m-folder-count" title={`${folderVps.length} VPS in this folder`}>{folderVps.length}</span>
                {folderActiveCount > 0 && (
                  <span className="m-folder-active-count" title={`${folderActiveCount} active session(s) in this folder`}>
                    {folderActiveCount}
                  </span>
                )}
              </div>
              {!folderCollapsed && (
                <div className="m-folder-body">
                  {folderVps.map((v) => renderVpsCard(v))}
                  {folderVps.length === 0 && folder.id !== '__orphans__' && (
                    <div className="m-folder-empty">no VPS in this folder</div>
                  )}
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

      {newShellSheet && (
        <NewShellSheet
          vpsList={vpsList}
          vpsPaths={vpsPaths}
          initial={newShellSheet}
          onClose={() => setNewShellSheet(null)}
          onCreated={(sh) => { setNewShellSheet(null); router.push(`/m/shell?id=${encodeURIComponent(sh.id)}`); }}
        />
      )}

      {ctxMenu?.kind === 'session' && (
        <MobileContextSheet
          title={ctxMenu.session.name || ctxMenu.session.cwd.split('/').slice(-2).join('/')}
          subtitle={ctxMenu.session.cwd}
          initialName={ctxMenu.session.name ?? ''}
          currentColor={(ctxMenu.session as any).color}
          // No `onKill` here: the kill→delete merge removed this middle
          // state. Only permanent deletion remains for sessions.
          // `onSleep` is only passed if the session is active (otherwise
          // the button doesn't appear — the user resumes from the chat screen).
          onRename={(name) => renameSession(ctxMenu.session.id, name)}
          onEditCwd={() => editSessionCwd(ctxMenu.session)}
          onColor={(color: RowColor) => patchSession(ctxMenu.session.id, { color })}
          onSleep={
            ['active', 'thinking', 'starting'].includes(ctxMenu.session.status)
              ? () => sleepSessionOne(ctxMenu.session.id)
              : undefined
          }
          onDelete={() => deleteSessionOne(ctxMenu.session.id)}
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
          killLabel="Close"
          killDisabledReason={ctxMenu.shell.exited ? 'already exited' : undefined}
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
