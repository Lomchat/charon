'use client';
import { attentionForRow, isWaitingAttention, rowStatus } from '@/lib/sessionAttention';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useReorder } from './useReorder';
import { setHiddenTabRows, useHiddenTabRows, type HiddenTabRows } from './chromeFolds';
import { useHoverPanels } from './HeaderSessionNav';
import { useLatest } from './useStable';
import type { Vps, VpsFolder } from '@/lib/db/schema';
import type { SessionListItem, ShellInfo, InstallInfo, AgentKind, TabDTO } from '@/lib/types/api';
import { IconTerminal, IconTools } from './icons';
import { FileIcon } from './fileIcons';
import AgentLogo, { agentLogoLabel } from './AgentLogo';
import { tipAttrs } from './tooltipText';
import { accountProfileNumber, profileLabel } from '@/lib/accountProfiles';
import { providerName } from '@/lib/providerText';
import { useAccountProfiles } from './accountProfileStore';
import { backendAvailability } from './vpsHealth';
import { providerLoginPatch } from '@/lib/sessionCapabilities';
import { ALL_BACKENDS_ENABLED, enabledKinds, type EnabledBackends } from './enabledBackends';
import { groupShown, mergeVisibleOrder, visibleTabs } from './pausedTabs';

// TabBar — the workspace strip above the main column. §14.78
// ─────────────────────────────────────────────────────────────────────────────
// Three rows — one per level — because a tab has three coordinates:
//
//   Row 1  VPS        — the machines with something open
//   Row 2  path       — the folders open on that machine. THE new level: a VPS
//                       routinely holds several projects, and a flat list of
//                       "everything open on web-01" tells you nothing about
//                       which one you're in.
//   Row 3  tabs       — what is open in that folder: sessions, shells, files.
//
// One level per line, but ONE SIZE for the three: they were drawn at three
// different scales and paddings, which read as three unrelated bars stacked by
// accident rather than as one hierarchy.
//
// Rows 1 and 2 FOLD (the ≡ button, browser-local, app/chromeFolds.ts): a
// hidden level becomes a crumb at the head of the first row left — "machine ›
// folder ›" — whose menu (hover opens, click pins: the header's
// `useHoverPanels`) lists what the row did, with an orange count when another
// machine or folder waits on you. Row 3 never folds. Its tabs scroll between
// the crumbs and the ＋ buttons, which stay put; "+N ▾" lists the whole folder,
// and the crumbs fold into one ("folder ▾") when the tabs would not fit.
//
// The set of tabs comes from the DB (shared across devices) instead of being
// derived from "every non-sleeping session", which is what it used to be. So a
// tab can be closed without touching the session, and a session can run with
// no tab at all — the sidebar remains its home.
//
// Temporary tabs are ITALIC and there is at most one per folder: opening
// something is a preview, and the next preview in that folder replaces it.
// Double-click (or any real interaction) pins.

export type TabState =
  | 'active' | 'thinking' | 'waiting' | 'starting' | 'failed' | 'background' | 'sleeping';

// 'background' outranks 'active': a folder holding one session that still has
// tasks running is not a folder where everything is done (§14.91).
const STATE_PRIORITY: Record<TabState, number> = {
  waiting: 6, failed: 5, thinking: 4, starting: 3, background: 2, active: 1, sleeping: 0,
};

/** A tab plus everything the strip needs to draw it. */
export type ResolvedTab = TabDTO & {
  label: string;
  title: string;
  state: TabState;
  agentKind?: AgentKind;
  profileNumber?: number;
  dirty: boolean;
  /** The thing is gone (a file that was deleted, a session mid-removal). */
  orphan: boolean;
  /**
   * The tab points at something that RUNS, so `state` means something and the
   * status dot is drawn. A file doesn't run: a green dot next to it claimed a
   * liveness it can't have, and made the whole strip look busy as soon as you
   * opened one. Files carry their icon and their unsaved dot, nothing else.
   */
  live: boolean;
  /** A hidden session's tab (§14.118): drawn only while hidden ones are shown. */
  hidden?: boolean;
};

type Args = {
  tabs: TabDTO[];
  sessions: SessionListItem[];
  shells: ShellInfo[];
  installs: InstallInfo[];
  dirtyIds: ReadonlySet<string>;
};

/**
 * Resolve every tab against the live entity lists.
 *
 * Pure and exported so HubPanel can reuse the same resolution for the main
 * pane — two different answers to "what is this tab" is how a bar and a pane
 * end up disagreeing.
 */
export function resolveTabs({
  tabs, sessions, shells, installs, dirtyIds,
}: Args): ResolvedTab[] {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const shellById = new Map(shells.map((s) => [s.id, s]));
  const installById = new Map(installs.map((i) => [i.id, i]));

  return tabs.map((t): ResolvedTab => {
    const dirty = dirtyIds.has(t.id);
    if (t.kind === 'session') {
      const s = sessionById.get(t.ref);
      // liveStatus first: it is patched from the LOW_VOLUME status bus the
      // moment anything moves, while `status` is the DB row and only refreshes
      // with the list poll — the strip was showing a minute-old dot. Anything
      // outside TabState (e.g. the client-only 'reconnecting') falls back to
      // 'active' just below.
      // Waiting = blocked | question from THE attention predicate
      // (lib/sessionAttention.ts) over the summary store's row (§14.108).
      const state: TabState = !s ? 'sleeping'
        : isWaitingAttention(attentionForRow(s)) ? 'waiting'
        : (rowStatus(s) as TabState) ?? 'active';
      return {
        ...t, dirty, orphan: !s, live: true, hidden: s?.hidden === 1,
        label: s?.name || '(unnamed)',
        title: `${s?.name || '(unnamed)'}\n${t.path}`,
        state: STATE_PRIORITY[state] === undefined ? 'active' : state,
        agentKind: (s?.kind as AgentKind) ?? 'claude',
        profileNumber: accountProfileNumber(s),
      };
    }
    if (t.kind === 'shell') {
      const sh = shellById.get(t.ref);
      return {
        ...t, dirty, orphan: !sh, live: true,
        label: sh?.name || 'shell',
        title: `shell\n${t.path}`,
        // Streaming = the sidebar's and the header's "busy", like a session's thinking.
        state: !sh ? 'sleeping' : sh.liveStatus === 'busy' ? 'thinking' : 'active',
      };
    }
    if (t.kind === 'install') {
      const i = installById.get(t.ref);
      return {
        // An install IS a running remote process — running/error is exactly
        // what its dot is for.
        ...t, dirty, orphan: !i, live: true,
        label: 'install',
        title: `agent install\n${i?.vpsName ?? ''}`,
        state: i?.status === 'running' ? 'thinking' : i?.status === 'error' ? 'failed' : 'active',
      };
    }
    const name = t.ref.split('/').pop() || t.ref;
    return {
      ...t, dirty, orphan: false, live: false,
      label: name,
      title: `${t.path}/${t.ref}${dirty ? '\nunsaved changes' : ''}`,
      state: 'sleeping',
    };
  });
}

/** The state of a group is the loudest state among the things in it that RUN —
 *  open files are skipped, or a folder you are only reading files in would
 *  report itself as active. A group with nothing live rolls up to 'sleeping'. */
function rollUp(list: { state: TabState; live: boolean }[]): TabState {
  let best: TabState = 'sleeping';
  for (const x of list) {
    if (x.live && STATE_PRIORITY[x.state] > STATE_PRIORITY[best]) best = x.state;
  }
  return best;
}

export type PathGroup = { vpsId: string; path: string; tabs: ResolvedTab[]; state: TabState; pos: number };

type Props = {
  resolved: ResolvedTab[];
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  activeVpsId: string | null;
  activePath: string | null;
  activeTabId: string | null;
  onVpsClick: (vpsId: string) => void;
  onPathClick: (vpsId: string, path: string) => void;
  onTabClick: (tab: ResolvedTab) => void;
  onTabDoubleClick: (tab: ResolvedTab) => void;
  onTabClose: (tab: ResolvedTab) => void;
  /** Close every tab of a machine / of a folder. A group is a view, so this
   *  closes tabs and nothing else — the sessions and shells underneath keep
   *  running and stay in the sidebar. */
  onVpsClose: (vpsId: string, tabs: ResolvedTab[]) => void;
  onPathClose: (vpsId: string, path: string, tabs: ResolvedTab[]) => void;
  onTabContext: (e: React.MouseEvent, tab: ResolvedTab) => void;
  onNewSession: (vpsId: string, path: string, agentKind: AgentKind, profile?: string) => void;
  onNewShell: (vpsId: string, path: string) => void;
  /** Why each backend's "+" is greyed (null = launchable). Same diagnosis as
   *  the sidebar's ＋ buttons — two launchers disagreeing is worse than a
   *  disabled button. */
  newSessionDisabledReason: Record<AgentKind, string | null>;
  /** Backends this hub offers (Settings). A disabled one loses its ＋ button
   *  here exactly as it does in the sidebar — two launchers disagreeing about
   *  which backends exist is worse than no launcher. */
  enabledBackends?: EnabledBackends;
  /** The sidebar's hidden switch (app/showPaused.ts § useShowHidden). OFF
   *  drops every hidden session's tab, and with them any folder or machine
   *  that held nothing else (app/pausedTabs.ts). */
  showHidden?: boolean;
  onReorderVps: (vpsIds: string[]) => void;
  onReorderPaths: (vpsId: string, paths: string[]) => void;
  onReorderTabs: (vpsId: string, path: string, ids: string[]) => void;
};

export default function TabBar({
  resolved, vpsList, vpsFolders, activeVpsId, activePath, activeTabId,
  onVpsClick, onPathClick, onTabClick, onTabDoubleClick, onTabClose, onTabContext,
  onVpsClose, onPathClose,
  onNewSession, onNewShell, newSessionDisabledReason,
  enabledBackends = ALL_BACKENDS_ENABLED, showHidden = false,
  onReorderVps, onReorderPaths, onReorderTabs,
}: Props) {
  const profiles = useAccountProfiles(activeVpsId ?? undefined);
  const { vpsRows, pathRows, tabRows, fullOrder } = useMemo(() => {
    // The strip has its OWN order now (`vpsPos` / `groupPos`, dragged by the
    // user). The sidebar's folder/vps positions are only the tiebreak for
    // machines that have never been dragged — every row starts at 0.
    const folderPos = new Map(vpsFolders.map((f) => [f.id, f.position]));
    const sidebarOrder = new Map(
      [...vpsList].sort((a, b) => {
        const byFolder = (folderPos.get(a.folderId ?? 'default') ?? 99) - (folderPos.get(b.folderId ?? 'default') ?? 99);
        return byFolder !== 0 ? byFolder : (a.position ?? 0) - (b.position ?? 0);
      }).map((v, i) => [v.id, i]),
    );

    // Everything below is built from the SHOWN tabs, so a folder or a machine
    // with nothing left to show simply has no row. `fullOrder` keeps the
    // unfiltered sequences: a drop commits the whole order (§14.80).
    const shown = visibleTabs(resolved, showHidden, activeTabId);
    const fullOrder = {
      vps: [...new Set(resolved.map((t) => t.vpsId))],
      paths: [...new Set(resolved.filter((t) => t.vpsId === activeVpsId).map((t) => t.path))],
      tabs: resolved
        .filter((t) => t.vpsId === activeVpsId && t.path === (activePath ?? ''))
        .slice().sort((a, b) => a.position - b.position).map((t) => t.id),
    };

    const byVps = new Map<string, ResolvedTab[]>();
    for (const t of shown) {
      const arr = byVps.get(t.vpsId) ?? [];
      arr.push(t);
      byVps.set(t.vpsId, arr);
    }
    const vpsRows = [...byVps.entries()]
      .map(([vpsId, list]) => ({
        vps: vpsList.find((v) => v.id === vpsId) ?? null,
        vpsId, tabs: list, count: list.length, state: rollUp(list),
        pos: Math.min(...list.map((t) => t.vpsPos)),
      }))
      .filter((r) => r.vps && groupShown(r.tabs, showHidden, activeTabId))
      .sort((a, b) => a.pos - b.pos
        || (sidebarOrder.get(a.vpsId) ?? 99) - (sidebarOrder.get(b.vpsId) ?? 99));

    const here = byVps.get(activeVpsId ?? '') ?? [];
    const byPath = new Map<string, ResolvedTab[]>();
    for (const t of here) {
      const arr = byPath.get(t.path) ?? [];
      arr.push(t);
      byPath.set(t.path, arr);
    }
    const pathRows: PathGroup[] = [...byPath.entries()]
      .filter(([, list]) => groupShown(list, showHidden, activeTabId))
      .map(([path, list]) => ({
        vpsId: activeVpsId!, path, tabs: list, state: rollUp(list),
        pos: Math.min(...list.map((t) => t.groupPos)),
      }))
      .sort((a, b) => a.pos - b.pos || a.path.localeCompare(b.path));

    const tabRows = (byPath.get(activePath ?? '') ?? [])
      .slice().sort((a, b) => a.position - b.position);
    return { vpsRows, pathRows, tabRows, fullOrder };
  }, [resolved, vpsList, vpsFolders, activeVpsId, activePath, showHidden, activeTabId]);

  // One hook per row. Each commits the FULL new order for that row — the
  // dragged subsequence is slotted back into the hidden rows' own order, or
  // turning the switch back on would show everything hidden pushed to the end.
  const vpsDnd = useReorder(vpsRows.map((r) => r.vpsId),
    (vpsIds) => onReorderVps(mergeVisibleOrder(fullOrder.vps, vpsIds)));
  const pathDnd = useReorder(pathRows.map((g) => g.path),
    (paths) => activeVpsId && onReorderPaths(activeVpsId, mergeVisibleOrder(fullOrder.paths, paths)));
  const tabDnd = useReorder(tabRows.map((t) => t.id),
    (ids) => activeVpsId && onReorderTabs(
      activeVpsId, activePath ?? '', mergeVisibleOrder(fullOrder.tabs, ids)));

  // ── Folded rows: the trail ──
  const hidden = useHiddenTabRows();
  const activeVpsRow = vpsRows.find((r) => r.vpsId === activeVpsId) ?? null;
  const activePathRow = pathRows.find((g) => g.path === (activePath ?? '')) ?? null;
  const machines: TrailRow[] = vpsRows.map((r) => ({
    id: r.vpsId, name: r.vps!.name, title: r.vps!.name, count: r.count, state: r.state,
  }));
  const folders: TrailRow[] = pathRows.map((g) => ({
    id: g.path, name: folderName(g.path), title: g.path || 'no folder', count: g.tabs.length, state: g.state,
  }));
  // Fold the crumbs into one when the tabs would not fit beside the full
  // trail. Keyed by what the trail shows: another machine or folder starts
  // over from the full trail, which is what gets measured.
  const trailKey = hidden === 2 ? `${activeVpsId}\n${activePath}\n${activeVpsRow?.vps?.name}` : '';
  const [compactKey, setCompactKey] = useState<string | null>(null);
  const compact = hidden === 2 && compactKey === trailKey;
  const trailWidthsRef = useRef<{ key: string; full: number | null }>({ key: '', full: null });

  // ── Row 3: the scrolling tabs, what is out of view ──
  const hasRows = vpsRows.length > 0;
  const rowRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [outIds, setOutIds] = useState<readonly string[]>([]);
  function measureStrip() {
    const row = rowRef.current, scroller = scrollRef.current;
    if (!row || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const out: string[] = [];
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-strip-tab]')) {
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push(el.dataset.stripTab!);
    }
    const max = scroller.scrollWidth - scroller.clientWidth;
    scroller.dataset.fade = `${scroller.scrollLeft > 1 ? 'l' : ''}${scroller.scrollLeft < max - 1 ? 'r' : ''}`;
    setOutIds((prev) => prev.length === out.length && prev.every((id, i) => id === out[i]) ? prev : out);

    if (hidden !== 2) return;
    const trail = row.querySelector<HTMLElement>('.tab-trail');
    if (!trail) return;
    const width = trail.getBoundingClientRect().width;
    const memo = trailWidthsRef.current;
    if (memo.key !== trailKey) { memo.key = trailKey; memo.full = null; }
    if (!compact) memo.full = width;
    if (memo.full == null) return;
    // The room the tabs would have beside the FULL trail: what they have now,
    // plus the "+N" chip's place and the row's slack, minus what the full
    // trail takes beyond the folded one. Both states compute the same number,
    // so the fold never flips back and forth.
    const style = getComputedStyle(row);
    const gap = parseFloat(style.columnGap) || 0;
    const contentRight = row.getBoundingClientRect().right - (parseFloat(style.paddingRight) || 0);
    const lastRight = row.lastElementChild?.getBoundingClientRect().right ?? contentRight;
    const slack = Math.max(0, contentRight - lastRight);
    const chip = row.querySelector<HTMLElement>(':scope > .tab-more');
    const chipW = chip ? chip.getBoundingClientRect().width + gap : 0;
    const room = scroller.clientWidth + chipW + slack - (compact ? memo.full - width : 0);
    const fold = scroller.scrollWidth > room + 1;
    if (fold !== compact) setCompactKey(fold ? trailKey : null);
  }
  // The current tab in view whenever it changes (a pick from the "+N" list,
  // a click in the sidebar).
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const el = scroller?.querySelector<HTMLElement>('.tb-item.selected');
    if (!scroller || !el) return;
    const box = scroller.getBoundingClientRect(), r = el.getBoundingClientRect();
    // Wider than the room left: its START shows (the name reads from there).
    if (r.left < box.left || r.width >= box.width) scroller.scrollLeft += r.left - box.left - (r.width >= box.width ? 0 : 24);
    else if (r.right > box.right) scroller.scrollLeft += r.right - box.right + 24;
  }, [activeTabId, hidden]);
  const measureRef = useLatest(measureStrip);
  const stripKey = `${hidden}|${compact}|${trailKey}|${activeTabId}|${tabRows.map((t) => `${t.id}:${t.label}:${t.dirty ? 1 : 0}`).join(',')}`;
  useLayoutEffect(() => { measureRef.current(); }, [stripKey, measureRef]);
  useEffect(() => {
    const row = rowRef.current, scroller = scrollRef.current;
    if (!row || !scroller) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measureRef.current(); });
    };
    // A vertical wheel scrolls the tabs sideways: there is no scrollbar.
    const onWheel = (e: WheelEvent) => {
      if (scroller.scrollWidth <= scroller.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      scroller.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: false });
    void document.fonts?.ready.then(schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('wheel', onWheel);
    };
  }, [measureRef, hasRows]);

  if (vpsRows.length === 0) return <div className="app-tabbar" />;

  const trail = hidden !== 0 && (
    <TabTrail level={hidden} compact={compact}
      machines={machines} folders={folders}
      vps={activeVpsRow ? machines.find((m) => m.id === activeVpsRow.vpsId) ?? null : null}
      folder={activePathRow ? folders.find((f) => f.id === activePathRow.path) ?? null : null}
      onPickVps={onVpsClick}
      onPickPath={(path) => activeVpsId && onPathClick(activeVpsId, path)} />
  );

  return (
    <div className={`app-tabbar${hidden ? ` hides-${hidden}` : ''}`}>
      {/* The three rows share one shape (`tb-item`) AND one size — what tells
          them apart is their line and their content, nothing else. Giving row 2
          its own scale made it read as a filter bar bolted on rather than as
          the middle of a hierarchy. */}
      {/* Rows 1 and 2 close too, and closing one closes everything under it.
          Same shape as row 3 for that reason: the item is a DIV holding a
          `tb-main` button and a `tb-close` button — a button inside a button
          is invalid HTML, and the close has to be its own click target. */}
      {hidden < 1 && <div className="tab-row tab-row-vps">
        {vpsRows.map((r) => (
          <div
            key={r.vpsId}
            className={`tb-item tb-vps${r.vpsId === activeVpsId ? ' selected' : ''} state-${r.state}`}
            {...vpsDnd.itemProps(r.vpsId)}
          >
            <button
              className="tb-main"
              onClick={() => onVpsClick(r.vpsId)}
              title={r.vps!.name}
              {...tipAttrs({
                detail: [`${r.count} open on this machine`],
                actions: [['Click', 'show its folders'], ['Drag', 'reorder']],
              })}
            >
              <span className="tb-dot" />
              <span className="tb-name">{r.vps!.name}</span>
              <span className="tb-count">{r.count}</span>
            </button>
            <button
              className="tb-close"
              onClick={(e) => { e.stopPropagation(); onVpsClose(r.vpsId, r.tabs); }}
              title={`close all ${r.count} tabs on ${r.vps!.name} (nothing stops running)`}
            >✕</button>
          </div>
        ))}
      </div>}

      {hidden < 2 && <div className="tab-row tab-row-paths">
        {hidden === 1 && trail}
        <div className="tab-row-items">
        {pathRows.map((g) => (
          <div
            key={g.path}
            className={`tb-item tb-path${g.path === activePath ? ' selected' : ''} state-${g.state}`}
            {...pathDnd.itemProps(g.path)}
          >
            <button
              className="tb-main"
              onClick={() => onPathClick(g.vpsId, g.path)}
              title={g.path || 'no folder'}
              {...tipAttrs({
                detail: [`${g.tabs.length} open in this folder`],
                actions: [['Click', 'show its tabs'], ['Drag', 'reorder']],
              })}
            >
              <span className="tb-dot" />
              <span className="tb-name">{folderName(g.path)}</span>
              <span className="tb-count">{g.tabs.length}</span>
            </button>
            <button
              className="tb-close"
              onClick={(e) => { e.stopPropagation(); onPathClose(g.vpsId, g.path, g.tabs); }}
              title={`close the ${g.tabs.length} tabs of this folder (nothing stops running)`}
            >✕</button>
          </div>
        ))}
        </div>
      </div>}

      <div className="tab-row tab-row-entities" ref={rowRef}>
        <button type="button" className="tab-rows-toggle"
          onClick={() => setHiddenTabRows(((hidden + 1) % 3) as HiddenTabRows)}
          aria-label={ROWS_TOGGLE_LABEL[hidden]} title={ROWS_TOGGLE_LABEL[hidden]}>
          <RowsIcon hidden={hidden} />
        </button>
        {hidden === 2 && trail}
        <div className="tab-scroll" ref={scrollRef}>
        {tabRows.length === 0 ? (
          <span className="tab-row-empty">nothing open in this folder</span>
        ) : tabRows.map((t) => (
          <div
            key={t.id}
            data-strip-tab={t.id}
            className={`tb-item tb-tab${t.id === activeTabId ? ' selected' : ''}${t.pinned ? '' : ' temporary'}`
              + ` state-${t.state}${t.orphan ? ' orphan' : ''}`}
            onContextMenu={(e) => onTabContext(e, t)}
            // Middle-click closes, like every browser and every IDE. On Linux
            // the default for button 1 is paste-primary-selection, so this has
            // to preventDefault or the click lands in whatever has focus.
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault(); e.stopPropagation();
              onTabClose(t);
            }}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            {...tabDnd.itemProps(t.id)}
          >
            <button
              className="tb-main"
              onClick={() => onTabClick(t)}
              onDoubleClick={() => onTabDoubleClick(t)}
              title={t.label}
              {...tipAttrs({
                detail: [[
                  t.kind === 'session' ? agentLogoLabel(t.agentKind, t.profileNumber)
                    : t.kind === 'shell' ? 'SSH shell' : t.kind === 'install' ? 'agent installation' : 'file',
                  t.pinned ? null : 'preview tab',
                  t.dirty ? 'unsaved changes' : null,
                ].filter(Boolean).join(' · '),
                t.kind === 'file' ? `${t.path}/${t.ref}` : t.kind === 'install' ? null : t.path],
                actions: [
                  ['Click', 'show'],
                  !t.pinned && ['Double-click', 'keep it open'],
                  ['Middle-click', 'close'],
                  ['Right-click', 'actions'],
                  ['Drag', 'reorder'],
                ],
              })}
            >
              {t.live && <span className="tb-dot" />}
              <span className="tb-glyph"><TabGlyph tab={t} /></span>
              <span className="tb-name">{t.label}</span>
              {t.dirty && <span className="tb-dirty" title="unsaved changes">●</span>}
            </button>
            <button
              className="tb-close"
              onClick={(e) => { e.stopPropagation(); onTabClose(t); }}
              title="close this tab (the session keeps running)"
            >✕</button>
          </div>
        ))}
        </div>

        <TabOverflow tabs={tabRows} activeTabId={activeTabId} outIds={outIds} onPick={onTabClick} />

        {activeVpsId && (
          <span className="tab-row-actions">
            {/* One button per ENABLED backend, like the sidebar's per-VPS ＋
                row: this strip is the fast path to "another agent right here",
                and Codex being reachable only from the sidebar made it the
                second-class backend it isn't. */}
            {enabledKinds(enabledBackends).flatMap((k) => {
              const found = profiles.filter((p) => p.provider === k && p.vpsId === activeVpsId);
              return (found.length ? found : [{ id: 'default', vpsId: activeVpsId, provider: k, number: 1, name: '', loggedIn: null }]).map((profile) => ({ k, profile }));
            }).map(({ k, profile }) => {
              const label = profileLabel(providerName(k), profile);
              const vps = vpsList.find((v) => v.id === activeVpsId);
              const av = profile.id !== 'default' && vps ? backendAvailability({ ...vps, ...providerLoginPatch(k, profile.loggedIn ? 1 : 0) }, k) : null;
              const reason = av ? av.ok ? null : av.reason : newSessionDisabledReason[k];
              return (
                <button
                  key={`${k}:${profile.id}`}
                  className={`tab-new-btn tab-new-session${k === 'codex' ? ' codex' : ''}`}
                  onClick={() => onNewSession(activeVpsId, activePath ?? '', k, profile.id)}
                  disabled={!!reason}
                  title={reason ? `${label} — ${reason}` : `new ${label} agent in this folder`}
                >
                  <span className="tab-new-plus">+</span>
                  <span className="tab-new-glyph"><AgentLogo kind={k} profileNumber={profile.number} size={12} title="" /></span>
                </button>
              );
            })}
            <button
              className="tab-new-btn tab-new-shell"
              onClick={() => onNewShell(activeVpsId, activePath ?? '')}
              title="new shell in this folder"
            >
              <span className="tab-new-plus">+</span>
              <span className="tab-new-glyph"><IconTerminal /></span>
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** A folder's label: its last segment ("—" for no folder). */
function folderName(path: string): string {
  return path ? (path.split('/').filter(Boolean).pop() || path) : '—';
}

function TabGlyph({ tab: t }: { tab: ResolvedTab }) {
  return t.kind === 'session' ? <AgentLogo kind={t.agentKind ?? 'claude'} profileNumber={t.profileNumber} size={12} title="" />
    : t.kind === 'shell' ? <IconTerminal />
    : t.kind === 'install' ? <IconTools />
    : <FileIcon name={t.label} />;
}

const ROWS_TOGGLE_LABEL: Record<HiddenTabRows, string> = {
  0: 'Fold the machine row',
  1: 'Fold the folder row too',
  2: 'Show the three rows',
};

/** Three bars, the folded ones faint. */
function RowsIcon({ hidden }: { hidden: HiddenTabRows }) {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1.5" y="2" width="11" height="2" rx="1" fill="currentColor" opacity={hidden >= 1 ? 0.3 : 1} />
      <rect x="1.5" y="6" width="11" height="2" rx="1" fill="currentColor" opacity={hidden >= 2 ? 0.3 : 1} />
      <rect x="1.5" y="10" width="11" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}

type TrailRow = { id: string; name: string; title: string; count: number; state: TabState };

/** A menu hanging under `el`, in viewport coordinates: the rows scroll
 *  sideways and would clip an absolutely placed one. */
function placeUnder(el: HTMLElement | null, align: 'left' | 'right', width = 240): CSSProperties | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const top = r.bottom + 4;
  const maxHeight = Math.max(120, window.innerHeight - top - 12);
  return align === 'right'
    ? { top, right: Math.max(8, window.innerWidth - r.right), maxHeight }
    : { top, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), maxHeight };
}

/** Machines and folders still waiting on you, outside the current one. */
const othersWaiting = (rows: TrailRow[], current: string | null | undefined) =>
  rows.filter((r) => r.id !== current && r.state === 'waiting').length;

function WaitBadge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="tab-wait" title={`${n} waiting for your answer`}>{n}</span>;
}

/** The folded rows as crumbs: "machine ▾ › folder ▾ ›", or ONE "folder ▾"
 *  when the tabs need the room. Each opens what its row listed. */
function TabTrail({ level, compact, machines, folders, vps, folder, onPickVps, onPickPath }: {
  level: 1 | 2; compact: boolean;
  machines: TrailRow[]; folders: TrailRow[];
  vps: TrailRow | null; folder: TrailRow | null;
  onPickVps: (vpsId: string) => void;
  onPickPath: (path: string) => void;
}) {
  const {
    openPanel: open, setOpenPanel, wrapRef, onPointerEnter, onPointerLeave, onTriggerLeave, onPanelEnter, onTriggerClick,
  } = useHoverPanels<'vps' | 'path' | 'both'>({ keepPinned: true });
  const vpsBtnRef = useRef<HTMLButtonElement>(null);
  const pathBtnRef = useRef<HTMLButtonElement>(null);
  const bothBtnRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ panel: string; style: CSSProperties } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const btn = open === 'vps' ? vpsBtnRef.current : open === 'path' ? pathBtnRef.current : bothBtnRef.current;
    const style = placeUnder(btn, 'left', open === 'both' ? 480 : 240);
    if (style) setPlace({ panel: open, style });
  }, [open]);

  const trigger = (panel: 'vps' | 'path' | 'both') => ({
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open === panel,
    onMouseEnter: () => onPointerEnter(panel),
    onMouseLeave: onTriggerLeave,
    onClick: () => { onTriggerClick(panel); },
  });
  const items = (rows: TrailRow[], current: string | null | undefined, pick: (id: string) => void, keepOpen = false) =>
    rows.map((r) => (
      <button key={r.id} type="button" role="menuitem" title={r.title}
        className={`tab-menu-item state-${r.state}${r.id === current ? ' is-current' : ''}`}
        onClick={() => { pick(r.id); if (!keepOpen) setOpenPanel(null); }}>
        <span className="tb-dot" /><span className="tb-name">{r.name}</span><span className="tb-count">{r.count}</span>
      </button>
    ));
  const showRow = (rows: HiddenTabRows, label: string) => (
    <button type="button" role="menuitem" className="tab-menu-item tab-menu-show"
      onClick={() => { setOpenPanel(null); setHiddenTabRows(rows); }}>
      <RowsIcon hidden={rows} />{label}
    </button>
  );
  const crumb = (panel: 'vps' | 'path' | 'both', row: TrailRow | null, waiting: number, title: string) => (
    <button ref={panel === 'vps' ? vpsBtnRef : panel === 'path' ? pathBtnRef : bothBtnRef} type="button"
      className={`tab-crumb state-${row?.state ?? 'sleeping'}`} title={open ? undefined : title} {...trigger(panel)}>
      <span className="tb-dot" />
      <span className="tb-name">{row?.name ?? '—'}</span>
      <WaitBadge n={waiting} />
      <span className="tab-crumb-caret" aria-hidden="true">▾</span>
    </button>
  );
  const vpsName = vps?.name ?? '—';
  const style = open && place?.panel === open ? place.style : { visibility: 'hidden' as const };

  return (
    <div className="tab-trail" ref={wrapRef} onMouseLeave={onPointerLeave}>
      {compact ? (
        <>
          {crumb('both', folder, othersWaiting(machines, vps?.id) + othersWaiting(folders, folder?.id), `${vpsName} › ${folder?.title ?? '—'}`)}
          <span className="tab-crumb-sep" aria-hidden="true">›</span>
        </>
      ) : (
        <>
          {crumb('vps', vps, othersWaiting(machines, vps?.id), vpsName)}
          <span className="tab-crumb-sep" aria-hidden="true">›</span>
          {level === 2 && <>
            {crumb('path', folder, othersWaiting(folders, folder?.id), folder?.title ?? '—')}
            <span className="tab-crumb-sep" aria-hidden="true">›</span>
          </>}
        </>
      )}
      {open === 'vps' && (
        <div className="tab-menu pop-kit" role="menu" style={style} onMouseEnter={onPanelEnter}>
          <div className="tab-menu-head">machines</div>
          {items(machines, vps?.id, onPickVps)}
          <div className="tab-menu-sep" />
          {showRow(0, 'show the machine row')}
        </div>
      )}
      {open === 'path' && (
        <div className="tab-menu pop-kit" role="menu" style={style} onMouseEnter={onPanelEnter}>
          <div className="tab-menu-head">folders · {vpsName}</div>
          {items(folders, folder?.id, onPickPath)}
          <div className="tab-menu-sep" />
          {showRow(1, 'show the folder row')}
        </div>
      )}
      {open === 'both' && (
        <div className="tab-menu tab-menu-cols pop-kit" role="menu" style={style} onMouseEnter={onPanelEnter}>
          <div>
            <div className="tab-menu-head">machines</div>
            {/* A machine picked here keeps the menu open: its folders are next. */}
            {items(machines, vps?.id, onPickVps, true)}
          </div>
          <div>
            <div className="tab-menu-head">folders · {vpsName}</div>
            {items(folders, folder?.id, onPickPath)}
          </div>
          <div className="tab-menu-sep tab-menu-span" />
          <div className="tab-menu-span">{showRow(0, 'show the three rows')}</div>
        </div>
      )}
    </div>
  );
}

/** "+N ▾": how many of this folder's tabs are out of view, and the whole
 *  folder as a list — hover opens it, a click pins it. Orange when one of the
 *  hidden ones waits on you. */
function TabOverflow({ tabs, activeTabId, outIds, onPick }: {
  tabs: ResolvedTab[]; activeTabId: string | null; outIds: readonly string[];
  onPick: (tab: ResolvedTab) => void;
}) {
  const {
    openPanel, setOpenPanel, wrapRef, onPointerEnter, onPointerLeave, onTriggerLeave, onPanelEnter, onTriggerClick,
  } = useHoverPanels<'tabs'>({ keepPinned: true });
  const open = openPanel === 'tabs';
  const btnRef = useRef<HTMLButtonElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (open) setStyle(placeUnder(btnRef.current, 'right'));
  }, [open]);
  if (outIds.length === 0 && !open) return null;
  const waitingOut = tabs.some((t) => t.state === 'waiting' && outIds.includes(t.id));
  return (
    <div className="tab-more" ref={wrapRef} onMouseLeave={onPointerLeave}>
      <button ref={btnRef} type="button" className="tab-more-btn" aria-haspopup="menu" aria-expanded={open}
        aria-label={`${outIds.length} more tabs`} title={open ? undefined : `${tabs.length} tabs in this folder`}
        onMouseEnter={() => onPointerEnter('tabs')} onMouseLeave={onTriggerLeave}
        onClick={() => { onTriggerClick('tabs'); }}>
        {waitingOut && <span className="tab-more-wait" />}+{outIds.length}<span className="tab-crumb-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="tab-menu pop-kit" role="menu" style={style ?? { visibility: 'hidden' }} onMouseEnter={onPanelEnter}>
          <div className="tab-menu-head">{tabs.length} tabs</div>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="menuitem" title={t.title}
              className={`tab-menu-item state-${t.state}${t.id === activeTabId ? ' is-current' : ''}${t.pinned ? '' : ' temporary'}`}
              onClick={() => { setOpenPanel(null); onPick(t); }}>
              {t.live ? <span className="tb-dot" /> : <span className="tab-menu-nodot" />}
              <span className="tb-glyph"><TabGlyph tab={t} /></span>
              <span className="tb-name">{t.label}</span>
              {t.dirty && <span className="tb-dirty">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
