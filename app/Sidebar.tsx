'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { SessionListItem, InstallInfo, AgentKind, VpsStalenessBaselines } from '@/lib/types/api';
import { IconAlarm, IconArrowClockwise, IconCheck2Circle, IconClockHistory, IconLightningCharge, IconListUl, IconMoon, IconPencil, IconRobot, IconServers, IconTerminal, IconTrash, IconWrench } from './icons';
import { getDraft, useHasDraft } from './inputDraftStore';
import { fmtMoment } from './taskTime';
import { describeSchedule, scheduledTaskTitle, type ScheduledTask } from '@/lib/scheduledTasks';
import AgentLogo, { agentLogoLabel } from './AgentLogo';
import { useAccountProfiles } from './accountProfileStore';
import { accountProfileNumber, type AccountProfile } from '@/lib/accountProfiles';
import { AccountChoiceMark, AccountChoiceMenu, accountChoices, useAccountChoice, vpsForProfile } from './AccountChoice';
import { providerText, providerName } from '@/lib/providerText';
import { useReorder, type ReorderItemProps } from './useReorder';
import { colorToCss } from './SessionContextMenu';
import { useLongPress } from './useLongPress';
import { useStableCallback, useStableOptionalCallback } from './useStable';
import { isVersionOutdated, isAgentOutdated, agentBuildRelation } from '@/lib/version';
import { backendAvailability, backendLauncher, parseAgentLastError, type BackendLauncher } from './vpsHealth';
import { isTreeSelectionOnly, selectTreeRow, type TreeSelectionModifiers } from './treeSelection';
import { isSameWorkspace, type WorkspaceScope } from './workspaceScope';
import {
  mergeSidebarPathGroupOrder, mergeSidebarPathOrder, sidebarPathKey, sidebarPathOrder,
  sidebarPathOrderedIds, sidebarVisiblePathItems,
} from './sidebarPathGroups';
import { ALL_BACKENDS_ENABLED, enabledKinds, type EnabledBackends } from './enabledBackends';
import {
  DEFAULT_SESSION_PROVIDER, PROVIDERS, SESSION_PROVIDERS, providerBackendState,
} from '@/lib/sessionCapabilities';
import { reconcileSidebarSessionSelection } from './sidebarSessionSelection';
import { attentionForRow, pendingSplit, rowStatus, shellAttention } from '@/lib/sessionAttention';
import { useShowPaused } from './showPaused';
import { focusAdmits, focusEmptyText, sessionFocusFacts, shellFocusFacts } from './sidebarFocus';
import PanelResizer from './PanelResizer';
import { usePanelLayout } from './panelLayoutStore';
import { tipAttrs } from './tooltipText';
import { CacheFlame, SessionCacheMark, cacheClockActive, cacheTipSection, sessionCacheFootText, useCacheTick, useSessionCacheReading } from './PromptCacheMarks';
import { cacheHeat } from '@/lib/promptCache';
import { isPanelClosed, sideTier } from './panelLayout';
import { isPausedSession } from './pausedCleanup';

// SessionListItem is defined in `lib/types/api.ts` (source of truth,
// aligned with the GET /api/sessions response). We re-export it
// here so we don't break the historical `import { SessionListItem }
// from './Sidebar'` imports.
export type { SessionListItem };

// Re-export for consumers (HubPanel) that pass installs.
export type { InstallInfo };

const DETAILS_KEY = 'hub.claude.showDetails.v1';
// The focus chips ("unread", "running"), browser-local like DETAILS_KEY.
const FOCUS_UNREAD_KEY = 'hub.claude.focusUnread.v1';
const FOCUS_RUNNING_KEY = 'hub.claude.focusRunning.v1';
const FOCUS_WARM_KEY = 'hub.claude.focusWarm.v1';
const ACTIVE_STATUSES = new Set(['active', 'thinking', 'starting', 'failed', 'background']);

function pathCollapseKey(vpsId: string, cwd: string | null | undefined): string {
  return JSON.stringify([vpsId, sidebarPathKey(cwd)]);
}

// How long a FINISHED install keeps its VPS in the sidebar. `running` alone
// was the rule, and it made a fresh machine — which by definition has no
// session or shell yet — take its whole box away the instant the install
// ended: the log row vanished at the exact moment the user was reading the
// result and about to create the first session there, and it read as "Charon
// folded the VPS by itself". The install session stays in memory anyway
// (§14.22), so the row remains reopenable; this only decides how long the
// machine keeps a place in the list without any content of its own.
const INSTALL_LINGER_MS = 30 * 60_000;

export function installKeepsVpsVisible(install: InstallInfo | null, selectedInstallId: string | null): boolean {
  if (!install) return false;
  if (install.status === 'running') return true;
  // Open in the main pane ⇒ visible for as long as it is being read, whatever
  // the age: a sidebar that doesn't list what fills the screen is a bug.
  if (install.id === selectedInstallId) return true;
  return install.endedAt != null && Date.now() - install.endedAt < INSTALL_LINGER_MS;
}

function useCollapsedGroups(storageKey: string) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (Array.isArray(saved)) setCollapsed(new Set(saved.filter((id): id is string => typeof id === 'string')));
    } catch {}
  }, [storageKey]);
  const update = useCallback((id: string, value?: boolean) => {
    setCollapsed((current) => {
      const collapse = value ?? !current.has(id);
      if (current.has(id) === collapse) return current;
      const next = new Set(current);
      if (collapse) next.add(id); else next.delete(id);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch {}
      return next;
    });
  }, [storageKey]);
  return [collapsed, update] as const;
}

let ageDateFormat: Intl.DateTimeFormat | null = null;
function formatAge(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'min';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
  // ONE formatter for every card (toLocaleDateString builds one per call).
  ageDateFormat ??= new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short' });
  return ageDateFormat.format(new Date(unixSeconds * 1000));
}

// One shared minute clock for the cards' ages ("5min", "3h"): a memoized card
// (§14.38) has no other reason to redraw while nothing about it changes.
let minuteNow = 0;
const minuteSubs = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
function subscribeMinute(cb: () => void): () => void {
  minuteSubs.add(cb);
  if (!minuteTimer) {
    minuteNow = Math.floor(Date.now() / 60_000);
    minuteTimer = setInterval(() => {
      minuteNow = Math.floor(Date.now() / 60_000);
      for (const f of minuteSubs) f();
    }, 60_000);
  }
  return () => {
    minuteSubs.delete(cb);
    if (!minuteSubs.size && minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
  };
}
function useMinuteTick(): number {
  return useSyncExternalStore(subscribeMinute, () => minuteNow, () => 0);
}

/** `formatAge` as a phrase: "created 3h ago", "created just now", "created Oct 02". */
function agePhrase(verb: string, age: string): string {
  return /^\d+(?:min|h|d)$/.test(age) ? `${verb} ${age} ago` : `${verb} ${age}`;
}

function cwdTail(cwd: string, max = 34): string {
  return cwd.length > max ? '…' + cwd.slice(-(max - 1)) : cwd;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A card's scheduled tasks, soonest first (lib/scheduledTasks.ts). */
function scheduledTaskList(s: SessionListItem): ScheduledTask[] {
  const tasks = s.scheduledTasks?.tasks ?? [];
  return tasks.length < 2 ? tasks
    : [...tasks].sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity));
}

/** The alarm mark's tooltip: one task per row, when it runs next. */
function scheduledTip(tasks: ScheduledTask[]): string[] {
  const now = Date.now();
  return tasks.slice(0, 4).map((t) => {
    const when = t.nextFireAt != null ? fmtMoment(t.nextFireAt, now) : describeSchedule(t.schedule, t.recurring);
    return `${when} · ${scheduledTaskTitle(t)}`;
  }).concat(tasks.length > 4 ? [`+${tasks.length - 4} more`] : []);
}

// Per-VPS backend availability (multi-agent) — thin aliases over the shared
// diagnosis (app/vpsHealth.tsx § backendAvailability), which also feeds the
// DataModal health chips + the wizard rows. Claude needs the Charon agent up
// AND `claude login`; Codex needs the openai-codex SDK importable AND a Codex
// login (codexLoggedIn !== 0 — null/never-checked is treated as "maybe", not a
// hard block). Returns a precise human reason when disabled (tooltip on the
// greyed button): "VPS unreachable (SSH)" vs "agent stopped" vs "not signed
// in"… cf. CLAUDE.md §14.59.
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
  // Live activity (agent >= 0.9.0): 'busy' while the PTY streams output →
  // amber-pulse dot, like a "thinking" Claude session. Fed by the global SSE
  // bus in HubPanel; undefined = idle/at-prompt. Structurally mirrors
  // ShellInfo so the two stay assignable.
  liveStatus?: 'active' | 'busy';
  /** Hub ms of its last finished activity (ShellInfo); orders the header nav. */
  lastActivityMs?: number | null;
  /** Durable "finished, unread" (ShellInfo, `shell_unread` frames). */
  unreadFinish?: boolean;
};

type Props = {
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  sessions: SessionListItem[];
  /** Sessions whose permanent DELETE is running in the background. */
  deletingSessionIds?: ReadonlySet<string>;
  shells: ShellListItem[];
  // Agent install sessions. In-memory only, like the shells. Listed per
  // VPS. An install session appears above the cards when active OR
  // recently finished (max 1 per VPS, cf. installSession.ts).
  installs: InstallInfo[];
  selectedId: string | null;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  /** The OPEN tab's entity id, whatever its kind. ⚠ Not derivable from the
   *  three above: a FILE tab has no sidebar row, so they are all null exactly
   *  as when nothing is open — and the two answers differ for the selection
   *  (`sidebarSessionSelection.ts`). */
  openTabRef?: string | null;
  /** The active tab-row group. Every session/shell at this exact VPS + path
   *  receives the workspace ring, independently of which entity is open. */
  activeWorkspace?: WorkspaceScope | null;
  /** Rendered on the SESSIONS row, in the button group at its right. A
   *  control that is off almost all the time does not get a line of the
   *  sidebar to itself. */
  toolbarSlot?: React.ReactNode;
  /** Display filter. Applied when listing a VPS, never when computing a
   *  reorder: the drag handlers need the complete list (sidebarPathGroups). */
  isEntityShown?: (vpsId: string, path: string | null, kind: 'session' | 'shell') => boolean;
  onSelect: (id: string, pin?: boolean) => void;
  onSelectShell: (id: string, pin?: boolean) => void;
  onSelectInstall: (id: string) => void;
  /** Reorder the sessions of ONE vps (drag & drop). §14.80 */
  onReorderSessions?: (vpsId: string, ids: string[]) => void;
  /** Backends this hub offers (Settings → Claude/Codex). A disabled backend
   *  loses its ＋ button on every VPS; with both off only the shell one is
   *  left. Display only — running sessions of that kind are untouched. */
  enabledBackends?: EnabledBackends;
  onNew: (opts: { vpsId?: string; cwd?: string; agentKind?: AgentKind; accountProfile?: string }) => void;
  onNewShell: (opts: { vpsId?: string; cwd?: string | null }) => void;
  onScan: (vpsId: string) => void;
  // "Manage VPS & folders" button in the sidebar toolbar.
  onOpenData: () => void;
  /** The trash beside "show paused": the paused-sessions cleanup modal. */
  onOpenPausedCleanup?: () => void;
  onContext?: (sessions: SessionListItem[], x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  onContextInstall?: (install: InstallInfo, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  // Opens an install session for this VPS (creates one if it doesn't
  // exist, focuses the existing one otherwise).
  onInstallAgent?: (vps: Vps) => void;
  onProviderLogin?: (vps: Vps, provider: AgentKind, profile?: AccountProfile) => void;
  onProviderContext?: (vps: Vps, provider: AgentKind, x: number, y: number, profile?: AccountProfile) => void;
  signingOutAccounts?: ReadonlySet<string>;
  // Codex device-code sign-in (opens HubPanel's CodexLoginModal, §14.61).
  onUpdateAgent?: (vps: Vps) => void;
  // Re-establish the agent connection (for a VPS shown as 'error' that is
  // actually healthy — the SSH transport just dropped). See
  // /api/vps/[id]/agent/refresh.
  onRefreshAgent?: (vps: Vps) => void;
  // Toggle a folder's collapsed state (persisted in DB via PATCH /api/vps-folders/[id]).
  onToggleFolderCollapsed?: (folderId: string, collapsed: boolean) => void;
  // `__version__` of the .pyz embedded in the dashboard — THE out-of-date baseline: a VPS is stale iff it
  // runs a STRICTLY OLDER version (ordered, so a hub on an older build never
  // rolls a co-tenant's newer agent back, §14.70).
  // Every DECLARED release line's latest, keyed by its registry `latestKey`
  // — compared to the VPS's reported version for the "out of date" badge and
  // the update bar. A bag, not N props: named individually, a newly declared
  // line never reached this component and its axis was invisible (§14.102).
  staleness?: VpsStalenessBaselines;
  // VPSes for which an update is in progress (UI loading)
  updatingAgentVpsIds?: Set<string>;
  // VPSes for which a refresh (reconnect) is in progress (UI loading)
  refreshingAgentVpsIds?: Set<string>;
  /** sessionId → addressable handle, unique per VPS. Computed by HubPanel
   *  over the FULL session list: deriving it here would let a display filter
   *  (hide paused) silently re-point `@name` at a different session. */
  sessionHandles?: Map<string, { handle: string; confirmed: boolean }>;
  /** Browser-local transcript filter. The parent owns it because the switch
   *  lives here while the filtered messages live in SessionView. */
  showTools: boolean;
  onToggleShowTools: () => void;
  /** Something opened FROM the peek is still in use (its context menu, an
   *  inline rename): the peek must not close under it when the pointer leaves
   *  for the menu. Never opens a peek by itself. */
  holdPeek?: boolean;
};

/** The closed sidebar opens the moment the pointer enters it, and closes only
 *  after a brief exit: a pointer grazing out and back must not flicker it. */
const PEEK_CLOSE_MS = 260;

export const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:       { glyph: '●', label: 'agent operational' },
  missing:  { glyph: '○', label: 'agent not installed' },
  error:    { glyph: '◐', label: 'agent unreachable — connection dropped' },
  unknown:  { glyph: '?', label: 'agent never tested' },
};

export default function Sidebar({
  vpsList, vpsFolders, sessions, shells, installs,
  deletingSessionIds = new Set(),
  selectedId,
  selectedShellId, selectedInstallId,
  openTabRef = null,
  activeWorkspace = null,
  toolbarSlot, isEntityShown,
  onSelect, onSelectShell, onSelectInstall, onReorderSessions,
  enabledBackends = ALL_BACKENDS_ENABLED,
  onNew, onNewShell, onScan, onOpenData, onOpenPausedCleanup,
  onContext, onContextShell, onContextInstall,
  editingId, onRenameSubmit, onRenameCancel,
  onInstallAgent, onProviderLogin, onProviderContext, signingOutAccounts,
  onUpdateAgent, onRefreshAgent, onToggleFolderCollapsed,
  staleness, updatingAgentVpsIds, refreshingAgentVpsIds,
  sessionHandles,
  showTools, onToggleShowTools,
  holdPeek = false,
}: Props) {

  const [collapsedVps, setVpsCollapsed] = useCollapsedGroups('hub.claude.collapsedVps.v2');
  const [collapsedPaths, setPathCollapsed] = useCollapsedGroups('hub.claude.collapsedPaths.v1');

  // Show / hide paused (sleeping) sessions. Default ON (= show everything).
  // Shared with the workspace strip, which filters on the same switch
  // (app/showPaused.ts) — one list hiding a session while the other keeps its
  // tab is the same session answering two ways.
  const [showPaused, toggleShowPaused] = useShowPaused();
  // Show / hide per-card details (first-message preview, cwd, age). Default OFF
  // (= compact one-line cards — the full info stays in the card tooltip); the
  // denser default keeps a many-VPS fleet scannable. Opt back IN via the
  // "details" toggle, persisted as DETAILS_KEY==='1'.
  const [showDetails, setShowDetails] = useState(false);
  // Focus chips: list only what finished unread and/or what is running. They
  // ADD up (both on = either kind), and narrow every other filter's result.
  const [focusUnread, setFocusUnread] = useState(false);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusWarm, setFocusWarm] = useState(false);
  // Browser-local Windows-style selection. `selectedId` remains the ONE open
  // workspace tab; this set is only what a bulk context action targets.
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const sessionSelectionAnchor = useRef<string | null>(null);
  // Opening a session collapses the selection onto it, whatever opened it — a
  // plain click here, the header nav, a notification, a tab, a new row — and
  // opening anything ELSE (shell, install, file) empties it: the open tab is
  // the only selected row. Kept on the tab ids rather than plumbed through
  // every caller: the tab bridge is the ONE place they all pass through, and a
  // leftover highlight on the session you just left reads as two selected
  // cards (it is even louder, cf. `.cs-card.multi-selected`). Ctrl/Shift build
  // a multi-selection without navigating, so this cannot erase one.
  useEffect(() => {
    setSelectedSessionIds((current) => {
      const next = reconcileSidebarSessionSelection(current, selectedId, openTabRef);
      if (next !== current) sessionSelectionAnchor.current = selectedId;
      return next;
    });
  }, [selectedId, openTabRef]);
  useEffect(() => {
    const live = new Set(sessions.map((session) => session.id));
    setSelectedSessionIds((current) => {
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
    if (sessionSelectionAnchor.current && !live.has(sessionSelectionAnchor.current)) {
      sessionSelectionAnchor.current = null;
    }
  }, [sessions]);
  useEffect(() => {
    try {
      if (localStorage.getItem(DETAILS_KEY) === '1') setShowDetails(true);
      if (localStorage.getItem(FOCUS_UNREAD_KEY) === '1') setFocusUnread(true);
      if (localStorage.getItem(FOCUS_RUNNING_KEY) === '1') setFocusRunning(true);
      if (localStorage.getItem(FOCUS_WARM_KEY) === '1') setFocusWarm(true);
    } catch {}
  }, []);
  function toggleFocus(key: string, set: (fn: (v: boolean) => boolean) => void) {
    set((v) => {
      try { localStorage.setItem(key, v ? '0' : '1'); } catch {}
      return !v;
    });
  }
  function toggleShowDetails() {
    setShowDetails((v) => {
      const next = !v;
      try { localStorage.setItem(DETAILS_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  // ── Auto-scroll to the selected entity (VSCode-style "reveal in
  // explorer"). On any change to the selection, expand the parent folder if
  // needed, then scroll the row into view.
  const asideRef = useRef<HTMLElement | null>(null);
  const pendingRevealId = useRef<string | null>(null);
  const activeTabId = selectedId ?? selectedShellId ?? selectedInstallId ?? null;
  const parentVpsId = useMemo(() => {
    if (!activeTabId) return null;
    return (
      sessions.find((s) => s.id === activeTabId)?.vpsId
      ?? shells.find((sh) => sh.id === activeTabId)?.vpsId
      ?? installs.find((i) => i.id === activeTabId)?.vpsId
      ?? null
    );
  }, [activeTabId, sessions, shells, installs]);
  const parentFolderId = useMemo(() => {
    if (!parentVpsId) return null;
    return vpsList.find((v) => v.id === parentVpsId)?.folderId ?? null;
  }, [parentVpsId, vpsList]);

  const selectedPathEntity = sessions.find((s) => s.id === activeTabId)
    ?? shells.find((sh) => sh.id === activeTabId);
  const parentPathKey = selectedPathEntity
    ? pathCollapseKey(selectedPathEntity.vpsId, selectedPathEntity.cwd) : null;

  useEffect(() => {
    pendingRevealId.current = activeTabId;
    if (!parentVpsId) return;
    setVpsCollapsed(parentVpsId, false);
    if (parentPathKey) setPathCollapsed(parentPathKey, false);
    if (parentFolderId) {
      const f = vpsFolders.find((ff) => ff.id === parentFolderId);
      if (f && f.collapsed === 1) onToggleFolderCollapsed?.(parentFolderId, false);
    }
    // Deliberately depend on navigation, not collapse state: the user may
    // hide the currently open session until they navigate to another row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, parentVpsId, parentFolderId, parentPathKey, setVpsCollapsed, setPathCollapsed]);

  useEffect(() => {
    // Ancestor expansion can arrive in a later render (folder state is remote).
    // Retry only a pending navigation, never recenter on manual collapse or SSE.
    if (!activeTabId || pendingRevealId.current !== activeTabId) return;
    const aside = asideRef.current;
    if (!aside) return;
    const raf = requestAnimationFrame(() => {
      if (pendingRevealId.current !== activeTabId) return;
      const viewport = aside.querySelector<HTMLElement>('.cs-scroll');
      const row = aside.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
      if (!viewport || !row) return;
      pendingRevealId.current = null;
      const vRect = viewport.getBoundingClientRect();
      const rRect = row.getBoundingClientRect();
      // A row under its VPS's sticky head is covered, not visible.
      const head = row.closest('.cs-vps')?.querySelector<HTMLElement>('.cs-vps-head');
      const coveredTop = head ? Math.max(vRect.top, head.getBoundingClientRect().bottom) : vRect.top;
      const isFullyVisible = rRect.top >= coveredTop && rRect.bottom <= vRect.bottom;
      if (isFullyVisible) return;
      viewport.scrollTo({
        top: viewport.scrollTop + rRect.top - vRect.top - (vRect.height - rRect.height) / 2,
        behavior: 'smooth',
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTabId, parentVpsId, parentFolderId, parentPathKey, vpsFolders, collapsedVps, collapsedPaths]);

  // Group VPSes by folderId, respecting the intra-folder `position` order.
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

  // Folders sorted by position, "default last", + a synthetic "(orphans)"
  // folder if a VPS points at an unknown folderId (data drift).
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

  // Sessions / shells per VPS (paused switch, then the machine+folder filter).
  // The selected entity is never dropped: a filter that excluded it would
  // leave the main pane blank with no explanation.
  const showEntity = isEntityShown ?? (() => true);
  // The focus chips (app/sidebarFocus.ts): unread and/or running, added up.
  const focus = { unread: focusUnread, running: focusRunning, warm: focusWarm };
  const focusing = focusUnread || focusRunning || focusWarm;
  // The shared prompt-cache clock (PromptCacheMarks): ticks only while some
  // session's cache is warm, so "warm" stays true to the minute.
  const cacheNow = useCacheTick(sessions.some((s) => cacheClockActive(s.promptCache)));
  function allSessionsFor(vpsId: string): SessionListItem[] {
    return sessions.filter((s) => s.vpsId === vpsId)
      // `position` first, `createdAt` as the tiebreak: every pre-existing row
      // is position 0, so an untouched sidebar sorts exactly as it did before
      // and only a list that was actually dragged looks different.
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)
        || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  function visibleSessionsFor(all: SessionListItem[]): SessionListItem[] {
    return sidebarVisiblePathItems(all, (s) =>
      (showPaused || (s.liveStatus ?? s.status) !== 'sleeping')
      && (s.id === selectedId || (showEntity(s.vpsId, s.cwd, 'session') && focusAdmits(focus, sessionFocusFacts(s, selectedId, cacheNow)))));
  }
  function sessionsFor(vpsId: string): SessionListItem[] {
    return visibleSessionsFor(allSessionsFor(vpsId));
  }
  function shellsFor(vpsId: string): ShellListItem[] {
    return shells
      .filter((sh) => sh.vpsId === vpsId)
      .filter((sh) => showPaused || !sh.exited)
      .filter((sh) => sh.id === selectedShellId || (showEntity(sh.vpsId, sh.cwd, 'shell') && focusAdmits(focus, shellFocusFacts(sh, selectedShellId))))
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }

  // Exact visual order, excluding collapsed folders/VPSes/paths and the
  // paused filter. Shift must select what is actually between the endpoints,
  // not invisible cards.
  const visibleSessionIds = sortedFolders.flatMap((folder) => {
    if (folder.collapsed === 1) return [];
    const folderVps = folder.id === '__orphans__'
      ? vpsList.filter((v) => !vpsFolders.some((known) => known.id === v.folderId))
      : (vpsByFolder.get(folder.id) ?? []);
    return folderVps.flatMap((vps) => collapsedVps.has(vps.id) ? [] : sidebarPathOrderedIds(
      sessionsFor(vps.id).filter((session) => !collapsedPaths.has(pathCollapseKey(vps.id, session.cwd))),
    ));
  });

  function selectSessionGesture(session: SessionListItem, modifiers: TreeSelectionModifiers): boolean {
    const next = selectTreeRow(
      visibleSessionIds, selectedSessionIds, sessionSelectionAnchor.current, session.id, modifiers,
    );
    setSelectedSessionIds(next.selected);
    sessionSelectionAnchor.current = next.anchor;
    return isTreeSelectionOnly(modifiers);
  }

  function openSessionContext(session: SessionListItem, x: number, y: number) {
    const ids = selectedSessionIds.has(session.id)
      ? visibleSessionIds.filter((id) => selectedSessionIds.has(id))
      : [session.id];
    if (!selectedSessionIds.has(session.id)) {
      setSelectedSessionIds(new Set([session.id]));
      sessionSelectionAnchor.current = session.id;
    }
    const byId = new Map(sessions.map((candidate) => [candidate.id, candidate]));
    const targets = ids.map((id) => byId.get(id)).filter((candidate): candidate is SessionListItem => !!candidate);
    if (targets.length) onContext?.(targets, x, y);
  }

  // ONE identity per handler for the memoized cards (SessionRow/ShellRow,
  // §14.38): rebuilt each render, every card redrew on every hub update.
  // Called from event handlers only, so they always run the latest closure.
  const selectStable = useStableCallback(onSelect);
  const selectShellStable = useStableCallback(onSelectShell);
  const selectionGestureStable = useStableCallback(selectSessionGesture);
  const sessionContextStable = useStableCallback(openSessionContext);
  const shellContextStable = useStableOptionalCallback(onContextShell);
  const renameSubmitStable = useStableOptionalCallback(onRenameSubmit);
  const renameCancelStable = useStableOptionalCallback(onRenameCancel);

  // "Agent out of date" = this hub SHIPS a strictly newer `__version__` than
  // the VPS runs (§14.6). Deliberately NOT a sha comparison: an equal version
  // with a different sha is ignored (bump `__version__` to propagate), and a
  // VPS running a NEWER agent — the normal steady state when two hubs share a
  // host, §14.70 — shows nothing rather than an update that would roll it back.
  function agentOutOfDateOf(v: Vps): boolean {
    const agentStatus = (v as any).agentStatus ?? 'unknown';
    // ⚠ From `staleness`, never a separate prop. Split out, the parent stopped
    // passing it, the comparison silently took `undefined` and EVERY
    // agent-update badge went dark with nothing saying why (§14.52).
    return agentStatus === 'ok'
      && isAgentOutdated((v as any).agentVersion, staleness?.builtAgentVersion);
  }

  // Width + closed state (desktop, app/panelLayout.ts). Narrow, the grid's
  // `data-side` tier lays the cards out for it (app.css); at the minimum
  // the sidebar is CLOSED — icons only — and hovering PEEKS the full list at
  // its default width over the chat. Same DOM, so scroll, collapsed groups and
  // an open filter survive the round trip.
  const sideW = usePanelLayout()?.sideW ?? null;
  const closed = sideW != null && isPanelClosed('side', sideW);
  const iconsOnly = sideW != null && sideTier(sideW) === 'icons';
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekHovered = useRef(false);
  const schedulePeek = useCallback((open: boolean) => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
    if (open) { setPeek(true); return; }
    peekTimer.current = setTimeout(() => {
      peekTimer.current = null;
      setPeek(false);
    }, PEEK_CLOSE_MS);
  }, []);
  const holdPeekRef = useRef(holdPeek);
  holdPeekRef.current = holdPeek;
  const peekEnter = useCallback(() => { peekHovered.current = true; schedulePeek(true); }, [schedulePeek]);
  const peekLeave = useCallback(() => {
    peekHovered.current = false;
    if (!holdPeekRef.current) schedulePeek(false);
  }, [schedulePeek]);
  useEffect(() => {
    if (!holdPeek && !peekHovered.current) schedulePeek(false);
  }, [holdPeek, schedulePeek]);
  useEffect(() => {
    if (closed) return;
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
    peekHovered.current = false;
    setPeek(false);
  }, [closed]);
  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current); }, []);
  // An inline rename lives in a card: among bare icons it would be a sliver
  // of input, so it opens the peek for as long as it is being typed.
  const peeking = (closed && peek) || (iconsOnly && !!editingId);

  const totalSleeping = sessions.filter(
    (s) => isPausedSession(s) && showEntity(s.vpsId, s.cwd, 'session'),
  ).length;
  // The cleanup lists the whole fleet, whatever the path filter hides.
  const fleetPaused = sessions.filter(isPausedSession).length;
  // The focus chips count within the path filter, like "paused".
  const scopedSessions = sessions.filter((s) => showEntity(s.vpsId, s.cwd, 'session'));
  const scopedShells = shells.filter((sh) => showEntity(sh.vpsId, sh.cwd, 'shell'));
  const sessionFacts = scopedSessions.map((s) => sessionFocusFacts(s, selectedId, cacheNow));
  const shellFacts = scopedShells.map((sh) => shellFocusFacts(sh, selectedShellId));
  const unreadCount = [...sessionFacts, ...shellFacts].filter((f) => f.unread).length;
  const runningCount = [...sessionFacts, ...shellFacts].filter((f) => f.running).length;
  const warmCount = sessionFacts.filter((f) => f.warm).length;
  const focusEmpty = focusing
    && (focusUnread ? unreadCount : 0) + (focusRunning ? runningCount : 0) + (focusWarm ? warmCount : 0) === 0;

  return (
    <>
    <aside
      className={`app-sidebar${peeking ? ' peek' : ''}`}
      ref={asideRef}
      data-tip-region
      onMouseEnter={closed ? peekEnter : undefined}
      onMouseLeave={closed ? peekLeave : undefined}
    >
      <div className="cs-top">
        <div className="cs-top-row">
          <span className="cs-title">SESSIONS</span>
          {/* One group holds the auto margin, so adding a button here is not
              a question of which one carries `margin-left: auto`. */}
          <div className="cs-top-actions">
            <button
              type="button"
              className="cs-mobile-refresh"
              onClick={() => window.location.reload()}
              title="reload the page"
              aria-label="reload the page"
            ><IconArrowClockwise /></button>
            {toolbarSlot}
            <button
              type="button"
              className="cs-manage"
              onClick={onOpenData}
              title="manage VPS, folders and paths"
              aria-label="manage VPS and folders"
            ><IconServers /></button>
          </div>
        </div>
        <div className="cs-add full">
          {/* Backend-free entry point: it stays even with both backends off,
              because the wizard is then where the user learns why (and gets a
              link to Settings) — a vanished button explains nothing. */}
          <button className="cs-add-btn agent" onClick={() => onNew({})}
            title={enabledKinds(enabledBackends).length === 1
              ? providerText.newAgent(enabledKinds(enabledBackends)[0])
              : 'new agent'}>
            <IconRobot /><span>Agent</span>
          </button>
          <button className="cs-add-btn shell" onClick={() => onNewShell({})} title="new SSH shell">
            <IconTerminal /><span>Shell</span>
          </button>
        </div>
        <div className="cs-switch-row">
          {/* Three view filters as icon chips that light up, on ONE line at
              any sidebar width: the tooltip names each, says its state and
              what a click does (a checkbox under each keeps them real
              toggles). The paused cleanup shares the moon's pill, past a
              hairline (`.cs-switch-pair`). */}
          <span className="cs-switch-pair">
            <label className="cs-chip" title="Paused sessions" {...tipAttrs({
              detail: [`${showPaused ? 'Shown' : 'Hidden'}${totalSleeping > 0 ? ` · ${totalSleeping} paused` : ''}`],
              actions: [['Click', showPaused ? 'hide them' : 'show them']],
            })}>
              <input type="checkbox" checked={showPaused} onChange={toggleShowPaused} aria-label="Show paused sessions" />
              <span className="cs-chip-face">
                <IconMoon />{totalSleeping > 0 ? <span className="cs-chip-count">{totalSleeping}</span> : null}
              </span>
            </label>
            {onOpenPausedCleanup && (
              <button
                type="button"
                className="cs-paused-trash"
                onClick={onOpenPausedCleanup}
                disabled={fleetPaused === 0}
                title={fleetPaused === 0 ? 'no paused session to delete' : `delete paused sessions… (${fleetPaused} paused)`}
                aria-label="delete paused sessions"
              ><IconTrash /></button>
            )}
          </span>
          <label className="cs-chip" title="Card details" {...tipAttrs({
            detail: ['First message, path and age on each card', showDetails ? 'On' : 'Off — compact cards'],
            actions: [['Click', showDetails ? 'compact cards' : 'show details']],
          })}>
            <input type="checkbox" checked={showDetails} onChange={toggleShowDetails} aria-label="Show card details" />
            <span className="cs-chip-face"><IconListUl /></span>
          </label>
          <label className="cs-chip" title="Tool calls" {...tipAttrs({
            detail: ['Tool calls and results, plans and reasoning in conversations', showTools ? 'Shown' : 'Hidden'],
            actions: [['Click', showTools ? 'hide them' : 'show them']],
          })}>
            <input type="checkbox" checked={showTools} onChange={onToggleShowTools} aria-label="Show tool calls" />
            <span className="cs-chip-face"><IconWrench /></span>
          </label>
          {/* Focus: list only these (unread | running), one pill at the end. */}
          <span className="cs-focus">
            <label className="cs-chip" title="Unread" {...tipAttrs({
              detail: [unreadCount ? `${unreadCount} finished while you were away` : 'Nothing unread',
                focusUnread ? 'Filter on — listing only these' : null],
              actions: [['Click', focusUnread ? 'list everything' : 'list only these']],
            })}>
              <input type="checkbox" checked={focusUnread} onChange={() => toggleFocus(FOCUS_UNREAD_KEY, setFocusUnread)} aria-label="List only unread sessions" />
              <span className="cs-chip-face"><IconCheck2Circle />{unreadCount > 0 ? <span className="cs-chip-count">{unreadCount}</span> : null}</span>
            </label>
            <label className="cs-chip" title="Running" {...tipAttrs({
              detail: [runningCount ? `${runningCount} working right now` : 'Nothing running',
                focusRunning ? 'Filter on — listing only these' : null],
              actions: [['Click', focusRunning ? 'list everything' : 'list only these']],
            })}>
              <input type="checkbox" checked={focusRunning} onChange={() => toggleFocus(FOCUS_RUNNING_KEY, setFocusRunning)} aria-label="List only running sessions" />
              <span className="cs-chip-face"><IconLightningCharge />{runningCount > 0 ? <span className="cs-chip-count">{runningCount}</span> : null}</span>
            </label>
            <label className="cs-chip cs-chip-warm" title="Warm cache" {...tipAttrs({
              detail: [warmCount ? `${warmCount} with a warm prompt cache` : 'No warm prompt cache',
                'A warm cache makes the next message cheaper — until it expires',
                focusWarm ? 'Filter on — listing only these' : null],
              actions: [['Click', focusWarm ? 'list everything' : 'list only these']],
            })}>
              <input type="checkbox" checked={focusWarm} onChange={() => toggleFocus(FOCUS_WARM_KEY, setFocusWarm)} aria-label="List only sessions with a warm prompt cache" />
              <span className="cs-chip-face"><CacheFlame level={4} />{warmCount > 0 ? <span className="cs-chip-count">{warmCount}</span> : null}</span>
            </label>
          </span>
        </div>
      </div>

      <div className="cs-scroll">
        {focusEmpty && (
          <div className="cs-empty cs-focus-empty">
            {focusEmptyText(focus)}
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

          // Resolve, per VPS, its visible content + whether to show it at all.
          const visibleVps = folderVps
            .map((v) => {
              const install = installs.find((i) => i.vpsId === v.id) ?? null;
              const allVpsSessions = allSessionsFor(v.id);
              return {
                vps: v,
                allVpsSessions,
                vpsSessions: visibleSessionsFor(allVpsSessions),
                vpsShells: shellsFor(v.id),
                install,
              };
            })
            // A VPS shows ONLY when it has a visible session/shell (the paused
            // switch decides via sessionsFor/shellsFor), with two exceptions:
            // an install session — otherwise a machine with nothing on it yet
            // (the normal case for a fresh install) has no row to hold the
            // install log; and, under a path filter, an unhealthy VPS the
            // filter emptied — its agent/login bar is the only place that
            // alarm is shown, and it lives on the VPS head, not on its rows.
            // Folders with no visible VPS are hidden below.
            .filter((x) => x.vpsSessions.length + x.vpsShells.length > 0
              || installKeepsVpsVisible(x.install, selectedInstallId)
              || (isEntityShown != null && x.vps.agentStatus !== 'ok'));

          if (visibleVps.length === 0) return null;

          const folderActiveCount = visibleVps.reduce(
            (acc, x) => acc + x.vpsSessions.filter((s) => ACTIVE_STATUSES.has(s.liveStatus ?? s.status)).length,
            0,
          );
          const folderCollapsed = folder.collapsed === 1;

          return (
            <section key={folder.id} className={`cs-folder${folderCollapsed ? ' collapsed' : ''}`}>
              <div
                className="cs-folder-head"
                onClick={() => { if (folder.id !== '__orphans__') onToggleFolderCollapsed?.(folder.id, !folderCollapsed); }}
                role="button"
                title={folderCollapsed ? 'click to expand the folder' : 'click to collapse the folder'}
              >
                <span className="cs-caret">{folderCollapsed ? '▸' : '▾'}</span>
                <span className="cs-folder-glyph">▤</span>
                <span className="cs-folder-name">{folder.name}</span>
                <span className="cs-count" title={`${visibleVps.length} VPS shown`}>{visibleVps.length}</span>
                {folderActiveCount > 0 && (
                  <span className="cs-folder-active" title={`${folderActiveCount} active session(s)`}>{folderActiveCount}</span>
                )}
              </div>
              {!folderCollapsed && (
                <div className="cs-folder-body">
                  {visibleVps.map((x) => renderVpsBox(x.vps, {
                    sessionHandles,
                    collapsed: collapsedVps.has(x.vps.id),
                    onToggleCollapsed: () => setVpsCollapsed(x.vps.id),
                    collapsedPaths, onTogglePath: setPathCollapsed,
                    vpsSessions: x.vpsSessions,
                    allVpsSessions: x.allVpsSessions,
                    vpsShells: x.vpsShells,
                    vpsInstall: x.install,
                    showDetails,
                    agentOutOfDate: agentOutOfDateOf(x.vps),
                    staleness,
                    selectedId, selectedShellId, selectedInstallId,
                    activeWorkspace,
                    deletingSessionIds,
                    onSelect: selectStable, onSelectShell: selectShellStable, onSelectInstall, onReorderSessions,
                    selectedSessionIds, onSessionSelectionGesture: selectionGestureStable,
                    enabledBackends,
                    onNew, onNewShell, onScan,
                    onContext: sessionContextStable, onContextShell: shellContextStable, onContextInstall,
                    editingId, onRenameSubmit: renameSubmitStable, onRenameCancel: renameCancelStable,
                    onInstallAgent, onProviderLogin, onProviderContext, signingOutAccounts,
                    onUpdateAgent, onRefreshAgent,
                    updatingAgentVpsIds, refreshingAgentVpsIds,
                  }))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
    {/* Closed, it stays at the icons' edge (drag or double-click opens); on a
        peek it moves to the peek's edge, and dragging it docks the sidebar. */}
    <PanelResizer
      panel="side"
      onMouseEnter={peeking ? peekEnter : undefined}
      onMouseLeave={peeking ? peekLeave : undefined}
    />
    </>
  );
}

// ── VPS box (the V1 "boxed VPS" design) ───────────────────────────────────
type VpsRenderOpts = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  collapsedPaths: ReadonlySet<string>;
  onTogglePath: (key: string) => void;
  sessionHandles?: Map<string, { handle: string; confirmed: boolean }>;
  vpsSessions: SessionListItem[];
  allVpsSessions: SessionListItem[];
  vpsShells: ShellListItem[];
  vpsInstall: InstallInfo | null;
  // "details" switch — false = compact cards (no preview/cwd/age).
  showDetails: boolean;
  agentOutOfDate: boolean;
  // `__version__` this hub ships — for the "vX → vY" labels and the 'ahead'
  // tooltip (the verdict itself is computed by the parent, §14.6).
  // Every declared line's latest, by `latestKey` (see the Props above).
  staleness?: VpsStalenessBaselines;
  selectedId: string | null;
  deletingSessionIds: ReadonlySet<string>;
  selectedShellId: string | null;
  selectedInstallId: string | null;
  activeWorkspace: WorkspaceScope | null;
  onSelect: (id: string, pin?: boolean) => void;
  onSelectShell: (id: string, pin?: boolean) => void;
  onSelectInstall: (id: string) => void;
  /** Reorder the sessions of ONE vps (drag & drop). §14.80 */
  onReorderSessions?: (vpsId: string, ids: string[]) => void;
  selectedSessionIds: ReadonlySet<string>;
  onSessionSelectionGesture: (session: SessionListItem, modifiers: TreeSelectionModifiers) => boolean;
  enabledBackends: EnabledBackends;
  onNew: (opts: { vpsId?: string; cwd?: string; agentKind?: AgentKind; accountProfile?: string }) => void;
  onNewShell: (opts: { vpsId?: string; cwd?: string | null }) => void;
  onScan: (vpsId: string) => void;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  onContextInstall?: (install: InstallInfo, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onInstallAgent?: (vps: Vps) => void;
  onProviderLogin?: (vps: Vps, provider: AgentKind, profile?: AccountProfile) => void;
  onProviderContext?: (vps: Vps, provider: AgentKind, x: number, y: number, profile?: AccountProfile) => void;
  signingOutAccounts?: ReadonlySet<string>;
  onUpdateAgent?: (vps: Vps) => void;
  onRefreshAgent?: (vps: Vps) => void;
  updatingAgentVpsIds?: Set<string>;
  refreshingAgentVpsIds?: Set<string>;
};

function renderVpsBox(v: Vps, opts: VpsRenderOpts) {
  const {
    sessionHandles, collapsed, onToggleCollapsed, collapsedPaths, onTogglePath,
    vpsSessions, allVpsSessions, vpsShells, vpsInstall, showDetails, agentOutOfDate,
    staleness,
    selectedId, selectedShellId, selectedInstallId, activeWorkspace, deletingSessionIds,
    onSelect, onSelectShell, onSelectInstall, onReorderSessions,
    selectedSessionIds, onSessionSelectionGesture,
    enabledBackends,
    onNew, onNewShell, onScan,
    onContext, onContextShell, onContextInstall,
    editingId, onRenameSubmit, onRenameCancel,
    onInstallAgent, onProviderLogin, onProviderContext, signingOutAccounts,
    onUpdateAgent, onRefreshAgent,
    updatingAgentVpsIds, refreshingAgentVpsIds,
  } = opts;

  const agentStatus = (v as any).agentStatus ?? 'unknown';
  const agentVersion = (v as any).agentVersion as string | undefined;
  const agentPyzSha = (v as any).agentPyzSha as string | undefined;
  // One clause per DECLARED release line (§14.102), so the tooltip and the
  // amber "update" dot carry every staleness axis without three hand-written
  // builders — the omission that once said "agent ✓" beside a lit button.
  const agentReady = agentStatus === 'ok';
  const latestByKey: Record<string, string | null | undefined> = staleness ?? {};
  const versionLines = SESSION_PROVIDERS.flatMap((p) =>
    providerBackendState(v as any, p).versions.map((line) => {
      const latest = latestByKey[line.latestKey] ?? null;
      return {
        ...line,
        provider: p,
        latest,
        // Both versions must be KNOWN and the agent must have answered: an old
        // recorded version on a dead box is not "behind", its pyz is stale
        // anyway and that lights the same bar.
        outdated: agentReady && isVersionOutdated(line.value, latest),
      };
    }));
  const sdkVersion = (v as any).sdkVersion as string | null | undefined;
  const agentUpdating = !!updatingAgentVpsIds?.has(v.id);
  const agentRefreshing = !!refreshingAgentVpsIds?.has(v.id);
  const agentMeta = AGENT_BADGE[agentStatus] ?? AGENT_BADGE.unknown;
  // ONE update surface for every staleness axis (pyz, claude SDK, codex SDK) —
  // the update button repairs all three in a single flow (redeploy pyz +
  // pip install -U claude-agent-sdk + openai-codex).
  const outdated = agentOutOfDate || versionLines.some((l) => l.outdated);
  const versionTip = versionLines
    .filter((l) => l.value)
    .map((l) => ` — ${l.provider} ${l.chipLabel} ${l.value}${l.outdated && l.latest ? ` → ${l.latest}` : ''}`)
    .join('');
  // Classified failure (vps.agentLastError → 'ssh-auth' | 'ssh-unreachable' |
  // 'daemon-down' | 'error') — refines the error bar + tooltips below.
  const { code: errCode, detail: errDetail } = parseAgentLastError(v);
  const errTip = agentStatus === 'error' && (errCode || errDetail)
    ? ` — ${[errCode, errDetail].filter(Boolean).join(': ')}`
    : '';
  // 'ahead' = the VPS runs a newer agent than this hub builds — expected on a
  // co-tenant host (§14.70); surfaced in the tooltip only, never as an action.
  const builtAgentVersion = staleness?.builtAgentVersion ?? null;
  const agentAhead = agentReady && agentBuildRelation(agentVersion, builtAgentVersion) === 'ahead';
  const agentTip = `${agentMeta.label}${errTip}${agentVersion ? ` (v${agentVersion})` : ''}${versionTip}`
    + (agentOutOfDate ? ` — agent update available (v${agentVersion} → v${builtAgentVersion})` : '')
    + (agentAhead ? ` — newer than this hub's build (v${builtAgentVersion}), left alone` : '');
  const noAgentReason = agentStatus === 'missing'
    ? 'install the agent first'
    : agentStatus === 'error'
    ? 'the agent connection dropped — click "refresh agent"'
    : 'agent not yet verified — click "install agent"';
  const installRunning = vpsInstall?.status === 'running';

  // Shared head elements — placed inline (details ON) or on their own
  // right-aligned second row (details OFF = compact head).
  const dotEl = (
    <span className={`cs-vps-dot agent-${agentStatus}${outdated ? ' outdated' : ''}`} title={agentTip}>
      {agentMeta.glyph}
    </span>
  );
  const historyBtn = (
    <button
      className="cs-icon-btn"
      onClick={(e) => { e.stopPropagation(); onScan(v.id); }}
      disabled={!agentReady}
      title={agentReady ? 'scan existing sessions to import' : `history unavailable — ${noAgentReason}`}
      aria-label="history"
    ><IconClockHistory /></button>
  );
  const addBtns = (
    <VpsAddButtons vps={v} enabledBackends={enabledBackends} signingOutAccounts={signingOutAccounts}
      onNew={onNew} onNewShell={onNewShell} onProviderLogin={onProviderLogin} onProviderContext={onProviderContext} />
  );

  const hostLabel = `${v.sshUser}@${v.ip}${v.sshPort !== 22 ? `:${v.sshPort}` : ''}`;

  return (
    <section key={v.id} className={`cs-vps agent-${agentStatus}${showDetails ? '' : ' compact'}${collapsed ? ' collapsed' : ''}`}>
      {showDetails ? (
      <div className="cs-vps-head">
        <button type="button" className="cs-vps-toggle" onClick={onToggleCollapsed}
          aria-expanded={!collapsed} aria-label={`${collapsed ? 'expand' : 'collapse'} server ${v.name}`}>
        <span className="cs-caret" aria-hidden>{collapsed ? '▸' : '▾'}</span>
        {dotEl}
        <span className="cs-vps-id">
          <span className="cs-vps-name">{v.name}</span>
          <span className="cs-vps-ip">{hostLabel}</span>
          {/* Agent + SDK versions — always visible under root@… (mobile + web),
              so the fleet's versions are legible at a glance. TWO stacked lines
              (the single `agent … · sdk …` line got ellipsis-cropped in the
              280px sidebar): each line goes amber for ITS OWN staleness; the
              tooltip carries the full status. Updates live via the `vps_status`
              bus event (HubPanel patches v.agentVersion / v.sdkVersion). */}
          <span className={`cs-vps-ver${agentOutOfDate ? ' outdated' : ''}`} title={agentTip}>
            {agentVersion
              ? `agent v${agentVersion}`
              : agentStatus === 'missing'
                ? 'agent not installed'
                : 'agent —'}
          </span>
          {/* Per-backend SDK lines, differentiated by the mini agent logo:
              claude-agent-sdk vs openai-codex, each amber for ITS OWN
              staleness (vs the PyPI latest). */}
          {versionLines.filter((l) => l.value).map((l) => (
            <span
              key={`${l.provider}-${l.chipLabel}`}
              className={`cs-vps-ver sdkline${l.outdated ? ' outdated' : ''}`}
              title={agentTip}
            >
              <AgentLogo kind={l.provider} size={10} title={l.packageLabel} />
              {`${l.provider === DEFAULT_SESSION_PROVIDER && l.chipLabel === 'sdk'
                ? l.provider : `${l.provider} ${l.chipLabel}`} ${l.value}`}
            </span>
          ))}
        </span>
        </button>
        {historyBtn}
        {addBtns}
      </div>
      ) : (
      /* Compact head ("details" switch OFF): dot + name on the first line,
         the 4 action buttons on a second right-aligned row. Host + versions
         move to the tooltip (the dot keeps the full agentTip too). */
      <div className="cs-vps-head compact">
        <button type="button" className="cs-vps-row1 cs-vps-toggle" onClick={onToggleCollapsed}
          aria-expanded={!collapsed} aria-label={`${collapsed ? 'expand' : 'collapse'} server ${v.name}`}>
          <span className="cs-caret" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          {dotEl}
          <span className="cs-vps-id" title={`${hostLabel} — ${agentTip}`}>
            <span className="cs-vps-name">{v.name}</span>
          </span>
        </button>
        <div className="cs-vps-actions">
          {historyBtn}
          {addBtns}
        </div>
      </div>
      )}

      {!collapsed && <div className="cs-vps-body">
          {/* Agent status / action bar — only when there's something to do. */}
          {installRunning ? null : agentStatus === 'missing' || agentStatus === 'unknown' ? (
            <div className="cs-agent-bar warn">
              <span className="cs-agent-meta">{agentStatus === 'missing' ? 'agent not installed' : 'agent not verified'}</span>
              {onInstallAgent && (
                <button className="cs-agent-btn primary" onClick={() => onInstallAgent(v)}>▸ install agent</button>
              )}
            </div>
          ) : agentStatus === 'error' ? (
            // Classified error (vps.agentLastError): say WHICH layer is broken.
            // ssh-level → no "reinstall" (bootstrap can't run without SSH).
            <div className="cs-agent-bar err">
              {/* Tooltip = raw ssh error + since-when: "last OK contact 2 min
                  ago" reads as a blip auto-healing on the next backoff retry;
                  "3 d ago" reads as a genuinely dead box. */}
              <span
                className="cs-agent-meta"
                title={[errCode === 'ssh-hostkey'
                  && 'This VPS presents a DIFFERENT SSH host key (reinstalled — or intercepted). If you reinstalled it, remove its line from ~/.ssh/charon_known_hosts on the hub, then refresh.',
                  errDetail, (v as any).agentLastSeenAt && `last OK contact: ${formatAge((v as any).agentLastSeenAt)}`,
                  (v as any).agentLastSeenAt && 'auto-retries with backoff (up to 5 min between tries)'].filter(Boolean).join('\n') || undefined}
              >
                {errCode === 'ssh-unreachable' ? 'vps unreachable (ssh)'
                  : errCode === 'ssh-auth' ? 'ssh key refused'
                  : errCode === 'ssh-hostkey' ? 'host key changed'
                  : errCode === 'daemon-down' ? 'agent stopped'
                  : 'agent unreachable'}
              </span>
              {onRefreshAgent && (
                <button className="cs-agent-btn primary" disabled={agentRefreshing} onClick={() => onRefreshAgent(v)}
                  title={errCode === 'ssh-hostkey'
                    ? 'retry once the host key has been checked and reset (see the tooltip)'
                    : 'reconnect and start the agent; if it will not stay up, redeploy this hub\'s agent (up to a minute)'}>
                  {agentRefreshing ? (errCode === 'daemon-down' ? '⟳ starting…' : '⟳ refreshing…') : errCode === 'daemon-down' ? '↻ start' : '↻ refresh'}
                </button>
              )}
              {onInstallAgent && errCode !== 'ssh-unreachable' && errCode !== 'ssh-auth' && errCode !== 'ssh-hostkey' && (
                <button className="cs-agent-btn" disabled={agentRefreshing} onClick={() => onInstallAgent(v)}>reinstall</button>
              )}
            </div>
          ) : outdated ? (
            <div className="cs-agent-bar update">
              <span className="cs-agent-meta">
                {/* Derived from the stale release lines (§14.102). ONE stale
                    line names it exactly; several stay generic (the bar is one
                    short line and the full detail is already in the tooltip);
                    the agent's own version leads when it is also behind. */}
                {(() => {
                  const stale = versionLines.filter((l) => l.outdated);
                  const agentPart = agentVersion
                    ? `v${agentVersion} → v${builtAgentVersion}` : 'update available';
                  if (!agentOutOfDate && stale.length === 1) {
                    const l = stale[0];
                    return `${l.provider} ${l.chipLabel} ${l.value} → ${l.latest}`;
                  }
                  if (!agentOutOfDate && stale.length > 1) {
                    return `sdk updates (${[...new Set(stale.map((l) => l.provider))].join(' + ')})`;
                  }
                  if (stale.length > 0) {
                    return `${agentVersion ? `${agentPart} · ` : ''}agent + SDK update`;
                  }
                  return agentPart;
                })()}
              </span>
              {onUpdateAgent && (
                <button className="cs-agent-btn update" disabled={agentUpdating} onClick={() => onUpdateAgent(v)}>
                  {agentUpdating ? '⟳ updating…' : '⇪ update'}
                </button>
              )}
            </div>
          ) : null}

          {/* Install session row (running / finished, reopenable). */}
          {vpsInstall && (
            <InstallRow
              install={vpsInstall}
              selected={vpsInstall.id === selectedInstallId}
              onSelect={onSelectInstall}
              onContext={onContextInstall}
            />
          )}

          {/* One visual + drag container per cwd. Agent sessions and SSH
              shells share the path heading, but only agent sessions reorder;
              a native drag cannot cross into another group's hook. */}
          <WorkspacePathGroups
            vpsId={v.id}
            collapsedPaths={collapsedPaths}
            onTogglePath={onTogglePath}
            sessions={vpsSessions}
            allSessions={allVpsSessions}
            shells={vpsShells}
            selectedId={selectedId}
            selectedShellId={selectedShellId}
            selectedSessionIds={selectedSessionIds}
            deletingSessionIds={deletingSessionIds}
            sessionHandles={sessionHandles}
            showDetails={showDetails}
            onSelect={onSelect}
            onSelectShell={onSelectShell}
            onSelectionGesture={onSessionSelectionGesture}
            onContext={onContext}
            onContextShell={onContextShell}
            editingId={editingId}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onReorder={onReorderSessions}
            activeWorkspace={activeWorkspace}
          />

          {vpsSessions.length === 0 && vpsShells.length === 0 && !installRunning && (
            <div className="cs-empty">no session — use ＋ to start one</div>
          )}
      </div>}
    </section>
  );
}

/** A component, not part of `renderVpsBox`: that one runs inside a `.map()`,
 *  where a hook would change count with the visible VPS list. */
function VpsAddButtons({ vps, enabledBackends, signingOutAccounts, onNew, onNewShell, onProviderLogin, onProviderContext }: {
  vps: Vps;
} & Pick<VpsRenderOpts, 'enabledBackends' | 'signingOutAccounts' | 'onNew' | 'onNewShell' | 'onProviderLogin' | 'onProviderContext'>) {
  const profiles = useAccountProfiles(vps.id);
  return (
    <div className="cs-add">
      {/* One button per enabled backend, and it is the ONLY control for that
          backend on this row: ready ⇒ new session, signed out ⇒ open the
          sign-in modal with a corner warning (`backendLauncher`). The separate
          sign-in bar this replaces meant the button you wanted was dead while
          the one that helped sat elsewhere. A backend switched OFF in Settings
          has no button at all — greying it would say "this VPS can't", the
          opposite of the truth. Several accounts stay ONE button: it opens
          the account choice (`AccountChoice.tsx`). */}
      {enabledKinds(enabledBackends).map((k) => (
        <VpsProviderButton key={k} vps={vps} provider={k} profiles={accountChoices(profiles, vps.id, k)}
          signingOutAccounts={signingOutAccounts}
          onNew={onNew} onProviderLogin={onProviderLogin} onProviderContext={onProviderContext} />
      ))}
      <button
        className="cs-add-btn shell"
        onClick={(e) => { e.stopPropagation(); onNewShell({ vpsId: vps.id, cwd: null }); }}
        title="new SSH shell on this VPS"
        aria-label="new shell"
      ><IconTerminal /></button>
    </div>
  );
}

function VpsProviderButton({ vps, provider, profiles, signingOutAccounts, onNew, onProviderLogin, onProviderContext }: {
  vps: Vps;
  provider: AgentKind;
  /** This backend's accounts on the VPS, default first (never empty). */
  profiles: AccountProfile[];
} & Pick<VpsRenderOpts, 'signingOutAccounts' | 'onNew' | 'onProviderLogin' | 'onProviderContext'>) {
  const main = profiles[0];
  const choice = useAccountChoice(profiles.length);
  const signingOut = (p: AccountProfile) => signingOutAccounts?.has(`${vps.id}:${provider}:${p.id}`) ?? false;
  const launcherOf = (p: AccountProfile) => backendLauncher(vpsForProfile(vps, provider, p), provider);
  const launcher = launcherOf(main);
  // A missing runtime blocks every account alike; a sign-in or a logout in
  // flight belongs to one account, and the menu carries it per row.
  const disabled = !launcher.enabled || (!choice.multi && signingOut(main));
  const warn = choice.multi ? !profiles.some((p) => launcherOf(p).ready) : launcher.warn;
  const launch = (profile: AccountProfile, l: BackendLauncher) => {
    if (l.ready) onNew({ vpsId: vps.id, agentKind: provider, accountProfile: profile.id });
    else if (l.fix) onProviderLogin?.(vps, provider, profile);
  };
  const lp = useLongPress(({ x, y }) => {
    if (!disabled) onProviderContext?.(vps, provider, x, y, main);
  });
  return (
    <>
      <button
        type="button"
        {...choice.trigger}
        className={`cs-add-btn agent ${provider}${warn ? ' needs-fix' : ''}${choice.multi ? ' has-accounts' : ''}`}
        {...lp.handlers}
        onClick={(e) => {
          e.stopPropagation();
          if (lp.consume() || disabled) return;
          if (choice.takeClick(e)) return;
          launch(main, launcher);
        }}
        onContextMenu={(e) => {
          if (!onProviderContext || disabled) return;
          e.preventDefault();
          e.stopPropagation();
          choice.close();
          onProviderContext(vps, provider, e.clientX, e.clientY, main);
        }}
        disabled={disabled}
        title={choice.multi ? providerText.accountsLauncher(provider, profiles.length)
          : signingOut(main) ? 'Logging out…'
          : launcher.title}
        {...(!choice.multi && !signingOut(main)
          ? tipAttrs({ detail: [`${providerName(provider)} on ${vps.name}`], actions: [['Right-click', 'account options']] })
          : {})}
        aria-busy={(!choice.multi && signingOut(main)) || undefined}
        aria-label={choice.multi ? providerText.chooseAccount(provider) : launcher.title}
      >
        {choice.multi && <AccountChoiceMark />}
        <AgentLogo kind={provider} size={14} title="" />
        {warn && <span className="cs-add-warn" aria-hidden="true">!</span>}
      </button>
      <AccountChoiceMenu choice={choice} vps={vps} provider={provider} profiles={profiles}
        busy={signingOut} onPick={launch}
        onContext={onProviderContext ? (p, x, y) => onProviderContext(vps, provider, x, y, p) : undefined} />
    </>
  );
}

function InstallRow({ install, selected, onSelect, onContext }: {
  install: InstallInfo;
  selected: boolean;
  onSelect: (id: string, pin?: boolean) => void;
  onContext?: (install: InstallInfo, x: number, y: number) => void;
}) {
  const lp = useLongPress((c) => { onContext?.(install, c.x, c.y); });
  return (
    <button
      type="button"
      data-tab-id={install.id}
      className={`cs-install-row ${install.status}${selected ? ' selected' : ''}`}
      onClick={() => { if (lp.consume()) return; onSelect(install.id); }}
      onContextMenu={(e) => { if (!onContext) return; e.preventDefault(); onContext(install, e.clientX, e.clientY); }}
      {...lp.handlers}
      title={`agent installation · ${install.status}`}
    >
      <span className="cs-install-dot" />
      <span className="cs-install-label">⚙ installation</span>
      <span className="cs-install-tag">
        {install.status === 'running'
          ? (install.currentPhase ?? 'init')
          : install.status === 'success' ? 'OK' : 'failed'}
      </span>
    </button>
  );
}

const DOT_CLASS: Record<string, string> = {
  active: 'dot-green',
  starting: 'dot-amber',
  thinking: 'dot-amber-pulse',
  sleeping: 'dot-gray',
  killed: 'dot-gray',
  error: 'dot-red',
  failed: 'dot-red',
  background: 'dot-violet-pulse',
  waiting: 'dot-orange-pulse',
  question: 'dot-orange-pulse',
};

const STATUS_TEXT: Record<string, string> = {
  active: 'ready',
  thinking: 'working',
  starting: 'starting',
  sleeping: 'paused',
  waiting: 'needs you',
  question: 'question',
  error: 'error',
  failed: 'error',
  // Idle, but the tasks it launched are still running (§14.91) — the one
  // state that is neither working nor done.
  background: 'background',
};

/**
 * Sessions and shells of ONE VPS, split by normalized cwd.
 *
 * Path-group order follows the full VPS session list, even if paused/filter
 * settings hide its first card. A group component owns its own reorder
 * hook, which structurally prevents cross-path drops.
 *
 * TWO nested drags, and they never meet: a card moves inside its own group
 * (that group's hook), a HEADING moves the whole path (this one). There is no
 * path order to store — it is read off the session order — so moving a heading
 * commits every session of that path at once. A heading is the handle, but the
 * drop target is the whole group: a 9px caption is not something to aim at,
 * and its midpoint decides before/after just as a row's does.
 */
function WorkspacePathGroups({
  vpsId, sessions, allSessions, selectedId, selectedSessionIds, deletingSessionIds,
  showDetails, sessionHandles, onSelect, onSelectionGesture, onContext,
  editingId, onRenameSubmit, onRenameCancel, onReorder,
  activeWorkspace, shells, selectedShellId, onSelectShell, onContextShell,
  collapsedPaths, onTogglePath,
}: {
  collapsedPaths: ReadonlySet<string>;
  onTogglePath: (key: string) => void;
  vpsId: string;
  sessions: SessionListItem[];
  allSessions: SessionListItem[];
  shells: ShellListItem[];
  selectedId: string | null;
  selectedShellId: string | null;
  selectedSessionIds: ReadonlySet<string>;
  deletingSessionIds: ReadonlySet<string>;
  showDetails: boolean;
  sessionHandles?: Map<string, { handle: string; confirmed: boolean }>;
  onSelect: (id: string, pin?: boolean) => void;
  onSelectShell: (id: string, pin?: boolean) => void;
  onSelectionGesture: (session: SessionListItem, modifiers: TreeSelectionModifiers) => boolean;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onReorder?: (vpsId: string, ids: string[]) => void;
  activeWorkspace: WorkspaceScope | null;
}) {
  const groups = useMemo(() => {
    const byPath = new Map<string, { path: string; sessions: SessionListItem[]; shells: ShellListItem[] }>();
    const ensure = (path: string) => {
      let group = byPath.get(path);
      if (!group) {
        group = { path, sessions: [], shells: [] };
        byPath.set(path, group);
      }
      return group;
    };
    for (const session of sessions) ensure(sidebarPathKey(session.cwd)).sessions.push(session);
    for (const shell of shells) ensure(sidebarPathKey(shell.cwd)).shells.push(shell);
    return [...byPath.values()];
  }, [sessions, shells]);

  // Only a path holding sessions can move: order lives in `position` on the
  // session rows, so a shell-only group has nothing to carry it — and since
  // the map above is filled from the sessions first, those groups already sit
  // at the end, which is where they would land anyway. Expand the drag against
  // the full list so hidden sessions keep their positions.
  const movablePaths = useMemo(() => sidebarPathOrder(sessions), [sessions]);
  const pathDnd = useReorder(movablePaths, (orderedPaths) => {
    const fullOrder = mergeSidebarPathGroupOrder(allSessions, orderedPaths);
    if (fullOrder) onReorder?.(vpsId, fullOrder);
  }, { axis: 'y' });
  const pathsMovable = !!onReorder && movablePaths.length > 1;

  return (
    <>
      {groups.map((group) => (
        <SessionPathGroup
          key={group.path}
          dnd={pathsMovable && group.sessions.length > 0 ? pathDnd.itemProps(group.path) : undefined}
          vpsId={vpsId}
          path={group.path}
          collapsed={collapsedPaths.has(pathCollapseKey(vpsId, group.path))}
          onToggleCollapsed={() => onTogglePath(pathCollapseKey(vpsId, group.path))}
          sessions={group.sessions}
          shells={group.shells}
          allSessions={allSessions}
          selectedId={selectedId}
          selectedShellId={selectedShellId}
          selectedSessionIds={selectedSessionIds}
          deletingSessionIds={deletingSessionIds}
          showDetails={showDetails}
          sessionHandles={sessionHandles}
          activeWorkspace={activeWorkspace}
          onSelect={onSelect}
          onSelectShell={onSelectShell}
          onSelectionGesture={onSelectionGesture}
          onContext={onContext}
          onContextShell={onContextShell}
          editingId={editingId}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          onReorder={onReorder}
        />
      ))}
    </>
  );
}

function SessionPathGroup({
  vpsId, path, sessions, shells, allSessions, collapsed, onToggleCollapsed,
  selectedId, selectedShellId, selectedSessionIds, deletingSessionIds,
  showDetails, sessionHandles, activeWorkspace,
  onSelect, onSelectShell, onSelectionGesture, onContext, onContextShell,
  editingId, onRenameSubmit, onRenameCancel, onReorder, dnd: pathDnd,
}: {
  vpsId: string;
  path: string;
  /** Heading drag: the handle is the caption, the drop target the whole group. */
  dnd?: ReorderItemProps;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sessions: SessionListItem[];
  shells: ShellListItem[];
  allSessions: SessionListItem[];
  selectedId: string | null;
  selectedShellId: string | null;
  selectedSessionIds: ReadonlySet<string>;
  deletingSessionIds: ReadonlySet<string>;
  showDetails: boolean;
  sessionHandles?: Map<string, { handle: string; confirmed: boolean }>;
  activeWorkspace: WorkspaceScope | null;
  onSelect: (id: string, pin?: boolean) => void;
  onSelectShell: (id: string, pin?: boolean) => void;
  onSelectionGesture: (session: SessionListItem, modifiers: TreeSelectionModifiers) => boolean;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  onContextShell?: (shell: ShellListItem, x: number, y: number) => void;
  editingId?: string | null;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onReorder?: (vpsId: string, ids: string[]) => void;
}) {
  const dnd = useReorder(sessions.map((session) => session.id), (orderedPathIds) => {
    const fullOrder = mergeSidebarPathOrder(allSessions, path, orderedPathIds,
      sessions.map((session) => session.id));
    if (fullOrder) onReorder?.(vpsId, fullOrder);
  }, { axis: 'y' });
  const current = path !== '~' && isSameWorkspace(activeWorkspace, vpsId, path);
  const count = sessions.length + shells.length;
  const label = path === '~' ? 'default home directory' : path;

  return (
    <section
      className={`cs-path-group${current ? ' current' : ''}`}
      onDragOver={pathDnd?.onDragOver}
      onDrop={pathDnd?.onDrop}
      data-dragging={pathDnd?.['data-dragging']}
      data-over={pathDnd?.['data-over']}
    >
      <button type="button" className="cs-path-head" onClick={onToggleCollapsed} data-tip-side="right"
        aria-expanded={!collapsed} aria-label={`${collapsed ? 'expand' : 'collapse'} path ${path}`}
        draggable={pathDnd?.draggable}
        onDragStart={pathDnd?.onDragStart}
        onDragEnd={pathDnd?.onDragEnd}
        title={label}
        {...tipAttrs({
          detail: [`${count} ${count === 1 ? 'session or shell' : 'sessions and shells'}`],
          actions: [
            ['Click', collapsed ? 'expand' : 'collapse'],
            !!pathDnd && ['Drag', 'move it with its sessions'],
          ],
        })}>
        <span className="cs-caret" aria-hidden>{collapsed ? '▸' : '▾'}</span>
        <span className="cs-path-mark" aria-hidden />
        <span className="cs-path-name">{path}</span>
        <span className="cs-path-count">{count}</span>
      </button>
      {!collapsed && sessions.map((s) => (
        <SessionRow
          key={s.id} s={s}
          deleting={deletingSessionIds.has(s.id)}
          multiSelected={selectedSessionIds.has(s.id)}
          handle={sessionHandles?.get(s.id)?.handle ?? null}
          selected={s.id === selectedId}
          showDetails={showDetails}
          onSelect={onSelect}
          onSelectionGesture={onSelectionGesture}
          onContext={onContext}
          editing={editingId === s.id}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          dnd={onReorder && !deletingSessionIds.has(s.id) ? dnd.itemProps(s.id) : undefined}
        />
      ))}
      {!collapsed && shells.map((sh) => (
        <ShellRow
          key={sh.id}
          sh={sh}
          selected={sh.id === selectedShellId}
          showDetails={showDetails}
          onSelect={onSelectShell}
          onContext={onContextShell}
        />
      ))}
    </section>
  );
}

// Memoized (§14.38): every prop is a primitive, the row's own summary object
// (kept by the store until it changes), a stable handler or the per-id drag
// props (`useReorder`) — so a hub update redraws only the cards it touched.
const SessionRow = memo(function SessionRow({
  s, handle, selected, multiSelected, deleting, showDetails,
  onSelect, onSelectionGesture, onContext, editing, onRenameSubmit, onRenameCancel, dnd,
}: {
  s: SessionListItem;
  /** Stable provider-neutral Charon handle on this VPS. */
  handle?: string | null;
  selected: boolean;
  multiSelected: boolean;
  deleting: boolean;
  showDetails: boolean;
  onSelect: (id: string, pin?: boolean) => void;
  onSelectionGesture: (session: SessionListItem, modifiers: TreeSelectionModifiers) => boolean;
  onContext?: (session: SessionListItem, x: number, y: number) => void;
  editing?: boolean;
  onRenameSubmit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  dnd?: Record<string, unknown>;
}) {
  // Touch long-press → context menu (mobile has no right-click). Must run
  // before the `editing` early-return to keep hook order stable. §11.
  const lp = useLongPress((c) => { if (!deleting) onContext?.(s, c.x, c.y); });
  useMinuteTick(); // the age below
  const hasDraft = useHasDraft(s.id);
  const pressedSelection = useRef<TreeSelectionModifiers | null>(null);
  const lastClickWasSelectionOnly = useRef(false);
  const baseStatus = rowStatus(s);
  // THE attention predicate (lib/sessionAttention.ts), shared with the header,
  // tab bar, filter chip and desk: blocked ⇒ "needs you" whatever the live
  // status (a gate is always raised mid-turn), async question ⇒ "question",
  // unread ⇒ the green ✓ (hidden on the card you are reading).
  const attention = attentionForRow(s, { viewedHere: selected });
  // The prompt cache the last turn left (lib/promptCache.ts), on the shared
  // clock: the mark, a tooltip block and the details line all read it.
  const cache = useSessionCacheReading(s);
  const effective = attention === 'blocked' ? 'waiting' : attention === 'question' ? 'question' : baseStatus;
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
  const cacheFoot = deleting ? null : sessionCacheFootText(cache);
  const headline = s.name || (preview ? preview.slice(0, 60) : s.cwd.split('/').slice(-2).join('/'));
  const age = formatAge(s.createdAt);
  // Unsent text in this browser tab's composer (inputDraftStore.ts). Not on the
  // card you are reading: the composer right there already shows it, and the
  // pencil would blink with the first and last character typed.
  const draft = hasDraft && !selected && !deleting
    ? getDraft(s.id).replace(/\s+/g, ' ').trim()
    : '';
  // Its tooltip: the name; the agent, address, folder and age; the first
  // message as an excerpt; what the pointer can do, small at the bottom.
  const tooltip = tipAttrs({
    detail: [
      [agentLogoLabel(s.kind as AgentKind, accountProfileNumber(s), s.endpoint?.active?.name),
        handle ? `@${handle}` : null].filter(Boolean).join(' · '),
      s.cwd,
      age ? agePhrase('created', age) : null,
      draft ? 'Unsent draft' : null,
    ],
    quote: preview && preview !== headline ? preview : null,
    // The prompt cache, under the excerpt: coloured headline + facts.
    section: cache && cache.phase !== 'small' && !deleting ? cacheTipSection(cache) : null,
    actions: deleting ? [] : [
      ['Click', 'open'],
      ['Double-click', 'keep the tab open'],
      !!dnd && ['Drag', 'reorder'],
      ['Right-click', 'actions'],
      ['Ctrl/Shift-click', 'select'],
    ],
  });
  const showPreview = !!preview && preview !== headline && !headline.startsWith(preview.slice(0, 30));
  const needsAttention = attention === 'blocked' || attention === 'question';
  const blocking = pendingSplit(s).pendingBlocking;
  // Background tasks still running once the turn is over (§14.91). Hidden
  // while the session works: turns start and reap short tasks constantly, and
  // the count only matters when the card would otherwise read "done".
  const bgRunning = !deleting && baseStatus !== 'thinking' && baseStatus !== 'starting'
    ? (s.runningBgTasks ?? 0) : 0;
  // "Finished, unread": the session ended a turn while you weren't looking and
  // you haven't opened it since (DB: unread_stop, §14.47). The durable marker
  // itself is untouched by the drawing.
  const unread = attention === 'unread';
  // Prompts the CLI will send this session by itself later (CronCreate /
  // ScheduleWakeup, lib/scheduledTasks.ts). Marked on a READY card only: a
  // working one is busy anyway, a paused one cannot fire them.
  const scheduled = !deleting && baseStatus === 'active' ? scheduledTaskList(s) : [];
  const colorToken = (s as any).color as string | null | undefined;
  return (
    <button
      type="button"
      data-tab-id={s.id}
      /* Beside the column, never over the next cards (app/HoverTip.tsx). */
      data-tip-side="right"
      className={`cs-card${selected ? ' selected' : ''}${multiSelected ? ' multi-selected' : ''}${deleting ? ' deleting' : ''}${needsAttention ? ' attention' : ''}${unread ? ' finished-unread' : ''}${baseStatus === 'sleeping' ? ' is-sleeping' : ''}${showDetails ? '' : ' compact'}`}
      disabled={deleting}
      aria-busy={deleting || undefined}
      aria-pressed={multiSelected}
      onClick={(e) => {
        if (deleting || lp.consume()) return;
        const modifiers = pressedSelection.current ?? {
          toggle: e.ctrlKey || e.metaKey, range: e.shiftKey,
        };
        pressedSelection.current = null;
        const selectionOnly = onSelectionGesture(s, modifiers);
        lastClickWasSelectionOnly.current = selectionOnly;
        if (selectionOnly) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect(s.id);
      }}
      onDoubleClick={(e) => {
        const selectionOnly = lastClickWasSelectionOnly.current
          || isTreeSelectionOnly({ toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
        lastClickWasSelectionOnly.current = false;
        if (deleting || selectionOnly) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect(s.id, true);
      }}
      {...(dnd ?? {})}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const modifiers = { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey };
        pressedSelection.current = isTreeSelectionOnly(modifiers) ? modifiers : null;
      }}
      onContextMenu={(e) => { if (!onContext || deleting) return; e.preventDefault(); onContext(s, e.clientX, e.clientY); }}
      {...lp.handlers}
      title={deleting ? `Deleting ${headline}…` : headline}
      {...tooltip}
      suppressHydrationWarning
      style={colorToken ? { ['--c' as any]: colorToCss(colorToken) } : undefined}
    >
      <span className="cs-card-stripe" />
      <div className="cs-card-top">
        <span className={`dot ${deleting ? 'dot-red' : dotClass}`} />
        <span className="cs-card-glyph"><AgentLogo kind={(s.kind as AgentKind) ?? 'claude'} profileNumber={accountProfileNumber(s)} size={14} endpointName={s.endpoint?.active?.name} title="" /></span>
        <span className="cs-card-name">{headline}</span>
        {draft && (
          <span className="cs-draft" title="Unsent draft"
            {...tipAttrs({ quote: draft.length > 200 ? `${draft.slice(0, 200)}…` : draft })}>
            <IconPencil />
          </span>
        )}
        {scheduled.length > 0 && (
          <span className="cs-sched" title={plural(scheduled.length, 'scheduled task')}
            {...tipAttrs({ detail: scheduledTip(scheduled) })}>
            <IconAlarm />
          </span>
        )}
        {/* 🔒 = BLOCKING gates only: an async question never blocks (§14.96);
            its QUESTION state chip already says so. */}
        {blocking > 0 && (
          <span className="cs-perm" title={`${blocking} pending request(s) blocking the session: permissions, questions, plan reviews`}>🔒{blocking}</span>
        )}
        {bgRunning > 0 && (
          <span className="cs-bg" title={`${bgRunning} background task${bgRunning > 1 ? 's' : ''} still running`}>
            ◐{bgRunning}
          </span>
        )}
        {!deleting && <SessionCacheMark reading={cache} />}
        <span className={`cs-state ${deleting ? 'deleting' : effective === 'question' ? 'waiting' : effective}`}>
          {deleting ? 'deleting…' : (STATUS_TEXT[effective] ?? effective)}
        </span>
      </div>
      {showDetails && showPreview && <div className="cs-card-preview">{preview}</div>}
      {showDetails && (
        <div className="cs-card-foot">
          {handle && (
            <span
              className="cs-card-handle"
              title={`Stable Charon address on this machine (${s.addressable ? 'currently reachable' : 'not currently reachable'})`}
            >
              @{handle}
            </span>
          )}
          <span className="cs-card-cwd">{cwdTail(s.cwd, 30)}</span>
          {cacheFoot && <span className="cs-card-cache" style={{ color: cacheHeat(cache!) }}>{cacheFoot}</span>}
          {age && <span className="cs-card-age" suppressHydrationWarning>{age}</span>}
        </div>
      )}
    </button>
  );
});

const ShellRow = memo(function ShellRow({ sh, selected, showDetails, onSelect, onContext }: {
  sh: ShellListItem;
  selected: boolean;
  showDetails: boolean;
  onSelect: (id: string, pin?: boolean) => void;
  onContext?: (sh: ShellListItem, x: number, y: number) => void;
}) {
  const lp = useLongPress((c) => { onContext?.(sh, c.x, c.y); });
  useMinuteTick(); // the age below
  const age = formatAge(Math.floor(sh.startedAt / 1000));
  const cwdShort = sh.cwd ? cwdTail(sh.cwd, 30) : '~';
  const headline = sh.name ?? `shell · ${sh.cwd ? cwdTail(sh.cwd, 16) : '~'}`;
  const dotClass = sh.exited ? 'dot-gray' : (sh.liveStatus === 'busy' ? 'dot-amber-pulse' : 'dot-green');
  // A job finished while nobody attended it (§14.47, like a session's ✓).
  const unread = shellAttention(sh, { viewedHere: selected }) === 'unread';
  return (
    <button
      type="button"
      data-tab-id={sh.id}
      data-tip-side="right"
      className={`cs-card shell${selected ? ' selected' : ''}${unread ? ' finished-unread' : ''}${sh.exited ? ' is-sleeping' : ''}${showDetails ? '' : ' compact'}`}
      onClick={() => { if (lp.consume()) return; onSelect(sh.id); }}
      onDoubleClick={() => onSelect(sh.id, true)}
      onContextMenu={(e) => { if (!onContext) return; e.preventDefault(); onContext(sh, e.clientX, e.clientY); }}
      {...lp.handlers}
      title={headline}
      {...tipAttrs({
        detail: [sh.exited ? 'SSH shell · ended' : 'SSH shell', sh.cwd ?? '~', age ? agePhrase('started', age) : null],
        actions: [['Click', 'open'], ['Double-click', 'keep the tab open'], ['Right-click', 'actions']],
      })}
      style={sh.color ? { ['--c' as any]: colorToCss(sh.color) } : undefined}
    >
      <span className="cs-card-stripe" />
      <div className="cs-card-top">
        <span className={`dot ${dotClass}`} />
        <span className="cs-card-glyph shell"><IconTerminal /></span>
        <span className="cs-card-name">{headline}</span>
        <span className={`cs-state ${sh.exited ? 'sleeping' : sh.liveStatus === 'busy' ? 'thinking' : 'active'}`}>
          {sh.exited ? 'ended' : sh.liveStatus === 'busy' ? 'busy' : 'idle'}
        </span>
      </div>
      {showDetails && (
        <div className="cs-card-foot">
          <span className="cs-card-cwd">{cwdShort}</span>
          {age && <span className="cs-card-age">{age}</span>}
        </div>
      )}
    </button>
  );
});

function RenameInput({ initial, onSubmit, onCancel }: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="cs-card rename-row">
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
