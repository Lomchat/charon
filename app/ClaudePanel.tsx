'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath, ClaudeSession } from '@/lib/db/schema';
import type { WorkerStatus, AccountUsage } from '@/lib/server/claude/types';
import type { AgentKind, TabDTO } from '@/lib/types/api';
import Sidebar, { type SessionListItem, type ShellListItem, type InstallInfo } from './Sidebar';
import TabBar, { resolveTabs, type ResolvedTab } from './TabBar';
import type { EditSnapshot } from './sessionTypes';
import {
  useTabs, hydrateTabs, refreshTabs, openTab as openWorkspaceTab, activateTab as activateWorkspaceTab,
  pinTab as pinWorkspaceTab, closeTab as closeWorkspaceTab,
  closeTabsWhere as closeWorkspaceTabsWhere, reorderTabs as reorderWorkspaceTabs,
} from './tabStore';
import ShellTerminal from './ShellTerminal';
import ConfirmModal from './ConfirmModal';
import PermissionPopup from './PermissionPopup';
import InstallNotificationPopup from './InstallNotificationPopup';
import { useCrossSessionInteractionFeed } from './useCrossSessionInteractionFeed';
import { useInstallNotifications } from './useInstallNotifications';
import { setFocus, subscribeAll } from './globalEventStream';
import SessionContextMenu from './SessionContextMenu';
import LocalAgentButton from './LocalAgentButton';
import ClaudeSessionView from './ClaudeSessionView';
import { assignHandlesByVps } from '@/lib/sessionHandle';
import UsageMeter from './UsageMeter';
import { backendAvailability } from './vpsHealth';
import SessionErrorBoundary from './SessionErrorBoundary';
import { revealLine } from './revealLine';
import { requestChatFocus } from './focusChat';
import { pushCurrentEndpoint, pushSubscribe, pushUnsubscribe, pushSupported, ensureFreshServiceWorker } from './pushClient';
import {
  IconBellFill, IconBellSlash, IconGear, IconSearch,
  IconServers, IconVolumeMute, IconVolumeUp, IconTelegram,
  IconMenu, IconPanelRight,
} from './icons';

// Heavy or rarely-opened surfaces stay out of the dashboard's bootstrap
// chunk. ChunkReloadGuard handles a lazy chunk invalidated by a deployment.
const ToolPanel = dynamic(() => import('./ToolPanel'));
const FileEditor = dynamic(() => import('./FileEditor'));
const InstallSessionView = dynamic(() => import('./InstallSessionView'));
const NewSessionWizard = dynamic(() => import('./NewSessionWizard'), { ssr: false });
const DataModal = dynamic(() => import('./DataModal'), { ssr: false });
const ResumeModal = dynamic(() => import('./ResumeModal'), { ssr: false });
const SearchModal = dynamic(() => import('./SearchModal'), { ssr: false });
const SettingsModal = dynamic(() => import('./SettingsModal'), { ssr: false });
const ClaudeLoginModal = dynamic(() => import('./ClaudeLoginModal'), { ssr: false });
const CodexLoginModal = dynamic(() => import('./CodexLoginModal'), { ssr: false });

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialSessions: ClaudeSession[];
  builtPyzSha: string | null;
  // `__version__` of the pyz this hub ships — THE agent-staleness baseline
  // (§14.6); builtPyzSha is kept for identity/receipts only.
  builtAgentVersion: string | null;
  // Latest claude-agent-sdk on PyPI (settings cache, null = never synced).
  // Compared to vps.sdkVersion for the sidebar "SDK out of date" badge.
  sdkLatestVersion: string | null;
  codexLatestVersion?: string | null;
  initialTabs: TabDTO[];
};

function sameSessionRows(a: SessionListItem[], b: SessionListItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>;
    const y = b[i] as unknown as Record<string, unknown>;
    const xk = Object.keys(x);
    const yk = Object.keys(y);
    if (xk.length !== yk.length) return false;
    for (const k of xk) if (x[k] !== y[k]) return false;
  }
  return true;
}

const STATUS_LABEL: Record<WorkerStatus, string> = {
  starting: 'starting',
  active: 'active',
  thinking: 'thinking',
  failed: 'error',
  background: 'background',
  sleeping: 'sleeping',
  killed: 'killed',
  error: 'error',
  reconnecting: 'reconnecting…',
};
const STATUS_DOT: Record<WorkerStatus, string> = {
  starting: 'amber',
  active: 'green',
  thinking: 'amber-pulse',
  failed: 'red',
  background: 'violet-pulse',
  sleeping: 'gray',
  killed: 'gray',
  error: 'red',
  reconnecting: 'amber-pulse',
};

// SessionState/emptyState removed in the refactor: per-session state now
// lives in `useClaudeSessionStream` (consumed by `<ClaudeSessionView>`).

const emptyEdits: Map<string, EditSnapshot> = new Map();

export default function ClaudePanel({ vpsList: initialVpsList, vpsFolders: initialFolders, vpsPaths: initialPaths, initialSessions, builtPyzSha, builtAgentVersion, sdkLatestVersion, codexLatestVersion, initialTabs }: Props) {
  // The workspace is part of the SSR snapshot. Hydrating it synchronously
  // prevents the initial session from mounting, being cleared by an empty tab
  // store, then mounting again after GET /api/tabs.
  hydrateTabs(initialTabs);
  const { tabs: workspaceTabs, dirty: dirtyIds, loaded: workspaceTabsLoaded } = useTabs();
  // Mutable copies — DataModal can add/delete VPSes, folders and paths without a reload.
  const [vpsList, setVpsList] = useState<Vps[]>(initialVpsList);
  const [vpsFolders, setVpsFolders] = useState<VpsFolder[]>(initialFolders);
  const [vpsPaths, setVpsPaths] = useState<VpsPath[]>(initialPaths);
  // LIVE staleness baselines. The SSR props freeze at page load; a tab that
  // survives a hub deploy would forever compare vps.agentPyzSha against the
  // OLD builtPyzSha → phantom "update agent" badge on the whole fleet until
  // F5 (and "update" would never clear it: the server deploys the NEW sha,
  // which still ≠ the stale prop). Refreshed from the session-list poll's
  // `meta` (15s + on session_list_changed). The ref mirrors the state for
  // use inside stable-closure event handlers.
  const [buildMeta, setBuildMeta] = useState({
    builtPyzSha: builtPyzSha ?? null,
    builtAgentVersion: builtAgentVersion ?? null,
    sdkLatestVersion: sdkLatestVersion ?? null,
    codexLatestVersion: codexLatestVersion ?? null,
  });
  const buildMetaRef = useRef(buildMeta);
  useEffect(() => { buildMetaRef.current = buildMeta; }, [buildMeta]);
  const searchParams = useSearchParams();
  const queryParamSession = searchParams?.get('session') ?? null;
  // `?shell=` deep-link (shell-idle push/telegram notification, parity with
  // `?session=`). When present it takes precedence over the session default so
  // a notification tap lands on the shell, not the first chat.
  const queryParamShell = searchParams?.get('shell') ?? null;
  const [sessions, setSessions] = useState<SessionListItem[]>(initialSessions as SessionListItem[]);

  // Addressable handles, one per session, unique WITHIN a VPS (§ sessionHandle).
  // A session's `name` is free-form and may be null or duplicated; the handle
  // is the form you can type after an `@` and hand to another agent as "who to
  // talk to". Derived here rather than server-side so every surface that shows
  // it — chat header, sidebar details, the @ menu — agrees by construction.
  // ⚠ The @ must be what CLAUDE answers to, not what we wish it answered to.
  //
  // `cliName` is the addressable identity read from the CLI itself (`claude
  // agents`), set by --name at session START. The derived handle is only a
  // PREDICTION of it: correct for anything started since agent 0.42.0, wrong
  // for a session started before, and stale for one renamed since (--name is
  // fixed at startup, so a rename lands at the next resume).
  //
  // So the real name wins whenever it is known, and the prediction is marked
  // unconfirmed rather than presented as an address — showing @migration for a
  // session every tool on the box calls eleven-duel-dev-87 is exactly the bug
  // this replaces.
  const sessionHandles = useMemo(() => {
    const predicted = assignHandlesByVps(sessions.map((s) => ({
      id: s.id, name: s.name, cwd: s.cwd, vpsId: s.vpsId, createdAt: s.createdAt,
    })));
    const out = new Map<string, { handle: string; confirmed: boolean }>();
    for (const s of sessions) {
      const real = (s as { cliName?: string | null }).cliName;
      out.set(s.id, real
        ? { handle: real, confirmed: true }
        : { handle: predicted.get(s.id) ?? s.id.slice(0, 6), confirmed: false });
    }
    return out;
  }, [sessions]);
  const initialActiveTab = initialTabs.find((t) => t.active) ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(queryParamShell
    ? null
    : (queryParamSession ?? (initialActiveTab?.kind === 'session' ? initialActiveTab.ref : null)));

  // If the ?session= param changes (notification click or navigation), switch

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
  // "Delete permanently" confirmation — styled modal instead of the native
  // confirm(). Holds the target session while the dialog is open.
  const [confirmDelete, setConfirmDelete] = useState<SessionListItem | null>(null);
  // "You are about to discard an unsaved buffer" — the ONLY close that asks.
  // `run` is the close that was requested (one tab, a folder, a machine), held
  // until the answer comes back so the dialog can't do a different thing than
  // the ✕ that opened it.
  const [closeAsk, setCloseAsk] = useState<
    { what: string; count: number; dirty: ResolvedTab[]; run: () => Promise<void> } | null
  >(null);
  // Interactive claude login console
  const [loginVps, setLoginVps] = useState<Vps | null>(null);

  // Codex device-code login modal (§14.61) — the Codex sibling of loginVps.
  // On confirmed success the server has already persisted codexLoggedIn=1 +
  // broadcast vps_status; patch locally too so THIS tab flips instantly.
  const [codexLoginVps, setCodexLoginVps] = useState<Vps | null>(null);
  const closeCodexLogin = useCallback((loggedIn: boolean) => {
    const v = codexLoginVps;
    setCodexLoginVps(null);
    if (!v || !loggedIn) return;
    setVpsList((prev) => prev.map((vp) => vp.id === v.id
      ? ({ ...vp, codexLoggedIn: 1, codexLoggedInCheckedAt: Math.floor(Date.now() / 1000) } as Vps)
      : vp));
  }, [codexLoginVps]);

  // Closing the Claude login modal (§14.64). On a CONFIRMED success we patch
  // locally right away — the server already persisted the flag and broadcast
  // `vps_status`, so other tabs follow on their own (mirrors closeCodexLogin).
  // Otherwise we re-check: the user may have signed in (or out) by another
  // route, and the result self-heals the sidebar button + health chips.
  const closeLoginConsole = useCallback((loggedIn: boolean) => {
    const v = loginVps;
    setLoginVps(null);
    if (!v) return;
    if (loggedIn) {
      setVpsList((prev) => prev.map((vp) => vp.id === v.id
        ? ({ ...vp, claudeLoggedIn: 1, claudeLoggedInCheckedAt: Math.floor(Date.now() / 1000) } as Vps)
        : vp));
      return;
    }
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
  // Right "usage & settings" drawer (mobile only, CSS-gated ≤820px): holds the
  // account-usage panel + the header action buttons. Left drawer = sessions.
  const [usageOpen, setUsageOpen] = useState(false);
  const closeDrawers = useCallback(() => { setNavOpen(false); setToolsOpen(false); setUsageOpen(false); }, []);
  // Account-usage gauges per VPS AND per provider (the `/usage` widget). A VPS
  // can run BOTH Claude and Codex, each with its own account/quota — the header
  // shows the one matching the CURRENT session's kind. Fed by the LOW_VOLUME
  // `account_usage` SSE event (carries `provider`) + hydrated on session-select
  // via GET /api/vps/[id]/usage ({ usage, codexUsage }). §14.58 / §14.59.
  const [usageByVps, setUsageByVps] = useState<Record<string, { claude?: AccountUsage; codex?: AccountUsage }>>({});
  const refreshUsage = useCallback((vpsId: string | null | undefined) => {
    if (!vpsId) return;
    api.getVpsUsage(vpsId)
      .then((r) => setUsageByVps((prev) => {
        const cur = prev[vpsId] ?? {};
        const next = { ...cur };
        if (r.usage) next.claude = r.usage as AccountUsage;
        if (r.codexUsage) next.codex = r.codexUsage as AccountUsage;
        return { ...prev, [vpsId]: next };
      }))
      .catch(() => {});
  }, []);
  // Usage snapshot for a VPS + session kind (defaults to the Claude account).
  const usageFor = useCallback(
    (vpsId: string | null | undefined, kind: AgentKind | null | undefined): AccountUsage | null => {
      if (!vpsId) return null;
      const e = usageByVps[vpsId];
      if (!e) return null;
      return (kind === 'codex' ? e.codex : e.claude) ?? null;
    },
    [usageByVps],
  );

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
                  // Live buildMeta (via ref — stable closure); null tolerable
                  // (fallback at the next AgentClient hello). The VERSION is
                  // what clears the "update" badge now (§14.6) — patching only
                  // the sha would leave it lit until the next hello.
                  agentPyzSha: buildMetaRef.current.builtPyzSha ?? v.agentPyzSha,
                  agentVersion: buildMetaRef.current.builtAgentVersion ?? v.agentVersion,
                } as Vps)
              : v,
          ));
        }
      }
    });
    return () => unsub();
  }, []);

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
          // codex fields: same "key present ⇔ known" no-clobber contract.
          const codexAvailable = (ev as any).codexAvailable !== undefined ? (ev as any).codexAvailable : (v as any).codexAvailable;
          const codexSdkVersion = (ev as any).codexSdkVersion !== undefined ? (ev as any).codexSdkVersion : (v as any).codexSdkVersion;
          // agentLastError: classified failure reason (ssh vs daemon) — feeds
          // the health chips (vpsHealth.tsx). Explicit null on 'ok' clears it.
          const agentLastError = (ev as any).agentLastError !== undefined ? (ev as any).agentLastError : (v as any).agentLastError;
          // Login flags, same no-clobber contract. Broadcast by the codex
          // (§14.61) and claude (§14.64) device-code logins on success — this
          // is what flips the chips/buttons in the OTHER tabs and devices
          // (the originating tab also patches locally on modal close).
          const codexLoggedIn = (ev as any).codexLoggedIn !== undefined ? (ev as any).codexLoggedIn : (v as any).codexLoggedIn;
          const claudeLoggedIn = (ev as any).claudeLoggedIn !== undefined ? (ev as any).claudeLoggedIn : (v as any).claudeLoggedIn;
          if (v.agentStatus === ev.agentStatus && v.agentVersion === agentVersion && v.agentPyzSha === agentPyzSha && v.sdkVersion === sdkVersion
              && (v as any).codexAvailable === codexAvailable && (v as any).codexSdkVersion === codexSdkVersion
              && (v as any).agentLastError === agentLastError
              && (v as any).codexLoggedIn === codexLoggedIn && (v as any).claudeLoggedIn === claudeLoggedIn) {
            return v;
          }
          changed = true;
          return { ...v, agentStatus: ev.agentStatus, agentVersion, agentPyzSha, sdkVersion, codexAvailable, codexSdkVersion, agentLastError, codexLoggedIn, claudeLoggedIn } as Vps;
        });
        return changed ? next : prev;
      });
    });
    return () => unsub();
  }, []);

  // Live account-usage gauges (§14.58). The hub polls get_usage once per
  // ACCOUNT (§14.72 — the endpoint is throttled per source IP) and fans one
  // `account_usage` event per VPS on that account (LOW_VOLUME → every tab;
  // sessionId = vpsId). Keep the latest snapshot per VPS so the header widget
  // follows the current session's account live, across tabs/devices, no F5.
  useEffect(() => {
    const unsub = subscribeAll((ev) => {
      if (ev.type !== 'account_usage') return;
      const vpsId = ev.sessionId;
      if (!vpsId) return;
      // ev is the account_usage variant = AccountUsage + {type, sessionId}; the
      // extra two keys are harmless (UsageMeter only reads AccountUsage fields).
      // Store under the event's provider (Claude default) so a VPS running both
      // backends keeps both gauges live.
      const provider = (ev as AccountUsage).provider === 'codex' ? 'codex' : 'claude';
      setUsageByVps((prev) => ({
        ...prev,
        [vpsId]: { ...(prev[vpsId] ?? {}), [provider]: ev as AccountUsage },
      }));
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
      // A session visible in this tab is read by definition. A stale server
      // focus (typically during SSE reconnect) may briefly classify its stop
      // as background; acknowledge it immediately and never paint a false
      // green marker locally.
      const visibleHere = id === selectedId;
      const next = ev.unread && !visibleHere ? 1 : 0;
      if (ev.unread && visibleHere) void setFocus(id);
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
  }, [selectedId]);

  // Opening a session marks it read locally the instant you select it. The
  // authoritative cross-device clear is server-side (POST /focus →
  // markSessionRead). Re-POST here as well as in useClaudeSessionStream so the
  // acknowledgement does not depend on that view mounting, and so selecting
  // an already-active session heals a prior SSE-registration race. Keyed on
  // selectedId so it covers EVERY open path (sidebar, tab bar, deep link,
  // push-notification click).
  useEffect(() => {
    if (!selectedId) return;
    void setFocus(selectedId);
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
    // Something the user just created is not a preview.
    openEntityTab('shell', sh.id, sh.vpsId, sh.cwd ?? '', true);
  }
  /**
   * Same for a session — and it takes the created row rather than an id on
   * purpose: `sessions` has not been refreshed yet, so a lookup by id here
   * finds nothing and the session the user just created opens nowhere.
   */
  function applyCreatedSession(c: { id: string; vpsId: string; cwd: string }) {
    openEntityTab('session', c.id, c.vpsId, c.cwd, true);
    // …and put the caret in its message box: creating a session is an intent to
    // talk, and the wizard already had the keyboard. Parked, because the input
    // bar mounts a beat later with the pane (app/focusChat.ts).
    requestChatFocus(c.id);
    refreshSessions();
    closeDrawers();
  }
  /**
   * Open a session by id from somewhere that isn't the sidebar (a
   * notification, the search modal, the resume list). Pass `hint` whenever the
   * caller already knows the folder — a bare id can only be resolved against
   * `sessions`, and every one of these paths can run before that list has
   * caught up. Without a tab the main pane would show a session the bar
   * doesn't list, and the next tab switch would silently drop it.
   */
  function openSessionById(id: string, pin: boolean, hint?: { vpsId: string; cwd: string }) {
    const s = hint ?? sessions.find((x) => x.id === id);
    if (s) openEntityTab('session', id, s.vpsId, (s as any).cwd ?? '', pin);
    else setSelectedId(id);
  }
  /**
   * Sidebar → open as a PREVIEW (single click) or pinned (double click).
   * §14.78: a click is browsing, and browsing must not accumulate tabs.
   */
  function selectShell(id: string, pin = false) {
    const sh = shells.find((x) => x.id === id);
    if (sh) openEntityTab('shell', id, sh.vpsId, sh.cwd ?? '', pin);
    closeDrawers();  // mobile: picking from the sidebar drawer closes it
  }
  function shellKilled(id: string) {
    setShells((prev) => prev.filter((s) => s.id !== id));
    if (selectedShellId === id) setSelectedShellId(null);
  }
  // When we select a Claude session, we deselect shell + install
  function selectClaude(id: string, pin = false) {
    const sess = sessions.find((x) => x.id === id);
    if (sess) openEntityTab('session', id, sess.vpsId, sess.cwd ?? '', pin);
    closeDrawers();  // mobile: picking from the sidebar drawer closes it
  }
  function selectInstall(id: string) {
    const inst = installs.find((x) => x.id === id);
    // Installs have no folder — they get the VPS's pathless group, and they
    // are pinned because they are short-lived and you always want to watch
    // one to the end.
    if (inst) openEntityTab('install', id, inst.vpsId, '', true);
    closeDrawers();
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
  // `mountedShellIds` is the set of shell ids whose <ShellTerminal> stays
  // MOUNTED (its WebSocket + xterm alive) even while another entity is
  // selected — so switching sessions and coming back keeps the live shell
  // and its scrollback instead of tearing down + reconnecting (which is
  // what made shells feel "non-persistent"). See §14 gotcha 37.
  //
  // Lazy on purpose: a shell mounts only once it has been SELECTED at least
  // once this page-load (not on F5 for every shell in the sidebar) — that
  // caps the number of live ssh+agent connections to shells the user
  // actually opened. Keep only the three most-recent terminals: detached
  // holders preserve every bash/scrollback remotely, so an older terminal
  // can reconnect on demand without leaking one browser WebSocket per shell.
  const [mountedShellIds, setMountedShellIds] = useState<Set<string>>(new Set());

  // Mount a shell terminal the first time it's selected, then keep it
  // mounted (see `mountedShellIds` above).
  useEffect(() => {
    if (!selectedShellId) return;
    setMountedShellIds((prev) => {
      const next = new Set(prev);
      // Delete+add touches insertion order, which is our tiny LRU.
      next.delete(selectedShellId);
      next.add(selectedShellId);
      while (next.size > 3) {
        const oldest = next.values().next().value as string | undefined;
        if (!oldest) break;
        next.delete(oldest);
      }
      if (next.size === prev.size && [...next].every((id, i) => [...prev][i] === id)) return prev;
      return next;
    });
  }, [selectedShellId]);

  // GC mounted shells: drop any whose shell row no longer exists or whose
  // persisted workspace tab was closed. Dropping unmounts the terminal and
  // closes its WebSocket; the detached remote holder remains alive.
  // and the ssh+agent client is freed. The agent's bash + durable log live
  // on, so reopening the shell replays the full scrollback.
  useEffect(() => {
    setMountedShellIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      const openShellIds = new Set(workspaceTabs.filter((t) => t.kind === 'shell').map((t) => t.ref));
      for (const id of prev) {
        const keep = shells.some((s) => s.id === id) && openShellIds.has(id);
        if (keep) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [shells, workspaceTabs]);

  // Unified "new session" wizard (VPS → path → name). `kind` is fixed by the
  // button that opened it (＋Agent vs ＋Shell). Replaces the old
  // NewSessionDialog / NewShellDialog.
  const [wizard, setWizard] = useState<null | { kind: 'agent' | 'shell'; vpsId?: string; cwd?: string | null; agentKind?: AgentKind }>(null);
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
              // Classified verdict (ssh vs daemon) for the health chips —
              // the route always sends it (null on ok = cleared).
              ...(r.agentLastError !== undefined ? { agentLastError: r.agentLastError } : {}),
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
              // Codex too, or a VPS stale ONLY on the codex axis keeps the
              // badge its own update just cleared (the sidebar ORs the three).
              codexSdkVersion: (r as any)?.codexSdkVersion ?? (v as any).codexSdkVersion,
              agentStatus: 'ok',
            } as Vps)
          : v
      ));
      // PARTIAL success (pyz deployed, a pip sub-step failed): say WHY the
      // "update" badge is about to relight instead of silently reverting.
      if (r?.warnings?.length) {
        setError({ msg: `update ${vps.name}: partial — ${r.warnings.join(' · ')}` });
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // A client/proxy timeout does NOT mean the update failed: pip can take
      // minutes and the flow finishes server-side (the badge then clears
      // itself via the next hello). Don't cry wolf for that case.
      if (/timeout|timed out|abort/i.test(msg)) {
        setError({ msg: `update ${vps.name}: still running server-side (client timed out) — the badge will clear by itself if it succeeds; retry otherwise` });
      } else {
        setError({ msg: `update ${vps.name}: ${msg}` });
      }
    } finally {
      setUpdatingAgentVpsIds((prev) => {
        const n = new Set(prev);
        n.delete(vps.id);
        return n;
      });
    }
  }

  // One dispatcher for the health-chip / wizard-row repair buttons
  // (app/vpsHealth.tsx). install + claude-login switch view → close the
  // wizard first; refresh/update run in place (the wizard rows / modal chips
  // repaint live via vpsList + the busy sets). Plain function (not
  // useCallback): it must close over the CURRENT runRefresh/runUpdate guards.
  function handleVpsFix(v: Vps, action: 'install' | 'refresh' | 'update' | 'claude-login' | 'codex-login') {
    if (action === 'install') { setWizard(null); openInstallSession(v); }
    else if (action === 'claude-login') { setWizard(null); setLoginVps(v); }
    // codex-login overlays whatever is open (wizard included — after the
    // sign-in the row's Codex button re-enables live and the user launches).
    else if (action === 'codex-login') { setCodexLoginVps(v); }
    else if (action === 'refresh') { runRefreshAgent(v); }
    else if (action === 'update') { runUpdateAgent(v); }
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

  // Handed down to <Message>: an assistant bubble that IS the "OAuth token
  // expired" message gets a "Sign in to Claude" button, so the fix is one
  // click from the error (§14.65). Stable across renders except when the VPS
  // itself changes — <Message> is memoized and must not get a fresh identity
  // on every parent render (§14.38).
  const reauthSelectedVps = useCallback(() => {
    if (selectedVps) setLoginVps(selectedVps);
  }, [selectedVps]);

  // Hydrate the current VPS's usage on select (SSE is live-only, §14.14): a
  // freshly-mounted tab has no snapshot until the next 60s poll — fetch once so
  // the header widget shows real numbers immediately. (Declared after
  // selectedVps to stay out of its temporal dead zone.)
  useEffect(() => {
    refreshUsage(selectedVps?.id);
  }, [selectedVps?.id, refreshUsage]);

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
  // change to sessions/shells/installs/pendings — cheap, ~O(n).
  // `ShellListItem` is structurally identical to `ShellInfo` (same fields).
  // ── Workspace tabs (§14.78) ───────────────────────────────────────────────
  // The bar is no longer derived from "every non-sleeping session": it is a
  // persisted, shared list. This resolves those rows against the live entity
  // lists once, and both the strip and the main pane read the same answer.
  const resolvedTabs = useMemo(() => resolveTabs({
    tabs: workspaceTabs, sessions, shells, installs,
    permQueue, questionQueue, exitPlanQueue, dirtyIds,
  }), [workspaceTabs, sessions, shells, installs, permQueue, questionQueue, exitPlanQueue, dirtyIds]);

  const activeTab = useMemo(() => resolvedTabs.find((t) => t.active) ?? null, [resolvedTabs]);
  // Row 1 / row 2 follow the active tab, but stay independently steerable so
  // clicking a VPS or a folder can browse without changing what's open.
  const [browseVpsId, setBrowseVpsId] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const activeVpsId = browseVpsId ?? activeTab?.vpsId ?? resolvedTabs[0]?.vpsId ?? null;
  const activePath = browsePath ?? (activeTab && activeTab.vpsId === activeVpsId
    ? activeTab.path
    : resolvedTabs.find((t) => t.vpsId === activeVpsId)?.path ?? null);

  // THE bridge: the active tab drives the main pane. Everything else in this
  // component still speaks in selectedId / selectedShellId / selectedInstallId,
  // so this is the single place that translates.
  const [selectedFile, setSelectedFile] = useState<ResolvedTab | null>(null);
  useEffect(() => {
    if (!workspaceTabsLoaded) return;
    if (!activeTab) {
      setSelectedId(null); setSelectedShellId(null); setSelectedInstallId(null); setSelectedFile(null);
      return;
    }
    setSelectedFile(activeTab.kind === 'file' ? activeTab : null);
    setSelectedId(activeTab.kind === 'session' ? activeTab.ref : null);
    setSelectedShellId(activeTab.kind === 'shell' ? activeTab.ref : null);
    setSelectedInstallId(activeTab.kind === 'install' ? activeTab.ref : null);
  }, [activeTab, workspaceTabsLoaded]);

  /** Open (or focus) something as a tab. Preview unless `pin`. */
  const openEntityTab = useCallback((
    kind: 'session' | 'shell' | 'install' | 'file',
    ref: string, vpsId: string, path: string, pin = false,
  ) => {
    setBrowseVpsId(null); setBrowsePath(null);
    void openWorkspaceTab({ vpsId, path, kind, ref, pin });
  }, []);

  // Handled-once guard. This component also WRITES `?session=` from the active
  // tab, so without it every selection bounced back through here — which is
  // what pinned a freshly-previewed session a beat after it opened — and every
  // 15s list poll re-ran it and stole focus back from whatever you had moved to.
  const handledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    // Moving to something that isn't a session DELETES the param (see the sync
    // effect above). Forget what we handled, so tapping the same notification
    // again later is an arrival rather than a swallowed no-op.
    if (!queryParamSession) { handledDeepLink.current = null; return; }
    if (handledDeepLink.current === queryParamSession) return;
    // Our own URL sync, not an arrival: the tab is already the active one.
    if (activeTab?.kind === 'session' && activeTab.ref === queryParamSession) {
      handledDeepLink.current = queryParamSession;
      return;
    }
    handledDeepLink.current = queryParamSession;
    // A notification tap must land on a real TAB, not on a pane the bar
    // doesn't show — but as a PREVIEW. Pinning is reserved for having actually
    // worked in a tab (a message, an edit, a double-click); arriving and
    // reading is not that.
    const sess = sessions.find((x) => x.id === queryParamSession);
    if (sess) openEntityTab('session', sess.id, sess.vpsId, sess.cwd ?? '', false);
    else setSelectedId(queryParamSession);
  }, [queryParamSession, sessions, activeTab, openEntityTab]);

  /**
   * Where you were, per group. Browser-side (not the DB): "the tab I was last
   * looking at in this folder" is a per-screen notion, and syncing it would
   * make two devices fight over each other's place. Survives a reload.
   */
  const lastTabByGroup = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    try {
      const raw = localStorage.getItem('hub.tabs.lastByGroup.v1');
      if (raw) lastTabByGroup.current = new Map(JSON.parse(raw) as [string, string][]);
    } catch { /* corrupt or unavailable — start empty */ }
  }, []);
  useEffect(() => {
    if (!activeTab) return;
    lastTabByGroup.current.set(`${activeTab.vpsId}\u0000${activeTab.path}`, activeTab.id);
    lastTabByGroup.current.set(activeTab.vpsId, activeTab.id);
    try {
      localStorage.setItem('hub.tabs.lastByGroup.v1',
        JSON.stringify([...lastTabByGroup.current.entries()].slice(-200)));
    } catch { /* quota / private mode — the memory just doesn't persist */ }
  }, [activeTab]);

  /** Focus the tab you were last on in this group, else its first tab. */
  const focusGroup = useCallback((key: string, candidates: ResolvedTab[]) => {
    if (candidates.length === 0) return;
    const remembered = lastTabByGroup.current.get(key);
    const target = candidates.find((t) => t.id === remembered) ?? candidates[0];
    setBrowseVpsId(null); setBrowsePath(null);
    void activateWorkspaceTab(target.id);
  }, []);

  // Row 1 / row 2: clicking a group SELECTS something in it. Browsing without
  // selecting left the main pane showing a tab from a folder you were no
  // longer looking at, which reads as the click having done nothing.
  function onVpsRowClick(vpsId: string) {
    setBrowseVpsId(vpsId);
    setBrowsePath(null);
    focusGroup(vpsId, resolvedTabs.filter((t) => t.vpsId === vpsId));
  }
  function onPathRowClick(vpsId: string, path: string) {
    setBrowseVpsId(vpsId);
    setBrowsePath(path);
    focusGroup(`${vpsId}\u0000${path}`, resolvedTabs.filter((t) => t.vpsId === vpsId && t.path === path));
  }

  /** Row 3: single click focuses, double click pins. */
  function onTabClick(t: ResolvedTab) {
    setBrowseVpsId(null); setBrowsePath(null);
    void activateWorkspaceTab(t.id);
  }
  function onTabDoubleClick(t: ResolvedTab) {
    setBrowseVpsId(null); setBrowsePath(null);
    void pinWorkspaceTab(t.id);
  }
  /**
   * Closing is a VIEW operation at all three scales: one tab, a whole folder
   * (row 2) or a whole machine (row 1). Sessions and shells keep running and
   * stay in the sidebar — the only thing that can actually be LOST is an
   * unsaved editor buffer, which lives in this browser and nowhere else, so
   * that is the one case that asks first (`<ConfirmModal>`, §14.80).
   */
  function closeTabsOrAsk(what: string, targets: ResolvedTab[], run: () => Promise<void>) {
    if (targets.length === 0) return;
    const dirty = targets.filter((t) => t.dirty);
    if (dirty.length === 0) { void run(); return; }
    setCloseAsk({ what, count: targets.length, dirty, run });
  }
  function onTabCloseClick(t: ResolvedTab) {
    closeTabsOrAsk(t.label, [t], () => closeWorkspaceTab(t.id));
  }
  // Both group closes drop the browse override when it pointed at what was
  // just closed — the server picks the next active tab, and an override left
  // behind would hold the strip on a machine or folder with nothing in it.
  // `wasBrowsing` is read when the ✕ is pressed, which is the truth: the
  // dialog is modal, so nothing can move the selection while it is open.
  function onPathRowClose(vpsId: string, path: string, tabs: ResolvedTab[]) {
    const name = path ? (path.split('/').filter(Boolean).pop() || path) : 'no folder';
    const wasBrowsing = browseVpsId === vpsId && browsePath === path;
    closeTabsOrAsk(name, tabs, async () => {
      await closeWorkspaceTabsWhere({ vpsId, path });
      if (wasBrowsing) setBrowsePath(null);
    });
  }
  function onVpsRowClose(vpsId: string, tabs: ResolvedTab[]) {
    const name = vpsList.find((v) => v.id === vpsId)?.name ?? 'this machine';
    const wasBrowsing = browseVpsId === vpsId;
    closeTabsOrAsk(name, tabs, async () => {
      await closeWorkspaceTabsWhere({ vpsId });
      if (wasBrowsing) { setBrowseVpsId(null); setBrowsePath(null); }
    });
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
    // The folder currently being browsed wins — that is what the user is
    // looking at when they press "+".
    if (browseVpsId === vpsId && browsePath) return browsePath;
    const here = resolvedTabs.filter((t) => t.vpsId === vpsId && t.path);
    if (here.length) return (here.find((t) => t.active) ?? here[here.length - 1]).path;
    const vps = vpsList.find((v) => v.id === vpsId);
    return vps?.defaultPath ?? undefined;
  }

  /** "+ Claude" / "+ Codex" buttons on the right of row 3 — open the wizard
   *  pre-filled with the active VPS and the same cwd as the last tab. The
   *  backend is FIXED by the button that was pressed, so the wizard skips
   *  straight to path/name. */
  function onTabBarNewSession(vpsId: string, path?: string, agentKind: AgentKind = 'claude') {
    const cwd = path || defaultCwdFor(vpsId);
    setWizard({ kind: 'agent', vpsId, cwd, agentKind });
  }
  /** "+ shell" button on the right of row 2 — open the NewShellDialog
   *  pre-filled with the active VPS and the same cwd as the last tab
   *  (mirrors the "+ Claude" flow). */
  function onTabBarNewShell(vpsId: string, path?: string) {
    const cwd = path || defaultCwdFor(vpsId) || null;
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
  function onTabContext(e: React.MouseEvent, t: ResolvedTab) {
    e.preventDefault();
    const x = e.clientX; const y = e.clientY;
    if (t.kind === 'session') {
      const sess = sessions.find((z) => z.id === t.ref);
      if (sess) setCtxMenu({ kind: 'session', session: sess, x, y });
    } else if (t.kind === 'shell') {
      const sh = shells.find((z) => z.id === t.ref);
      if (sh) setCtxMenu({ kind: 'shell', shell: sh, x, y });
    } else if (t.kind === 'install') {
      const inst = installs.find((z) => z.id === t.ref);
      if (inst) setCtxMenu({ kind: 'install', install: inst, x, y });
    }
    // A file tab has no entity menu — closing is the ✕, pinning is a
    // double-click, and everything else about a file lives in the tree.
  }

  /** Reason to disable each of the tab bar's "+ agent" buttons. The shell
   *  button stays enabled — SSH doesn't need the agent. Uses the SHARED
   *  diagnosis (app/vpsHealth.tsx § backendAvailability), so a backend the
   *  sidebar greys out is greyed out here too, with the same wording. */
  const tabBarNewSessionReasons = useMemo((): Record<AgentKind, string | null> => {
    const vps = activeVpsId ? vpsList.find((v) => v.id === activeVpsId) : null;
    if (!vps) return { claude: null, codex: null };
    const reason = (k: AgentKind) => {
      const av = backendAvailability(vps, k);
      return av.ok ? null : av.reason;
    };
    return { claude: reason('claude'), codex: reason('codex') };
  }, [vpsList, activeVpsId]);

  // ── Sessions list (slow convergence poll; SSE is the fast path) ──
  // Before: 4s. But each tick did `setSessions(...)` (same content) which
  // re-rendered the Sidebar + main panel → CPU + flicker. Intra-session
  // status changes already arrive via the per-session SSE; the poll only
  // serves to refresh the count badges + detect sessions created on
  // another client. 15s is amply sufficient.
  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.listClaudeSessions();
      const next = r.sessions as SessionListItem[];
      setSessions((prev) => sameSessionRows(prev, next) ? prev : next);
      // Refresh the staleness baselines (builtPyzSha / PyPI latests) so a
      // long-open tab converges within one poll after a hub deploy — no more
      // phantom "update agent" badges that only F5 could clear.
      const m = r.meta;
      if (m) {
        setBuildMeta((prev) =>
          prev.builtPyzSha === m.builtPyzSha
            && prev.builtAgentVersion === (m.builtAgentVersion ?? null)
            && prev.sdkLatestVersion === m.sdkLatestVersion
            && prev.codexLatestVersion === m.codexLatestVersion
            ? prev
            : {
                builtPyzSha: m.builtPyzSha,
                builtAgentVersion: m.builtAgentVersion ?? null,
                sdkLatestVersion: m.sdkLatestVersion,
                codexLatestVersion: m.codexLatestVersion,
              });
      }
    } catch {}
  }, []);

  // Live per-session STATUS mirror (cross-device dots). `status` events are
  // LOW_VOLUME (every tab gets them, §14.16) but only the focused session's
  // view consumed them — a session going thinking/sleeping on ANOTHER device
  // only updated this sidebar at the next 15s poll. Patch the list row
  // immediately; the poll remains the convergence backstop (replays or missed
  // events can't wedge anything). 'killed' is a deletion signal — handled by
  // session_list_changed → refreshSessions, skip it here.
  useEffect(() => {
    const unsub = subscribeAll((ev) => {
      if (ev.type !== 'status') return;
      const sid = ev.sessionId;
      const st = (ev as any).status as string | undefined;
      if (!sid || !st || st === 'killed') return;
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          if (s.id !== sid) return s;
          if ((s.liveStatus ?? s.status) === st) return s;
          changed = true;
          return { ...s, liveStatus: st as SessionListItem['liveStatus'] };
        });
        return changed ? next : prev;
      });
    });
    return () => unsub();
  }, []);
  useEffect(() => {
    refreshSessions();
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') refreshSessions();
    };
    const t = setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSessions(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
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
      if (ev.type === 'tabs_changed') { void refreshTabs(); return; }
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
            openSessionById(s.id, false, { vpsId: s.vpsId, cwd: s.cwd ?? '' });
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
        openSessionById(sid, false);
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
  // have confirmed — the context menu goes through `<ConfirmModal>`
  // (`confirmDelete` state), no native confirm() here. No more soft-kill
  // (`status='killed'` which kept the row in DB for post-mortem inspection)
  // — the rework merged kill→delete (cf. CLAUDE.md §10). To pause the
  // session without losing it, use `doSleep` (reversible) in
  // `<ClaudeSessionView>`.
  async function deleteSessionOne(id: string) {
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
      // Kill failed (agent unreachable). Offer "forget": drop the Charon row
      // anyway — the detached holder may keep running on the VPS (P0.6).
      const msg = String(e?.message ?? e);
      if (window.confirm(`kill failed (${msg}).\nForget this shell anyway? The remote bash may keep running on the VPS.`)) {
        try {
          await api.killShell(id, true);
          shellKilled(id);
        } catch (e2: any) {
          setError({ msg: 'forget shell: ' + (e2?.message ?? e2) });
        }
      } else {
        setError({ msg: 'kill shell: ' + msg });
      }
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
    <div className={`claude-root${selectedShellId && !selectedFile ? '' : ' has-tools'}${navOpen ? ' nav-open' : ''}${toolsOpen ? ' tools-open' : ''}${usageOpen ? ' usage-open' : ''}`}>
      {/* Backdrop behind any open drawer (mobile only; CSS-gated). Tap to close. */}
      <div className="drawer-backdrop" onClick={closeDrawers} aria-hidden />
      <header className="claude-head">
        {/* ☰ opens the sidebar drawer; CSS reveals it only ≤820px (.m-only). */}
        <button
          className="head-btn m-only nav-toggle"
          onClick={() => { setNavOpen(true); setToolsOpen(false); setUsageOpen(false); }}
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
          {/* Mobile only (CSS ≤820px): head-right becomes the right "usage &
              settings" drawer. The account-usage panel sits at its top; the
              toggle buttons that open it live OUTSIDE head-right (below) so they
              stay visible. Hidden on desktop — the buttons flow inline as
              before. cf. CLAUDE.md §14.58. */}
          <div className="head-usage-panel">
            <UsageMeter
              usage={usageFor(selectedVps?.id, selected?.kind as AgentKind | undefined)}
              vpsName={selectedVps?.name}
              compact={false}
              onRefresh={() => refreshUsage(selectedVps?.id)}
            />
          </div>
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
              <span className="dot" /> {selected?.kind === 'codex' ? 'codex' : 'claude'} is thinking
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
          <button className="head-btn" onClick={() => setSearchOpen(true)} title="search across all messages" aria-label="search" data-label="search">
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
            data-label={pushOn ? 'push notifications — on' : 'push notifications — off'}
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
            data-label={notifSoundEnabled ? 'notification sound — on' : 'notification sound — off'}
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
            data-label={!tgConfigured ? 'telegram — not set up' : tgEnabled ? 'telegram — on' : 'telegram — off'}
          >
            <IconTelegram />
          </button>
          <button className="head-btn" onClick={() => setDataOpen(true)} title="VPS, projects, paths" aria-label="VPS data" data-label="vps, projects & paths">
            <IconServers />
          </button>
          <LocalAgentButton />
          <button className="head-btn" onClick={() => setSettingsOpen(true)} title="settings" aria-label="settings" data-label="settings">
            <IconGear />
          </button>
        </div>
        {/* Mobile-only right-drawer toggles (CSS-gated). They live OUTSIDE
            head-right because head-right itself becomes the drawer ≤820px. The
            tools-toggle (ToolPanel drawer, ≤1100px) moved here from inside
            head-right for the same reason. cf. CLAUDE.md §14.58 / §11. */}
        <div className="head-toggles">
        {selectedId && (
          <button
            className="head-btn m-only tools-toggle"
            onClick={() => { setToolsOpen(true); setNavOpen(false); setUsageOpen(false); }}
            title="diffs, tool calls & files" aria-label="open tool panel"
          >
            <IconPanelRight />
          </button>
        )}
        <button
          className="head-btn m-only usage-toggle"
          onClick={() => { setUsageOpen(true); setNavOpen(false); setToolsOpen(false); }}
          title="usage & settings" aria-label="open usage and settings"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
            <path d="M12 12l4-3" />
            <path d="M5 18a8 8 0 1 1 14 0" />
          </svg>
        </button>
        </div>
      </header>

      <Sidebar
        sessionHandles={sessionHandles}
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
        onReorderSessions={(vpsId, ids) => {
          // Optimistic: the row must land where it was dropped, not snap back
          // for the length of a request. The 15s list poll is the reconcile.
          setSessions((prev) => prev.map((s) => (
            s.vpsId === vpsId && ids.includes(s.id) ? { ...s, position: ids.indexOf(s.id) } : s)));
          void api.reorderSessions(vpsId, ids).catch(() => refreshSessions());
        }}
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
        onCodexLoginAgent={(v) => setCodexLoginVps(v)}
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
        builtAgentVersion={buildMeta.builtAgentVersion}
        sdkLatestVersion={buildMeta.sdkLatestVersion}
        codexLatestVersion={buildMeta.codexLatestVersion}
        updatingAgentVpsIds={updatingAgentVpsIds}
        refreshingAgentVpsIds={refreshingAgentVpsIds}
      />

      <TabBar
        resolved={resolvedTabs}
        vpsList={vpsList}
        vpsFolders={vpsFolders}
        activeVpsId={activeVpsId}
        activePath={activePath}
        activeTabId={activeTab?.id ?? null}
        onVpsClick={onVpsRowClick}
        onPathClick={onPathRowClick}
        onTabClick={onTabClick}
        onTabDoubleClick={onTabDoubleClick}
        onTabClose={onTabCloseClick}
        onVpsClose={onVpsRowClose}
        onPathClose={onPathRowClose}
        onTabContext={onTabContext}
        onNewSession={onTabBarNewSession}
        onNewShell={onTabBarNewShell}
        newSessionDisabledReason={tabBarNewSessionReasons}
        onReorderVps={(vpsIds) => void reorderWorkspaceTabs({ scope: 'vps', vpsIds })}
        onReorderPaths={(vpsId, paths) => void reorderWorkspaceTabs({ scope: 'groups', vpsId, paths })}
        onReorderTabs={(vpsId, path, ids) => void reorderWorkspaceTabs({ scope: 'tabs', vpsId, path, ids })}
      />

      {/* Main panel routing: 3 mutually exclusive views.
          - selectedInstallId → <InstallSessionView> (full-screen install log)
          - selectedShellId   → <ShellTerminal> (ephemeral SSH xterm)
          - selectedId        → <ClaudeSessionView> (chat + tool panel)
          - otherwise: placeholder. */}
      {selectedFile ? (
        <>
        <FileEditor
          key={`${selectedFile.vpsId}:${selectedFile.path}:${selectedFile.ref}`}
          tabId={selectedFile.id}
          vpsId={selectedFile.vpsId}
          root={selectedFile.path}
          path={selectedFile.ref}
          // Editing or saving is a real interaction: the tab stops being a
          // preview so the next file opened here can't evict unsaved work.
          onInteract={() => { if (!selectedFile.pinned) void pinWorkspaceTab(selectedFile.id); }}
          // Go-to-definition. The target is an ABSOLUTE path from the language
          // server; a tab is (group path, path relative to it), so anything
          // outside this group's folder cannot be opened as a tab here.
          onOpenLocation={(abs, line) => {
            const base = selectedFile.path.replace(/\/+$/, '');
            if (abs !== base && !abs.startsWith(base + '/')) return;
            const rel = abs.slice(base.length + 1);
            revealLine(selectedFile.vpsId, selectedFile.path, rel, line);
            void openWorkspaceTab({
              vpsId: selectedFile.vpsId, path: selectedFile.path, kind: 'file', ref: rel,
            });
          }}
        />
        {/* The explorer has to stay: opening a file from the tree and losing
            the tree in the same gesture is how you end up clicking back and
            forth. The session-scoped tabs (diffs / attach / tools) render
            their empty states — there is no session here. */}
        <ToolPanel
          sessionId={null}
          toolCalls={[]}
          edits={emptyEdits}
          onRevert={() => {}}
          vpsId={selectedFile.vpsId}
          cwd={selectedFile.path}
          onOpenSession={(id) => openSessionById(id, false)}
          onReveal={() => setToolsOpen(true)}
        />
        </>
      ) : selectedInstallId ? (() => {
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
                      agentPyzSha: buildMetaRef.current.builtPyzSha ?? v.agentPyzSha,
                      agentVersion: buildMetaRef.current.builtAgentVersion ?? v.agentVersion,
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
          handle={sessionHandles.get(selected.id)?.handle ?? null}
          handleConfirmed={sessionHandles.get(selected.id)?.confirmed ?? false}
          // Other sessions on the SAME machine — the ones this session can
          // actually address (cross-session messaging is filesystem-scoped).
          siblings={sessions
            .filter((s) => s.vpsId === selected.vpsId && s.id !== selected.id)
            .map((s) => ({
              id: s.id, name: s.name,
              handle: sessionHandles.get(s.id)?.handle ?? s.id.slice(0, 6),
              confirmed: sessionHandles.get(s.id)?.confirmed ?? false,
              status: (s.liveStatus ?? s.status) as string,
            }))}
          selectedVps={selectedVps}
          usage={usageFor(selectedVps?.id, selected.kind as AgentKind | undefined)}
          onUsageRefresh={() => refreshUsage(selectedVps?.id)}
          onReauth={reauthSelectedVps}
          // The git chip lives in the chat header but points at the ToolPanel,
          // which is a drawer <=1100px — it has to be able to reveal it.
          onOpenTools={() => setToolsOpen(true)}
          onOpenSession={(id) => openSessionById(id, false)}
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

      <PermissionPopup
        queue={permQueue}
        currentSessionId={selectedId}
        onRespond={respondPermissionCrossSession}
        onSwitchSession={(id) => openSessionById(id, false)}
      />

      <InstallNotificationPopup
        notifications={installNotifications}
        onOpen={(installId) => selectInstall(installId)}
        onDismiss={dismissInstallNotif}
      />

      {wizard && (
        <NewSessionWizard
          kind={wizard.kind}
          agentKind={wizard.agentKind}
          vpsList={vpsList}
          vpsFolders={vpsFolders}
          vpsPaths={vpsPaths}
          initialVpsId={wizard.vpsId}
          initialCwd={wizard.cwd}
          onClose={() => setWizard(null)}
          onCreatedSession={(c) => { setWizard(null); applyCreatedSession(c); }}
          onCreatedShell={(sh) => { setWizard(null); applyCreatedShell(sh); }}
          onFix={handleVpsFix}
          refreshingAgentVpsIds={refreshingAgentVpsIds}
          updatingAgentVpsIds={updatingAgentVpsIds}
        />
      )}

      {resumeOpen && (
        <ResumeModal
          vpsList={vpsList}
          dbSessions={sessions}
          initialVpsId={resumeOpen.vpsId}
          onClose={() => setResumeOpen(null)}
          onImported={(c) => { setResumeOpen(null); applyCreatedSession(c); }}
          onResumed={async (id) => {
            setResumeOpen(null);
            try { await api.resumeClaudeSession(id); }
            catch (e: any) { setError({ msg: String(e?.message ?? e) }); return; }
            openSessionById(id, true);
            refreshSessions();
          }}
        />
      )}

      {searchOpen && (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onPick={(id) => { setSearchOpen(false); openSessionById(id, false); }}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} vpsList={vpsList} />}
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
          onRefreshAgent={(v) => { runRefreshAgent(v); }}
          onUpdateAgent={(v) => { runUpdateAgent(v); }}
          onCodexLogin={(v) => setCodexLoginVps(v)}
          onClaudeLogin={(v) => setLoginVps(v)}
          refreshingAgentVpsIds={refreshingAgentVpsIds}
          updatingAgentVpsIds={updatingAgentVpsIds}
          liveVps={vpsList}
          builtAgentVersion={buildMeta.builtAgentVersion}
          sdkLatestVersion={buildMeta.sdkLatestVersion}
          codexLatestVersion={buildMeta.codexLatestVersion}
        />
      )}

      {/* Device-code logins (Codex §14.61, Claude §14.64) — rendered AFTER the
          wizard/data modal so they overlay whichever surface launched them.
          loginVps/codexLoginVps are cross-panel (sidebar, health chips,
          install view), hence a single global mount each. */}
      {codexLoginVps && (
        <CodexLoginModal vps={codexLoginVps} onClose={closeCodexLogin} />
      )}
      {loginVps && (
        <ClaudeLoginModal vps={loginVps} onClose={closeLoginConsole} />
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
          // makes sense (active/thinking/starting/failed). For sleeping/error/killed,
          // the item disappears from the menu (the "resume" button in the
          // chat header takes care of waking up the session; we don't duplicate here).
          onRename={() => setEditingId(ctxMenu.session.id)}
          onEditCwd={() => editSessionCwd(ctxMenu.session)}
          onColor={(color) => patchSession(ctxMenu.session.id, { color })}
          onSleep={
            ['active', 'thinking', 'starting', 'failed', 'background'].includes(ctxMenu.session.status)
              ? () => sleepOne(ctxMenu.session.id)
              : undefined
          }
          onDelete={() => setConfirmDelete(ctxMenu.session)}
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

      {closeAsk && (
        <ConfirmModal
          title={closeAsk.dirty.length === 1 ? 'Unsaved changes' : `${closeAsk.dirty.length} files with unsaved changes`}
          confirmLabel="close and discard"
          busyLabel="closing…"
          onConfirm={async () => {
            await closeAsk.run();
            setCloseAsk(null);
          }}
          onClose={() => setCloseAsk(null)}
        >
          <div className="confirm-target">
            <span className="ct-name">{closeAsk.what}</span>
            <span className="ct-sub">
              {closeAsk.count === 1 ? '1 tab' : `${closeAsk.count} tabs`} · nothing stops running
            </span>
          </div>
          <ul className="confirm-list">
            {closeAsk.dirty.map((t) => <li key={t.id}>{t.ref || t.label}</li>)}
          </ul>
          <p className="confirm-text">
            {closeAsk.dirty.length === 1
              ? 'This file has edits that were never saved. They exist only in this browser, so closing the tab throws them away — cancel and press Ctrl+S to keep them.'
              : 'These files have edits that were never saved. They exist only in this browser, so closing throws them away — cancel and press Ctrl+S in each to keep them.'}
            {closeAsk.count > closeAsk.dirty.length
              && ' The other tabs just close: sessions and shells keep running and stay in the sidebar.'}
          </p>
        </ConfirmModal>
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete session"
          confirmLabel="delete permanently"
          busyLabel="deleting…"
          onConfirm={async () => {
            // deleteSessionOne catches its own errors (→ error banner), so
            // we always close the dialog afterwards.
            await deleteSessionOne(confirmDelete.id);
            setConfirmDelete(null);
          }}
          onClose={() => setConfirmDelete(null)}
        >
          <div className="confirm-target">
            <span className="ct-name">
              {confirmDelete.name || confirmDelete.cwd.split('/').slice(-2).join('/')}
            </span>
            <span className="ct-sub">{confirmDelete.cwd}</span>
          </div>
          <p className="confirm-text">
            The session and its whole history (messages, permissions, logs)
            will be permanently deleted. This cannot be undone — to keep it
            around, pause it instead.
          </p>
        </ConfirmModal>
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
