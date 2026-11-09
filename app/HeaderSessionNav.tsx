'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AgentKind, SessionListItem } from '@/lib/types/api';
import AgentLogo, { agentLogoLabel } from './AgentLogo';
import { tipAttrs } from './tooltipText';
import { accountProfileNumber } from '@/lib/accountProfiles';
import { isWorkingStatus } from './sessionUnread';
import { attentionForRow, isWaitingAttention, rowStatus, shellAttention } from '@/lib/sessionAttention';
import TabNotificationBadge from './TabNotificationBadge';
import { IconTerminal } from './icons';
import type { ShellListItem } from './Sidebar';

/**
 * Header shortcut to the sessions you are actually using: a trigger carrying
 * how many are working and how many finished unread, opening a panel with what
 * is running, the last few that finished (and how long ago), and every session
 * under a search box.
 *
 * It reads the SAME projection of the session list the sidebar already holds —
 * no new request, no second source of truth. The only field added for it is
 * `lastActivityMs` (sessions route): "finished 4 minutes ago" cannot be ordered
 * from `unreadStop` (a flag) or `createdAt` (the launch).
 *
 * The global nav lists the live SHELLS too, from the sidebar's shell list: a
 * busy one is working, an idle one ready, ordered by `shells.last_activity_ms`
 * (shellNotify), with the sessions' finished-unread marker (`shellAttention`,
 * §14.47) and no gate. Account panels list sessions only (a shell bills no
 * account).
 */

/** How many finished sessions the dedicated section shows. The rest are one
 *  scroll away in the full list, which is the point of having both. */
const FINISHED_SHOWN = 5;

/** The pointer leaving the trigger AND the panel closes it — after a grace long
 *  enough to walk the gap between the two. The CSS bridge (`.hnav-panel::before`)
 *  covers that gap geometrically; this covers the pointer that cuts a corner. */
const HOVER_CLOSE_MS = 160;

/** One reading per row, computed once: the CSS class, the word in the tooltip
 *  and whether the unread pulse applies all come from it. */
type NavState = 'needs-you' | 'working' | 'background' | 'error' | 'idle' | 'ready';

type NavRowBase = {
  /** The session's or the shell's id: what a click opens. */
  id: string;
  state: NavState;
  working: boolean;
  waiting: boolean;
  /** The wait is an async question (answerable any time), not a parked turn. */
  question: boolean;
  unread: boolean;
  /** Finished BADLY and not opened yet (attention `error`): the red twin of
   *  `unread`. A paused or failed row that was already seen stays still. */
  errored: boolean;
  /** When this session last did anything; the launch for one that never spoke. */
  when: number;
};
export type SessionNavRow = NavRowBase & { s: SessionListItem; shell?: undefined };
export type ShellNavRow = NavRowBase & { shell: ShellListItem; s?: undefined };
export type NavRow = SessionNavRow | ShellNavRow;

function stateOf(s: SessionListItem, working: boolean, waiting: boolean): NavState {
  if (waiting) return 'needs-you';
  // `liveStatus ?? status`: an SSR row or an older hub's row may lack the live
  // field, and reading it alone painted every such row 'ready' (R5 D-1).
  const live = rowStatus(s);
  // Still counted as working (its tasks are), but in the sidebar's violet: the
  // turn is over, only what it launched runs on (§14.91).
  if (live === 'background') return 'background';
  if (working) return 'working';
  if (live === 'error' || live === 'failed') return 'error';
  if (live === 'sleeping') return 'idle';
  return 'ready';
}

export function rowOf(s: SessionListItem): SessionNavRow {
  // THE attention predicate (lib/sessionAttention.ts), shared with the sidebar,
  // the tab bar, the filter chip and the desk: one session, one reading.
  const attention = attentionForRow(s);
  // The rows ARE the summary store (§14.108): gates and attention arrive in
  // the same frame, no side feed to union.
  const waiting = isWaitingAttention(attention);
  // A turn parked on a blocking gate is still a running turn; a paused session
  // holding an async question is not "working".
  const working = isWorkingStatus(rowStatus(s)) || attention === 'blocked';
  return {
    id: s.id,
    s,
    state: stateOf(s, working, waiting),
    working,
    waiting,
    question: attention === 'question',
    unread: !waiting && attention === 'unread',
    errored: attention === 'error',
    when: s.lastActivityMs ?? (s.createdAt ? s.createdAt * 1000 : 0),
  };
}

/** A live shell: streaming = working, otherwise ready (unread when a job
 *  finished and the shell was not left since). */
export function shellRowOf(shell: ShellListItem): ShellNavRow {
  const working = shell.liveStatus === 'busy';
  return {
    id: shell.id,
    shell,
    state: working ? 'working' : 'ready',
    working,
    waiting: false,
    question: false,
    unread: shellAttention(shell) === 'unread',
    errored: false,
    when: shell.lastActivityMs ?? shell.startedAt,
  };
}

/** The panel's top sections. Every session the badge counts as waiting has a
 *  row there: a waiting one that is NOT working (an async question on an idle
 *  or paused session, a gate the live feed knows before the list) gets its own
 *  "Waiting on you" section, above Working (which keeps its spec'd count). */
export function navSections<R extends NavRow>(rows: R[]): { waitingOnly: R[]; running: R[]; finished: R[] } {
  return {
    waitingOnly: rows.filter((r) => r.waiting && !r.working),
    running: rows.filter((r) => r.working),
    // "Recently finished" is the short list you act on, so it holds sessions
    // you can still walk into: a PAUSED one finished too, but reading it means
    // waking it first, and there are enough of them to push every live session
    // out of a five-row window. They stay one scroll away, under "All
    // sessions". A failed one is still connected and idle (§14.68) — it just
    // finished badly, which is the last thing a list of what finished should
    // hide.
    finished: rows.filter((r) => r.state === 'ready' || r.state === 'error').slice(0, FINISHED_SHOWN),
  };
}

function label(r: NavRow): string {
  if (r.shell) return r.shell.name || `shell · ${r.shell.cwd ? r.shell.cwd.split('/').filter(Boolean).pop() || '/' : '~'}`;
  return r.s.name || r.s.firstUserMessage?.slice(0, 40) || '(unnamed)';
}

function where(r: NavRow): { vpsId: string; cwd: string } {
  return r.shell ? { vpsId: r.shell.vpsId, cwd: r.shell.cwd ?? '~' } : { vpsId: r.s.vpsId, cwd: r.s.cwd };
}

/** What a row's path collapses to when it does not fit: `…/<last folder>`.
 *  A one-segment path (`/srv`, `~`) has nothing to drop. */
export function lastFolderPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? path : `…/${trimmed.slice(cut + 1)}`;
}

/** Each row shows its whole path when it fits, else `lastFolderPath`. CSS
 *  cannot swap text on overflow, so the rows of one section are measured in
 *  one batch: show every full path, read which overflow (a single layout),
 *  collapse those. The path box's width does not depend on its text (the
 *  location only takes what the name leaves, `.hnav-row-where`), so the
 *  verdict is stable. `data-compact` is not a React prop: re-renders keep it.
 *  Overflow is read in FRACTIONAL px: the ellipsis cuts at any sub-pixel
 *  overflow, which the integer scrollWidth/clientWidth pair rounds away (the
 *  full path then shows, cut at its end). Refit when a location box changes
 *  width (the age grows a digit, a scrollbar appears) or a font lands. */
function useFittedPaths(ref: RefObject<HTMLElement | null>, rows: unknown) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const fit = () => {
      const cells = [...root.querySelectorAll<HTMLElement>('.hnav-row-cwd')];
      for (const el of cells) el.removeAttribute('data-compact');
      const over = cells.map((el) => {
        const full = el.firstElementChild;
        return !!full && full.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.01;
      });
      cells.forEach((el, i) => { if (over[i]) el.setAttribute('data-compact', ''); });
    };
    fit();
    const ro = new ResizeObserver(fit);
    for (const box of root.querySelectorAll('.hnav-row-where')) ro.observe(box);
    document.fonts?.addEventListener('loadingdone', fit);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener('loadingdone', fit);
    };
  }, [ref, rows]);
}

function ago(ms: number): string {
  if (!ms) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function stateWord(r: NavRow): string {
  if (r.shell) return r.working ? 'busy' : r.unread ? 'finished, unread' : 'idle';
  switch (r.state) {
    case 'needs-you': return r.question ? 'question' : 'needs you';
    case 'working': return 'working';
    case 'background': return 'background';
    case 'error': return r.errored ? 'error, unread' : 'error';
    case 'idle': return 'paused';
    default: return r.unread ? 'finished, unread' : 'ready';
  }
}

/**
 * What a click on the trigger does. A hover already opened the panel on a
 * desktop, and reaching for the trigger then clicking it is the natural
 * gesture: that click PINS the panel (and focuses its search) instead of
 * toggling it shut. Only a click on a panel the user opened by clicking
 * closes it.
 */
export function triggerClickOutcome(open: boolean, openedBy: 'hover' | 'click'): 'open' | 'close' | 'pin' {
  if (!open) return 'open';
  return openedBy === 'hover' ? 'pin' : 'close';
}

/** The trigger's attention class over a set of rows: orange outranks red,
 *  red outranks green (a question blocking a session, then a session that
 *  ended badly, then a page waiting to be read — the card's precedence).
 *  Shared by the global trigger and every account button (app/AccountNav.tsx),
 *  so they light up from ONE reading. */
export type NavAttentionClass = '' | 'has-waiting' | 'has-error' | 'has-unread';
export function navAttentionClass(rows: readonly NavRow[]): NavAttentionClass {
  if (rows.some((r) => r.waiting)) return 'has-waiting';
  if (rows.some((r) => r.errored)) return 'has-error';
  if (rows.some((r) => r.unread)) return 'has-unread';
  return '';
}


/** Phase-lock the attention pulse on the DOCUMENT TIMELINE: every surface
 *  carrying it beats together, whenever it lit up (the global nav and the
 *  account buttons light up from different renders). The CSS animation is
 *  re-anchored at timeline 0 — a wall-clock `animation-delay` set from an
 *  effect stayed off by each element's own commit→effect latency. */
export function lockPulsePhase(el: Element | null | undefined): void {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations()) {
    const name = (a as Animation & { animationName?: string }).animationName;
    if (name && name.startsWith('row-pulse') && a.startTime !== 0) a.startTime = 0;
  }
}

/** `lockPulsePhase` on `ref` whenever the attention class changes (a new
 *  class is a new CSS animation). Before paint: no first frame off-beat. */
export function usePulsePhase(ref: RefObject<Element | null>, cls: NavAttentionClass): void {
  useLayoutEffect(() => { if (cls) lockPulsePhase(ref.current); }, [ref, cls]);
}

/** A coarse pointer synthesizes `mouseenter` on TAP, so hover-to-open would
 *  open the panel and let the tap's own click close it again. Hovering is a
 *  fine-pointer gesture; touch keeps the click toggle. */
function hoverOpens() {
  return !window.matchMedia?.('(pointer: coarse)').matches;
}

/**
 * What a click on panel `target`'s trigger does when `current` is open (null:
 * none). Another panel open ⇒ this one simply OPENS (they are exclusive);
 * the same panel follows `triggerClickOutcome`.
 */
export function panelClickOutcome<K extends string>(
  current: K | null, target: K, openedBy: 'hover' | 'click',
): 'open' | 'close' | 'pin' {
  return triggerClickOutcome(current === target, openedBy);
}

/** A hover on ANOTHER panel's trigger while one is open does not swap at
 *  once: the path from one trigger to the open panel can cross the other
 *  trigger (the ▾ sits at the item's right edge, its panel hangs from the
 *  left). The switch needs the pointer to REST there this long. */
export const HOVER_SWITCH_MS = 220;

/**
 * What a pointer entering panel `target`'s trigger does when `current` is open
 * (null: none). Nothing open ⇒ open now; the same one ⇒ keep; another one a
 * hover opened ⇒ switch after `HOVER_SWITCH_MS` of rest; another one a CLICK
 * opened (pinned) ⇒ a hover never replaces it.
 */
export function panelHoverOutcome<K extends string>(
  current: K | null, target: K, openedBy: 'hover' | 'click',
): 'open' | 'keep' | 'switch-later' | 'ignore' {
  if (current === null) return 'open';
  if (current === target) return 'keep';
  return openedBy === 'click' ? 'ignore' : 'switch-later';
}

/** Whether the pointer leaving the wrapper (and its panels) closes the open
 *  panel after the grace. A hover-opened one always does; a click-opened
 *  (pinned) one only when the surface does not keep pins (`keepPinned`). */
export function leaveCloses(openedBy: 'hover' | 'click', keepPinned: boolean): boolean {
  return openedBy === 'hover' || !keepPinned;
}

// The header's popovers are ONE at a time across every hover-panel instance
// (the account buttons sit side by side, each with its own state): a panel
// opening closes whichever other instance still shows one (its leave grace
// would otherwise overlap — and paint over — the new one). A client module:
// one copy per page, so a module-level slot is THE slot.
let headerPopoverOwner: { id: object; close: () => void } | null = null;

/** `id` now shows a header popover: close the previous owner's. */
export function claimHeaderPopover(id: object, close: () => void): void {
  const prev = headerPopoverOwner;
  headerPopoverOwner = { id, close };
  if (prev && prev.id !== id) prev.close();
}

/** `id` closed its popover: free the slot if it still holds it. */
export function releaseHeaderPopover(id: object): void {
  if (headerPopoverOwner?.id === id) headerPopoverOwner = null;
}

/** The hover/click machinery for a set of MUTUALLY EXCLUSIVE panels sharing
 *  one wrapper (an account button: usage + sessions). Hover opens on fine
 *  pointers (closing after a grace; a hover on another trigger switches after
 *  `panelHoverOutcome`'s rest, never over a pinned one), a click pins or
 *  toggles (`panelClickOutcome`), Escape and a press outside `wrapRef`
 *  dismiss. `keepPinned`: a click-opened panel survives the pointer leaving
 *  (`leaveCloses`). One header popover at a time across instances
 *  (`claimHeaderPopover`). */
export function useHoverPanels<K extends string>({ keepPinned = false }: { keepPinned?: boolean } = {}) {
  const [openPanel, setOpenPanel] = useState<K | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How the panel opened decides whether the keyboard follows it: a hover is
  // not a request for focus.
  const opened = useRef<'hover' | 'click'>('click');
  const self = useRef<object>({});

  function cancelClose() {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  /** Drop a pending hover switch (the pointer left that trigger, or reached
   *  the open panel). */
  function cancelSwitch() {
    if (switchTimer.current === null) return;
    clearTimeout(switchTimer.current);
    switchTimer.current = null;
  }
  function onPointerEnter(panel: K) {
    if (!hoverOpens()) return;
    cancelClose();
    cancelSwitch();
    const next = panelHoverOutcome(openPanel, panel, opened.current);
    if (next === 'open') { opened.current = 'hover'; setOpenPanel(panel); }
    else if (next === 'switch-later') {
      switchTimer.current = setTimeout(() => {
        switchTimer.current = null;
        opened.current = 'hover';
        setOpenPanel(panel);
      }, HOVER_SWITCH_MS);
    }
  }
  /** The pointer leaving a trigger (not the wrapper): a switch it started is off. */
  function onTriggerLeave() { cancelSwitch(); }
  function onPointerLeave() {
    if (!hoverOpens()) return;
    cancelClose();
    cancelSwitch();
    if (!leaveCloses(opened.current, keepPinned)) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpenPanel(null);
    }, HOVER_CLOSE_MS);
  }
  /** The pointer reached an open panel: it stays, whatever was pending. */
  function onPanelEnter() { cancelClose(); cancelSwitch(); }
  /** Returns 'pin' when the click pinned a hover-opened panel. */
  function onTriggerClick(panel: K): 'open' | 'close' | 'pin' {
    cancelClose();
    cancelSwitch();
    const next = panelClickOutcome(openPanel, panel, opened.current);
    opened.current = 'click';
    if (next !== 'pin') setOpenPanel(next === 'open' ? panel : null);
    return next;
  }
  useEffect(() => () => { cancelClose(); cancelSwitch(); releaseHeaderPopover(self.current); }, []);

  useEffect(() => {
    const id = self.current;
    if (openPanel === null) { releaseHeaderPopover(id); return; }
    claimHeaderPopover(id, () => {
      if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
      if (switchTimer.current !== null) { clearTimeout(switchTimer.current); switchTimer.current = null; }
      setOpenPanel(null);
    });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenPanel(null); };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenPanel(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openPanel]);

  return {
    openPanel, setOpenPanel, wrapRef, opened, cancelClose, onPointerEnter, onPointerLeave,
    onTriggerLeave, onPanelEnter, onTriggerClick, hoverOpens,
  };
}

/** One hover/click panel (`useHoverPanels` with a single member). */
export function useHoverMenu() {
  const m = useHoverPanels<'menu'>();
  const { setOpenPanel } = m;
  const setOpen = useCallback((next: boolean) => setOpenPanel(next ? 'menu' : null), [setOpenPanel]);
  return {
    open: m.openPanel === 'menu', setOpen, wrapRef: m.wrapRef, opened: m.opened, cancelClose: m.cancelClose,
    onPointerEnter: () => m.onPointerEnter('menu'), onPointerLeave: m.onPointerLeave,
    onTriggerClick: () => m.onTriggerClick('menu'), hoverOpens,
  };
}

/** Rows as a nav panel lists them: newest activity first. `shells`: the live
 *  ones join in. */
export function useNavRows(
  sessions: readonly SessionListItem[], shells?: readonly ShellListItem[],
): NavRow[] {
  return useMemo(() => navRows(sessions, shells), [sessions, shells]);
}

export function navRows(
  sessions: readonly SessionListItem[], shells?: readonly ShellListItem[],
): NavRow[] {
  const rows: NavRow[] = sessions.map((session) => rowOf(session));
  for (const shell of shells ?? []) if (!shell.exited) rows.push(shellRowOf(shell));
  return rows.sort((a, b) => b.when - a.when);
}

/** The panel's sections when no search runs — the global nav and every
 *  account panel render the SAME ones. */
export function NavSections({ rows, ...rowProps }: RowProps & { rows: NavRow[] }) {
  const { waitingOnly, running, finished } = navSections(rows);
  return (
    <>
      <Section title={`Waiting on you (${waitingOnly.length})`} rows={waitingOnly}
        empty="" {...rowProps} />
      <Section title={`Working (${running.length})`} rows={running}
        empty="nothing running" {...rowProps} />
      <Section title="Recently finished" rows={finished}
        empty="no finished session yet" {...rowProps} />
      <Section title={`All sessions (${rows.length})`} rows={rows}
        empty="" scroll {...rowProps} />
    </>
  );
}

type Props = {
  sessions: SessionListItem[];
  shells?: ShellListItem[];
  vpsName: (vpsId: string) => string;
  /** The open session or shell (ids never collide: 32 vs 16 hex). */
  selectedId: string | null;
  onOpen: (id: string) => void;
  onOpenShell?: (id: string) => void;
};

export default function HeaderSessionNav({ sessions, shells, vpsName, selectedId, onOpen, onOpenShell }: Props) {
  const menu = useHoverMenu();
  const { open, setOpen, opened } = menu;
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  // Opening ON PURPOSE lands on the search box; closing forgets the query, so
  // the panel always reopens on the live picture rather than on an old filter.
  // A hover opens nothing the keyboard asked for — the pointer can cross the
  // trigger while you are typing in the chat box, and pulling focus out of it
  // would eat the next keystrokes. A coarse pointer never auto-focuses: the
  // virtual keyboard would cover the very list the tap opened (vpsSearch.ts).
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    if (opened.current === 'click' && menu.hoverOpens()) search.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rows = useNavRows(sessions, shells);
  const { running } = navSections(rows);
  const unreadCount = rows.filter((r) => r.unread).length;
  // The other durable "go and look" count, and the louder one: a session is
  // BLOCKED on you until you answer. Same apparatus as the unread green —
  // a count on the trigger, a pulse, a row you click to land on the card.
  const waitingCount = rows.filter((r) => r.waiting).length;
  // The red twin of the unread green: a turn or a session that ended in an
  // error nobody has opened yet.
  const errorCount = rows.filter((r) => r.errored).length;
  const attention = navAttentionClass(rows);
  const trigger = useRef<HTMLButtonElement>(null);
  usePulsePhase(trigger, attention);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return rows;
    const terms = q.split(/\s+/);
    return rows.filter((r) => {
      const at = where(r);
      const hay = [
        label(r), r.s?.handle ?? '', at.cwd, vpsName(at.vpsId), r.shell ? 'shell' : String(r.s.kind),
      ].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, q, vpsName]);

  function pick(r: NavRow) {
    if (r.shell) onOpenShell?.(r.id);
    else onOpen(r.id);
    setOpen(false);
  }
  const rowProps = { onPick: pick, selectedId, vpsName };

  return (
    // The panel is a CHILD of the wrapper, so walking from the trigger into the
    // list never leaves this element: one enter/leave pair drives both.
    <div className={`hnav${open ? ' is-open' : ''}`} ref={menu.wrapRef}
      onMouseEnter={menu.onPointerEnter} onMouseLeave={menu.onPointerLeave}>
      <TabNotificationBadge count={unreadCount + waitingCount + errorCount} />
      <button
        type="button"
        ref={trigger}
        className={`hnav-trigger${open ? ' is-open' : ''}${attention ? ` ${attention}` : ''}`}
        onClick={() => {
          if (menu.onTriggerClick() === 'pin') search.current?.focus({ preventScroll: true });
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title={[
          `${running.length} working`,
          ...(waitingCount ? [`${waitingCount} waiting on you`] : []),
          ...(errorCount ? [`${errorCount} ended in error, unread`] : []),
          `${unreadCount} finished, unread`,
          `${rows.length} sessions`,
        ].join(' · ')}
      >
        {/* Violet only when background work is ALL that runs; a live turn or a
            waiting gate is the louder fact. */}
        <span className={`hnav-dot ${!running.length ? 'idle'
          : running.every((r) => r.state === 'background') ? 'background' : 'working'}`} aria-hidden />
        <span className="hnav-trigger-count">{running.length}</span>
        <span className="hnav-trigger-word">working</span>
        {/* Blocked sessions are counted on the left too (a turn parked on
            you still runs); an async question on a paused session is not
            working, so this is not always a subset (lib/sessionAttention.ts). */}
        {!!waitingCount && (
          <span className="hnav-trigger-waiting" title={`${waitingCount} waiting for your answer`}>
            <span className="hnav-dot waiting" aria-hidden />{waitingCount}
          </span>
        )}
        {!!errorCount && (
          <span className="hnav-trigger-error" title={`${errorCount} ended in an error and not opened yet`}>
            <span className="hnav-dot errored" aria-hidden />{errorCount}
          </span>
        )}
        {!!unreadCount && (
          <span className="hnav-trigger-unread" title={`${unreadCount} finished and not opened yet`}>
            <span className="hnav-dot unread" aria-hidden />{unreadCount}
          </span>
        )}
        <span className="hnav-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="hnav-panel" role="menu">
          <div className="hnav-search">
            <input
              ref={search}
              className="hnav-search-input"
              value={query}
              placeholder="search sessions and shells — name, path, machine…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {!!query && (
              <button type="button" className="hnav-search-clear" onClick={() => setQuery('')}
                aria-label="clear search">×</button>
            )}
          </div>
          {q ? (
            <Section title={`Matches (${matches.length})`} rows={matches}
              empty="nothing matches" scroll {...rowProps} />
          ) : (
            <NavSections rows={rows} {...rowProps} />
          )}
        </div>
      )}
    </div>
  );
}

type RowProps = {
  onPick: (r: NavRow) => void;
  selectedId: string | null;
  vpsName: (id: string) => string;
};

function Section({ title, rows, empty, scroll, ...rowProps }: RowProps & {
  title: string; rows: NavRow[]; empty: string; scroll?: boolean;
}) {
  const rowsRef = useRef<HTMLDivElement | null>(null);
  useFittedPaths(rowsRef, rows);
  if (!rows.length && !empty) return null;
  return (
    <div className={`hnav-section${scroll ? ' is-scroll' : ''}`}>
      <div className="hnav-section-title">{title}</div>
      {rows.length === 0 && <div className="hnav-empty">{empty}</div>}
      <div className="hnav-section-rows" ref={rowsRef}>
        {rows.map((r) => <Row key={r.id} r={r} {...rowProps} />)}
      </div>
    </div>
  );
}

function Row({ r, onPick, selectedId, vpsName }: RowProps & { r: NavRow }) {
  const at = where(r);
  const machine = vpsName(at.vpsId);
  return (
    <button
      type="button"
      role="menuitem"
      data-nav-id={r.id}
      className={`hnav-row ${r.state}${r.shell ? ' shell' : ''}${r.unread ? ' unread' : ''}${r.errored ? ' errored' : ''}${r.id === selectedId ? ' is-open' : ''}`}
      onClick={() => onPick(r)}
      title={label(r)}
      {...tipAttrs({
        detail: [
          `${r.shell ? 'SSH shell' : agentLogoLabel(r.s.kind as AgentKind, accountProfileNumber(r.s))} · ${stateWord(r)}`,
          `${machine} · ${at.cwd}`,
        ],
        actions: [['Click', 'open']],
      })}
    >
      <span className="hnav-dot" aria-hidden />
      {r.shell
        ? <IconTerminal className="hnav-row-glyph" />
        : <AgentLogo kind={r.s.kind as AgentKind} profileNumber={accountProfileNumber(r.s)} size={13} title="" />}
      <span className="hnav-row-name">{label(r)}</span>
      {/* Machine and path are TWO facts, joined the way the session subtitle
          joins them (`CwdSubtitle`). Glued with a colon, a machine whose name
          ends in a word — "chalco - new" — read as a prefix of the path. */}
      <span className="hnav-row-where">
        <span className="hnav-row-vps">{machine}</span>
        <span className="hnav-row-cwd">
          <span className="hnav-row-cwd-full">{at.cwd}</span>
          <span className="hnav-row-cwd-short">{lastFolderPath(at.cwd)}</span>
        </span>
      </span>
      <span className="hnav-row-when">{ago(r.when)}</span>
    </button>
  );
}
