'use client';
// Header account buttons (CLAUDE.md §11): one per LOGIN across every VPS,
// only while one of its sessions is live (lib/accountGroups.ts). Each reads [logo · label · 5h/7d rings] — hovering
// (fine pointers) or clicking opens the SAME usage popover the session header
// uses (`UsageRings`), Cursor keeps its dashboard link — plus a ▾ that opens
// that account's sessions with the global nav's own sections and rows
// (`NavSections`). Both panels ride ONE `useHoverPanels`: same hover grace and
// click-pins-a-hover-open as the global nav, exclusive by construction; a hover
// switches between them only after a rest and never over a click-pinned one,
// which survives the pointer leaving. One header popover at a time across
// items (`claimHeaderPopover`). The button carries
// the global trigger's attention class (`navAttentionClass` over THE
// predicate, lib/sessionAttention.ts), phase-locked on the document timeline,
// so the account that just finished pulses together with the global nav.
// On a phone the strip folds to ONE item — the open session's login
// (`is-current`) — in the header's first row; `+N` (then ×) drops every login
// as a vertical menu under the header (`.acct-nav-menu`), closed by ×, Escape,
// an outside press or opening a session. Desktop CSS ignores the fold and
// hides the toggle.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import type { AccountUsage } from '@/lib/server/hub/types';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { accountGroupUsage, type AccountGroup } from '@/lib/accountGroups';
import { providerText } from '@/lib/providerText';
import AgentLogo from './AgentLogo';
import { UsageRings } from './UsageMeter';
import { readUsage, useUsageMap } from './usageStore';
import {
  NavSections, navAttentionClass, navSections, useHoverPanels, useNavRows, usePulsePhase,
} from './HeaderSessionNav';

/** THE account button's mark — the one place to change it. */
export function AccountLogo({ provider, size = 14 }: { provider: SessionProvider; size?: number }) {
  return <AgentLogo kind={provider} size={size} title="" />;
}

type ItemProps = {
  group: AccountGroup;
  usage: AccountUsage | null;
  /** Stable (memo): the item binds its own group. */
  onRefreshUsage: (g: AccountGroup) => void;
  vpsName: (vpsId: string) => string;
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** The login the phone's folded strip keeps visible. */
  current?: boolean;
  /** The open session's login: marked like the sidebar's selected card. */
  selected?: boolean;
};

// Memoized: HubPanel re-renders on every drawer/modal/selection change;
// an item only re-renders when its group, its usage or the selection moves.
export const AccountNavItem = memo(function AccountNavItem({ group, usage, onRefreshUsage, vpsName, selectedId, onOpen, current, selected }: ItemProps) {
  // The usage popover and the sessions panel share one anchor: exactly one
  // may be open at a time per item.
  // keepPinned: a click-opened popover stays until Escape / an outside press.
  const menu = useHoverPanels<'usage' | 'sessions'>({ keepPinned: true });
  const { openPanel, setOpenPanel } = menu;
  const open = openPanel === 'sessions';
  const usageOpen = openPanel === 'usage';
  const rows = useNavRows(group.sessions);
  const attention = navAttentionClass(rows);
  usePulsePhase(menu.wrapRef, attention);
  const { running } = navSections(rows);
  // UsageRings' own dismiss (outside press, Escape) only ever closes.
  const onUsageOpen = useCallback((next: boolean) => {
    setOpenPanel((cur) => (next ? 'usage' : cur === 'usage' ? null : cur));
  }, [setOpenPanel]);

  const onRefresh = useCallback(() => onRefreshUsage(group), [onRefreshUsage, group]);

  // The strip scrolls sideways, so its popovers hang off the HEADER (they
  // would be clipped inside the strip): place them under this item, and size
  // the panel's hover bridge to the real item→panel gap (`--acct-pop-gap`).
  function place() {
    const el = menu.wrapRef.current;
    const head = el?.closest('.app-head');
    if (!el || !head) return;
    const box = el.getBoundingClientRect();
    const headBox = head.getBoundingClientRect();
    el.style.setProperty('--acct-pop-x', `${Math.round(box.left - headBox.left)}px`);
    // Panel top = header bottom + 2px (app.css § .acct-nav-panel).
    el.style.setProperty('--acct-pop-gap', `${Math.max(0, Math.ceil(headBox.bottom - box.bottom) + 2)}px`);
  }

  return (
    <div
      ref={menu.wrapRef}
      className={`acct-nav-item${current ? ' is-current' : ''}${selected ? ' is-selected' : ''}${openPanel ? ' is-open' : ''}${attention ? ` ${attention}` : ''}`}
      data-account={group.key}
      onMouseEnter={() => { place(); if (openPanel) menu.cancelClose(); }}
      onPointerDown={place}
      onFocus={place}
      onMouseLeave={menu.onPointerLeave}
    >
      <UsageRings
        usage={usage}
        kind={group.provider}
        accountLabel={group.accountLabel}
        title={group.title}
        open={usageOpen}
        onOpenChange={onUsageOpen}
        onTriggerClick={() => { menu.onTriggerClick('usage'); }}
        onTriggerEnter={() => menu.onPointerEnter('usage')}
        onTriggerLeave={menu.onTriggerLeave}
        vpsName={group.vpsNames.join(', ')}
        onRefresh={onRefresh}
        className="acct-nav-usage"
        lead={<><AccountLogo provider={group.provider} /><span className="acct-nav-label">{group.label}</span></>}
      />
      <button
        type="button"
        className="acct-nav-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={providerText.accountSessions(group.provider, group.label)}
        title={providerText.accountSessions(group.provider, group.label)}
        onMouseEnter={() => menu.onPointerEnter('sessions')}
        onMouseLeave={menu.onTriggerLeave}
        onClick={() => { menu.onTriggerClick('sessions'); }}
      >
        <span className={`hnav-dot ${!running.length ? 'idle'
          : running.every((r) => r.state === 'background') ? 'background' : 'working'}`} aria-hidden />
        <span aria-hidden>▾</span>
      </button>
      {/* Hover bridge across the item→popover gap (the popover scrolls, so
          its own ::before would be clipped); a child: crossing it stays inside. */}
      {usageOpen && <div className="acct-nav-bridge" aria-hidden />}
      {open && (
        <div className="hnav-panel acct-nav-panel" role="menu" onMouseEnter={menu.onPanelEnter}>
          <div className="acct-nav-panel-head">
            <AccountLogo provider={group.provider} />
            <span>{group.title}</span>
          </div>
          <NavSections rows={rows} selectedId={selectedId} vpsName={vpsName}
            onPick={(r) => { onOpen(r.id); setOpenPanel(null); }} />
        </div>
      )}
    </div>
  );
});

type Props = {
  groups: readonly AccountGroup[];
  onRefreshUsage: (g: AccountGroup) => void;
  vpsName: (vpsId: string) => string;
  selectedId: string | null;
  onOpen: (id: string) => void;
};

export default function AccountNav({ groups, onRefreshUsage, vpsName, selectedId, onOpen }: Props) {
  // The gauges come from the usage store HERE, not from the hub root: a
  // reading re-renders this strip only (app/usageStore.ts). The stored
  // readings keep their identity, so unchanged items stay memo-hit.
  const usageMap = useUsageMap();
  const usage = useMemo(
    () => new Map(groups.map((g) => [g.key, accountGroupUsage(g, (m, provider) => readUsage(usageMap, m.vpsId, provider, m.profileId))] as const)),
    [groups, usageMap],
  );
  const stripRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // The phone's unfolded menu closes like one: Escape or a press outside the
  // strip (the items' popovers render inside it, so using them keeps it open).
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: PointerEvent) => {
      if (!stripRef.current?.contains(e.target as Node)) setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded]);
  // Opening a session from the menu is done with it.
  const openAndFold = useCallback((id: string) => { setExpanded(false); onOpen(id); }, [onOpen]);
  // A vertical wheel over the sideways strip scrolls it sideways: buttons past
  // the edge stay reachable with a plain mouse (the thin scrollbar shows they exist).
  function onWheel(e: WheelEvent<HTMLDivElement>) {
    const el = stripRef.current;
    if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  }
  if (!groups.length) return null;
  // A group lists every non-archived session of its login, sleeping ones too.
  const selectedKey = groups.find((g) => g.sessions.some((s) => s.id === selectedId))?.key ?? null;
  // No open session (or its login has no button): the first login stands in,
  // so the folded strip is never empty — but only a real match is marked.
  const currentKey = selectedKey ?? groups[0]!.key;
  const others = groups.length - 1;
  return (
    <div className={`acct-nav${expanded ? ' is-expanded' : ''}`} role="group" aria-label={providerText.accountNavLabel}
      ref={stripRef} onWheel={onWheel}>
      {groups.map((g) => (
        <AccountNavItem key={g.key} group={g} usage={usage.get(g.key) ?? null} onRefreshUsage={onRefreshUsage}
          vpsName={vpsName} selectedId={selectedId} onOpen={openAndFold} current={g.key === currentKey} selected={g.key === selectedKey} />
      ))}
      {others > 0 && (
        <button
          type="button"
          className="acct-nav-more"
          aria-expanded={expanded}
          aria-label={expanded ? 'hide the account list' : `show all ${groups.length} accounts`}
          title={expanded ? 'hide the account list' : `${others} more account${others > 1 ? 's' : ''}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '×' : `+${others}`}
        </button>
      )}
      {/* The phone's unfolded menu: EVERY login, strip order, the open
          session's one marked — rows of their own, so the folded chip above
          stays put. Inside the strip, so pressing a row is not "outside". */}
      {expanded && (
        <div className="acct-nav-menu" role="group" aria-label={providerText.accountNavLabel}>
          {groups.map((g) => (
            <AccountNavItem key={g.key} group={g} usage={usage.get(g.key) ?? null} onRefreshUsage={onRefreshUsage}
              vpsName={vpsName} selectedId={selectedId} onOpen={openAndFold} selected={g.key === selectedKey} />
          ))}
        </div>
      )}
    </div>
  );
}
