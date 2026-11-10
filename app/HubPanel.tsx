'use client';
import { effectiveBrowserNotifications } from '@/lib/notificationPreferences';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import {
  PROVIDERS, SESSION_PROVIDERS, asSessionProvider, providerLoginPatch,
} from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';
import { PROVIDER_LOGIN } from './loginModals';
import type { Vps, VpsFolder, VpsPath, AgentSession } from '@/lib/db/schema';
import type { AgentKind, TabDTO, VpsStalenessBaselines } from '@/lib/types/api';
import Sidebar, { type SessionListItem, type ShellListItem, type InstallInfo } from './Sidebar';
import SidebarPathFilter from './SidebarPathFilter';
import {
  type PathFilter, type VpsFilter, isFilterActive, isPathVisible, isVpsVisible,
  normalizePath, parsePathFilter, parseVpsFilter,
} from './pathFilter';
import TabBar, { resolveTabs, type ResolvedTab } from './TabBar';
import { nextMountedFiles } from './fileViews';
import type { EditSnapshot } from './sessionTypes';
import {
  useTabs, hydrateTabs, restoreLocalTabFocus, refreshTabs,
  openTab as openWorkspaceTab, activateTab as activateWorkspaceTab,
  pinTab as pinWorkspaceTab, closeTab as closeWorkspaceTab,
  closeTabsWhere as closeWorkspaceTabsWhere, reorderTabs as reorderWorkspaceTabs,
} from './tabStore';
import ShellTerminal from './ShellTerminal';
import ConfirmModal from './ConfirmModal';
import PermissionPopup from './PermissionPopup';
import InstallNotificationPopup from './InstallNotificationPopup';
import { useCrossSessionInteractionFeed } from './useCrossSessionInteractionFeed';
import { useInstallNotifications } from './useInstallNotifications';
import {
  initSyncPosition, isDegraded, setFocus, subscribeAll, subscribeBuildMismatch,
  subscribeDegraded, subscribeResync, subscribeSyncFrames,
} from './globalEventStream';
import {
  addOverlay, hydrateSummaries, seedFromListResponse, useSessionList, useVpsRuntime,
} from './sync/summaryStore';
import { createRerunner, createRevResource } from './sync/revResource';
import { reconcileInstallsOnResync } from './sync/installResync';
import { refreshAll as refreshAllFileActivity } from './fileActivityStore';
import { attentionForRow, isWaitingAttention } from '@/lib/sessionAttention';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { SyncRev } from '@/lib/sync/rev';
import { applyTheme } from './themeClient';
import { applyDensity } from './density';
import { applyFileIcons } from './fileIconStyle';
import SessionContextMenu from './SessionContextMenu';
import ProviderAccountMenu from './ProviderAccountMenu';
import { useAccountList } from './accountsStore';
import AccountsBanner, { accountsNeedAttention } from './AccountsBanner';
const AccountsModal = dynamic(() => import('./AccountsModal'), { ssr: false });
const AccountLoginModal = dynamic(() => import('./AccountLoginModal'), { ssr: false });
import { sessionAccountProfile, sameLoginProfiles, usageAccountLabel, accountProfileId, accountProfileNumber, profileUsageKey, type AccountProfile } from '@/lib/accountProfiles';
import { useAccountProfiles, useAccountProfilesLoaded, refreshAccountProfiles } from './accountProfileStore';
import PromptModal from './PromptModal';
import { useModelNotices } from './useModelNotices';
import SessionView from './SessionView';
import HeaderSessionNav from './HeaderSessionNav';
import AccountNav from './AccountNav';
import { accountGroupRepresentative, buildAccountGroups, type AccountGroup } from '@/lib/accountGroups';
import { useShowHidden } from './showPaused';
import { dropOtherLoginUsage, putUsage, useUsageFeed } from './usageStore';
import { useStableCallback } from './useStable';
import { backendAvailability, type VpsFixAction } from './vpsHealth';
import { useHasSavedEndpoints } from './savedEndpointsStore';
import {
  AGENT_KINDS, ALL_BACKENDS_ENABLED, enabledBackendsFromSettings, sameBackends,
} from './enabledBackends';
import type { SettingsCategory } from './SettingsModal';
import SessionErrorBoundary from './SessionErrorBoundary';
import { revealLine } from './revealLine';
import { ensureFreshServiceWorker } from './pushClient';
import { useBrowserNotifications, saveBrowserNotifications, readBrowserNotifications } from './browserNotifications';
import {
  IconArrowClockwise, IconBellFill, IconBellSlash, IconGear, IconSearch,
  IconServers, IconVolumeMute, IconVolumeUp, IconTelegram, IconPeople,
  IconMenu, IconPanelRight, IconRobot, IconThreeDotsVertical,
} from './icons';
import { SHOW_TOOLS_STORAGE_KEY } from './chatVisibility';
import { canResumeSession, canSleepSession } from './sessionBulkActions';
import { DeepLinkGuard } from './deepLinkGuard';
import { openExplorerRoot } from './explorerRoots';
import { PROVIDER_VERSION_COLUMNS, pickVpsRuntimeFields } from '@/lib/vpsRuntimeFields';
import { nudgeGit } from './gitStore';
import {
  DEFAULT_SETTING_SOURCES, formatSettingSources, resolveSettingSources,
  safeParseSettingSources, type ClaudeSettingSource,
} from '@/lib/settingSources';
import { DEFAULT_PANEL_LAYOUT, sideTier, toolsTier, type PanelLayout } from './panelLayout';
import { PanelLayoutProvider, usePanelLayoutRoot } from './panelLayoutStore';

// Heavy or rarely-opened surfaces stay out of the dashboard's bootstrap
// chunk. ChunkReloadGuard handles a lazy chunk invalidated by a deployment.
const ToolPanel = dynamic(() => import('./ToolPanel'));
const FileEditor = dynamic(() => import('./FileEditor'));
/** File panes kept mounted besides unsaved ones (§14.111). */
const MAX_MOUNTED_FILES = 4;
const fileTabKey = (t: { vpsId: string; path: string; ref: string }) => `${t.vpsId}\u0000${t.path}\u0000${t.ref}`;
const InstallSessionView = dynamic(() => import('./InstallSessionView'));
const NewSessionWizard = dynamic(() => import('./NewSessionWizard'), { ssr: false });
const OpenFolderModal = dynamic(() => import('./OpenFolderModal'), { ssr: false });
const DataModal = dynamic(() => import('./DataModal'), { ssr: false });
const ResumeModal = dynamic(() => import('./ResumeModal'), { ssr: false });
const PausedSessionsModal = dynamic(() => import('./PausedSessionsModal'), { ssr: false });
const SearchModal = dynamic(() => import('./SearchModal'), { ssr: false });
import type { SearchAction } from './SearchModal';
const SettingsModal = dynamic(() => import('./SettingsModal'), { ssr: false });
const SettingScopeModal = dynamic(() => import('./SettingScopeModal'), { ssr: false });

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  /** Annotated server-side (`annotateSessionRows`): live status, gate split,
   *  bg count — the header is right from the first paint (R5 D-1). */
  initialSessions: SessionListItem[];
  builtPyzSha: string | null;
  // `__version__` of the pyz this hub ships — THE agent-staleness baseline
  // (§14.6); builtPyzSha is kept for identity/receipts only.
  builtAgentVersion: string | null;
  // Every DECLARED release line's latest (settings cache, null = never
  // synced), keyed by the registry's `latestKey`. Compared per axis against
  // the VPS's installed version for the sidebar "out of date" badge and the
  // health chips. One bag on purpose — see `buildMeta` below.
  staleness: VpsStalenessBaselines;
  initialTabs: TabDTO[];
  // The SSR summaries (§14.108, = `initialSessions`) and the bus revision they
  // reflect + the build id: the proto-2 transport's first `?since=` (C15).
  initialSummaries?: import('@/lib/sessionSummary').SessionSummary[];
  initialSync?: import('@/lib/sync/protocol').SyncStamp & { buildId: string };
  /** Side-column widths from the cookie (app/panelLayout.ts), so the
   *  first paint already has the user's grid. */
  initialPanels?: PanelLayout;
};

// SessionState/emptyState removed in the refactor: per-session state now
// lives in `useSessionStream` (consumed by `<SessionView>`).

const emptyEdits: Map<string, EditSnapshot> = new Map();
const NOOP = () => {};
/** List GET cadence (§11): 60 s, 15 s against an older hub (degraded). */
const LIST_POLL_MS = 60_000;
const LIST_POLL_DEGRADED_MS = 15_000;

/** A successful bootstrap deployed THIS build's agent: patch the row locally
 *  (else the "outdated" badge stays lit until the next hello). Live buildMeta;
 *  null tolerable (fallback at the next AgentClient hello). The VERSION is what
 *  clears the "update" badge (§14.6) — patching only the sha would leave it lit. */
function patchVpsInstalled(
  prev: Vps[], vpsId: string, meta: { builtPyzSha?: string | null; builtAgentVersion?: string | null },
): Vps[] {
  return prev.map((v) =>
    v.id === vpsId
      ? ({
          ...v,
          agentStatus: 'ok',
          agentPyzSha: meta.builtPyzSha ?? v.agentPyzSha,
          agentVersion: meta.builtAgentVersion ?? v.agentVersion,
        } as Vps)
      : v,
  );
}

/** Merge the summary store's runtime slice (rev-ordered, §14.52) into the VPS
 *  rows: only the keys it holds, only rows whose snapshot changed. Same array
 *  back when nothing differs. */
function mergeRuntimeSlices(current: Vps[], slices: Array<Record<string, unknown> & { id: string }>): Vps[] {
  if (!slices.length) return current;
  const byId = new Map(slices.map((x) => [x.id, x]));
  let changed = false;
  const next = current.map((row) => {
    const slice = byId.get(row.id);
    if (!slice) return row;
    const patch = pickVpsRuntimeFields(slice);
    const cur = row as unknown as Record<string, unknown>;
    if (Object.entries(patch).every(([k, v]) => cur[k] === v)) return row;
    changed = true;
    return { ...row, ...patch } as Vps;
  });
  return changed ? next : current;
}

export default function HubPanel({ vpsList: initialVpsList, vpsFolders: initialFolders, vpsPaths: initialPaths, initialSessions, builtPyzSha, builtAgentVersion, staleness, initialTabs, initialSummaries, initialSync, initialPanels = DEFAULT_PANEL_LAYOUT }: Props) {
  // The workspace is part of the SSR snapshot. Hydrating it synchronously
  // prevents the initial session from mounting, being cleared by an empty tab
  // store, then mounting again after GET /api/tabs.
  hydrateTabs(initialTabs);
  // Same for the summaries (§14.108) and the transport's first `?since=`: the
  // page resumes the bus from the revision its SSR reflects (§9).
  const ssrSummaries = (initialSummaries ?? initialSessions) as SessionSummary[];
  initSyncPosition(initialSync ?? null);
  hydrateSummaries(ssrSummaries, initialSync ?? null);
  const { tabs: workspaceTabs, dirty: dirtyIds, loaded: workspaceTabsLoaded } = useTabs(initialTabs);
  // Focus is a browser preference, not part of the shared workspace layout.
  // Restore after hydration so desktop/mobile never steer each other and the
  // first server/client render still agrees.
  useEffect(() => { restoreLocalTabFocus(); }, []);
  // Mutable copies — DataModal can add/delete VPSes, folders and paths without a reload.
  const [vpsList, setVpsList] = useState<Vps[]>(initialVpsList);
  const [vpsFolders, setVpsFolders] = useState<VpsFolder[]>(initialFolders);
  const [vpsPaths, setVpsPaths] = useState<VpsPath[]>(initialPaths);
  // Global browser preference for transcript density. Default ON, matching
  // the historical UI; read storage only after mount so SSR hydration stays
  // deterministic (same rule as the notification-sound preference below).
  const [showTools, setShowTools] = useState(true);
  // The preference is known (read below): until then the transcript fetches
  // nothing, so a page load with tools hidden never fetches the full window
  // first (React runs the child's effects before this one, §14.107).
  const [showToolsReady, setShowToolsReady] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(SHOW_TOOLS_STORAGE_KEY) === '0') setShowTools(false);
    } catch {}
    setShowToolsReady(true);
  }, []);
  const toggleShowTools = useCallback(() => {
    setShowTools((current) => {
      const next = !current;
      try { localStorage.setItem(SHOW_TOOLS_STORAGE_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);
  // LIVE staleness baselines. The SSR props freeze at page load; a tab that
  // survives a hub deploy would forever compare vps.agentPyzSha against the
  // OLD builtPyzSha → phantom "update agent" badge on the whole fleet until
  // F5 (and "update" would never clear it: the server deploys the NEW sha,
  // which still ≠ the stale prop). Refreshed from the session-list poll's
  // `meta` (60s while visible + on session_list_changed). The ref mirrors the state for
  // use inside stable-closure event handlers.
  // ONE bag, not N named fields: the `latest`s are keyed by the registry's
  // declared `latestKey` (§14.102), so a newly declared release line reaches
  // the sidebar, the health chips and the data modal without another four-file
  // prop rename — which is precisely what the Cursor axis did NOT get, leaving
  // it comparing against `undefined` on every consumer.
  const [buildMeta, setBuildMeta] = useState<VpsStalenessBaselines>({
    builtPyzSha: builtPyzSha ?? null,
    builtAgentVersion: builtAgentVersion ?? null,
    ...staleness,
  });
  const buildMetaRef = useRef(buildMeta);
  useEffect(() => { buildMetaRef.current = buildMeta; }, [buildMeta]);
  const searchParams = useSearchParams();
  const queryParamSession = searchParams?.get('session') ?? null;
  // `?shell=` deep-link (shell-idle push/telegram notification, parity with
  // `?session=`). When present it takes precedence over the session default so
  // a notification tap lands on the shell, not the first chat.
  const queryParamShell = searchParams?.get('shell') ?? null;
  // THE session list = the summary store (app/sync/summaryStore.ts, §14.108):
  // `session_summary` frames, resync snapshots and the default list GET, each
  // applied iff newer (I5), optimistic writes as overlays (§14.32).
  const sessions: SessionListItem[] = useSessionList(ssrSummaries);
  // The default list GET: ONE in flight, one rerun after it. It seeds the
  // store (complete, stamped `sync`), the VPS runtime slice and `meta`; a
  // filtered/archived call (ResumeModal) never reaches the store.
  const [listRefresher] = useState(() => createRerunner(async () => {
    const r = await api.listSessions();
    if (!seedFromListResponse(r)) return;   // an answer from an older hub process
    {
      // Refresh the staleness baselines (builtPyzSha / PyPI latests) so a
      // long-open tab converges within one poll after a hub deploy — no more
      // phantom "update agent" badges that only F5 could clear.
      const m = r.meta;
      if (m) {
        // Compared key-wise over whatever the server sent, so a line added to
        // the registry converges here with no edit.
        setBuildMeta((prev) => {
          const next: VpsStalenessBaselines = {
            ...m,
            builtPyzSha: m.builtPyzSha ?? null,
            builtAgentVersion: m.builtAgentVersion ?? null,
          };
          const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
          const same = [...keys].every((k) => (
            (prev as Record<string, unknown>)[k] === (next as Record<string, unknown>)[k]
          ));
          return same ? prev : next;
        });
      }
    }
  }));

  // Stable Charon addresses are persisted independently from display names.
  // Keep sleeping targets visible in identity surfaces; `addressable` below
  // separately gates the composer menu to sessions that can receive now.
  const sessionHandles = useMemo(() => {
    const out = new Map<string, { handle: string; confirmed: boolean }>();
    for (const s of sessions) {
      if (s.handle) {
        out.set(s.id, { handle: s.handle, confirmed: true });
      }
    }
    return out;
  }, [sessions]);
  const initialActiveTab = initialTabs.find((t) => t.active) ?? null;
  // A link to a session the list doesn't hold (deleted, archived) selects nothing.
  const [selectedId, setSelectedId] = useState<string | null>(queryParamShell
    ? null
    : (queryParamSession && sessions.some((s) => s.id === queryParamSession)
      ? queryParamSession
      : (initialActiveTab?.kind === 'session' ? initialActiveTab.ref : null)));
  // Charon both consumes and produces these query parameters. Keep provenance,
  // otherwise Next's asynchronous useSearchParams update can reinterpret our
  // own replaceState as a fresh deep link and bounce between two tabs forever.
  const sessionDeepLink = useRef(new DeepLinkGuard());
  const shellDeepLink = useRef(new DeepLinkGuard());
  // The page-load links: the first list that lacks one proves it dead.
  const linkAtLoad = useRef({ session: queryParamSession, shell: queryParamShell }).current;
  // Re-runs the tab → pane bridge and the URL sync: a link that has no row must
  // not leave a selection or a URL behind with no active-tab change to undo them.
  const [paneResync, resyncPane] = useReducer((n: number) => n + 1, 0);
  // `error` stays on the parent: it carries errors from rename/kill/patch etc.
  // which are cross-session actions (not in the active view). Errors for the
  // ACTIVE SESSION live in `<SessionView>` via the hook.
  const [error, setError] = useState<{ msg: string; canResume?: boolean } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<
    | { kind: 'session'; sessions: SessionListItem[]; x: number; y: number }
    | { kind: 'shell'; shell: ShellListItem; x: number; y: number }
    | { kind: 'install'; install: InstallInfo; x: number; y: number }
    | { kind: 'provider'; vps: Vps; provider: AgentKind; x: number; y: number; profile?: AccountProfile }
    | null
  >(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [handleEditor, setHandleEditor] = useState<SessionListItem | null>(null);
  // "Delete permanently" confirmation — styled modal instead of the native
  // confirm(). Holds the target session while the dialog is open.
  const [confirmDelete, setConfirmDelete] = useState<SessionListItem[] | null>(null);
  // Confirmation closes immediately; the card stays visible and red until
  // the DELETE request settles. Shared by Claude and Codex rows.
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(() => new Set());
  // The trash beside the moon (PausedSessionsModal): null = closed, else
  // whether it deletes hidden or normal sleeping sessions (§14.118).
  const [pausedCleanupOpen, setPausedCleanupOpen] = useState<null | { hidden: boolean }>(null);
  // "You are about to discard an unsaved buffer" — the ONLY close that asks.
  // `run` is the close that was requested (one tab, a folder, a machine), held
  // until the answer comes back so the dialog can't do a different thing than
  // the ✕ that opened it.
  const [closeAsk, setCloseAsk] = useState<
    { what: string; count: number; dirty: ResolvedTab[]; run: () => Promise<void> } | null
  >(null);
  // Interactive claude login console
  // ONE sign-in target for every backend (§14.102): `{vps, provider}` instead of
  // a `useState` per provider. Cross-panel (sidebar, health chips, install
  // view, auth-error bubble), hence a single global mount below.
  const [loginTarget, setLoginTarget] =
    useState<{ vps: Vps; provider: AgentKind; profile?: AccountProfile } | null>(null);
  const profiles = useAccountProfiles();
  const profilesLoaded = useAccountProfilesLoaded();
  const profileState = useRef(profiles); profileState.current = profiles;
  // Hub-owned accounts (§14.115): the Accounts panel and its own sign-in
  // (opened from the panel/banner, where no VPS is involved).
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [hubLogin, setHubLogin] = useState<{ provider: AgentKind; accountId: string | null } | null>(null);
  // The list only: a usage reading must not re-render the hub (usageStore.ts).
  const accountsState = useAccountList();
  /** Open a provider's sign-in surface. Closing the wizard is the surface's own
   *  declared behaviour, not the caller's guess. */
  const openProviderLogin = useCallback((v: Vps, provider: AgentKind, profile?: AccountProfile) => {
    if (PROVIDER_LOGIN[provider].closesWizard) setWizard(null);
    setLoginTarget({ vps: v, provider, profile });
  }, []);
  // Accounts are the hub's (§14.115): nothing is ever signed out per VPS.
  const signingOutAccounts: ReadonlySet<string> = useMemo(() => new Set<string>(), []);

  // "Which Claude settings files does this VPS load?" (§14.100). Opened by an
  // agent install, and by the VPS card in DataModal for a later change.
  const [scopeModal, setScopeModal] = useState<
    { vps: Vps; hubDefault: ClaudeSettingSource[]; mode: 'install' | 'edit' } | null
  >(null);

  // Closing ANY provider's sign-in surface. On a CONFIRMED success the server
  // has already persisted the flag and broadcast `vps_status`, so other tabs
  // follow on their own — we patch locally too so THIS tab flips instantly, and
  // the columns come from `providerLoginPatch` rather than being named here.
  // Without confirmation, a provider that has a probe route re-checks: the user
  // may have signed in (or out) elsewhere, and the result self-heals the
  // sidebar button + the health chips.
  const closeProviderLogin = useCallback((loggedIn: boolean) => {
    const target = loginTarget;
    setLoginTarget(null);
    if (!target) return;
    const { vps: v, provider, profile } = target;
    void refreshAccountProfiles();
    if (profile && profile.id !== "default") return;
    const patch = (fields: Record<string, number>) => setVpsList((prev) =>
      prev.map((vp) => (vp.id === v.id ? ({ ...vp, ...fields } as Vps) : vp)));
    if (loggedIn) { patch(providerLoginPatch(provider, 1)); return; }
    // Best-effort, async. If it fails we keep the value we already show.
    void PROVIDER_LOGIN[provider].recheck?.(v.id).then((r) => {
      if (r) patch(providerLoginPatch(provider, r.loggedIn ? 1 : 0, r.checkedAt));
    }).catch(() => {});
  }, [loginTarget]);
  // Ephemeral SSH shells. Live list (polled on mount, updated locally).
  const [shells, setShells] = useState<ShellListItem[]>([]);
  const [shellsLoaded, setShellsLoaded] = useState(false);
  // Read by the SSE handler below, which subscribes once.
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const shellStatusRef = useRef(new Map<string, string>());
  // Shells created with no explicit cwd start in the SSH user's home and are
  // historically stored as cwd=null. The IDE APIs need an absolute root, so
  // resolve `~` lazily once per VPS when such a shell is selected.
  const [shellHomeByVps, setShellHomeByVps] = useState<Record<string, string>>({});
  // If non-null, a shell is displayed in the main panel (instead of the chat).
  // Initialized from `?shell=` so a shell-idle notification tap opens it.
  const [selectedShellId, setSelectedShellId] = useState<string | null>(queryParamShell);

  // --- Sidebar filter (?vps= and ?path=) ---
  //
  // Sidebar receives the COMPLETE lists plus this predicate, never a
  // pre-filtered list. It expands a drag into a full VPS reorder through
  // sidebarPathGroups, whose contract is explicit that it needs every
  // session: handing it a subset would rewrite the stored position of
  // every hidden one, server-side, for every client.
  //
  // Shells resolve `unknown` differently: they are stored with cwd=null
  // whenever opened without an explicit directory, so treating that as
  // "show it" would leak every home shell through the filter.
  const [pathFilter] = useState<PathFilter>(
    () => parsePathFilter(searchParams?.getAll('path') ?? []),
  );
  const [vpsFilter] = useState<VpsFilter>(
    () => parseVpsFilter(searchParams?.getAll('vps') ?? []),
  );
  const filterActive = isFilterActive(pathFilter) || isFilterActive(vpsFilter);
  // The two dimensions are crossed with AND: a folder rule says WHICH folder,
  // a machine rule says WHERE. Several boxes here share a cwd (/srv on four of
  // them, /srv/charon on two), so a path alone cannot mean one project.
  const isEntityShown = useCallback(
    (vpsId: string, path: string | null, kind: 'session' | 'shell') => (
      isVpsVisible(vpsId, vpsFilter)
      && isPathVisible(path, pathFilter, kind === 'shell' ? 'hidden' : 'visible')
    ),
    [pathFilter, vpsFilter],
  );
  // Mirrors exactly what Sidebar drops, the selected-stays-visible rule
  // included, so the counter can never disagree with the list.
  const hiddenSessions = useMemo(
    () => sessions.filter((s) => s.id !== selectedId && !isEntityShown(s.vpsId, s.cwd, 'session')),
    [sessions, selectedId, isEntityShown],
  );
  const hiddenShells = useMemo(
    () => shells.filter((sh) => sh.id !== selectedShellId && !isEntityShown(sh.vpsId, sh.cwd, 'shell')),
    [shells, selectedShellId, isEntityShown],
  );
  const hiddenCount = hiddenSessions.length + hiddenShells.length;

  // What the builder can offer, grouped BY MACHINE — a flat folder list is
  // ambiguous the moment two boxes share an arborescence, and a fleet built
  // from the same playbook always does.
  const knownFilterGroups = useMemo(() => {
    const byVps = new Map<string, Set<string>>();
    const bucket = (vpsId: string) => {
      let set = byVps.get(vpsId);
      if (!set) { set = new Set(); byVps.set(vpsId, set); }
      return set;
    };
    const add = (vpsId: string, p: string | null | undefined) => {
      const n = normalizePath(p);
      if (n) bucket(vpsId).add(n);
    };
    for (const s of sessions) add(s.vpsId, s.cwd);
    for (const sh of shells) add(sh.vpsId, sh.cwd);
    for (const vp of vpsPaths) add(vp.vpsId, vp.path);
    for (const v of vpsList) add(v.id, v.defaultPath);
    // Sidebar order, so the builder reads like the list it filters. A machine
    // with no known folder still gets a row: selecting the whole box is a
    // legitimate filter, and it is the only way to reach a fresh one.
    return vpsList.map((v) => ({
      vpsId: v.id,
      vpsName: v.name || v.ip,
      paths: [...(byVps.get(v.id) ?? [])].sort(),
    }));
  }, [sessions, shells, vpsPaths, vpsList]);
  const vpsNameOf = useCallback(
    (id: string) => vpsList.find((v) => v.id === id)?.name || id,
    [vpsList],
  );

  // Agent install sessions. In-memory only (shell pattern). One install
  // per VPS max (cf. installSession.ts § startInstall).
  const [installs, setInstalls] = useState<InstallInfo[]>([]);
  const installsRef = useRef(installs); installsRef.current = installs;
  // If non-null, an install session occupies the main panel.
  const [selectedInstallId, setSelectedInstallId] = useState<string | null>(null);

  // Responsive drawers (§11): under the CSS breakpoints (≤1100px the ToolPanel
  // becomes a right drawer, ≤820px the Sidebar becomes a left drawer) these
  // toggle `.nav-open` / `.tools-open` on `.app-root`. No effect on desktop
  // (the toggle buttons + drawer positioning are CSS-gated by media query).
  const [navOpen, setNavOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Right menu drawer (mobile only, CSS-gated ≤820px): the header action
  // buttons. Left drawer = sessions. Account usage is not in it — on a phone
  // it is the rings beside the session title (`UsageRings`).
  const [menuOpen, setMenuOpen] = useState(false);
  const closeDrawers = useCallback(() => { setNavOpen(false); setToolsOpen(false); setMenuOpen(false); }, []);
  // Desktop side columns (app/panelLayout.ts): the grid reads each width as a
  // CSS variable and its tier as `data-side`/`data-tools`, which lay the
  // column's contents out for it. Drawers below the breakpoints ignore both.
  const panels = usePanelLayoutRoot(initialPanels);
  // Account-usage gauges (the `/usage` widgets) live in app/usageStore.ts, NOT
  // in this component's state: only the gauges subscribe, so a reading never
  // re-renders the hub (and with it the sidebar and the whole chat). Fed by
  // the LOW_VOLUME `account_usage` SSE event + hydrated here on session-select
  // via GET /api/vps/[id]/usage. §14.58 / §14.59 / §14.115.
  useUsageFeed();
  // Every (VPS, provider, profile) gauge this tab has displayed: a resync
  // refetches them all (account_usage frames missed beyond the ring, R3 A4).
  // Value = cache-only: the header account buttons hydrate every login from
  // the hub's snapshot (no awaited poll per account, which would hold HTTP/1.1
  // sockets on a cold load); a gauge ever fetched normally stays normal.
  const usageKeysRef = useRef(new Map<string, boolean>());
  const refreshUsage = useCallback((vpsId: string | null | undefined, provider: AgentKind = 'claude', profile = 'default', force = false, cachedOnly = false) => {
    if (!vpsId) return;
    const usageKey = `${vpsId}\u0000${provider}\u0000${profile}`;
    usageKeysRef.current.set(usageKey, cachedOnly && usageKeysRef.current.get(usageKey) !== false);
    api.getVpsUsage(vpsId, provider, profile, force, cachedOnly && !force).then((r) => {
      const fresh = r.byProvider?.[provider] ?? (provider === 'claude' ? r.usage : r.codexUsage);
      const currentProfile = profileState.current.find((p) => p.vpsId === vpsId && p.provider === provider && p.id === profile);
      const sessionProvider = asSessionProvider(provider);
      if (!fresh) {
        // No snapshot yet for the current login: gauges stamped with ANOTHER
        // login (changed while the hub was down) must not stay on screen.
        const now = currentProfile?.accountKey;
        if (now) dropOtherLoginUsage(vpsId, sessionProvider, profile, now);
        return;
      }
      if (currentProfile?.accountKey && fresh.accountKey && currentProfile.accountKey !== fresh.accountKey) return;
      // Keyed by what was ASKED (a reading names its account, §14.115).
      putUsage(vpsId, { ...fresh, provider: sessionProvider, accountProfile: profile });
    }).catch(() => {});
  }, []);

  // Load the shells list at mount + refresh when a selector changes
  useEffect(() => {
    let cancelled = false;
    api.listShells().then((r) => {
      if (cancelled) return;
      setShells(r?.shells ?? []);
      setShellsLoaded(true);
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
          const vpsId = ev.vpsId;
          setVpsList((prev) => patchVpsInstalled(prev, vpsId, buildMetaRef.current));
        }
      }
    });
    return () => unsub();
  }, []);

  // A resync's `sync_installs` is the complete set of RUNNING installs at R
  // (§3.3): listed unknown ids are fetched and added; an unlisted `running`
  // row finished in the gap and is REFETCHED (its success/error + log stay,
  // §14.22), dropped only on a 404 (app/sync/installResync.ts).
  useEffect(() => subscribeSyncFrames((frame) => {
    if (frame.type !== 'sync_installs') return;
    const running = (frame.running as Array<{ installId: string; vpsId: string; vpsName: string }>) ?? [];
    reconcileInstallsOnResync(installsRef.current, running.map((r) => r.installId), {
      getInstall: api.getInstall,
      update: setInstalls,
      onFinished: (info) => setVpsList((prev) => patchVpsInstalled(prev, info.vpsId, buildMetaRef.current)),
    });
  }), []);

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
      // A shell's durable "finished, unread" marker flipped (§14.47).
      if (ev.type === 'shell_unread') {
        const shellId = ev.sessionId;
        const unread = ev.unread === true;
        setShells((prev) => prev.some((sh) => sh.id === shellId && !!sh.unreadFinish !== unread)
          ? prev.map((sh) => sh.id === shellId ? { ...sh, unreadFinish: unread } : sh)
          : prev);
        return;
      }
      if (ev.type !== 'shell_status') return;
      const shellId = ev.sessionId;
      if (!shellId) return;
      const status = ev.status; // 'active' | 'busy' | 'exited'
      // busy → active: a command handed the prompt back, and may have written
      // files. A debounced nudge — prompt redraws make this edge bursty.
      const was = shellStatusRef.current.get(shellId);
      shellStatusRef.current.set(shellId, String(status));
      if (was === 'busy' && status === 'active') {
        const sh = shellsRef.current.find((x) => x.id === shellId);
        if (sh?.cwd) nudgeGit(sh.vpsId, sh.cwd);
      }
      // Set only when this status moved the shell's activity time (the
      // header nav orders by it); never older than what the row holds.
      const at = typeof ev.lastActivityMs === 'number' ? ev.lastActivityMs : null;
      setShells((prev) => {
        let changed = false;
        const next = prev.map((sh) => {
          if (sh.id !== shellId) return sh;
          if (status === 'exited') {
            if (sh.exited) return sh;
            changed = true;
            return { ...sh, exited: true, liveStatus: undefined };
          }
          const moved = at != null && at > (sh.lastActivityMs ?? 0);
          if (!sh.exited && sh.liveStatus === status && !moved) return sh;
          changed = true;
          return { ...sh, exited: false, liveStatus: status, ...(moved ? { lastActivityMs: at } : {}) };
        });
        return changed ? next : prev;
      });
    });
    return () => unsub();
  }, []);

  // Live VPS runtime (agent status, versions, logins — §14.52). The summary
  // store holds it rev-ordered per key (`vps_status` frames, the resync's
  // `sync_vps`, the list GET's `vpsRuntime`), so a list GET that started
  // before a sign-in and lands after it can no longer revert it (R3 F3).
  // Merged into `vpsList` only for the VPSes whose slice changed: local
  // patches of an action's own answer (update, refresh, sign-out) survive
  // until the store holds something newer.
  const vpsRuntime = useVpsRuntime();
  const mergedRuntime = useRef<ReadonlyMap<string, unknown>>(new Map());
  useEffect(() => {
    const changed: Array<Record<string, unknown> & { id: string }> = [];
    for (const [id, slice] of vpsRuntime) {
      if (mergedRuntime.current.get(id) !== slice) changed.push(slice as Record<string, unknown> & { id: string });
    }
    mergedRuntime.current = vpsRuntime;
    if (changed.length) setVpsList((prev) => mergeRuntimeSlices(prev, changed));
  }, [vpsRuntime]);

  // Background-task counts, "finished, unread" markers and live statuses all
  // ride the session summary now (§14.108): no per-field patchers (R3
  // A5/A6/A7). The open session is no exception: its finish stays lit.
  //
  // The open SHELL is a focus target too (16 hex, never a session id).
  const focusTarget = selectedId ?? selectedShellId;

  // Opening a session focuses it (routing). Re-POST here as well as in
  // useSessionStream so the focus does not depend on that view mounting, and
  // so selecting an already-active session heals a prior SSE-registration
  // race. Keyed on selectedId so it covers EVERY open path (sidebar, tab bar,
  // deep link, push-notification click).
  //
  // Moving the focus OFF a session is its read acknowledgement (§14.47): the
  // hub clears the finish marker of what an attended view just left. A main
  // pane that is NOT a session or a shell (file, install, nothing) clears the
  // focus, so opening a file leaves the session too.
  useEffect(() => {
    if (!focusTarget) { void setFocus(null); return; }
    if (document.visibilityState !== 'visible') return;
    void setFocus(focusTarget);
  }, [focusTarget]);

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
  // Stable for the memoized header navs (AccountNav items): the latest
  // `selectSession` through a ref.
  const selectSessionRef = useRef<(id: string, pin?: boolean) => void>(() => {});
  selectSessionRef.current = selectSession;
  const openFromNav = useCallback((id: string) => selectSessionRef.current(id, true), []);
  const selectShellRef = useRef<(id: string, pin?: boolean) => void>(() => {});
  selectShellRef.current = selectShell;
  const openShellFromNav = useCallback((id: string) => selectShellRef.current(id, true), []);
  function selectSession(id: string, pin = false) {
    const sess = sessions.find((x) => x.id === id);
    // Always the tab store, even from an empty workspace (no open tab): a
    // page load here put the sidebar back at the top, then scrolled it down
    // to the row.
    if (sess) openEntityTab('session', id, sess.vpsId, sess.cwd ?? '', pin);
    closeDrawers();  // mobile: picking from the sidebar drawer closes it
  }
  // `row` is the just-created install, passed by the caller that created it.
  // Without it this looked the id up in `installs` — the state array the
  // caller had only just asked React to update, so the lookup MISSED and the
  // install opened nowhere: the log ran in the background while the user
  // stayed on the session they came from. Same trap as a newly created
  // session (§14.78): take the created ROW, never a bare id.
  function selectInstall(id: string, row?: InstallInfo) {
    const inst = row ?? installs.find((x) => x.id === id);
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
  // Installing an agent is the moment this MACHINE's Claude settings policy
  // gets decided (§14.100), so the choice is asked for here rather than buried
  // in a settings page nobody opens. The dialog is pre-filled with what the
  // VPS already carries (fresh row → "inherit the hub default"), and the same
  // dialog is reachable later from DataModal: on a brand-new box the files it
  // names do not exist yet, so this is a policy, never a selection.
  async function openSettingScope(vps: Vps, mode: 'install' | 'edit' = 'edit') {
    let hubDefault = [...DEFAULT_SETTING_SOURCES];
    try {
      const s = await api.getSettings();
      hubDefault = resolveSettingSources(safeParseSettingSources(s['claude.setting_sources']));
    } catch { /* the built-in default is a fine answer */ }
    setScopeModal({ vps, hubDefault, mode });
  }

  async function openInstallSession(vps: Vps) {
    await openSettingScope(vps, 'install');
  }

  async function startInstallSession(vps: Vps) {
    try {
      const info = await api.startInstall(vps.id);
      // Optimistic update — the install_started event will also arrive via SSE.
      setInstalls((prev) => {
        const others = prev.filter((i) => i.id !== info.id);
        return [...others, info];
      });
      // Starting an install is a decision to WATCH it: land on its console.
      selectInstall(info.id, info);
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
  const [wizard, setWizard] = useState<null | { kind: 'agent' | 'shell'; vpsId?: string; cwd?: string | null; agentKind?: AgentKind; accountProfile?: string; offerShell?: boolean }>(null);
  // The explorer's ＋ (ToolPanel): which folder to open as a tab of the
  // workspace `(vpsId, cwd)` it was asked from (`explorerRoots.ts`).
  const [folderPicker, setFolderPicker] = useState<null | { vpsId: string; cwd: string }>(null);
  const openFolderPicker = useCallback((vpsId: string, cwd: string) => setFolderPicker({ vpsId, cwd }), []);
  const folderPickerInUse = useMemo(() => {
    if (!folderPicker) return [] as string[];
    const out: string[] = [];
    for (const x of sessions) if (x.vpsId === folderPicker.vpsId && x.cwd) out.push(x.cwd);
    for (const x of shells) if (x.vpsId === folderPicker.vpsId && x.cwd) out.push(x.cwd);
    return out;
  }, [folderPicker, sessions, shells]);
  // The explorer's "New Session Here…": the header's "＋ agent here" flow on
  // any folder — which agent (or a shell), then the name.
  const newSessionIn = useCallback((vpsId: string, cwd: string) => {
    closeDrawers();
    setWizard({ kind: 'agent', vpsId, cwd, offerShell: true });
  }, [closeDrawers]);
  const [resumeOpen, setResumeOpen] = useState<null | { vpsId?: string }>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Ctrl/Cmd+K toggles the global palette from anywhere (composer, editor) —
  // except inside a terminal, where Ctrl+K belongs to the shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      if ((e.target as Element | null)?.closest?.('.xterm')) return;
      e.preventDefault();
      setSearchOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Section the settings modal opens on (null = its own default). Set by the
  // wizard's "enable one in Settings" link when both backends are off.
  const [settingsCat, setSettingsCat] = useState<SettingsCategory | null>(null);
  // Hub-wide backend switches (claude.enabled / codex.enabled). Refreshed with
  // the rest of the shared settings below, so a change on one device hides the
  // launchers on every other one through `settings_changed`. Optimistic
  // default = both ON: a hub that hasn't answered yet must not look like it
  // lost a backend. cf. app/enabledBackends.ts.
  const [backends, setBackends] = useState(ALL_BACKENDS_ENABLED);
  // One header button per LOGIN across every VPS with a LIVE session
  // (app/AccountNav.tsx, lib/accountGroups.ts): `sessions` is the summary
  // store, so a start/pause shows/hides it live. Every member hydrates from the hub's CACHED
  // snapshot (no poll: `account_usage` keeps it live); `refreshUsage`
  // registers the key so a resync refetches it the same way.
  // Nothing until the profile store has answered once: before it every
  // session looks profile-less, so one login would show one button per VPS,
  // then merge and reorder under the pointer.
  // The sidebar's hidden switch, read from the shared store: the strip and the
  // header navs filter on the same value the list does (app/showPaused.ts).
  const [showHidden] = useShowHidden();
  // What the header navs and the search list: one side of that switch only —
  // a hidden session is on no screen until hidden ones are shown (§14.118).
  const viewSessions = useMemo(
    () => sessions.filter((s) => (s.hidden === 1) === showHidden),
    [sessions, showHidden],
  );
  const accountGroups = useMemo(
    () => profilesLoaded ? buildAccountGroups({ sessions: viewSessions, profiles, enabled: backends, vpsName: vpsNameOf }) : [],
    [profilesLoaded, viewSessions, profiles, backends, vpsNameOf],
  );
  const vpsReachable = useCallback(
    (id: string) => vpsList.find((v) => v.id === id)?.agentStatus === 'ok',
    [vpsList],
  );
  const refreshAccountGroupUsage = useCallback((g: AccountGroup) => {
    const r = accountGroupRepresentative(g, vpsReachable);
    refreshUsage(r.vpsId, g.provider, r.profileId, true);
  }, [vpsReachable, refreshUsage]);
  const accountUsageTargets = accountGroups
    .filter((g) => !PROVIDERS[g.provider].usageDashboardUrl)
    .flatMap((g) => g.members.map((m) => `${m.vpsId}\u0000${g.provider}\u0000${m.profileId}`))
    .join('\u0001');
  useEffect(() => {
    if (!accountUsageTargets) return;
    for (const t of accountUsageTargets.split('\u0001')) {
      // Only targets new to this tab: a known key is already live through
      // `account_usage`, and a resync refetches it (usageKeysRef).
      if (usageKeysRef.current.has(t)) continue;
      const [vpsId, provider, profile] = t.split('\u0000');
      refreshUsage(vpsId, provider as AgentKind, profile, false, true);
    }
  }, [accountUsageTargets, refreshUsage]);
  const { notices: modelNotices, markSeen: markModelsSeen, hasNewModels } = useModelNotices();
  const [dataOpen, setDataOpen] = useState(false);
  const browserNotifications = useBrowserNotifications();
  const pushOn = browserNotifications.enabled;
  const notifSoundEnabled = browserNotifications.sound;
  const [pushBusy, setPushBusy] = useState(false);
  // Telegram notifications = an INDEPENDENT channel from browser push. The
  // header toggle drives the `telegram.enabled` server setting (gated inside
  // sendPlainToTelegram→configured()); it has nothing to do with `pushOn`
  // (this browser's preferences). `tgConfigured` = token + chat_id are set.
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
      // Patch the local row to reflect the new versions — prevents the
      // "outdated" badge from staying displayed until the next hello. EVERY
      // provider's columns, derived from the registry: the sidebar ORs all the
      // staleness axes, so a VPS stale only on a backend this patch forgot kept
      // the badge its own update had just cleared (§14.52).
      setVpsList((prev) => prev.map((v) => {
        if (v.id !== vps.id) return v;
        const result = (r ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {
          agentVersion: result.newVersion ?? v.agentVersion,
          agentPyzSha: result.newPyzSha ?? v.agentPyzSha,
          agentStatus: 'ok',
        };
        for (const column of PROVIDER_VERSION_COLUMNS) {
          const next = result[column];
          if (typeof next === 'string' && next) patch[column] = next;
        }
        return { ...v, ...patch } as Vps;
      }));
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
  function handleVpsFix(v: Vps, action: VpsFixAction) {
    switch (action) {
      case 'install': setWizard(null); openInstallSession(v); break;
      case 'refresh': runRefreshAgent(v); break;
      case 'update': runUpdateAgent(v); break;
      default: {
        // Every remaining action is a `<provider>-login` (§14.102), routed by
        // the registry — a new backend needs no branch here, only its entry
        // in PROVIDER_LOGIN, which the type system already demands.
        const p = SESSION_PROVIDERS.find((x) => PROVIDERS[x].backend.login.action === action);
        if (p) openProviderLogin(v, p);
        else console.warn('[vpsFix] no handler for action', action);
      }
    }
  }

  // Cross-session permission popup: derived from the summary store's gates
  // (useCrossSessionInteractionFeed, §14.108).
  const { perms: permQueue } = useCrossSessionInteractionFeed();

  // How many hidden sessions are waiting on the user: THE attention predicate
  // (blocked | question, lib/sessionAttention.ts) over the summaries, so the
  // chip agrees with the sidebar and the header; unread is not "waiting".
  const hiddenWaitingCount = useMemo(() => {
    return hiddenSessions.filter(
      (s) => isWaitingAttention(attentionForRow(s)),
    ).length;
  }, [hiddenSessions]);

  // [esRef, chatBodyRef, assistantBufRef, scroll mechanics (isAtBottomRef,
  //  newCount, lastMessageCountRef, handleChatScroll, onPillClick) — all of
  //  this lives in `<SessionView>` after the refactor.]

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const selectedAccount = sessionAccountProfile(profiles, selected);
  // Whose usage the session gauges show: its header account button's label
  // when it has one (same login ⇒ same string), else the same rule over every
  // profile of that login (`usageAccountLabel`, §14.58).
  const selectedUsageLabel = useMemo(() => {
    if (!selected) return null;
    const provider = asSessionProvider(selected.kind);
    const key = profileUsageKey(selected.vpsId, provider, accountProfileId(selected));
    const group = accountGroups.find((g) => g.members.some((m) => m.usageKey === key));
    return group?.accountLabel ?? usageAccountLabel(providerName(provider), selectedAccount,
      accountProfileNumber(selected), sameLoginProfiles(profiles, selectedAccount));
  }, [selected, accountGroups, selectedAccount, profiles]);
  const selectedShell = selectedShellId ? shells.find((s) => s.id === selectedShellId) ?? null : null;
  const selectedShellWorkspaceRoot = selectedShell
    ? (selectedShell.cwd?.trim() || shellHomeByVps[selectedShell.vpsId] || null)
    : null;
  const selectedVps = useMemo<Vps | null>(
    () => (selected ? vpsList.find((v) => v.id === selected.vpsId) ?? null : null),
    [selected, vpsList],
  );

  useEffect(() => {
    const vpsId = selectedShell?.vpsId;
    if (!vpsId || selectedShell.cwd?.trim() || shellHomeByVps[vpsId]) return;
    let cancelled = false;
    api.listVpsDirs(vpsId, '~')
      .then((result) => {
        const root = result.ok && result.exists !== false ? result.resolved?.trim() : '';
        if (!cancelled && root) {
          setShellHomeByVps((current) => current[vpsId] === root
            ? current
            : { ...current, [vpsId]: root });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedShell?.vpsId, selectedShell?.cwd, shellHomeByVps]);

  // Handed down to <Message>: a durable authentication-error bubble opens the
  // matching provider login (Claude hosted OAuth / Codex device code). Stable
  // across renders because <Message> is memoized (§14.38/65/68).
  const reauthSelectedVps = useCallback(() => {
    if (!selectedVps) return;
    openProviderLogin(selectedVps, asSessionProvider(selected?.kind), profiles.find((p) => p.vpsId === selectedVps.id && p.provider === asSessionProvider(selected?.kind) && p.id === accountProfileId(selected)));
  }, [selected?.kind, selected?.accountProfile, selectedVps, profiles, openProviderLogin]);

  // Hydrate the current VPS's usage on select (SSE is live-only, §14.14): a
  // freshly-mounted tab has no snapshot until the next 60s poll — fetch once so
  // the header widget shows real numbers immediately. (Declared after
  // selectedVps to stay out of its temporal dead zone.)
  useEffect(() => {
    refreshUsage(selectedVps?.id, asSessionProvider(selected?.kind), accountProfileId(selected));
  }, [selectedVps?.id, selected?.kind, selected?.accountProfile, selectedAccount?.accountKey, selectedAccount?.loggedIn, refreshUsage]);


  // Ordered tab list (sidebar order, grouped by VPS). Recomputed on any
  // change to sessions/shells/installs/pendings — cheap, ~O(n).
  // `ShellListItem` is structurally identical to `ShellInfo` (same fields).
  // ── Workspace tabs (§14.78) ───────────────────────────────────────────────
  // The bar is no longer derived from "every non-sleeping session": it is a
  // persisted, shared list. This resolves those rows against the live entity
  // lists once, and both the strip and the main pane read the same answer.
  const resolvedTabs = useMemo(() => resolveTabs({
    tabs: workspaceTabs, sessions, shells, installs, dirtyIds,
  }), [workspaceTabs, sessions, shells, installs, dirtyIds]);

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
  // The hydration frame's active tab is the stored/legacy one. Under a
  // `?session=`/`?shell=` deep link the initial selection IS the link, and the
  // deep-link effect below is about to open its tab: following the stale tab
  // for that one commit would mount (focus + window GET) an unrelated session.
  // Once the active tab changes at all, the bridge follows it unconditionally.
  const hydrationTab = useRef<{ id: string | null } | null>(null);
  const hydrationDone = useRef(false);
  useEffect(() => {
    if (!workspaceTabsLoaded) return;
    const id = activeTab?.id ?? null;
    if (!hydrationDone.current) {
      if (hydrationTab.current == null) hydrationTab.current = { id };
      else if (hydrationTab.current.id !== id) hydrationDone.current = true;
    }
    if (!hydrationDone.current) {
      const linked = queryParamShell ? { kind: 'shell', ref: queryParamShell }
        : queryParamSession ? { kind: 'session', ref: queryParamSession } : null;
      if (linked && !(activeTab?.kind === linked.kind && activeTab.ref === linked.ref)) return;
      hydrationDone.current = true;
    }
    if (!activeTab) {
      setSelectedId(null); setSelectedShellId(null); setSelectedInstallId(null); setSelectedFile(null);
      return;
    }
    setSelectedFile(activeTab.kind === 'file' ? activeTab : null);
    setSelectedId(activeTab.kind === 'session' ? activeTab.ref : null);
    setSelectedShellId(activeTab.kind === 'shell' ? activeTab.ref : null);
    setSelectedInstallId(activeTab.kind === 'install' ? activeTab.ref : null);
  }, [activeTab, workspaceTabsLoaded, paneResync]);

  /** Open (or focus) something as a tab. Preview unless `pin`. */
  const openEntityTab = useCallback((
    kind: 'session' | 'shell' | 'install' | 'file',
    ref: string, vpsId: string, path: string, pin = false,
  ) => {
    setBrowseVpsId(null); setBrowsePath(null);
    void openWorkspaceTab({ vpsId, path, kind, ref, pin });
  }, []);

  // Consume external deep links without feeding Charon's own URL writes back
  // into local active-tab state. The guard also keeps a new arrival in
  // charge until its optimistic/server tab mutation has actually settled.
  useEffect(() => {
    // A shell link wins if a caller supplied both parameters. Internal URL
    // writes are atomic, but old bookmarks and external callers may not be.
    if (queryParamShell) {
      sessionDeepLink.current.consume(queryParamSession);
      sessionDeepLink.current.settle(queryParamSession);
      return;
    }
    const activeMatches = !!queryParamSession
      && activeTab?.kind === 'session' && activeTab.ref === queryParamSession;
    const isNew = sessionDeepLink.current.consume(queryParamSession);
    if (activeMatches) {
      sessionDeepLink.current.settle(queryParamSession);
      return;
    }
    if (!queryParamSession
      || (!isNew && !sessionDeepLink.current.isAwaiting(queryParamSession))) return;
    // A notification tap must land on a real TAB, not on a pane the bar
    // doesn't show — but as a PREVIEW. Pinning is reserved for having actually
    // worked in a tab (a message, an edit, a double-click); arriving and
    // reading is not that.
    const sess = sessions.find((x) => x.id === queryParamSession);
    if (sess) {
      openEntityTab('session', sess.id, sess.vpsId, sess.cwd ?? '', false);
      return;
    }
    // No row: the link never holds the pane, or every tap on a session is
    // overwritten by a link to one that no longer exists (§14.78).
    const gaveUp = sessionDeepLink.current.giveUpIfMissing(
      queryParamSession, activeTab?.id ?? null, queryParamSession === linkAtLoad.session,
    );
    if (gaveUp) hydrationDone.current = true;
    if (gaveUp || isNew) resyncPane();
  }, [queryParamSession, sessions, activeTab, openEntityTab, linkAtLoad]);

  // Shell deep links follow the exact same guarded path. Opening a real
  // workspace tab (when its row is known) is important: direct selected-state
  // writes are otherwise overwritten by the active-tab bridge above.
  useEffect(() => {
    const activeMatches = !!queryParamShell
      && activeTab?.kind === 'shell' && activeTab.ref === queryParamShell;
    const isNew = shellDeepLink.current.consume(queryParamShell);
    if (activeMatches) {
      shellDeepLink.current.settle(queryParamShell);
      return;
    }
    if (!queryParamShell
      || (!isNew && !shellDeepLink.current.isAwaiting(queryParamShell))) return;
    const sh = shells.find((x) => x.id === queryParamShell);
    if (sh) {
      openEntityTab('shell', sh.id, sh.vpsId, sh.cwd ?? '', false);
      return;
    }
    // As for a session, but the shell list only arrives after mount.
    const gaveUp = shellDeepLink.current.giveUpIfMissing(
      queryParamShell, activeTab?.id ?? null, shellsLoaded && queryParamShell === linkAtLoad.shell,
    );
    if (gaveUp) hydrationDone.current = true;
    if (gaveUp || isNew) resyncPane();
  }, [queryParamShell, shells, shellsLoaded, activeTab, openEntityTab, linkAtLoad]);

  // Sync the active workspace tab to the URL atomically. Drive this from the
  // tab itself, not selectedId: the latter updates one effect later and could
  // overwrite a just-arrived deep link with the previous session. Two separate
  // replaceState calls also briefly exposed both ?session= and ?shell=.
  useEffect(() => {
    if (typeof window === 'undefined' || !workspaceTabsLoaded) return;
    const url = new URL(window.location.href);
    const desiredSession = activeTab?.kind === 'session' ? activeTab.ref : null;
    const desiredShell = activeTab?.kind === 'shell' ? activeTab.ref : null;
    const currentSession = url.searchParams.get('session');
    const currentShell = url.searchParams.get('shell');
    if (currentSession === desiredSession && currentShell === desiredShell) {
      sessionDeepLink.current.settle(currentSession);
      shellDeepLink.current.settle(currentShell);
      return;
    }
    if (sessionDeepLink.current.shouldDeferUrlSync(currentSession)
      || shellDeepLink.current.shouldDeferUrlSync(currentShell)) return;

    sessionDeepLink.current.markInternal(desiredSession);
    shellDeepLink.current.markInternal(desiredShell);
    if (desiredSession) url.searchParams.set('session', desiredSession);
    else url.searchParams.delete('session');
    if (desiredShell) url.searchParams.set('shell', desiredShell);
    else url.searchParams.delete('shell');
    window.history.replaceState(null, '', url);
  }, [activeTab, workspaceTabsLoaded, paneResync]);

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
  // just closed — the local store picks the next active tab, and an override left
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
  function onTabBarNewSession(vpsId: string, path?: string, agentKind: AgentKind = 'claude', accountProfile = 'default') {
    const cwd = path || defaultCwdFor(vpsId);
    setWizard({ kind: 'agent', vpsId, cwd, agentKind, accountProfile });
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
   * because the rendering happens once at the bottom of HubPanel's
   * JSX (`<SessionContextMenu>` for ctxMenu.kind=session/shell/install).
   */
  function onTabContext(e: React.MouseEvent, t: ResolvedTab) {
    e.preventDefault();
    const x = e.clientX; const y = e.clientY;
    if (t.kind === 'session') {
      const sess = sessions.find((z) => z.id === t.ref);
      if (sess) setCtxMenu({ kind: 'session', sessions: [sess], x, y });
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
  const hasSavedEndpoints = useHasSavedEndpoints();
  const tabBarNewSessionReasons = useMemo((): Record<AgentKind, string | null> => {
    const vps = activeVpsId ? vpsList.find((v) => v.id === activeVpsId) : null;
    const reason = (k: AgentKind) => {
      if (!vps) return null;
      const av = backendAvailability(vps, k, hasSavedEndpoints);
      return av.ok ? null : av.reason;
    };
    return Object.fromEntries(
      AGENT_KINDS.map((k) => [k, reason(k)]),
    ) as Record<AgentKind, string | null>;
  }, [vpsList, activeVpsId, hasSavedEndpoints]);

  // ── Sessions list: frames are the path, the list GET the backstop ──
  // `session_summary` frames keep the store current; the default list GET
  // (60 s, visible AND hidden — a hidden tab's favicon must catch up — plus
  // the visible wake) reconciles it, and refreshes `meta`/runtime. Against an
  // older hub (degraded: no frames carry summaries) it runs every 15 s and the
  // legacy change frames trigger it too. One GET in flight (listRefresher).
  const refreshSessions = useCallback(() => { void listRefresher.trigger(); }, [listRefresher]);
  /** After an action, converge only when no frame will (degraded mode). */
  const refreshIfDegraded = useCallback(() => { if (isDegraded()) refreshSessions(); }, [refreshSessions]);
  useEffect(() => {
    refreshSessions();
    let lastAt = Date.now();
    const poll = setInterval(() => {
      const every = isDegraded() ? LIST_POLL_DEGRADED_MS : LIST_POLL_MS;
      if (Date.now() - lastAt < every - 1_000) return;
      lastAt = Date.now();
      refreshSessions();
    }, LIST_POLL_DEGRADED_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      lastAt = Date.now();
      refreshSessions();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshSessions]);

  // `tabs_changed` → the rev-guarded layout refetch (tabStore). Degraded mode
  // only: the legacy change frames still mean "the list changed".
  useEffect(() => {
    const unsub = subscribeAll((ev, reception) => {
      if (ev.type === 'tabs_changed') { void refreshTabs(reception.rev); return; }
      if (!isDegraded()) return;
      if (ev.type === 'session_list_changed' || ev.type === 'permission_request'
        || ev.type === 'user_question' || ev.type === 'exit_plan_request'
        || ev.type === 'interaction_resolved' || ev.type === 'session_unread'
        || ev.type === 'session_bg_tasks' || ev.type === 'status') {
        refreshSessions();
      }
    });
    return () => unsub();
  }, [refreshSessions]);

  // The explicit resync (§9): the hub's ring could not cover what this tab
  // missed. Everything the bus would have carried is refetched ONCE: the list
  // (meta + runtime; the summaries already came in the snapshot), tabs and
  // settings (rev-guarded), shells, the displayed usage gauges, file activity
  // and account profiles. Running installs came with the snapshot. Nothing
  // runs on a resume (exact).
  useEffect(() => subscribeResync(() => {
    refreshSessions();
    void refreshTabs();
    void settingsResource.refresh();
    void api.listShells().then((r) => {
      setShells(r?.shells ?? []);
      setShellsLoaded(true);
    }).catch(() => {});
    for (const [key, cachedOnly] of usageKeysRef.current) {
      const [vpsId, provider, profile] = key.split('\u0000');
      refreshUsage(vpsId, provider as AgentKind, profile, false, cachedOnly);
    }
    void refreshAllFileActivity();
    void refreshAccountProfiles();
  }), [refreshSessions, refreshUsage]);

  // Version skew (FM8) and an older hub (degraded): one chip, "reload".
  const [reloadChip, setReloadChip] = useState<'build' | 'degraded' | null>(null);
  useEffect(() => {
    const offBuild = subscribeBuildMismatch(() => setReloadChip('build'));
    const offDegraded = subscribeDegraded((d) => setReloadChip((cur) => (cur === 'build' ? cur : d ? 'degraded' : null)));
    if (isDegraded()) setReloadChip((cur) => cur ?? 'degraded');
    return () => { offBuild(); offDegraded(); };
  }, []);

  async function toggleNotifSound() {
    setPushBusy(true);
    try { await saveBrowserNotifications({ ...readBrowserNotifications(), sound: !notifSoundEnabled }); }
    catch (e) { alert('Notification settings: ' + (e instanceof Error ? e.message : String(e))); }
    finally { setPushBusy(false); }
  }

  useEffect(() => { void ensureFreshServiceWorker(); }, []);

  // Listens for service worker messages: notification click (open-session)
  // and the push-triggered in-app sound (notif-sound). The SW fires
  // `notif-sound` to the focused/visible tab on every push so the custom
  // sound plays immediately when a tab is open (focused = reliable,
  // backgrounded = best-effort, Chrome may throttle background audio).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      // A push means some session changed state, possibly while this tab's
      // SSE was suspended: converge the list (one GET in flight).
      if (e.data?.type === 'open-session' || e.data?.type === 'notif-sound') void listRefresher.trigger();
      if (e.data?.type === 'open-session' && e.data.sessionId) {
        const sid = e.data.sessionId as string;
        openSessionById(sid, false);
        // Tell the (possibly already-mounted) session hook to force an
        // immediate resync — the pending question/permission that the
        // notification is about may have arrived while this tab wasn't the
        // focused one, and a same-session click triggers no remount.
        try { window.dispatchEvent(new CustomEvent('charon:notif-open', { detail: { sessionId: sid } })); } catch {}
      } else if (e.data?.type === 'notif-sound') {
        const prefs = effectiveBrowserNotifications(readBrowserNotifications(), e.data.sessionId);
        if (prefs.enabled && prefs.sound && prefs.events[e.data.event as keyof typeof prefs.events]) playBeep();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  async function togglePush() {
    setPushBusy(true);
    try {
      await saveBrowserNotifications({ ...readBrowserNotifications(), enabled: !pushOn });
    } catch (e) {
      alert('Notification settings: ' + (e instanceof Error ? e.message : String(e)));
    } finally { setPushBusy(false); }
  }

  // Shared settings (Telegram, backend switches, theme, density): a
  // revision-guarded resource (app/sync/revResource.ts) — a `settings_changed`
  // frame at R is only satisfied by an answer whose `sync ≥ R`; one GET at a
  // time; the resync handler and window focus refresh it.
  const settingsOpenRef = useRef(settingsOpen); settingsOpenRef.current = settingsOpen;
  const [settingsResource] = useState(() => createRevResource<Awaited<ReturnType<typeof api.getSettings>>>({
    fetch: () => api.getSettings(),
    stampOf: (s) => (s as unknown as { sync?: SyncRev }).sync ?? null,
    apply: (s) => {
      setTgEnabled(s['telegram.enabled'] === 'true');
      setTgConfigured(!!s['telegram.bot_token'] && !!s['telegram.chat_id']);
      setBackends((prev) => {
        const next = enabledBackendsFromSettings(s);
        // `sameBackends`, never a hand-written pair: comparing only claude and
        // codex discarded the whole object whenever those two agreed, pinning
        // every later provider to its default (§14.102).
        return sameBackends(prev, next) ? prev : next;
      });
      // The theme is hub-wide: this is how the OTHER tabs and devices follow
      // a change. Held while the settings modal is open — it is previewing a
      // theme that is deliberately not saved yet, and this same refresh runs
      // on window focus (§11).
      if (!settingsOpenRef.current) {
        applyTheme(s['app.theme']);
        applyDensity(s['app.density']);
        applyFileIcons(s['app.file_icons']);
      }
    },
  }));
  useEffect(() => {
    const unsub = subscribeAll((ev, reception) => {
      if (ev.type === 'settings_changed') void settingsResource.invalidate(reception.rev);
    });
    const onFocus = () => { void settingsResource.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { unsub(); window.removeEventListener('focus', onFocus); };
  }, [settingsResource]);
  // Closing the modal re-applies the saved theme (its preview is discarded).
  useEffect(() => { if (!settingsOpen) void settingsResource.refresh(); }, [settingsOpen, settingsResource]);

  async function toggleTelegram() {
    // Not set up yet → send the user to Settings to enter token + chat_id.
    if (!tgConfigured) { setSettingsOpen(true); return; }
    setTgBusy(true);
    const next = !tgEnabled;
    setTgEnabled(next); // optimistic
    try {
      await api.updateSettings({ 'telegram.enabled': next ? 'true' : 'false' });
    } catch {
      setTgEnabled(!next); // revert on failure
    } finally { setTgBusy(false); }
  }

  // Note: before the refactor, applyApiPendings synced permQueue/
  // questionQueue/exitPlanQueue from the API on every refetch. Today
  // useCrossSessionInteractionFeed keeps these queues up to date via an
  // SSE per session (pendings are replayed on subscribe). Nothing to do here.

  // [SSE + per-session state + refetch + scroll = delegated to
  //   `<SessionView>` which uses `useSessionStream`.
  //   Before the refactor, HubPanel contained ~250 lines of SSE handler,
  //   `applyApiPendings`, `refetchHistory`, `prefetchSession`, visibilityChange,
  //   and the new-messages tracker. All of this now lives in the hook or
  //   directly in the view.]

  // [send/interrupt/forceStop/setMode/doSleep/doResume/doDelete/respondPermission
  //  for the ACTIVE SESSION are in `<SessionView>` via the
  //  `useSessionStream` hook. HubPanel only keeps cross-session
  //  actions: deletion of another session via the menu
  //  (`deleteSessionOne`), edit cwd (`editSessionCwd`), patch shell, etc.]

  // Optimistic writes are summary-store OVERLAYS (§14.32): shown until the
  // route answered AND this tab's bus position reached the `sync` it returned
  // (the summary frame carrying the change is then in the store); a failure
  // reverts.
  async function renameSession(id: string, name: string) {
    setEditingId(null);
    const o = addOverlay(id, { name: name || null });
    try {
      const r = await api.renameAgentSession(id, name || null);
      o.ack(r?.sync);
      refreshIfDegraded();
    } catch (e: any) {
      o.fail();
      setError({ msg: 'rename: ' + (e?.message ?? e) });
    }
  }

  // Cross-session sleep (from the sidebar context menu). No confirm —
  // it's reversible (resume reopens the session). The active session's
  // header button remains the main entry point, but right-clicking in the
  // sidebar lets us pause a session without having to focus it.
  function runSessionLifecycle(action: 'sleep' | 'resume', targets: SessionListItem[]) {
    const eligible = targets.filter(action === 'sleep' ? canSleepSession : canResumeSession);
    if (!eligible.length) return;
    const call = action === 'sleep' ? api.sleepSession : api.resumeSession;
    void Promise.allSettled(eligible.map((session) => call(session.id))).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) {
        const first = failed[0] as PromiseRejectedResult;
        setError({
          msg: `${action}: ${failed.length}/${eligible.length} failed — ${first.reason?.message ?? first.reason}`,
        });
      }
      refreshIfDegraded();
    });
  }

  // Hide / show back (§14.118): the session keeps running; the list moves it
  // to the other side of the hidden switch, with its sub-sessions.
  function setHidden(targets: SessionListItem[], hidden: boolean) {
    const ids = targets.filter((t) => (t.hidden === 1) !== hidden).map((t) => t.id);
    if (!ids.length) return;
    void Promise.allSettled(ids.map(async (id) => {
      const o = addOverlay(id, { hidden: hidden ? 1 : 0 });
      try { o.ack((await api.setSessionHidden(id, hidden))?.sync); } catch (e) { o.fail(); throw e; }
    })).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        const first = failed[0] as PromiseRejectedResult;
        setError({ msg: `${hidden ? 'hide' : 'show'}: ${failed.length}/${ids.length} failed — ${first.reason?.message ?? first.reason}` });
      }
      refreshIfDegraded();
    });
  }

  async function archiveOne(id: string) {
    const o = addOverlay(id, { removed: true });
    try {
      const r = await api.archiveSession(id);
      o.ack(r?.sync);
      const tab = resolvedTabs.find((t) => t.kind === 'session' && t.ref === id);
      if (tab) await closeWorkspaceTab(tab.id);
      if (id === selectedId) setSelectedId(null);
      refreshIfDegraded();
    } catch (e: any) {
      o.fail();
      setError({ msg: 'archive: ' + (e?.message ?? e) });
    }
  }

  // Permanent deletion (DB cascade on the server side). The caller must
  // have confirmed — the context menu goes through `<ConfirmModal>`
  // (`confirmDelete` state), no native confirm() here. No more soft-kill
  // (`status='killed'` which kept the row in DB for post-mortem inspection)
  // — the rework merged kill→delete (cf. CLAUDE.md §10). To pause the
  // session without losing it, use `doSleep` (reversible) in
  // `<SessionView>`.
  function deleteSessionOne(id: string) {
    if (deletingSessionIds.has(id)) return;
    setDeletingSessionIds((current) => new Set(current).add(id));
    void api.deleteAgentSession(id).then((r) => {
      // The summary `null` frame normally wins this race; the overlay hides
      // the row until this tab's bus position covers the deletion, so a
      // dropped SSE never leaves a completed red card behind.
      addOverlay(id, { removed: true }).ack(r?.sync);
      if (id === selectedId) setSelectedId(null);
      refreshIfDegraded();
    }).catch((e: any) => {
      // The row stays in place and loses its deleting treatment, making retry
      // possible. The existing cross-session error surface carries the reason.
      setError({ msg: 'delete: ' + (e?.message ?? e) });
      refreshSessions();
    }).finally(() => {
      setDeletingSessionIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });
  }

  // The paused cleanup: the same deletion, N sessions in one request, and only
  // those still paused when the server gets to them (bulk-delete route). The
  // cards go red for the duration exactly as with `deleteSessionOne`.
  async function deletePausedSessions(ids: string[]) {
    setDeletingSessionIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
    try {
      const r = await api.bulkDeleteSessions({ ids, onlyPaused: true });
      const gone = new Set([...r.deleted, ...r.missing]);
      const sync = (r as { sync?: SyncRev }).sync;
      for (const id of gone) addOverlay(id, { removed: true }).ack(sync);
      // Functional: the user may have navigated while the request ran.
      setSelectedId((current) => (current && gone.has(current) ? null : current));
      return r;
    } finally {
      setDeletingSessionIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      refreshIfDegraded();
    }
  }

  async function patchSession(id: string, body: { name?: string | null; color?: string | null; cwd?: string }) {
    const o = addOverlay(id, body as Partial<SessionSummary>);
    try {
      const r = await api.patchAgentSession(id, body);
      o.ack(r?.sync);
      refreshIfDegraded();
    } catch (e: any) {
      o.fail();
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
  }

  async function updateSessionHandle(sess: SessionListItem, value: string) {
    // The route normalizes the handle: the overlay carries ITS answer.
    const updated = await api.updateSessionHandle(sess.id, value);
    addOverlay(sess.id, { handle: updated?.handle ?? null } as Partial<SessionSummary>).ack(updated?.sync);
    setHandleEditor(null);
    refreshIfDegraded();
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
  async function respondPermissionCrossSession(
    sessionId: string, permId: string, allow: boolean, always: boolean, suggestion?: number,
  ) {
    try {
      await api.respondPermission(sessionId, permId, allow, always, suggestion);
      refreshIfDegraded();
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
  const selectedShellExists = !!selectedShell;

  // ── File panes that stay mounted (§14.111) ────────────────────────────────
  // Like the shells above: leaving a file tab must not tear its pane down —
  // the live page, the PDF, an image's zoom, a video's position and the
  // editor's scroll all live in it. The newest few stay, plus every one with
  // unsaved edits (evicting it would discard the buffer); hidden ones go
  // quiet (FileEditor `active`). Keyed like the tab, never by its id: a
  // provisional tab turning durable must not remount the pane.
  const fileTabsByKey = useMemo(() => {
    const m = new Map<string, ResolvedTab>();
    for (const t of resolvedTabs) if (t.kind === 'file') m.set(fileTabKey(t), t);
    return m;
  }, [resolvedTabs]);
  const selectedFileKey = selectedFile ? fileTabKey(selectedFile) : null;
  const dirtyFileKeys = useMemo(() => new Set(
    [...fileTabsByKey].filter(([, t]) => dirtyIds.has(t.id)).map(([k]) => k),
  ), [fileTabsByKey, dirtyIds]);
  const [mountedFileKeys, setMountedFileKeys] = useState<string[]>([]);
  useEffect(() => {
    setMountedFileKeys((prev) => {
      const next = nextMountedFiles(prev, selectedFileKey, new Set(fileTabsByKey.keys()), dirtyFileKeys, MAX_MOUNTED_FILES);
      return next.length === prev.length && next.every((k, i) => k === prev[i]) ? prev : next;
    });
  }, [selectedFileKey, fileTabsByKey, dirtyFileKeys]);
  // Rendered in MOUNT order, never in recency order: React moving a pane's
  // node re-inserts it, and a re-inserted iframe reloads (and scroll offsets
  // reset). The LRU above only decides who stays.
  const fileMountSeq = useRef(new Map<string, number>());
  const mountedFiles = useMemo(() => {
    const keys = [...mountedFileKeys];
    // The selection renders on its first frame, before the effect commits.
    if (selectedFileKey && !keys.includes(selectedFileKey)) keys.push(selectedFileKey);
    const seq = fileMountSeq.current;
    for (const k of [...seq.keys()]) if (!keys.includes(k)) seq.delete(k);
    let next = Math.max(0, ...seq.values()) + 1;
    for (const k of keys) if (!seq.has(k)) seq.set(k, next++);
    const out: ResolvedTab[] = [];
    for (const k of [...keys].sort((a, b) => seq.get(a)! - seq.get(b)!)) {
      const t = fileTabsByKey.get(k) ?? (k === selectedFileKey ? selectedFile : null);
      if (t) out.push(t);
    }
    return out;
  }, [mountedFileKeys, selectedFileKey, fileTabsByKey, selectedFile]);

  // Stable for the memoized ToolPanel beside a file or a shell (§14.38).
  const openSessionFromPanel = useStableCallback((id: string) => openSessionById(id, false));
  const revealTools = useCallback(() => setToolsOpen(true), []);

  // The global palette (SearchModal): stable callbacks, so its memoized
  // sections do not recompute on every hub render.
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const searchOpenSession = useStableCallback((id: string, pin: boolean) => openSessionById(id, pin));
  const searchOpenShell = useStableCallback((id: string, pin: boolean) => selectShell(id, pin));
  const searchOpenProject = useStableCallback((vpsId: string, path: string) => {
    closeDrawers();
    if (resolvedTabs.some((t) => t.vpsId === vpsId && t.path === path)) onPathRowClick(vpsId, path);
    else setWizard({ kind: 'agent', vpsId, cwd: path, offerShell: true });
  });
  const searchActionFolder = activeTab ? { vpsId: activeTab.vpsId, path: activeTab.path } : null;
  const searchActions = useMemo<SearchAction[]>(() => {
    const list: SearchAction[] = [
      { id: 'new-session', label: 'New session', keywords: 'agent create start', run: () => setWizard({ kind: 'agent' }) },
      { id: 'new-shell', label: 'New shell', keywords: 'terminal create start', run: () => setWizard({ kind: 'shell' }) },
    ];
    if (searchActionFolder) {
      const { vpsId, path } = searchActionFolder;
      list.push({ id: 'open-folder', label: 'Open folder…', keywords: 'directory project tab explorer', run: () => setFolderPicker({ vpsId, cwd: path }) });
    }
    list.push(
      { id: 'resume-session', label: 'Resume a session…', keywords: 'import scan history', run: () => setResumeOpen({}) },
      { id: 'paused-sessions', label: 'Paused sessions…', keywords: 'sleeping cleanup delete', run: () => setPausedCleanupOpen({ hidden: showHidden }) },
      { id: 'settings', label: 'Settings', keywords: 'preferences config', run: () => setSettingsOpen(true) },
      { id: 'vps-data', label: 'VPS & paths', keywords: 'servers machines projects data', run: () => setDataOpen(true) },
      { id: 'toggle-tools', label: 'Toggle tools panel', keywords: 'explorer git search side panel', run: toggleShowTools },
    );
    return list;
  }, [searchActionFolder?.vpsId, searchActionFolder?.path, toggleShowTools]);

  return (
    <PanelLayoutProvider value={initialPanels}>
    <div
      className={`app-root has-tools${navOpen ? ' nav-open' : ''}${toolsOpen ? ' tools-open' : ''}${menuOpen ? ' menu-open' : ''}`}
      style={{ '--side-w': `${panels.sideW}px`, '--tools-w': `${panels.toolsW}px` } as React.CSSProperties}
      data-side={sideTier(panels.sideW)}
      data-tools={toolsTier(panels.toolsW)}
    >
      {/* Backdrop behind any open drawer (mobile only; CSS-gated). Tap to close. */}
      <div className="drawer-backdrop" onClick={closeDrawers} aria-hidden />
      <header className="app-head">
        {/* ☰ opens the sidebar drawer; CSS reveals it only ≤820px (.m-only). */}
        <button
          className="head-btn m-only nav-toggle"
          onClick={() => { setNavOpen(true); setToolsOpen(false); setMenuOpen(false); }}
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
        {/* The desk: the same sessions, the same engines, read as a machine
            room in three.js. It is a PLACE, not a panel — it has its own route
            and its own tab, so it renders on its own while you keep reading a
            session here (app/desk, served at /desk).
            A new tab is the whole point: the room takes the screen and the
            keyboard (WASD floats through it), which is not something a drawer
            can share with the chat box.
            This anchor and its phone twin in the ⋮ drawer (head-right) are the
            ONLY references to /desk outside app/desk/ — delete that folder and
            these two are the ones left pointing nowhere. Hidden ≤820px: a
            WASD room is no use under a finger, and the header row needs the room. */}
        <a
          className="head-btn head-desk"
          href="/desk"
          target="_blank"
          rel="noopener noreferrer"
          title="the desk — Charon's machine room"
          aria-label="open the desk, the machine room, in a new tab"
        >
          <IconRobot />
        </a>
        {/* Jump to a session without hunting for it in the sidebar: the same
            data that sidebar holds, read as activity (app/HeaderSessionNav.tsx). */}
        <HeaderSessionNav
          sessions={viewSessions}
          shells={shells}
          vpsName={vpsNameOf}
          selectedId={selectedId ?? selectedShellId}
          onOpen={openFromNav}
          onOpenShell={openShellFromNav}
        />
        {/* One button per login: its usage, its sessions, its attention. */}
        <AccountNav
          groups={accountGroups}
          onRefreshUsage={refreshAccountGroupUsage}
          vpsName={vpsNameOf}
          selectedId={selectedId}
          onOpen={openFromNav}
        />
        <div className="head-right">
          {/* Mobile only (CSS ≤820px): head-right becomes the right menu
              drawer; the toggle that opens it lives OUTSIDE head-right (below)
              so it stays visible. Desktop: the buttons flow inline. */}
          {/* No "<vps>:<cwd>" context string and no status pill here: the
              session bar (`SessionView`) already carries the name, the
              cwd and the live state (ThinkingBar/status), and the sidebar card
              carries it too — a third, 4s-stale copy in the app header was
              pure duplication. */}
          {/* No "×N connected clients" pill either: nobody acted on it. */}
          {/* Version skew (a new build deployed) or an older hub (degraded
              transport): ONE chip, never an automatic reload over a draft
              (globalEventStream.ts § maybeReloadForBuild). */}
          {reloadChip && (
            <button
              className="head-btn toggle-btn is-on reload-chip"
              onClick={() => { try { window.location.reload(); } catch {} }}
              title={reloadChip === 'build'
                ? 'Charon was updated — reload to use the new version (unsent drafts are lost)'
                : 'This page is newer than the hub — reload when convenient (unsent drafts are lost)'}
              aria-label="Charon was updated, reload"
              data-label="charon was updated — reload"
            >
              <IconArrowClockwise />
              <span className="reload-chip-label">reload</span>
            </button>
          )}
          <button className="head-btn" onClick={() => setSearchOpen(true)} title="search sessions, projects, files, messages (Ctrl/Cmd+K)" aria-label="search" data-label="search">
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
            disabled={pushBusy}
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
          <button className="head-btn model-notice-anchor" onClick={() => setAccountsOpen(true)}
            title={accountsNeedAttention(accountsState.data, backends) ? 'accounts — action needed' : 'accounts — sign in once, for every VPS'}
            aria-label="accounts" data-label="accounts">
            <IconPeople />
            {accountsNeedAttention(accountsState.data, backends) && <span className="model-notice-dot" aria-hidden="true" />}
          </button>
          <button className="head-btn" onClick={() => setDataOpen(true)} title="VPS, projects, paths" aria-label="VPS data" data-label="vps, projects & paths">
            <IconServers />
          </button>
          {/* The phone's way to the desk (the header link is hidden there). */}
          <a
            className="head-btn m-only desk-drawer-link"
            href="/desk"
            target="_blank"
            rel="noopener noreferrer"
            title="the desk — Charon's machine room"
            aria-label="open the desk, the machine room, in a new tab"
            data-label="the desk"
          >
            <IconRobot />
          </a>
          <button className="head-btn model-notice-anchor" onClick={() => setSettingsOpen(true)} title={hasNewModels ? "settings — new models available" : "settings"} aria-label={hasNewModels ? "settings — new models available" : "settings"} data-label="settings">
            <IconGear />
            {hasNewModels && <span className="model-notice-dot" aria-hidden="true" />}
          </button>
        </div>
        {/* Mobile-only right-drawer toggles (CSS-gated). They live OUTSIDE
            head-right because head-right itself becomes the drawer ≤820px. The
            tools-toggle (ToolPanel drawer, ≤1100px) moved here from inside
            head-right for the same reason. cf. CLAUDE.md §14.58 / §11. */}
        <div className="head-toggles">
        {(selectedId || selectedShellExists || selectedFile) && (
          <button
            className="head-btn m-only tools-toggle"
            onClick={() => { setToolsOpen(true); setNavOpen(false); setMenuOpen(false); }}
            title="diffs, tool calls & files" aria-label="open tool panel"
          >
            <IconPanelRight />
          </button>
        )}
        {/* The phone's settings live in this drawer, so the new-models dot
            rides its toggle — the drawer's own copy is invisible until opened. */}
        <button
          className="head-btn m-only menu-toggle model-notice-anchor"
          onClick={() => { setMenuOpen(true); setNavOpen(false); setToolsOpen(false); }}
          title={hasNewModels ? 'menu — new models available' : 'menu'}
          aria-label={hasNewModels ? 'open menu — new models available' : 'open menu'}
        >
          <IconThreeDotsVertical />
          {hasNewModels && <span className="model-notice-dot" aria-hidden="true" />}
        </button>
        </div>
      </header>
      <Sidebar
        noticeSlot={(
          <AccountsBanner data={accountsState.data} loaded={accountsState.loaded} enabled={backends} hasVps={vpsList.length > 0}
            onLogin={(provider, accountId) => setHubLogin({ provider, accountId })} />
        )}
        toolbarSlot={(
          <SidebarPathFilter
            groups={knownFilterGroups}
            filter={pathFilter}
            vpsFilter={vpsFilter}
            vpsNameOf={vpsNameOf}
            hiddenCount={hiddenCount}
            hiddenWaitingCount={hiddenWaitingCount}
          />
        )}
        // Passed only when a filter is really on, so Sidebar can read its
        // presence as "a filter is active" — and pays nothing when it is not.
        isEntityShown={filterActive ? isEntityShown : undefined}
        sessionHandles={sessionHandles}
        showTools={showTools}
        onToggleShowTools={toggleShowTools}
        holdPeek={!!ctxMenu || !!editingId}
        vpsList={vpsList}
        vpsFolders={vpsFolders}
        vpsPaths={vpsPaths}
        sessions={sessions}
        deletingSessionIds={deletingSessionIds}
        shells={shells}
        installs={installs}
        selectedId={selectedId}
        selectedShellId={selectedShellId}
        selectedInstallId={selectedInstallId}
        openTabRef={activeTab?.ref ?? null}
        activeWorkspace={activeTab ? { vpsId: activeTab.vpsId, path: activeTab.path } : null}
        onSelect={selectSession}
        onSelectShell={selectShell}
        onSelectInstall={selectInstall}
        onReorderSessions={(vpsId, ids) => {
          // Optimistic: the row must land where it was dropped, not snap back
          // for the length of a request — one overlay per moved row, held
          // until the summaries carrying the new positions are in the store.
          const moved = sessions.filter((s) => s.vpsId === vpsId && ids.includes(s.id));
          const os = moved.map((s) => addOverlay(s.id, { position: ids.indexOf(s.id) } as Partial<SessionSummary>));
          void api.reorderSessions(vpsId, ids)
            .then((r) => { for (const o of os) o.ack(r?.sync); refreshIfDegraded(); })
            .catch(() => { for (const o of os) o.fail(); refreshSessions(); });
        }}
        enabledBackends={backends}
        onNew={(opts) => setWizard({ kind: 'agent', ...opts })}
        onNewShell={(opts) => setWizard({ kind: 'shell', ...opts })}
        onScan={(vpsId) => setResumeOpen({ vpsId })}
        onOpenData={() => setDataOpen(true)}
        onOpenPausedCleanup={(hidden) => setPausedCleanupOpen({ hidden })}
        onContext={(targets, x, y) => {
          const available = targets.filter((session) => !deletingSessionIds.has(session.id));
          if (available.length) setCtxMenu({ kind: 'session', sessions: available, x, y });
        }}
        onContextShell={(sh, x, y) => setCtxMenu({ kind: 'shell', shell: sh, x, y })}
        onContextInstall={(inst, x, y) => setCtxMenu({ kind: 'install', install: inst, x, y })}
        editingId={editingId}
        onRenameSubmit={renameSession}
        onRenameCancel={() => setEditingId(null)}
        onInstallAgent={openInstallSession}
        onProviderLogin={openProviderLogin}
        onProviderContext={(vps, provider, x, y, profile) => setCtxMenu({ kind: 'provider', vps, provider, x, y, profile })}
        signingOutAccounts={signingOutAccounts}
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
        staleness={buildMeta}
        updatingAgentVpsIds={updatingAgentVpsIds}
        refreshingAgentVpsIds={refreshingAgentVpsIds}
      />

      <TabBar
        resolved={resolvedTabs}
        showHidden={showHidden}
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
        enabledBackends={backends}
        onReorderVps={(vpsIds) => void reorderWorkspaceTabs({ scope: 'vps', vpsIds })}
        onReorderPaths={(vpsId, paths) => void reorderWorkspaceTabs({ scope: 'groups', vpsId, paths })}
        onReorderTabs={(vpsId, path, ids) => void reorderWorkspaceTabs({ scope: 'tabs', vpsId, path, ids })}
      />

      {/* Main panel routing: 3 mutually exclusive views.
          - selectedInstallId → <InstallSessionView> (full-screen install log)
          - selectedShellId   → <ShellTerminal> (ephemeral SSH xterm)
          - selectedId        → <SessionView> (chat + tool panel)
          - otherwise: placeholder. */}
      {selectedFile ? (
        <>
        {/* The pane itself lives in the file layer below (§14.111). The explorer has to stay: opening a file from the tree and losing
            the tree in the same gesture is how you end up clicking back and
            forth. The session-scoped tabs (diffs / attach / tools) render
            their empty states — there is no session here. */}
        <ToolPanel
          sessionId={null}
          toolCalls={[]}
          edits={emptyEdits}
          onRevert={NOOP}
          vpsId={selectedFile.vpsId}
          cwd={selectedFile.path}
          onOpenSession={openSessionFromPanel}
          onOpenFolder={openFolderPicker}
          onNewSessionIn={newSessionIn}
          onReveal={revealTools}
        />
        </>
      ) : selectedInstallId ? (() => {
        const inst = installs.find((i) => i.id === selectedInstallId);
        if (!inst) return <main className="app-main"><div className="bar-empty">install not found</div></main>;
        const vps = vpsList.find((v) => v.id === inst.vpsId);
        return (
          <InstallSessionView
            key={inst.id}
            installId={inst.id}
            vpsId={inst.vpsId}
            vpsName={inst.vpsName}
            onClosed={() => installClosed(inst.id)}
            onSetupLogin={vps ? () => openProviderLogin(vps, 'claude') : undefined}
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
        <>
          {/* The actual terminal lives in the persistent layer below. Its IDE
              is workspace-scoped, exactly like the panel beside a file: the
              shell contributes only its VPS and startup cwd. */}
          {selectedShellExists ? (
            <ToolPanel
              key={`shell-tools:${selectedShellId}`}
              sessionId={null}
              workspaceOnly
              toolCalls={[]}
              edits={emptyEdits}
              onRevert={NOOP}
              vpsId={selectedShell!.vpsId}
              cwd={selectedShellWorkspaceRoot}
              onOpenSession={openSessionFromPanel}
              onOpenFolder={openFolderPicker}
              onNewSessionIn={newSessionIn}
              onReveal={revealTools}
            />
          ) : (
            <main className="app-main"><div className="bar-empty">shell not found</div></main>
          )}
        </>
      ) : selected ? (
        // Error boundary: a render error in the chat subtree (hydration
        // mismatch, transient undefined, bad markdown) must NOT permanently
        // freeze the chat. The boundary catches it, shows "reconnecting…",
        // and remounts after ~1.5s → all effects (polling/SSE/refetch)
        // restart → self-heal. resetKey=selectedId clears errors on switch.
        // cf. CLAUDE.md §14 gotcha 24.
        <SessionErrorBoundary resetKey={selectedId ?? ''}>
        <SessionView
          key={selectedId}
          sessionId={selected.id}
          selected={selected}
          showTools={showTools}
          showToolsReady={showToolsReady}
          handle={sessionHandles.get(selected.id)?.handle ?? null}
          handleConfirmed={sessionHandles.get(selected.id)?.confirmed ?? false}
          // Other sessions on the SAME machine — the ones this session can
          // actually address (cross-session messaging is filesystem-scoped).
          siblings={sessions
            .filter((s) => s.vpsId === selected.vpsId
              && s.id !== selected.id && s.addressable && sessionHandles.has(s.id))
            .map((s) => ({
              id: s.id, name: s.name,
              handle: sessionHandles.get(s.id)?.handle ?? s.id.slice(0, 6),
              confirmed: sessionHandles.get(s.id)?.confirmed ?? false,
              status: (s.liveStatus ?? s.status) as string,
            }))}
          selectedVps={selectedVps}
          profileNumber={accountProfileNumber(selected)}
          usageAccountLabel={selectedUsageLabel}
          onUsageRefresh={() => refreshUsage(selectedVps?.id, asSessionProvider(selected.kind), accountProfileId(selected), true)}
          onReauth={reauthSelectedVps}
          // The git chip lives in the chat header but points at the ToolPanel,
          // which is a drawer <=1100px — it has to be able to reveal it.
          onOpenTools={revealTools}
          onOpenSession={(id, hint, pin) => openSessionById(id, pin ?? false, hint)}
          // No agentKind: the wizard asks which backend — or a shell — then
          // the name; the VPS and path are this session's (NewSessionWizard §
          // 'backend'). The phone has no tab bar, so this is its ＋ shell too.
          onNewAgentHere={selected.cwd
            ? () => setWizard({ kind: 'agent', vpsId: selected.vpsId, cwd: selected.cwd, offerShell: true })
            : undefined}
          onOpenFolder={openFolderPicker}
          onNewSessionIn={newSessionIn}
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
            refreshIfDegraded();
          }}
          onAfterRevert={() => refreshSessions()}
        />
        </SessionErrorBoundary>
      ) : (
      // No session selected: placeholder. ToolPanel is not rendered in this
      // case (before the refactor it was, with sessionId=null, but displayed
      // nothing useful).
      <main className="app-main">
        <div className="app-bar">
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
        <main className="app-main shell-main" style={{ display: selectedShellExists ? 'flex' : 'none' }}>
          {mountedShellList.map((sh) => (
            <div
              key={sh.id}
              className="shell-slot"
              style={{ display: selectedShellId === sh.id ? 'flex' : 'none' }}
            >
              <ShellTerminal
                shellId={sh.id}
                vpsName={vpsNameOf(sh.vpsId)}
                cwd={sh.cwd}
                active={selectedShellId === sh.id}
                onKilled={() => shellKilled(sh.id)}
              />
            </div>
          ))}
        </main>
      )}

      {/* Mounted file panes (§14.111): every file opened recently stays here,
          only the selected one visible. Hidden with `visibility`, not
          `display:none` — a display:none box loses its scroll offsets (the
          PDF's, the editor's) and its iframe's layout. `inert` keeps hidden
          panes out of the tab order and the screen reader. */}
      {mountedFiles.length > 0 && (
        <div className={`file-layer${selectedFile ? ' shown' : ''}`}>
          {mountedFiles.map((f) => {
            const on = fileTabKey(f) === selectedFileKey;
            return (
              <div key={fileTabKey(f)} className={`file-slot${on ? ' on' : ''}`} inert={!on} aria-hidden={!on}>
                <FileEditor
                  tabId={f.id}
                  vpsId={f.vpsId}
                  root={f.path}
                  path={f.ref}
                  active={on}
                  // Editing or saving is a real interaction: the tab stops being a
                  // preview so the next file opened here can't evict unsaved work.
                  onInteract={() => { if (!f.pinned) void pinWorkspaceTab(f.id); }}
                  // Go-to-definition. The target is an ABSOLUTE path from the language
                  // server; a tab is (group path, path relative to it), so anything
                  // outside this group's folder cannot be opened as a tab here.
                  onOpenLocation={(abs, line) => {
                    const base = f.path.replace(/\/+$/, '');
                    if (abs !== base && !abs.startsWith(base + '/')) return;
                    const rel = abs.slice(base.length + 1);
                    revealLine(f.vpsId, f.path, rel, line);
                    void openWorkspaceTab({ vpsId: f.vpsId, path: f.path, kind: 'file', ref: rel });
                  }}
                />
              </div>
            );
          })}
        </div>
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

      {accountsOpen && <AccountsModal enabled={(p) => backends[p]} onClose={() => setAccountsOpen(false)}
        onLogin={(provider, account) => setHubLogin({ provider, accountId: account?.id ?? null })} />}
      {hubLogin && <AccountLoginModal key={`${hubLogin.provider}:${hubLogin.accountId ?? 'new'}`} provider={hubLogin.provider}
        accountId={hubLogin.accountId} onClose={() => { setHubLogin(null); void refreshAccountProfiles(); }} />}
      {wizard && (
        <NewSessionWizard
          kind={wizard.kind}
          offerShell={wizard.offerShell}
          agentKind={wizard.agentKind}
          initialAccountProfile={wizard.accountProfile}
          onProfileLogin={openProviderLogin}
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
          enabledBackends={backends}
          onOpenSettings={(section) => { setWizard(null); setSettingsCat(section); setSettingsOpen(true); }}
        />
      )}

      {folderPicker && (() => {
        const v = vpsList.find((x) => x.id === folderPicker.vpsId);
        if (!v) return null;
        return (
          <OpenFolderModal
            vps={v}
            vpsPaths={vpsPaths}
            inUse={folderPickerInUse}
            onOpen={(path) => {
              openExplorerRoot(folderPicker.vpsId, folderPicker.cwd, path);
              setFolderPicker(null);
            }}
            onClose={() => setFolderPicker(null)}
          />
        );
      })()}

      {resumeOpen && (
        <ResumeModal
          vpsList={vpsList}
          dbSessions={sessions}
          enabledBackends={backends}
          initialVpsId={resumeOpen.vpsId}
          onClose={() => setResumeOpen(null)}
          onOpen={(id) => { setResumeOpen(null); openSessionById(id, true); }}
          onImported={(c) => { setResumeOpen(null); applyCreatedSession(c); }}
          onResumed={async (id) => {
            setResumeOpen(null);
            try { await api.resumeSession(id); }
            catch (e: any) { setError({ msg: String(e?.message ?? e) }); return; }
            openSessionById(id, true);
            refreshIfDegraded();
          }}
        />
      )}

      {searchOpen && (
        <SearchModal
          onClose={closeSearch}
          onPick={searchOpenSession}
          onOpenShell={searchOpenShell}
          onOpenProject={searchOpenProject}
          sessions={viewSessions}
          shells={shells}
          vpsList={vpsList}
          vpsPaths={vpsPaths}
          actions={searchActions}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); setSettingsCat(null); }} vpsList={vpsList} initialCat={settingsCat ?? undefined} modelNotices={modelNotices} onModelsSeen={markModelsSeen} />}
      {dataOpen && (
        <DataModal
          onClose={() => setDataOpen(false)}
          initialVps={vpsList}
          initialFolders={vpsFolders}
          initialPaths={vpsPaths}
          onChange={({ vps, folders, paths }) => {
            // The modal owns CRUD fields only: the runtime fields of a VPS it
            // already knew stay ours (it holds a copy from when it opened —
            // R3 F4: a CRUD action reverted every newer login/version).
            setVpsList((prev) => vps.map((v) => {
              const cur = prev.find((x) => x.id === v.id);
              return cur
                ? ({ ...v, ...pickVpsRuntimeFields(cur as unknown as Record<string, unknown>) } as Vps)
                : v;
            }));
            setVpsFolders(folders);
            setVpsPaths(paths);
          }}
          onInstallAgent={openInstallSession}
          onRefreshAgent={(v) => { runRefreshAgent(v); }}
          onUpdateAgent={(v) => { runUpdateAgent(v); }}
          onProviderLogin={openProviderLogin}
          onEditSettingScope={(v) => void openSettingScope(v)}
          refreshingAgentVpsIds={refreshingAgentVpsIds}
          updatingAgentVpsIds={updatingAgentVpsIds}
          liveVps={vpsList}
          staleness={buildMeta}
        />
      )}

      {/* Device-code logins (Codex §14.61, Claude §14.64) — rendered AFTER the
          wizard/data modal so they overlay whichever surface launched them.
          loginVps/codexLoginVps are cross-panel (sidebar, health chips,
          install view), hence a single global mount each. */}
      {loginTarget && (() => {
        const { Modal } = PROVIDER_LOGIN[loginTarget.provider];
        return <Modal key={`${loginTarget.vps.id}:${loginTarget.provider}:${loginTarget.profile?.id ?? "default"}`} vps={loginTarget.vps} profile={loginTarget.profile} onClose={closeProviderLogin} />;
      })()}

      {scopeModal && (
        <SettingScopeModal
          vpsName={scopeModal.vps.name}
          initial={scopeModal.vps.claudeSettingSources ?? null}
          hubDefault={scopeModal.hubDefault}
          confirmLabel={scopeModal.mode === 'install' ? 'save & install agent' : 'save'}
          busyLabel={scopeModal.mode === 'install' ? 'starting…' : 'saving…'}
          onClose={() => setScopeModal(null)}
          onConfirm={async (value) => {
            const { vps, mode } = scopeModal;
            const stored = value == null ? null : formatSettingSources(value);
            // Only write when it actually changed: an install must not fail
            // because a no-op PATCH did.
            if (stored !== (vps.claudeSettingSources ?? null)) {
              const updated = await api.updateVps(vps.id, { claudeSettingSources: stored });
              setVpsList((prev) => prev.map((v) => (v.id === vps.id
                ? ({ ...v, claudeSettingSources: updated?.claudeSettingSources ?? stored } as Vps)
                : v)));
            }
            setScopeModal(null);
            if (mode === 'install') await startInstallSession(vps);
          }}
        />
      )}

      {ctxMenu && ctxMenu.kind === 'provider' && (() => {
        const { provider, x, y, profile } = ctxMenu;
        const v = vpsList.find((v) => v.id === ctxMenu.vps.id) ?? ctxMenu.vps;
        return <ProviderAccountMenu key={`${v.id}:${provider}:${profile?.id ?? "default"}`}
          vps={v} provider={provider} profile={profile && profile.id !== 'default' ? profile : undefined} x={x} y={y}
          onLogin={() => openProviderLogin(v, provider, profile)}
          onManage={() => setAccountsOpen(true)}
          onClose={() => setCtxMenu(null)}
        />;
      })()}

      {ctxMenu && ctxMenu.kind === 'session' && (() => {
        const targets = ctxMenu.sessions;
        const single = targets.length === 1 ? targets[0] : null;
        const sleepTargets = targets.filter(canSleepSession);
        const resumeTargets = targets.filter(canResumeSession);
        return <SessionContextMenu
          title={single
            ? (single.name || single.cwd.split('/').slice(-2).join('/'))
            : `${targets.length} sessions selected`}
          subtitle={single ? single.cwd : 'bulk session actions'}
          x={ctxMenu.x}
          y={ctxMenu.y}
          currentColor={single ? (single as any).color : null}
          // No `onKill` here: the kill→delete rework merged the two
          // actions. Only `onDelete` remains for Claude sessions. The
          // shells/installs below keep their `onKill` (= close).
          //
          // `onSleep` is only passed if the session is in a state where sleep
          // makes sense (active/thinking/starting/failed). For sleeping/error/killed,
          // the item disappears from the menu (the "resume" button in the
          // chat header takes care of waking up the session; we don't duplicate here).
          showRename={!!single}
          showColor={!!single}
          onRename={single ? () => setEditingId(single.id) : undefined}
          onEditHandle={single ? () => setHandleEditor(single) : undefined}
          onEditCwd={single ? () => editSessionCwd(single) : undefined}
          onColor={single ? (color) => patchSession(single.id, { color }) : undefined}
          onSleep={sleepTargets.length ? () => runSessionLifecycle('sleep', sleepTargets) : undefined}
          sleepLabel={sleepTargets.length > 1 ? `💤 Sleep ${sleepTargets.length} sessions` : '💤 Sleep'}
          onResume={resumeTargets.length ? () => runSessionLifecycle('resume', resumeTargets) : undefined}
          resumeLabel={resumeTargets.length > 1 ? `Resume ${resumeTargets.length} sessions` : 'Resume'}
          onArchive={single ? () => archiveOne(single.id) : undefined}
          // Every target is on the side the switch shows, so one verb fits
          // them all: hide from the normal view, show from the hidden one.
          onHide={() => setHidden(targets, !targets.every((t) => t.hidden === 1))}
          hideLabel={targets.every((t) => t.hidden === 1)
            ? (targets.length > 1 ? `Show ${targets.length} sessions` : 'Show (unhide)')
            : (targets.length > 1 ? `Hide ${targets.length} sessions` : 'Hide')}
          onDelete={() => setConfirmDelete(targets)}
          deleteLabel={targets.length > 1 ? `Delete ${targets.length} permanently` : 'Delete permanently'}
          onClose={() => setCtxMenu(null)}
        />
      })()}
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

      {handleEditor && (
        <PromptModal
          title="Change session address"
          hint={<>Stable on this VPS and independent from the display name. You may type it with or without <code>@</code>; spaces and accents are normalized.</>}
          initial={handleEditor.handle ?? ''}
          placeholder="api-worker"
          confirmLabel="change address"
          busyLabel="changing…"
          icon="@"
          validate={(value) => value.replace(/^@/, '').trim() ? null : 'a handle is required'}
          onSubmit={(value) => updateSessionHandle(handleEditor, value)}
          onClose={() => setHandleEditor(null)}
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

      {pausedCleanupOpen && (
        <PausedSessionsModal
          hidden={pausedCleanupOpen.hidden}
          sessions={sessions.filter((s) => (s.hidden === 1) === pausedCleanupOpen.hidden)}
          vpsList={vpsList}
          vpsFolders={vpsFolders}
          deletingSessionIds={deletingSessionIds}
          onDelete={deletePausedSessions}
          onClose={() => setPausedCleanupOpen(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.length === 1 ? 'Delete session' : `Delete ${confirmDelete.length} sessions`}
          confirmLabel={confirmDelete.length === 1 ? 'delete permanently' : `delete ${confirmDelete.length} permanently`}
          busyLabel="deleting…"
          onConfirm={() => {
            // Start, close, then let the red sidebar card own progress.
            for (const session of confirmDelete) deleteSessionOne(session.id);
            setConfirmDelete(null);
          }}
          onClose={() => setConfirmDelete(null)}
        >
          {confirmDelete.length === 1 ? (
            <div className="confirm-target">
              <span className="ct-name">
                {confirmDelete[0].name || confirmDelete[0].cwd.split('/').slice(-2).join('/')}
              </span>
              <span className="ct-sub">{confirmDelete[0].cwd}</span>
            </div>
          ) : (
            <ul className="confirm-list">
              {confirmDelete.map((session) => (
                <li key={session.id}>{session.name || session.cwd.split('/').slice(-2).join('/')}</li>
              ))}
            </ul>
          )}
          <p className="confirm-text">
            {confirmDelete.length === 1 ? 'The session and its whole history' : 'These sessions and their whole histories'}
            {' (messages, permissions, logs) will be permanently deleted. This cannot be undone — to keep them around, pause them instead.'}
          </p>
        </ConfirmModal>
      )}
    </div>
    </PanelLayoutProvider>
  );
}

// InlinePermissionCard, ThinkingBar, fmtElapsed: moved into
// `./SessionView.tsx` (used only by the session view).
// rebuildStateFromMessages: in `./sessionRebuild.ts`.

// Notification sound. Played by HubPanel when another session goes
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
// notification — the SW push message (immediate) and the 60s poll
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
