'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';
import type { RowColor } from '../../SessionContextMenu';
import { IconRobot, IconTerminal } from '../../icons';
import NewWizardSheet from '../NewWizardSheet';
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

const COLLAPSED_KEY = 'm.hub.claude.collapsedVps';
const PAUSED_KEY = 'm.hub.claude.showPaused';

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialSessions: ClaudeSession[];
};

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

const STATUS_TEXT: Record<string, string> = {
  active: 'ready', thinking: 'working', starting: 'starting',
  sleeping: 'paused', waiting: 'needs you', error: 'error',
};

export default function MobileSelect({ vpsList, vpsFolders: initialFolders, vpsPaths, initialSessions }: Props) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions as SessionListItem[]);
  const [shells, setShells] = useState<ShellListItem[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showPaused, setShowPaused] = useState(true);
  const [vpsFolders, setVpsFolders] = useState<VpsFolder[]>(initialFolders);
  // Unified "new session" wizard (VPS → path → name). `kind` fixed by the button.
  const [wizard, setWizard] = useState<null | { kind: 'agent' | 'shell'; vpsId?: string; cwd?: string | null }>(null);
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; session: SessionListItem }
    | { kind: 'shell'; shell: ShellListItem }
    | null
  >(null);

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
  function toggleShowPaused() {
    setShowPaused((v) => {
      const next = !v;
      try { localStorage.setItem(PAUSED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  async function toggleFolderCollapsed(folderId: string, collapsedNext: boolean) {
    setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsedNext ? 1 : 0 } : f));
    try {
      await api.updateVpsFolder(folderId, { collapsed: collapsedNext });
    } catch (e: any) {
      setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsedNext ? 0 : 1 } : f));
      alert('toggle folder: ' + (e?.message ?? e));
    }
  }

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

  useEffect(() => {
    prefetchAll(sessions.map((s) => s.id));
    const t = setInterval(() => prefetchAll(sessions.map((s) => s.id)), 10_000);
    return () => clearInterval(t);
  }, [sessions]);

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

  const quickNavGroups = useMemo(
    () => computeQuickNavGroups(sessions, shells, vpsList),
    [sessions, shells, vpsList],
  );

  function openSession(id: string) { router.push(`/m/chat?id=${encodeURIComponent(id)}`); }
  function openShell(id: string) { router.push(`/m/shell?id=${encodeURIComponent(id)}`); }

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

  const totalSleeping = sessions.filter((s) => (s.liveStatus ?? s.status) === 'sleeping').length;

  // ── Session / shell mutations (context menu) ──────────────────────────────
  async function patchSession(id: string, body: { name?: string | null; color?: string | null; cwd?: string }) {
    try {
      const res = await fetch(`/api/claude/sessions/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH session: HTTP ${res.status}`);
      const updated = await res.json();
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) { alert('error: ' + (e?.message ?? e)); }
  }
  async function renameSession(id: string, name: string) {
    try { await api.renameClaudeSession(id, name || null); refresh(); }
    catch (e: any) { alert('rename: ' + (e?.message ?? e)); }
  }
  async function editSessionCwd(s: SessionListItem) {
    const newCwd = prompt('New folder (cwd) for this session?\n(the session will be recreated on next resume)', s.cwd);
    if (newCwd == null || newCwd.trim() === '' || newCwd.trim() === s.cwd) return;
    await patchSession(s.id, { cwd: newCwd.trim() });
    refresh();
  }
  async function sleepSessionOne(id: string) {
    try { await api.sleepClaudeSession(id); refresh(); }
    catch (e: any) { alert('sleep: ' + (e?.message ?? e)); }
  }
  async function deleteSessionOne(id: string) {
    if (!confirm('Permanently delete this session and all its history?')) return;
    try { await api.deleteClaudeSession(id); refresh(); }
    catch (e: any) { alert('delete: ' + (e?.message ?? e)); }
  }
  async function patchShell(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const updated = await api.updateShell(id, body);
      setShells((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) { alert('shell: ' + (e?.message ?? e)); }
  }
  async function killShell(id: string) {
    try { await api.killShell(id); setShells((prev) => prev.filter((s) => s.id !== id)); }
    catch (e: any) { alert('kill shell: ' + (e?.message ?? e)); }
  }

  function renderVpsBox(v: Vps) {
    const vpsSessions = sessionsFor(v.id);
    const vpsShells = shellsFor(v.id);
    const isCollapsed = collapsed.has(v.id);
    const activeCount = vpsSessions.filter((s) => ACTIVE_STATUSES.has(s.liveStatus ?? s.status)).length;
    const agentStatus = (v as any).agentStatus ?? 'unknown';
    const agentReady = agentStatus === 'ok';

    return (
      <section key={v.id} className={`m-vps-card agent-${agentStatus}${isCollapsed ? ' collapsed' : ''}`}>
        <div className="m-vps-head">
          <span className="m-vps-caret" onClick={() => toggleCollapsed(v.id)}>{isCollapsed ? '▸' : '▾'}</span>
          <div className="m-vps-id" onClick={() => toggleCollapsed(v.id)}>
            <span className="m-vps-name">{v.name}</span>
            <span className="m-vps-host">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
          </div>
          <span className={`m-vps-count${activeCount === 0 ? ' zero' : ''}`}>{activeCount}/{vpsSessions.length}</span>
          <div className="m-add">
            <button className="m-add-btn agent" disabled={!agentReady}
              onClick={() => setWizard({ kind: 'agent', vpsId: v.id })}
              title={agentReady ? 'new Claude agent' : 'agent not ready (use desktop)'} aria-label="new agent">
              <IconRobot />
            </button>
            <button className="m-add-btn shell"
              onClick={() => setWizard({ kind: 'shell', vpsId: v.id })}
              title="new SSH shell" aria-label="new shell">
              <IconTerminal />
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <div className="m-vps-body">
            {vpsSessions.map((s) => (
              <SessionRow key={s.id} s={s}
                onTap={() => openSession(s.id)}
                onLongPress={() => setCtxMenu({ kind: 'session', session: s })} />
            ))}
            {vpsShells.map((sh) => (
              <ShellRow key={sh.id} sh={sh}
                onTap={() => openShell(sh.id)}
                onLongPress={() => setCtxMenu({ kind: 'shell', shell: sh })} />
            ))}
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
                  <QuickNavChip key={`${it.kind}-${it.id}`} item={it}
                    onClick={() => (it.kind === 'session' ? openSession(it.id) : openShell(it.id))} />
                ))}
              </div>
            </div>
          ))}
        </nav>
      )}

      <div className="m-toolbar">
        <div className="m-add full">
          <button className="m-add-btn agent" onClick={() => setWizard({ kind: 'agent' })}>
            <IconRobot /><span>Agent</span>
          </button>
          <button className="m-add-btn shell" onClick={() => setWizard({ kind: 'shell' })}>
            <IconTerminal /><span>Shell</span>
          </button>
        </div>
        <label className="m-switch" title="show or hide paused sessions">
          <input type="checkbox" checked={showPaused} onChange={toggleShowPaused} />
          <span className="m-switch-track"><span className="m-switch-thumb" /></span>
          <span className="m-switch-label">paused{totalSleeping > 0 ? ` · ${totalSleeping}` : ''}</span>
        </label>
      </div>

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
          // Keep only VPSes with a visible session/shell (paused switch decides).
          const visibleVps = folderVps.filter((v) => sessionsFor(v.id).length + shellsFor(v.id).length > 0);
          if (visibleVps.length === 0) return null;

          const folderActiveCount = visibleVps.reduce(
            (acc, v) => acc + sessionsFor(v.id).filter((s) => ACTIVE_STATUSES.has(s.liveStatus ?? s.status)).length, 0,
          );
          const folderCollapsed = folder.collapsed === 1;

          return (
            <section key={folder.id} className={`m-folder-section${folderCollapsed ? ' m-folder-collapsed' : ''}`}>
              <div
                className="m-folder-head"
                onClick={() => { if (folder.id !== '__orphans__') toggleFolderCollapsed(folder.id, !folderCollapsed); }}
                role="button" aria-expanded={!folderCollapsed}
              >
                <span className="m-folder-caret">{folderCollapsed ? '▸' : '▾'}</span>
                <span className="m-folder-glyph">▤</span>
                <span className="m-folder-name">{folder.name}</span>
                <span className="m-folder-count">{visibleVps.length}</span>
                {folderActiveCount > 0 && <span className="m-folder-active-count">{folderActiveCount}</span>}
              </div>
              {!folderCollapsed && (
                <div className="m-folder-body">
                  {visibleVps.map((v) => renderVpsBox(v))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {wizard && (
        <NewWizardSheet
          kind={wizard.kind}
          vpsList={vpsList}
          vpsFolders={vpsFolders}
          vpsPaths={vpsPaths}
          initialVpsId={wizard.vpsId}
          initialCwd={wizard.cwd}
          onClose={() => setWizard(null)}
          onCreatedSession={(id) => { setWizard(null); router.push(`/m/chat?id=${encodeURIComponent(id)}`); }}
          onCreatedShell={(sh) => { setWizard(null); router.push(`/m/shell?id=${encodeURIComponent(sh.id)}`); }}
        />
      )}

      {ctxMenu?.kind === 'session' && (
        <MobileContextSheet
          title={ctxMenu.session.name || ctxMenu.session.cwd.split('/').slice(-2).join('/')}
          subtitle={ctxMenu.session.cwd}
          initialName={ctxMenu.session.name ?? ''}
          currentColor={(ctxMenu.session as any).color}
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
  const effective = (s.pendingPermissions ?? 0) > 0 && baseStatus === 'active' ? 'waiting' : baseStatus;
  const dotClass = DOT_CLASS[effective] ?? 'dot-gray';
  const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  const headline = s.name || (preview ? preview.slice(0, 60) : s.cwd.split('/').slice(-2).join('/'));
  const age = formatAge(s.createdAt);
  const showPreview = !!preview && preview !== headline && !headline.startsWith(preview.slice(0, 30));
  const needsAttention = (s.pendingPermissions ?? 0) > 0;
  return (
    <button
      type="button"
      className={`m-session-row${needsAttention ? ' attention' : ''}${effective === 'sleeping' ? ' is-paused' : ''}`}
      {...lp.handlers}
      onContextMenu={lp.onContextMenu}
      onClick={() => { if (!lp.consume()) onTap(); }}
    >
      <div className="m-row-head">
        <span className={`m-row-dot ${dotClass}`} />
        <span className="m-row-glyph"><IconRobot /></span>
        <span className="m-row-label">{headline}</span>
        {!!s.pendingPermissions && <span className="m-row-perm">🔒{s.pendingPermissions}</span>}
        <span className={`m-row-state ${effective}`}>{STATUS_TEXT[effective] ?? effective}</span>
      </div>
      {showPreview && <div className="m-row-preview">{preview}</div>}
      <div className="m-row-meta">
        <span className="m-meta-cwd">{cwdTail(s.cwd, 30)}</span>
        {age && <span>· {age}</span>}
      </div>
    </button>
  );
}

function ShellRow({ sh, onTap, onLongPress }: { sh: ShellListItem; onTap: () => void; onLongPress: () => void }) {
  const lp = useLongPress(onLongPress, { ms: 500 });
  const age = formatAge(Math.floor(sh.startedAt / 1000));
  const cwdShort = sh.cwd ? cwdTail(sh.cwd, 30) : '~';
  const headline = sh.name ?? (sh.cwd ? cwdTail(sh.cwd, 18) : '~');
  return (
    <button
      type="button"
      className={`m-session-row shell${sh.exited ? ' is-paused' : ''}`}
      {...lp.handlers}
      onContextMenu={lp.onContextMenu}
      onClick={() => { if (!lp.consume()) onTap(); }}
    >
      <div className="m-row-head">
        <span className={`m-row-dot ${sh.exited ? 'dot-gray' : 'dot-green'}`} />
        <span className="m-row-glyph shell"><IconTerminal /></span>
        <span className="m-row-label">{headline}</span>
        <span className={`m-row-state ${sh.exited ? 'sleeping' : 'active'}`}>{sh.exited ? 'ended' : 'shell'}</span>
      </div>
      <div className="m-row-meta">
        <span className="m-meta-cwd">{cwdShort} · {age}</span>
      </div>
    </button>
  );
}
