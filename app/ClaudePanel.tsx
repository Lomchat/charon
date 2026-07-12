'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus } from '@/lib/server/claude/types';
import Sidebar, { type SessionListItem, type ShellListItem, type InstallInfo } from './Sidebar';
import TabBar, { computeTabs, type EntityTab } from './TabBar';
import ShellTerminal from './ShellTerminal';
import InstallSessionView from './InstallSessionView';
import NewSessionWizard from './NewSessionWizard';
import DataModal from './DataModal';
import ResumeModal from './ResumeModal';
import PermissionPopup from './PermissionPopup';
import InstallNotificationPopup from './InstallNotificationPopup';
import { useCrossSessionInteractionFeed } from './useCrossSessionInteractionFeed';
import { useInstallNotifications } from './useInstallNotifications';
import { subscribeAll } from './globalEventStream';
import SearchModal from './SearchModal';
import SettingsModal from './SettingsModal';
import SessionContextMenu from './SessionContextMenu';
import LoginConsole from './LoginConsole';
import LocalAgentButton from './LocalAgentButton';
import ClaudeSessionView from './ClaudeSessionView';
import SessionErrorBoundary from './SessionErrorBoundary';
import { prefetchAll as sessionCachePrefetchAll } from './sessionCache';
import { pushCurrentEndpoint, pushSubscribe, pushUnsubscribe, pushSupported, ensureFreshServiceWorker } from './pushClient';
import {
  IconBellFill, IconBellSlash, IconGear, IconSearch,
  IconServers, IconVolumeMute, IconVolumeUp, IconTelegram,
  IconMenu, IconPanelRight,
} from './icons';

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialSessions: ClaudeSession[];
  builtPyzSha: string | null;
  // Latest claude-agent-sdk on PyPI (settings cache, null = never synced).
  // Compared to vps.sdkVersion for the sidebar "SDK out of date" badge.
  sdkLatestVersion: string | null;
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  starting: 'starting',
  active: 'active',
  thinking: 'thinking',
  sleeping: 'sleeping',
  killed: 'killed',
  error: 'error',
  reconnecting: 'reconnecting…',
};
const STATUS_DOT: Record<WorkerStatus, string> = {
  starting: 'amber',
  active: 'green',
  thinking: 'amber-pulse',
  sleeping: 'gray',
  killed: 'gray',
  error: 'red',
  reconnecting: 'amber-pulse',
};

// SessionState/emptyState removed in the refactor: per-session state now
// lives in `useClaudeSessionStream` (consumed by `<ClaudeSessionView>`).

export default function ClaudePanel({ vpsList: initialVpsList, vpsFolders: initialFolders, vpsPaths: initialPaths, initialSessions, builtPyzSha, sdkLatestVersion }: Props) {
  // Mutable copies — DataModal can add/delete VPSes, folders and paths without a reload.
  const [vpsList, setVpsList] = useState<Vps[]>(initialVpsList);
  const [vpsFolders, setVpsFolders] = useState<VpsFolder[]>(initialFolders);
  const [vpsPaths, setVpsPaths] = useState<VpsPath[]>(initialPaths);
  const searchParams = useSearchParams();
  const queryParamSession = searchParams?.get('session') ?? null;
  // `?shell=` deep-link (shell-idle push/telegram notification, parity with
  // `?session=`). When present it takes precedence over the session default so
  // a notification tap lands on the shell, not the first chat.
  const queryParamShell = searchParams?.get('shell') ?? null;
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions as SessionListItem[]);
  const [selectedId, setSelectedId] = useState<string | null>(
    queryParamShell ? null : (queryParamSession ?? initialSessions[0]?.id ?? null),
  );

  // If the ?session= param changes (notification click or navigation), switch
  useEffect(() => {
    if (queryParamSession && queryParamSession !== selectedId) {
      setSelectedId(queryParamSession);
    }
  }, [queryParamSession]); // eslint-disable-line

  // Sync selectedId → URL (?session=...) without spamming history
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (selectedId) {
      if (url.searchParams.get('session') !== selectedId) {
        url.searchParams.set('session', selectedId);
        window.history.replaceState(null, '', url);
      }
    } else if (url.searchParams.has('session')) {
      url.searchParams.delete('session');
      window.history.replaceState(null, '', url);
    }
  }, [selectedId]);
  // `error` stays on the parent: it carries errors from rename/kill/patch etc.
  // which are cross-session actions (not in the active view). Errors for the
  // ACTIVE SESSION live in `<ClaudeSessionView>` via the hook.
  const [error, setError] = useState<{ msg: string; canResume?: boolean } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; session: SessionListItem; x: number; y: number }
    | { kind: 'shell'; shell: ShellListItem; x: number; y: number }
    | { kind: 'install'; install: InstallInfo; x: number; y: number }
    | null
  >(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Interactive claude login console
  const [loginVps, setLoginVps] = useState<Vps | null>(null);

  // When the user closes the LoginConsole, we re-check the VPS's `claude
  // login` state — they may have just logged in (or out). The result is
  // persisted on the server side and patched locally so the sidebar
  // immediately hides the "claude login" button if no longer needed.
  const closeLoginConsole = useCallback(() => {
    const v = loginVps;
    setLoginVps(null);
    if (!v) return;
    // Best-effort, async. If SSH crashes, we keep the old value.
    api.checkVpsClaudeLogin(v.id)
      .then((r) => {
        if (!r.ok) return;
        setVpsList((prev) => prev.map((vp) =>
          vp.id === v.id
            ? ({
                ...vp,
                claudeLoggedIn: r.loggedIn ? 1 : 0,
                claudeLoggedInCheckedAt: r.checkedAt,
              } as Vps)
            : vp,
        ));
      })
      .catch(() => {});
  }, [loginVps]);
  // Ephemeral SSH shells. Live list (polled on mount, updated locally).
  const [shells, setShells] = useState<ShellListItem[]>([]);
  // If non-null, a shell is displayed in the main panel (instead of the chat).
  // Initialized from `?shell=` so a shell-idle notification tap opens it.
  const [selectedShellId, setSelectedShellId] = useState<string | null>(queryParamShell);

  // React to `?shell=` changes (a second notification tap while the tab is
  // already open). Mirrors the `?session=` reaction above; selecting a shell
  // clears the session/install selection (mutually exclusive views).
  useEffect(() => {
    if (queryParamShell && queryParamShell !== selectedShellId) {
      setSelectedShellId(queryParamShell);
      setSelectedId(null);
      setSelectedInstallId(null);
    }
  }, [queryParamShell]); // eslint-disable-line

  // Sync selectedShellId → URL (?shell=...) without spamming history.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (selectedShellId) {
      if (url.searchParams.get('shell') !== selectedShellId) {
        url.searchParams.set('shell', selectedShellId);
        window.history.replaceState(null, '', url);
      }
    } else if (url.searchParams.has('shell')) {
      url.searchParams.delete('shell');
      window.history.replaceState(null, '', url);
    }
  }, [selectedShellId]);
  // Agent install sessions. In-memory only (shell pattern). One install
  // per VPS max (cf. installSession.ts § startInstall).
  const [installs, setInstalls] = useState<InstallInfo[]>([]);
  // If non-null, an install session occupies the main panel.
  const [selectedInstallId, setSelectedInstallId] = useState<string | null>(null);

  // Responsive drawers (§11): under the CSS breakpoints (≤1100px the ToolPanel
  // becomes a right drawer, ≤820px the Sidebar becomes a left drawer) these
  // toggle `.nav-open` / `.tools-open` on `.claude-root`. No effect on desktop
  // (the toggle buttons + drawer positioning are CSS-gated by media query).
  const [navOpen, setNavOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const closeDrawers = useCallback(() => { setNavOpen(false); setToolsOpen(false); }, []);

  // Load the shells list at mount + refresh when a selector changes
  useEffect(() => {
    let cancelled = false;
    api.listShells().then((r) => {
      if (!cancelled) setShells(r?.shells ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load the installs list at mount (to recover installs still in progress
  // after a tab refresh — the pool is server-memory, survives).
  useEffect(() => {
    let cancelled = false;
    api.listInstalls().then((r) => {
      if (!cancelled) setInstalls(r?.installs ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Live refresh of the installs list on bus events:
  //   - install_started → add / update the sidebar row
  //   - install_finished → status update; we keep the row so the user
  //     can reopen the log (manual close via right-click)
  useEffect(() => {
    const refreshOne = async (installId: string) => {
      try {
        const info = await api.getInstall(installId);
        setInstalls((prev) => {
          const others = prev.filter((i) => i.id !== installId);
          return [...others, info];
        });
      } catch {}
    };
    const unsub = subscribeAll((ev) => {
      if (!('installId' in ev)) return;
      if (ev.type === 'install_started' || ev.type === 'install_finished') {
        refreshOne(ev.installId);
        // Update vps.agentStatus + agentPyzSha locally when the install
        // succeeds. Without this: the "outdated" badge stays displayed
        // because the local `agentPyzSha` (fetched at initial SSR) is still
        // the old one, while on the server side the bootstrap has already
        // persisted the new sha (cf. bootstrap.ts § ping_agent). By
        // construction, after a successful bootstrap, the deployed sha IS
        // `builtPyzSha` — so we can patch locally without refetching.
        if (ev.type === 'install_finished' && ev.status === 'success') {
          setVpsList((prev) => prev.map((v) =>
            v.id === ev.vpsId
              ? ({
                  ...v,
                  agentStatus: 'ok',
                  // builtPyzSha comes from the prop; null tolerable (fallback
                  // at the next AgentClient hello).
                  agentPyzSha: builtPyzSha ?? v.agentPyzSha,
                } as Vps)
              : v,
          ));
        }
      }
    });
    return () => unsub();
  }, [builtPyzSha]);

  // Live shell activity status (agent >= 0.9.0). The agent emits a
  // `shell_status` busy/active event whenever a PTY starts/stops streaming
  // output; shellNotify fans it onto the global SSE bus with sessionId =
  // shellId (classed LOW_VOLUME so it reaches EVERY tab regardless of focus —
  // shells are not the SSE's focused session). We mirror it onto the local
  // `shells` list so the tab/dot paints "thinking" (blue) while busy, exactly
  // like a Claude session — and flips the row dead on 'exited'. The `changed`
  // guard avoids a needless re-render when nothing actually moved.
  useEffect(() => {
    const unsub = subscribeAll((ev) => {
      if (ev.type !== 'shell_status') return;
      const shellId = ev.sessionId;
      if (!shellId) return;
      const status = ev.status; // 'active' | 'busy' | 'exited'
      setShells((prev) => {
        let changed = false;
        const next = prev.map((sh) => {
          if (sh.id !== shellId) return sh;
          if (status === 'exited') {
            if (sh.exited) return sh;
            changed = true;
            return { ...sh, exited: true, liveStatus: undefined };
          }
          if (!sh.exited && sh.liveStatus === status) return sh;
          changed = true;
          return { ...sh, exited: false, liveStatus: status };
        });
        return changed ? next : prev;
      });
    });
    return () => unsub();
  }, []);

  // Live VPS agent status (F1). AgentClient pushes a `vps_status` event
  // (sessionId = vpsId) on every persisted flip of `vps.agentStatus` —
  // hello success ('ok' + version/sha) or a classified failure
  // ('error'/'missing', gated to skip transient SSH drops). Mirroring it
  // here keeps the sidebar badge + action buttons ("install" vs "refresh"
  // vs "update") truthful without an F5 — previously the status was only
  // read at SSR (cf. CLAUDE.md §14 gotcha 34, amplifier #1).
  useEffect(() => {
    const unsub = subscribeAll((ev) => {
      if (ev.type !== 'vps_status') return;
      const vpsId = ev.sessionId;
      if (!vpsId) return;
      setVpsList((prev) => {
        let changed = false;
        const next = prev.map((v) => {
          if (v.id !== vpsId) return v;
          const agentVersion = ev.agentVersion !== undefined ? ev.agentVersion : v.agentVersion;
          const agentPyzSha = ev.agentPyzSha !== undefined ? ev.agentPyzSha : v.agentPyzSha;
          // sdkVersion: patch ONLY when the event carries the key — an event
          // from an old agent's hello must not wipe a known SDK version
          // (mirrors the DB no-clobber guard in AgentClient.ts).
          const sdkVersion = ev.sdkVersion !== undefined ? ev.sdkVersion : v.sdkVersion;
          if (v.agentStatus === ev.agentStatus && v.agentVersion === agentVersion && v.agentPyzSha === agentPyzSha && v.sdkVersion === sdkVersion) {
            return v;
          }
          changed = true;
          return { ...v, agentStatus: ev.agentStatus, agentVersion, agentPyzSha, sdkVersion } as Vps;
        });
        return changed ? next : prev;
      });
    });
    return () => unsub();
  }, []);

  // Live "finished, unread" marker (CLAUDE.md §14.47). When a BACKGROUND
  // session finishes its turn, sessionOps flips claudeSessions.unreadStop and
  // fans a `session_unread` event on the bus (LOW_VOLUME → every tab, even ones
  // not focused on that session). Mirror it onto the local sessions list so the
  // sidebar's green "finished" glow appears / clears without waiting for the
  // 15s list refresh. Cross-device: the same event also fires on POST /focus
  // (the "read" signal) from any device.
  useEffect(() => {
    const unsub = subscribeAll((ev) => {
      if (ev.type !== 'session_unread') return;
      const id = ev.sessionId;
      if (!id) return;
      const next = ev.unread ? 1 : 0;
      setSessions((prev) => {
        let changed = false;
        const out = prev.map((s) => {
          if (s.id !== id) return s;
          if ((s.unreadStop ?? 0) === next) return s;
          changed = true;
          return { ...s, unreadStop: next };
        });
        return changed ? out : prev;
      });
    });
    return () => unsub();
  }, []);

  // Opening a session marks it read locally the instant you select it. The
  // authoritative cross-device clear is server-side (POST /focus →
  // markSessionRead, fired by useClaudeSessionStream); this just prevents a
  // flash of the green marker on the very card you just opened. Keyed on
  // selectedId so it covers EVERY open path (sidebar, tab bar, deep link,
  // push-notification click).
  useEffect(() => {
    if (!selectedId) return;
    setSessions((prev) => {
      const s = prev.find((x) => x.id === selectedId);
      if (!s || !s.unreadStop) return prev;
      return prev.map((x) => x.id === selectedId ? { ...x, unreadStop: 0 } : x);
    });
  }, [selectedId]);

  // Install notifications (tab-local queue, populated by the global bus)
  const {
    notifications: installNotifications,
    dismiss: dismissInstallNotif,
  } = useInstallNotifications();

  // Adopt an already-created shell into the sidebar/tab state + select it.
  // The actual creation now happens inside <NewShellDialog> (so it can show
  // inline busy/error like the session dialog); this just wires the result in.
  function applyCreatedShell(sh: ShellListItem) {
    setShells((prev) => [...prev.filter((s) => s.id !== sh.id), sh]);
    setSelectedShellId(sh.id);
    setSelectedId(null);  // mutually exclusive with a Claude session
    setSelectedInstallId(null);
  }
  function selectShell(id: string) {
    setSelectedShellId(id);
    setSelectedId(null);
    setSelectedInstallId(null);
    closeDrawers();  // mobile: picking from the sidebar drawer closes it
  }
  function shellKilled(id: string) {
    setShells((prev) => prev.filter((s) => s.id !== id));
    if (selectedShellId === id) setSelectedShellId(null);
  }
  // When we select a Claude session, we deselect shell + install
  function selectClaude(id: string) {
    setSelectedId(id);
    setSelectedShellId(null);
    setSelectedInstallId(null);
    closeDrawers();  // mobile: picking from the sidebar drawer closes it
  }
  function selectInstall(id: string) {
    setSelectedInstallId(id);
    setSelectedId(null);
    setSelectedShellId(null);
    closeDrawers();  // mobile: picking from the sidebar drawer closes it
  }
  function installClosed(id: string) {
    setInstalls((prev) => prev.filter((i) => i.id !== id));
    if (selectedInstallId === id) setSelectedInstallId(null);
  }

  /**
   * Opens (or creates if it doesn't exist) an install session for this VPS.
   * Used in 3 cases:
   *   1. "install agent" button in the Sidebar (VPS without an agent)
   *   2. "import claude_agent_sdk" error mid-session (re-triggers
   *      the install automatically)
   *   3. Out-of-date agent update — already handled by `runUpdateAgent`, not
   *      via the install session (cf. design choice: update remains a direct call).
   */
  async function openInstallSession(vps: Vps) {
    try {
      const info = await api.startInstall(vps.id);
      // Optimistic update — the install_started event will also arrive via SSE.
      setInstalls((prev) => {
        const others = prev.filter((i) => i.id !== info.id);
        return [...others, info];
      });
      selectInstall(info.id);
    } catch (e: any) {
      setError({ msg: 'start install: ' + (e?.message ?? e) });
    }
  }

  async function killInstallOne(id: string) {
    try {
      await api.closeInstall(id);
      installClosed(id);
    } catch (e: any) {
      setError({ msg: 'close install: ' + (e?.message ?? e) });
    }
  }
  // ── Tabs (VSCode-style) ────────────────────────────────────────────────
  // `keptOpenIds` is the set of entity ids the user wants to keep visible in
  // the tab bar even after they've become inactive (sleeping session, exited
  // shell, finished install). Active entities always show a tab regardless.
  //
  // Auto-populated as soon as an entity is selected or becomes active —
  // that way a session put to sleep doesn't immediately vanish; it stays
  // greyed-out with a × until the user explicitly closes it.
  //
  // Cleared when the user clicks × on a closable tab.
  const [keptOpenIds, setKeptOpenIds] = useState<Set<string>>(new Set());

  const keepOpen = useCallback((id: string) => {
    setKeptOpenIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const forgetOpen = useCallback((id: string) => {
    setKeptOpenIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // `mountedShellIds` is the set of shell ids whose <ShellTerminal> stays
  // MOUNTED (its WebSocket + xterm alive) even while another entity is
  // selected — so switching sessions and coming back keeps the live shell
  // and its scrollback instead of tearing down + reconnecting (which is
  // what made shells feel "non-persistent"). See §14 gotcha 37.
  //
  // Lazy on purpose: a shell mounts only once it has been SELECTED at least
  // once this page-load (not on F5 for every shell in the sidebar) — that
  // caps the number of live ssh+agent connections to shells the user
  // actually opened. The GC effect below drops ids whose shell is gone OR
  // whose tab was closed (× → removed from keptOpenIds).
  const [mountedShellIds, setMountedShellIds] = useState<Set<string>>(new Set());

  // Whenever a new active entity appears (or is selected), pin its tab.
  // Active Claude sessions, live shells, running installs.
  useEffect(() => {
    const ids: string[] = [];
    for (const s of sessions) {
      const st = s.liveStatus ?? s.status;
      if (st === 'active' || st === 'thinking' || st === 'starting') ids.push(s.id);
    }
    for (const sh of shells) if (!sh.exited) ids.push(sh.id);
    for (const i of installs) if (i.status === 'running') ids.push(i.id);
    if (selectedId) ids.push(selectedId);
    if (selectedShellId) ids.push(selectedShellId);
    if (selectedInstallId) ids.push(selectedInstallId);
    setKeptOpenIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [sessions, shells, installs, selectedId, selectedShellId, selectedInstallId]);

  // Garbage-collect ids of entities that no longer exist (deleted sessions,
  // killed shells removed from the list, etc.) — otherwise the Set grows
  // monotonically.
  useEffect(() => {
    setKeptOpenIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set<string>();
      for (const s of sessions) alive.add(s.id);
      for (const sh of shells) alive.add(sh.id);
      for (const i of installs) alive.add(i.id);
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions, shells, installs]);

  // Mount a shell terminal the first time it's selected, then keep it
  // mounted (see `mountedShellIds` above).
  useEffect(() => {
    if (!selectedShellId) return;
    setMountedShellIds((prev) => {
      if (prev.has(selectedShellId)) return prev;
      const next = new Set(prev);
      next.add(selectedShellId);
      return next;
    });
  }, [selectedShellId]);

  // GC mounted shells: drop any whose shell row no longer exists (deleted /
  // reconciled away) OR whose tab the user closed (no longer in
  // keptOpenIds). Dropping unmounts <ShellTerminal> → its WebSocket closes
  // and the ssh+agent client is freed. The agent's bash + durable log live
  // on, so reopening the shell replays the full scrollback.
  useEffect(() => {
    setMountedShellIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        const keep = shells.some((s) => s.id === id) && keptOpenIds.has(id);
        if (keep) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [shells, keptOpenIds]);

  // Unified "new session" wizard (VPS → path → name). `kind` is fixed by the
  // button that opened it (＋Agent vs ＋Shell). Replaces the old
  // NewSessionDialog / NewShellDialog.
  const [wizard, setWizard] = useState<null | { kind: 'agent' | 'shell'; vpsId?: string; cwd?: string | null }>(null);
  const [resumeOpen, setResumeOpen] = useState<null | { vpsId?: string }>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  // Telegram notifications = an INDEPENDENT channel from browser push. The
  // header toggle drives the `telegram.enabled` server setting (gated inside
  // sendPlainToTelegram→configured()); it has nothing to do with `pushOn`
  // (this browser's Web Push subscription) or `notif.global_enabled` (the
  // browser/push master). `tgConfigured` = token + chat_id are set.
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgConfigured, setTgConfigured] = useState(false);
  const [tgBusy, setTgBusy] = useState(false);
  // Set of VPSes whose agent is being updated (UI loading)
  const [updatingAgentVpsIds, setUpdatingAgentVpsIds] = useState<Set<string>>(new Set());
  // Set of VPSes whose agent connection is being refreshed (UI loading)
  const [refreshingAgentVpsIds, setRefreshingAgentVpsIds] = useState<Set<string>>(new Set());

  // "Refresh agent": re-establish the SSH+hello connection without a full
  // reinstall. For a VPS shown as 'error' whose agent is actually healthy
  // (the transport just dropped). Patches the local row with the verdict.
  async function runRefreshAgent(vps: Vps) {
    if (refreshingAgentVpsIds.has(vps.id)) return;
    setRefreshingAgentVpsIds((prev) => new Set(prev).add(vps.id));
    try {
      const r = await api.refreshVpsAgent(vps.id);
      setVpsList((prev) => prev.map((v) =>
        v.id === vps.id
          ? ({
              ...v,
              agentStatus: r.agentStatus,
              agentVersion: r.agentVersion ?? v.agentVersion,
              agentPyzSha: r.agentPyzSha ?? v.agentPyzSha,
            } as Vps)
          : v
      ));
      if (!r.ok) {
        setError({ msg: `refresh agent: ${r.error ?? 'agent still unreachable'}` });
      }
    } catch (e: any) {
      setError({ msg: `refresh agent: ${e?.message ?? e}` });
    } finally {
      setRefreshingAgentVpsIds((prev) => {
        const n = new Set(prev);
        n.delete(vps.id);
        return n;
      });
    }
  }

  async function runUpdateAgent(vps: Vps) {
    if (updatingAgentVpsIds.has(vps.id)) return;
    setUpdatingAgentVpsIds((prev) => new Set(prev).add(vps.id));
    try {
      const r = await api.updateVpsAgent(vps.id);
      // Patch the local row to reflect the new version/sha/SDK — prevents the
      // "outdated" badge from staying displayed until the next hello.
      setVpsList((prev) => prev.map((v) =>
        v.id === vps.id
          ? ({
              ...v,
              agentVersion: r?.newVersion ?? v.agentVersion,
              agentPyzSha: r?.newPyzSha ?? v.agentPyzSha,
              sdkVersion: r?.sdkVersion ?? v.sdkVersion,
              agentStatus: 'ok',
            } as Vps)
          : v
      ));
    } catch (e: any) {
      setError({ msg: `update agent: ${e?.message ?? e}` });
    } finally {
      setUpdatingAgentVpsIds((prev) => {
        const n = new Set(prev);
        n.delete(vps.id);
        return n;
      });
    }
  }

  // Cross-session interaction queues: fed by
  // useCrossSessionInteractionFeed (ONE single aggregated SSE to
  // /api/claude/interactions/stream which multiplexes events from all
  // sessions). Before: N SSEs (one per session), which saturated the
  // HTTP/1.1 limit (6 connections/origin) as soon as we had 6+ sessions and
  // blocked all POSTs.
  const { perms: permQueue, questions: questionQueue, exitPlans: exitPlanQueue } =
    useCrossSessionInteractionFeed();

  // [esRef, chatBodyRef, assistantBufRef, scroll mechanics (isAtBottomRef,
  //  newCount, lastMessageCountRef, handleChatScroll, onPillClick) — all of
  //  this lives in `<ClaudeSessionView>` after the refactor.]

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const selectedVps = useMemo<Vps | null>(
    () => (selected ? vpsList.find((v) => v.id === selected.vpsId) ?? null : null),
    [selected, vpsList],
  );

  // "Active session has a pending interaction" indicator — used by the
  // status pill in the header. Comes from the cross-session feed, not from
  // the per-session state (which no longer exists in ClaudePanel after the refactor).
  const selectedHasPending = useMemo(() => {
    if (!selectedId) return false;
    return (
      permQueue.some((p) => p.sessionId === selectedId) ||
      questionQueue.some((q) => q.sessionId === selectedId) ||
      exitPlanQueue.some((e) => e.sessionId === selectedId)
    );
  }, [permQueue, questionQueue, exitPlanQueue, selectedId]);

  // Ordered tab list (sidebar order, grouped by VPS). Recomputed on any
  // change to sessions/shells/installs/pendings/keptOpen — cheap, ~O(n).
  // `ShellListItem` is structurally identical to `ShellInfo` (same fields).
  const tabGroups = useMemo(
    () => computeTabs({
      sessions,
      shells,
      installs,
      vpsList,
      vpsFolders,
      keptOpenIds,
      permQueue, questionQueue, exitPlanQueue,
    }),
    [sessions, shells, installs, vpsList, vpsFolders, keptOpenIds,
     permQueue, questionQueue, exitPlanQueue],
  );

  // Active VPS for the 2-row tab bar.
  // Source of truth: derived from the currently selected entity (its
  // vpsId), with a per-VPS memory of the last selected entity so the
  // user can hop between VPSes without losing context.
  const lastSelectedByVpsRef = useRef<Map<string, EntityTab>>(new Map());
  // Remember the entity each time it gets selected.
  useEffect(() => {
    const tab = tabGroups.flat.find((t) => (
      (t.kind === 'session' && t.id === selectedId)
      || (t.kind === 'shell' && t.id === selectedShellId)
      || (t.kind === 'install' && t.id === selectedInstallId)
    ));
    if (tab) lastSelectedByVpsRef.current.set(tab.vpsId, tab);
  }, [selectedId, selectedShellId, selectedInstallId, tabGroups]);

  // The "active VPS" is the one of the currently selected entity. If
  // nothing is selected, fall back to the first VPS that has tabs.
  const activeVpsId = useMemo(() => {
    const selectedEntity = tabGroups.flat.find((t) => (
      (t.kind === 'session' && t.id === selectedId)
      || (t.kind === 'shell' && t.id === selectedShellId)
      || (t.kind === 'install' && t.id === selectedInstallId)
    ));
    if (selectedEntity) return selectedEntity.vpsId;
    return tabGroups.vpsTabs[0]?.vps.id ?? null;
  }, [selectedId, selectedShellId, selectedInstallId, tabGroups]);

  // Click on a VPS tab → switch to that VPS. Selects:
  //   - the entity we last selected for that VPS (if it's still around), OR
  //   - the first entity in that VPS's row (sidebar order).
  function onVpsTabClick(vps: Vps) {
    const entities = tabGroups.entitiesByVps.get(vps.id);
    if (!entities || entities.length === 0) return;
    const remembered = lastSelectedByVpsRef.current.get(vps.id);
    const stillExists = remembered && entities.some((e) =>
      e.kind === remembered.kind && e.id === remembered.id
    );
    const next = stillExists ? remembered! : entities[0];
    selectEntity(next);
  }

  // Tab click dispatch (handles all 3 kinds). Mutually exclusive views —
  // selecting one clears the others (mirrors selectClaude/selectShell/selectInstall).
  function selectEntity(t: EntityTab) {
    if (t.kind === 'session') {
      setSelectedId(t.id); setSelectedShellId(null); setSelectedInstallId(null);
    } else if (t.kind === 'shell') {
      setSelectedShellId(t.id); setSelectedId(null); setSelectedInstallId(null);
    } else {
      setSelectedInstallId(t.id); setSelectedId(null); setSelectedShellId(null);
    }
  }
  /**
   * Resolves the "default cwd" for a "+ new tab" action triggered from
   * row 2's action buttons. Strategy (mirrors the user expectation
   * "same path as the last tab"):
   *   1. Walk the active VPS's entities from the rightmost (most recent)
   *      backward, returning the first cwd we find. Sessions always
   *      carry a cwd; shells may have null (user home); installs don't
   *      have one. The walk skips entries without a cwd.
   *   2. Otherwise fall back to `Vps.defaultPath` (DB-configured per VPS).
   *   3. Otherwise undefined (server-side falls back to user home).
   */
  function defaultCwdFor(vpsId: string): string | undefined {
    const entities = tabGroups.entitiesByVps.get(vpsId) ?? [];
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i];
      if (e.kind === 'session') {
        const s = sessions.find((x) => x.id === e.id);
        if (s?.cwd) return s.cwd;
      } else if (e.kind === 'shell') {
        const sh = shells.find((x) => x.id === e.id);
        if (sh?.cwd) return sh.cwd;
      }
      // installs: no cwd, skip
    }
    const vps = vpsList.find((v) => v.id === vpsId);
    return vps?.defaultPath ?? undefined;
  }

  /** "+ Claude" button on the right of row 2 — open the NewSessionDialog
   *  pre-filled with the active VPS and the same cwd as the last tab. */
  function onTabBarNewSession(vpsId: string) {
    const cwd = defaultCwdFor(vpsId);
    setWizard({ kind: 'agent', vpsId, cwd });
  }
  /** "+ shell" button on the right of row 2 — open the NewShellDialog
   *  pre-filled with the active VPS and the same cwd as the last tab
   *  (mirrors the "+ Claude" flow). */
  function onTabBarNewShell(vpsId: string) {
    const cwd = defaultCwdFor(vpsId) ?? null;
    setWizard({ kind: 'shell', vpsId, cwd });
  }
  /**
   * Right-click on a tab → resolve the entity in our lists, then dispatch
   * to the SAME `ctxMenu` state used by the sidebar's right-click. This
   * is THE shared-menu point: any future change to the menu (new option,
   * relabeling, color tweak) applies to both entry points automatically
   * because the rendering happens once at the bottom of ClaudePanel's
   * JSX (`<SessionContextMenu>` for ctxMenu.kind=session/shell/install).
   */
  function onTabContext(t: EntityTab, x: number, y: number) {
    if (t.kind === 'session') {
      const s = sessions.find((x) => x.id === t.id);
      if (s) setCtxMenu({ kind: 'session', session: s, x, y });
    } else if (t.kind === 'shell') {
      const sh = shells.find((x) => x.id === t.id);
      if (sh) setCtxMenu({ kind: 'shell', shell: sh, x, y });
    } else {
      const inst = installs.find((x) => x.id === t.id);
      if (inst) setCtxMenu({ kind: 'install', install: inst, x, y });
    }
  }

  /** Reason to disable the "+ Claude" button (agent not ready). The
   *  shell button stays enabled — SSH doesn't need the agent. Mirrors
   *  the sidebar's `agentReady`/`noAgentReason` logic. */
  function newSessionDisabledReasonFor(vpsId: string | null): string | null {
    if (!vpsId) return null;
    const vps = vpsList.find((v) => v.id === vpsId);
    if (!vps) return null;
    const status = (vps as any).agentStatus ?? 'unknown';
    if (status === 'ok') return null;
    if (status === 'missing') return 'agent not installed';
    if (status === 'error') return 'agent in error';
    return 'agent not yet verified';
  }

  // Closing a tab is purely local — it just removes the entity from the
  // tab bar (not from the DB or from the sidebar). Active tabs are not
  // closable so this only fires on greyed-out / sleeping tabs.
  function onEntityClose(t: EntityTab) {
    forgetOpen(t.id);
    lastSelectedByVpsRef.current.delete(t.vpsId);
    // If we just closed the currently-selected tab, jump elsewhere so the
    // user isn't left looking at an "orphan" view. Prefer the previous tab
    // in the same VPS row first, falling back to the global flat order.
    const wasSelected =
      (t.kind === 'session' && t.id === selectedId)
      || (t.kind === 'shell' && t.id === selectedShellId)
      || (t.kind === 'install' && t.id === selectedInstallId);
    if (!wasSelected) return;
    const sameVps = tabGroups.entitiesByVps.get(t.vpsId) ?? [];
    const sameVpsIdx = sameVps.findIndex((x) => x.id === t.id);
    const sameVpsRemaining = sameVps.filter((x) => x.id !== t.id);
    if (sameVpsRemaining.length > 0) {
      const next = sameVpsIdx > 0 ? sameVps[sameVpsIdx - 1] : sameVpsRemaining[0];
      selectEntity(next);
      return;
    }
    const flatRemaining = tabGroups.flat.filter((x) => x.id !== t.id);
    if (flatRemaining.length === 0) {
      setSelectedId(null); setSelectedShellId(null); setSelectedInstallId(null);
      return;
    }
    selectEntity(flatRemaining[0]);
  }

  // ── Sessions list (poll 15s) ──
  // Before: 4s. But each tick did `setSessions(...)` (same content) which
  // re-rendered the Sidebar + main panel → CPU + flicker. Intra-session
  // status changes already arrive via the per-session SSE; the poll only
  // serves to refresh the count badges + detect sessions created on
  // another client. 15s is amply sufficient.
  const refreshSessions = useCallback(async () => {
    try {
      const r = (await api.listClaudeSessions()) as { sessions: SessionListItem[] };
      setSessions(r.sessions);
    } catch {}
  }, []);
  useEffect(() => {
    refreshSessions();
    const t = setInterval(refreshSessions, 15_000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  // Live "the session list changed" signal (CLAUDE.md §14.52). When a session
  // is created / imported / deleted on ANY tab or device, sessionOps fans a
  // `session_list_changed` event on the bus (LOW_VOLUME → reaches every tab,
  // even unfocused ones). Refetch the list immediately so the sidebar + tab bar
  // reflect it without waiting for the 15s poll — this is what makes a session
  // started on a phone appear on the desktop without an F5. The poll stays as a
  // backstop in case an event is missed (SSE drop).
  useEffect(() => {
    const unsub = subscribeAll((ev) => {
      if (ev.type !== 'session_list_changed') return;
      refreshSessions();
    });
    return () => unsub();
  }, [refreshSessions]);

  // ── Notification when a session takes a pending while we're elsewhere
  // (another session, another tab, another window). Detects 0 → N
  // transitions between 2 polls and fires a native Notification + a small sound.
  const prevPendingRef = useRef<Map<string, number>>(new Map());
  // First effect run after mount only seeds the baseline — it must NOT
  // notify. Otherwise every page refresh (which resets prevPendingRef to
  // empty) re-fires a notification for every session that already had a
  // pending, even though the user was already notified when it happened.
  const attentionBaselineSetRef = useRef(false);
  useEffect(() => {
    const prev = prevPendingRef.current;
    const firstRun = !attentionBaselineSetRef.current;
    const newAttentions: SessionListItem[] = [];
    for (const s of sessions) {
      const before = prev.get(s.id) ?? 0;
      const now = s.pendingPermissions ?? 0;
      if (!firstRun && now > before && s.id !== selectedId) {
        newAttentions.push(s);
      }
      prev.set(s.id, now);
    }
    attentionBaselineSetRef.current = true;
    if (newAttentions.length === 0) return;
    // Title flash + native Notification if tab is hidden OR another session
    for (const s of newAttentions) {
      const label = s.name ?? s.cwd?.split('/').filter(Boolean).slice(-1)[0] ?? s.id.slice(0, 6);
      const vpsName = vpsList.find((v) => v.id === s.vpsId)?.name;
      const title = vpsName
        ? `❓ ${vpsName} · ${label} is awaiting a response`
        : `❓ ${label} is awaiting a response`;
      const body = s.cwd ?? '';
      try {
        if (typeof window !== 'undefined' && 'Notification' in window
            && Notification.permission === 'granted') {
          const n = new Notification(title, { body, tag: 'claude-' + s.id });
          n.onclick = () => {
            window.focus();
            setSelectedId(s.id);
            n.close();
          };
        }
      } catch {}
    }
    // Always beep here (tab open). The service worker ALSO drives the
    // sound immediately on the push event, but that depends on the SW
    // being up-to-date and on background-audio not being throttled — so
    // this poll-driven call is the reliable fallback. playBeep() debounces
    // internally, so the two paths don't double-play the same notification.
    if (notifSoundEnabled) playBeep();
  }, [sessions, selectedId]);

  // Notification permission request at mount (silent if already granted/denied)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      // Non-blocking ask at the next user click (otherwise Chrome blocks)
      const ask = () => {
        Notification.requestPermission().catch(() => {});
        document.removeEventListener('click', ask);
      };
      document.addEventListener('click', ask, { once: true });
    }
  }, []);

  // Local sound toggle (localStorage). MUST init to the SSR default and
  // only read localStorage AFTER mount — otherwise the value read during
  // hydration (if localStorage = '0') differs from the SSR'd `true`, the
  // <button title> + icon swap produces a hydration mismatch, React 19
  // recovers by re-rendering the entire root, the useEffect cleanups all
  // run, and any module-level subscriptions (here: subscribeReconnect on
  // the SSE) are torn down. End result: the SSE reconnect handler has no
  // listeners → after `systemctl restart charon`, the chat stays frozen
  // until F5. Don't reintroduce the localStorage-in-useState-init pattern
  // here — see CLAUDE.md §14 gotcha 24.
  const [notifSoundEnabled, setNotifSoundEnabled] = useState<boolean>(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem('hub.claude.notif.sound');
      if (stored === '0') setNotifSoundEnabled(false);
    } catch {}
  }, []);
  function toggleNotifSound() {
    setNotifSoundEnabled((v) => {
      const next = !v;
      try { localStorage.setItem('hub.claude.notif.sound', next ? '1' : '0'); } catch {}
      return next;
    });
  }
  // Ref mirroring the latest sound state so the service-worker message
  // listener (registered once) reads a fresh value without re-subscribing.
  // Used by the push-triggered in-app sound.
  const notifSoundEnabledRef = useRef(notifSoundEnabled);
  useEffect(() => { notifSoundEnabledRef.current = notifSoundEnabled; }, [notifSoundEnabled]);

  // Tab title: (N) hub claude when N sessions are waiting
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const total = sessions.reduce((acc, s) => acc + (s.pendingPermissions ?? 0), 0);
    document.title = total > 0 ? `(${total}) hub claude` : 'hub claude';
  }, [sessions]);

  // Initial detection of the push state + force the SW to refresh so a
  // newly-deployed sw.js (e.g. notif-sound support) takes over without a
  // manual DevTools unregister.
  useEffect(() => {
    (async () => {
      if (!(await pushSupported())) return;
      ensureFreshServiceWorker();
      const ep = await pushCurrentEndpoint();
      setPushOn(!!ep);
    })();
  }, []);

  // Listens for service worker messages: notification click (open-session)
  // and the push-triggered in-app sound (notif-sound). The SW fires
  // `notif-sound` to the focused/visible tab on every push so the custom
  // sound plays immediately when a tab is open (focused = reliable,
  // backgrounded = best-effort, Chrome may throttle background audio).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open-session' && e.data.sessionId) {
        const sid = e.data.sessionId as string;
        setSelectedId(sid);
        // Tell the (possibly already-mounted) session hook to force an
        // immediate resync — the pending question/permission that the
        // notification is about may have arrived while this tab wasn't the
        // focused one, and a same-session click triggers no remount.
        try { window.dispatchEvent(new CustomEvent('charon:notif-open', { detail: { sessionId: sid } })); } catch {}
      } else if (e.data?.type === 'notif-sound') {
        if (notifSoundEnabledRef.current) playBeep();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  async function togglePush() {
    setPushBusy(true);
    try {
      if (pushOn) {
        await pushUnsubscribe();
        setPushOn(false);
      } else {
        const r = await pushSubscribe();
        if (!r.ok) alert('Push not enabled: ' + (r.reason ?? '?'));
        setPushOn(r.ok);
      }
    } finally { setPushBusy(false); }
  }

  // Load the Telegram on/off + configured state for the header toggle. Re-runs
  // when the Settings modal closes so editing token/chat_id there refreshes the
  // button (it doubles as the initial mount load — settingsOpen starts false).
  useEffect(() => {
    if (settingsOpen) return;
    let alive = true;
    api.getClaudeSettings().then((s) => {
      if (!alive) return;
      setTgEnabled(s['telegram.enabled'] === 'true');
      setTgConfigured(!!s['telegram.bot_token'] && !!s['telegram.chat_id']);
    }).catch(() => {});
    return () => { alive = false; };
  }, [settingsOpen]);

  async function toggleTelegram() {
    // Not set up yet → send the user to Settings to enter token + chat_id.
    if (!tgConfigured) { setSettingsOpen(true); return; }
    setTgBusy(true);
    const next = !tgEnabled;
    setTgEnabled(next); // optimistic
    try {
      await api.updateClaudeSettings({ 'telegram.enabled': next ? 'true' : 'false' });
    } catch {
      setTgEnabled(!next); // revert on failure
    } finally { setTgBusy(false); }
  }

  // Note: before the refactor, applyApiPendings synced permQueue/
  // questionQueue/exitPlanQueue from the API on every refetch. Today
  // useCrossSessionInteractionFeed keeps these queues up to date via an
  // SSE per session (pendings are replayed on subscribe). Nothing to do here.

  // Prefetch all sessions at mount (and when the list changes) → the
  // module-level `sessionCache.ts` cache is populated; when the user clicks
  // a session, `<ClaudeSessionView>` remounts with its hook reading from the
  // cache first (instant render) then fetching fresh in the background.
  useEffect(() => {
    sessionCachePrefetchAll(sessions.map((s) => s.id));
  }, [sessions.length, sessions]);

  // [SSE + per-session state + refetch + scroll = delegated to
  //   `<ClaudeSessionView>` which uses `useClaudeSessionStream`.
  //   Before the refactor, ClaudePanel contained ~250 lines of SSE handler,
  //   `applyApiPendings`, `refetchHistory`, `prefetchSession`, visibilityChange,
  //   and the new-messages tracker. All of this now lives in the hook or
  //   directly in the view.]

  // [send/interrupt/forceStop/setMode/doSleep/doResume/doDelete/respondPermission
  //  for the ACTIVE SESSION are in `<ClaudeSessionView>` via the
  //  `useClaudeSessionStream` hook. ClaudePanel only keeps cross-session
  //  actions: deletion of another session via the menu
  //  (`deleteSessionOne`), edit cwd (`editSessionCwd`), patch shell, etc.]

  async function renameSession(id: string, name: string) {
    setEditingId(null);
    try {
      await api.renameClaudeSession(id, name || null);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: 'rename: ' + (e?.message ?? e) });
    }
  }

  // Cross-session sleep (from the sidebar context menu). No confirm —
  // it's reversible (resume reopens the session). The active session's
  // header button remains the main entry point, but right-clicking in the
  // sidebar lets us pause a session without having to focus it.
  async function sleepOne(id: string) {
    try {
      await api.sleepClaudeSession(id);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: 'sleep: ' + (e?.message ?? e) });
    }
  }

  // Permanent deletion (DB cascade on the server side). The caller must
  // have confirmed. No more soft-kill (`status='killed'` which kept the row
  // in DB for post-mortem inspection) — the rework merged kill→delete (cf.
  // CLAUDE.md §10). To pause the session without losing it, use
  // `doSleep` (reversible) in `<ClaudeSessionView>`.
  async function deleteSessionOne(id: string) {
    if (!confirm('Permanently delete this session and all its history?')) return;
    try {
      await api.deleteClaudeSession(id);
      if (id === selectedId) setSelectedId(null);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: 'delete: ' + (e?.message ?? e) });
    }
  }

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
      setError({ msg: 'patch session: ' + (e?.message ?? e) });
    }
  }

  /** Edits a session's cwd via prompt(). The PATCH on the server side
   *  automatically kills the agent instance if it exists, and resets the
   *  DB status to 'sleeping' so the user can click resume with the new
   *  cwd. */
  async function editSessionCwd(sess: SessionListItem) {
    const newCwd = prompt('New folder (cwd) for this session?\n(the session will be recreated at the next resume)', sess.cwd);
    if (newCwd == null || newCwd.trim() === '' || newCwd.trim() === sess.cwd) return;
    await patchSession(sess.id, { cwd: newCwd.trim() });
    refreshSessions();
  }

  async function patchShell(id: string, body: { name?: string | null; color?: string | null }) {
    try {
      const updated = await api.updateShell(id, body);
      setShells((prev) => prev.map((s) => s.id === id ? { ...s, ...updated } : s));
    } catch (e: any) {
      setError({ msg: 'patch shell: ' + (e?.message ?? e) });
    }
  }

  async function killShellOne(id: string) {
    try {
      await api.killShell(id);
      shellKilled(id);
    } catch (e: any) {
      setError({ msg: 'kill shell: ' + (e?.message ?? e) });
    }
  }

  // Cross-session permission popup → when the user clicks allow/deny on
  // a perm from ANOTHER session than the selected one. The active session
  // has its own popup managed by the hook.
  async function respondPermissionCrossSession(sessionId: string, permId: string, allow: boolean, always: boolean) {
    try {
      await api.respondClaudePermission(sessionId, permId, allow, always);
      refreshSessions();
    } catch (e: any) {
      setError({ msg: String(e?.message ?? e) });
    }
  }

  // The shells whose <ShellTerminal> is kept mounted (union of the lazily-
  // tracked `mountedShellIds` and the current selection, in case the
  // selection effect hasn't committed yet), resolved to live rows. Rendered
  // as a persistent layer below — only the selected one is visible; the
  // rest stay mounted with display:none so their WS/xterm survive switches.
  const mountedShellList = useMemo(() => {
    const ids = new Set(mountedShellIds);
    if (selectedShellId) ids.add(selectedShellId);
    const out: ShellListItem[] = [];
    for (const id of ids) {
      const sh = shells.find((s) => s.id === id);
      if (sh) out.push(sh);
    }
    return out;
  }, [mountedShellIds, selectedShellId, shells]);
  const selectedShellExists = !!selectedShellId && shells.some((s) => s.id === selectedShellId);

  return (
    <div className={`claude-root${selectedShellId ? '' : ' has-tools'}${navOpen ? ' nav-open' : ''}${toolsOpen ? ' tools-open' : ''}`}>
      {/* Backdrop behind any open drawer (mobile only; CSS-gated). Tap to close. */}
      <div className="drawer-backdrop" onClick={closeDrawers} aria-hidden />
      <header className="claude-head">
        {/* ☰ opens the sidebar drawer; CSS reveals it only ≤820px (.m-only). */}
        <button
          className="head-btn m-only nav-toggle"
          onClick={() => { setNavOpen(true); setToolsOpen(false); }}
          title="menu" aria-label="open navigation"
        >
          <IconMenu />
        </button>
        <svg className="brand-logo" viewBox="12 32 236 196" aria-hidden>
          <path d="M 18 120 Q 32 114 46 120 T 74 120 T 100 120" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 22 140 Q 36 134 50 140 T 78 140 T 100 140" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 26 160 Q 40 154 54 160 T 82 160 T 100 160" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 120 Q 174 114 188 120 T 216 120 T 242 120" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 140 Q 174 134 188 140 T 216 140 T 238 140" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 160 160 Q 174 154 188 160 T 216 160 T 234 160" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
          <path d="M 130 40 Q 100 75 96 140 Q 94 188 130 220 Q 166 188 164 140 Q 160 75 130 40 Z" fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round"/>
          <circle cx="130" cy="145" r="17" fill="none" stroke="currentColor" strokeWidth="7"/>
          <circle cx="130" cy="145" r="11" fill="currentColor"/>
          <line x1="108" y1="103" x2="152" y2="103" stroke="currentColor" strokeWidth="4.5" opacity="0.7"/>
          <line x1="106" y1="187" x2="154" y2="187" stroke="currentColor" strokeWidth="4.5" opacity="0.7"/>
        </svg>
        <h1>CHARON</h1>
        <div className="head-right">
          {/* Opens the ToolPanel (diffs/todos/calls) drawer; CSS reveals it
              only ≤1100px, and only meaningful when a Claude session is open. */}
          {selectedId && (
            <button
              className="head-btn m-only tools-toggle"
              onClick={() => { setToolsOpen(true); setNavOpen(false); }}
              title="diffs, todos & tool calls" aria-label="open tool panel"
            >
              <IconPanelRight />
            </button>
          )}
          {selected && selectedVps && (
            <span className="ctx">{selectedVps.name}:{selected.cwd}</span>
          )}
          {!!selected?.subscribers && selected.subscribers > 1 && (
            <span className="multi-pill" title={`${selected.subscribers} clients connected to this session`}>
              ×{selected.subscribers}
            </span>
          )}
          {/* 3 visual states:
              1) Claude is working → "thinking" amber-pulse
              2) Awaiting a response from you → "awaiting your response" orange-pulse
              3) Idle/done → "active" green
              Source: `selected.liveStatus` (poll refresh 4s) + the
              cross-session feed for the "pending". Max lag 4s vs real-time SSE
              of the active view, acceptable for a header indicator. */}
          {selected?.liveStatus === 'thinking' ? (
            <span className="status-pill status-amber-pulse">
              <span className="dot" /> claude is thinking
            </span>
          ) : selectedHasPending ? (
            <span className="status-pill status-orange-pulse">
              <span className="dot" /> awaiting your response
            </span>
          ) : selected?.liveStatus ? (
            <span className={`status-pill status-${STATUS_DOT[selected.liveStatus as WorkerStatus]}`}>
              <span className="dot" /> {STATUS_LABEL[selected.liveStatus as WorkerStatus]}
            </span>
          ) : null}
          <button className="head-btn" onClick={() => setSearchOpen(true)} title="search across all messages" aria-label="search">
            <IconSearch />
          </button>
          <button
            className={`head-btn toggle-btn ${pushOn ? 'is-on' : 'is-off'}`}
            onClick={togglePush}
            disabled={pushBusy}
            title={pushOn
              ? 'Push notifications: ON — click to turn off'
              : 'Push notifications: OFF — click to turn on'}
            aria-label={pushOn ? 'Push notifications on, click to turn off' : 'Push notifications off, click to turn on'}
            aria-pressed={pushOn}
          >
            {pushOn ? <IconBellFill /> : <IconBellSlash />}
          </button>
          <button
            className={`head-btn toggle-btn ${notifSoundEnabled ? 'is-on' : 'is-off'}`}
            onClick={toggleNotifSound}
            title={notifSoundEnabled
              ? 'In-app sound: ON — click to mute (only plays while this tab is open)'
              : 'In-app sound: OFF (muted) — click to unmute'}
            aria-label={notifSoundEnabled ? 'In-app sound on, click to mute' : 'In-app sound muted, click to unmute'}
            aria-pressed={notifSoundEnabled}
          >
            {notifSoundEnabled ? <IconVolumeUp /> : <IconVolumeMute />}
          </button>
          <button
            className={`head-btn toggle-btn ${tgEnabled && tgConfigured ? 'is-on' : 'is-off'}`}
            onClick={toggleTelegram}
            disabled={tgBusy}
            title={!tgConfigured
              ? 'Telegram notifications: not configured — click to set bot token & chat_id'
              : tgEnabled
                ? 'Telegram notifications: ON — click to turn off'
                : 'Telegram notifications: OFF — click to turn on'}
            aria-label={tgEnabled && tgConfigured ? 'Telegram notifications on, click to turn off' : 'Telegram notifications off, click to turn on'}
            aria-pressed={tgEnabled && tgConfigured}
          >
            <IconTelegram />
          </button>
          <button className="head-btn" onClick={() => setDataOpen(true)} title="VPS, projects, paths" aria-label="VPS data">
            <IconServers />
          </button>
          <LocalAgentButton />
          <button className="head-btn" onClick={() => setSettingsOpen(true)} title="settings" aria-label="settings">
            <IconGear />
          </button>
        </div>
      </header>

      <Sidebar
        vpsList={vpsList}
        vpsFolders={vpsFolders}
        vpsPaths={vpsPaths}
        sessions={sessions}
        shells={shells}
        installs={installs}
        selectedId={selectedId}
        selectedShellId={selectedShellId}
        selectedInstallId={selectedInstallId}
        onSelect={selectClaude}
        onSelectShell={selectShell}
        onSelectInstall={selectInstall}
        onNew={(opts) => setWizard({ kind: 'agent', ...opts })}
        onNewShell={(opts) => setWizard({ kind: 'shell', ...opts })}
        onScan={(vpsId) => setResumeOpen({ vpsId })}
        onOpenData={() => setDataOpen(true)}
        onContext={(s, x, y) => setCtxMenu({ kind: 'session', session: s, x, y })}
        onContextShell={(sh, x, y) => setCtxMenu({ kind: 'shell', shell: sh, x, y })}
        onContextInstall={(inst, x, y) => setCtxMenu({ kind: 'install', install: inst, x, y })}
        editingId={editingId}
        onRenameSubmit={renameSession}
        onRenameCancel={() => setEditingId(null)}
        onInstallAgent={openInstallSession}
        onLoginAgent={(v) => setLoginVps(v)}
        onUpdateAgent={(v) => { runUpdateAgent(v); }}
        onRefreshAgent={(v) => { runRefreshAgent(v); }}
        onToggleFolderCollapsed={async (folderId, collapsed) => {
          // Optimistic: update immediately, then POST. Roll back if it fails.
          setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsed ? 1 : 0 } : f));
          try {
            await api.updateVpsFolder(folderId, { collapsed });
          } catch (e: any) {
            setError({ msg: String(e?.message ?? e) });
            setVpsFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, collapsed: collapsed ? 0 : 1 } : f));
          }
        }}
        builtPyzSha={builtPyzSha}
        sdkLatestVersion={sdkLatestVersion}
        updatingAgentVpsIds={updatingAgentVpsIds}
        refreshingAgentVpsIds={refreshingAgentVpsIds}
      />

      <TabBar
        vpsTabs={tabGroups.vpsTabs}
        entitiesByVps={tabGroups.entitiesByVps}
        activeVpsId={activeVpsId}
        selectedSessionId={selectedId}
        selectedShellId={selectedShellId}
        selectedInstallId={selectedInstallId}
        onVpsClick={onVpsTabClick}
        onEntitySelect={selectEntity}
        onEntityClose={onEntityClose}
        onNewSession={onTabBarNewSession}
        onNewShell={onTabBarNewShell}
        newSessionDisabledReason={newSessionDisabledReasonFor(activeVpsId)}
        onTabContext={onTabContext}
      />

      {/* Main panel routing: 3 mutually exclusive views.
          - selectedInstallId → <InstallSessionView> (full-screen install log)
          - selectedShellId   → <ShellTerminal> (ephemeral SSH xterm)
          - selectedId        → <ClaudeSessionView> (chat + tool panel)
          - otherwise: placeholder. */}
      {selectedInstallId ? (() => {
        const inst = installs.find((i) => i.id === selectedInstallId);
        if (!inst) return <main className="claude-main"><div className="bar-empty">install not found</div></main>;
        const vps = vpsList.find((v) => v.id === inst.vpsId);
        return (
          <InstallSessionView
            key={inst.id}
            installId={inst.id}
            vpsId={inst.vpsId}
            vpsName={inst.vpsName}
            onClosed={() => installClosed(inst.id)}
            onSetupLogin={vps ? () => setLoginVps(vps) : undefined}
            onInstallSuccess={() => {
              // Local patch: the agent is now OK AND at the embedded version.
              // Without the agentPyzSha, the "outdated" badge would stay
              // displayed. The subscribeAll handler above does the same on a
              // cross-session finished event — this is idempotent.
              setVpsList((prev) => prev.map((v) =>
                v.id === inst.vpsId
                  ? ({
                      ...v,
                      agentStatus: 'ok',
                      agentPyzSha: builtPyzSha ?? v.agentPyzSha,
                    } as Vps)
                  : v,
              ));
            }}
          />
        );
      })() : selectedShellId ? (
        // The actual <ShellTerminal>s live in the persistent layer rendered
        // below (kept mounted across session switches so the live shell +
        // its scrollback survive). Here we only render the not-found
        // fallback when the selected shell row no longer exists.
        selectedShellExists ? null : (
          <main className="claude-main"><div className="bar-empty">shell not found</div></main>
        )
      ) : selected ? (
        // Error boundary: a render error in the chat subtree (hydration
        // mismatch, transient undefined, bad markdown) must NOT permanently
        // freeze the chat. The boundary catches it, shows "reconnecting…",
        // and remounts after ~1.5s → all effects (polling/SSE/refetch)
        // restart → self-heal. resetKey=selectedId clears errors on switch.
        // cf. CLAUDE.md §14 gotcha 24.
        <SessionErrorBoundary resetKey={selectedId ?? ''}>
        <ClaudeSessionView
          key={selectedId}
          sessionId={selected.id}
          selected={selected}
          selectedVps={selectedVps}
          overlay={
            <>
              {loginVps && <LoginConsole vps={loginVps} onClose={closeLoginConsole} />}
            </>
          }
          onImportError={(vps) => {
            // The VPS agent crashed an "import claude_agent_sdk" → we trigger
            // the install in a new install session (instead of the
            // BootstrapBanner overlay that existed before). The user returns
            // to their Claude session once the install is OK (via notif + click).
            const existing = installs.find((i) => i.vpsId === vps.id && i.status === 'running');
            if (existing) {
              selectInstall(existing.id);
            } else {
              openInstallSession(vps);
            }
          }}
          onKilled={() => {
            setSelectedId(null);
            refreshSessions();
          }}
          onAfterRevert={() => refreshSessions()}
        />
        </SessionErrorBoundary>
      ) : (
      // No session selected: placeholder. ToolPanel is not rendered in this
      // case (before the refactor it was, with sessionId=null, but displayed
      // nothing useful).
      <main className="claude-main">
        <div className="claude-bar">
          <span className="bar-empty">— select or create a session in the sidebar —</span>
        </div>
      </main>
      )}

      {/* Persistent shell layer: every shell the user has opened this
          page-load stays mounted here (its WebSocket + xterm alive), so
          switching to another session and back keeps the live shell and
          its full scrollback — no reconnect, no flash. The whole layer is
          display:none unless a shell is the current selection; within it,
          only the selected shell's slot is visible (the rest are hidden
          with display:none → ShellTerminal active=false → it stops fitting
          but keeps streaming). See §14 gotcha 37. */}
      {mountedShellList.length > 0 && (
        <main className="claude-main shell-main" style={{ display: selectedShellExists ? 'flex' : 'none' }}>
          {mountedShellList.map((sh) => (
            <div
              key={sh.id}
              className="shell-slot"
              style={{ display: selectedShellId === sh.id ? 'flex' : 'none' }}
            >
              <ShellTerminal
                shellId={sh.id}
                vpsName={sh.vpsName}
                cwd={sh.cwd}
                active={selectedShellId === sh.id}
                onKilled={() => shellKilled(sh.id)}
              />
            </div>
          ))}
        </main>
      )}

      {/* Also render the LoginConsole when selected ALONG with an install/shell —
          loginVps is cross-panel (triggered from Sidebar or
          InstallSessionView). We keep a global mount. */}
      {loginVps && (selectedShellId || selectedInstallId) && (
        <LoginConsole vps={loginVps} onClose={closeLoginConsole} />
      )}

      <PermissionPopup
        queue={permQueue}
        currentSessionId={selectedId}
        onRespond={respondPermissionCrossSession}
        onSwitchSession={(id) => setSelectedId(id)}
      />

      <InstallNotificationPopup
        notifications={installNotifications}
        onOpen={(installId) => selectInstall(installId)}
        onDismiss={dismissInstallNotif}
      />

      {wizard && (
        <NewSessionWizard
          kind={wizard.kind}
          vpsList={vpsList}
          vpsFolders={vpsFolders}
          vpsPaths={vpsPaths}
          initialVpsId={wizard.vpsId}
          initialCwd={wizard.cwd}
          onClose={() => setWizard(null)}
          onCreatedSession={(id) => { setWizard(null); selectClaude(id); refreshSessions(); }}
          onCreatedShell={(sh) => { setWizard(null); applyCreatedShell(sh); }}
        />
      )}

      {resumeOpen && (
        <ResumeModal
          vpsList={vpsList}
          dbSessions={sessions}
          initialVpsId={resumeOpen.vpsId}
          onClose={() => setResumeOpen(null)}
          onImported={(id) => { setResumeOpen(null); setSelectedId(id); refreshSessions(); }}
          onResumed={async (id) => {
            setResumeOpen(null);
            try { await api.resumeClaudeSession(id); }
            catch (e: any) { setError({ msg: String(e?.message ?? e) }); return; }
            setSelectedId(id);
            refreshSessions();
          }}
        />
      )}

      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onPick={(id) => { setSearchOpen(false); setSelectedId(id); }}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {dataOpen && (
        <DataModal
          onClose={() => setDataOpen(false)}
          initialVps={vpsList}
          initialFolders={vpsFolders}
          initialPaths={vpsPaths}
          onChange={({ vps, folders, paths }) => {
            setVpsList(vps);
            setVpsFolders(folders);
            setVpsPaths(paths);
          }}
          onInstallAgent={openInstallSession}
        />
      )}

      {ctxMenu && ctxMenu.kind === 'session' && (
        <SessionContextMenu
          title={ctxMenu.session.name || ctxMenu.session.cwd.split('/').slice(-2).join('/')}
          subtitle={ctxMenu.session.cwd}
          x={ctxMenu.x}
          y={ctxMenu.y}
          currentColor={(ctxMenu.session as any).color}
          // No `onKill` here: the kill→delete rework merged the two
          // actions. Only `onDelete` remains for Claude sessions. The
          // shells/installs below keep their `onKill` (= close).
          //
          // `onSleep` is only passed if the session is in a state where sleep
          // makes sense (active/thinking/starting). For sleeping/error/killed,
          // the item disappears from the menu (the "resume" button in the
          // chat header takes care of waking up the session; we don't duplicate here).
          onRename={() => setEditingId(ctxMenu.session.id)}
          onEditCwd={() => editSessionCwd(ctxMenu.session)}
          onColor={(color) => patchSession(ctxMenu.session.id, { color })}
          onSleep={
            ['active', 'thinking', 'starting'].includes(ctxMenu.session.status)
              ? () => sleepOne(ctxMenu.session.id)
              : undefined
          }
          onDelete={() => deleteSessionOne(ctxMenu.session.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {ctxMenu && ctxMenu.kind === 'shell' && (
        <SessionContextMenu
          title={ctxMenu.shell.name || `⌨ ${ctxMenu.shell.cwd ?? '~'}`}
          x={ctxMenu.x}
          y={ctxMenu.y}
          currentColor={ctxMenu.shell.color}
          canKill={!ctxMenu.shell.exited}
          killLabel="Close"
          killDisabledReason={ctxMenu.shell.exited ? 'already ended' : undefined}
          showDelete={false}
          onRename={() => {
            const name = prompt('Shell name?', ctxMenu.shell.name ?? '');
            if (name != null) patchShell(ctxMenu.shell.id, { name: name.trim() || null });
          }}
          onColor={(color) => patchShell(ctxMenu.shell.id, { color })}
          onKill={() => killShellOne(ctxMenu.shell.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {ctxMenu && ctxMenu.kind === 'install' && (
        <SessionContextMenu
          title={`⚙ installation · ${ctxMenu.install.vpsName}`}
          subtitle={
            ctxMenu.install.status === 'running'
              ? `running — phase: ${ctxMenu.install.currentPhase ?? 'init'}`
              : ctxMenu.install.status === 'success'
                ? 'completed successfully'
                : 'failed'
          }
          x={ctxMenu.x}
          y={ctxMenu.y}
          showRename={false}
          showColor={false}
          showDelete={false}
          killLabel="Close"
          killDisabledReason={
            ctxMenu.install.status === 'running'
              ? "the install is still running — it continues on the server"
              : undefined
          }
          onKill={() => killInstallOne(ctxMenu.install.id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// InlinePermissionCard, ThinkingBar, fmtElapsed: moved into
// `./ClaudeSessionView.tsx` (used only by the session view).
// rebuildStateFromMessages: in `./sessionRebuild.ts`.

// Notification sound. Played by ClaudePanel when another session goes
// pending (cross-session notification, not in the active view).
//
// ─────────────────────────────────────────────────────────────────────
// CUSTOM SOUND: the file lives at `public/notif.wav` and is served at
// `/notif.wav`. Replace that file with your own WAV/MP3 to change the
// sound — no rebuild needed (it's a static asset). To use a different
// filename/extension (e.g. an .mp3), just update NOTIF_SOUND_URL below.
// If the file is missing or can't be decoded, we fall back to a
// synthesized Web Audio beep so the notification is never silent.
// ─────────────────────────────────────────────────────────────────────
const NOTIF_SOUND_URL = '/notif.wav';
let _notifAudio: HTMLAudioElement | null = null;
// Debounce: two independent paths can call playBeep for the SAME
// notification — the SW push message (immediate) and the 15s poll
// (fallback). Swallow calls that land within this window so we don't
// double-chime. Kept short (2s) so distinct notifications spaced further
// apart still each chime.
let _lastBeepAt = 0;
const BEEP_DEBOUNCE_MS = 2000;
function playBeep() {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - _lastBeepAt < BEEP_DEBOUNCE_MS) return;
  _lastBeepAt = now;
  try {
    if (!_notifAudio) {
      _notifAudio = new Audio(NOTIF_SOUND_URL);
      _notifAudio.preload = 'auto';
    }
    _notifAudio.currentTime = 0;
    const p = _notifAudio.play();
    // play() rejects on 404 / decode error / autoplay block → synth fallback.
    if (p && typeof p.catch === 'function') p.catch(() => playSynthBeep());
  } catch {
    playSynthBeep();
  }
}

// Fallback beep — Web Audio (no file to load).
// Singleton AudioContext to avoid the Chrome warning (max 6 contexts).
let _audioCtx: AudioContext | null = null;
function playSynthBeep() {
  if (typeof window === 'undefined') return;
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);
    osc.start();
    osc.stop(ctx.currentTime + 0.20);
  } catch {}
}
