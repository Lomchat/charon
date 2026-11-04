'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Vps } from '@/lib/db/schema';
import type { AgentKind } from '@/lib/types/api';
import { DEFAULT_ACCOUNT_PROFILE, profileLabel, type AccountProfile } from '@/lib/accountProfiles';
import { providerLoginPatch } from '@/lib/sessionCapabilities';
import { providerName, providerText } from '@/lib/providerText';
import { backendLauncher, type BackendLauncher } from './vpsHealth';
import AgentLogo from './AgentLogo';
import { useLongPress } from './useLongPress';

/**
 * One launcher per backend, whatever the number of accounts (§14.58). With a
 * second account on the VPS the launcher carries a corner mark, and pointing
 * at it opens a small menu IN PLACE — its first row where the button was — to
 * choose which account the session runs on. Touch has no hover: a tap opens
 * the same menu. Used by the sidebar ＋ buttons and the new-session wizard; the
 * tab bar keeps its own per-account buttons.
 */

/** The VPS as one account sees it: an extra profile's login stands in for the
 *  default's columns in the launcher rule (`vpsHealth § backendLauncher`). */
export function vpsForProfile(v: Vps, provider: AgentKind, profile?: AccountProfile): Vps {
  return profile && profile.number > 1 ? { ...v, ...providerLoginPatch(provider, profile.loggedIn ? 1 : 0) } : v;
}

/** This VPS's accounts for one backend, default first. A synthetic default
 *  stands in until the list has loaded. */
export function accountChoices(profiles: AccountProfile[], vpsId: string, provider: AgentKind): AccountProfile[] {
  const found = profiles.filter((p) => p.vpsId === vpsId && p.provider === provider)
    .sort((a, b) => a.number - b.number);
  return found.length ? found : [{ id: DEFAULT_ACCOUNT_PROFILE, vpsId, provider, number: 1, name: '', loggedIn: null }];
}

/** A pointer only crossing the button does not open anything. */
const HOVER_OPEN_MS = 60;
/** Long enough to forgive a pointer cutting a corner (cf. HeaderSessionNav). */
const HOVER_CLOSE_MS = 160;
/** The menu's own padding: its first row's logo lands on the button's. */
const MENU_INSET = 6;

const coarse = () => !!window.matchMedia?.('(pointer: coarse)').matches;

type Opened = { rect: DOMRect; focus: boolean };

export type AccountChoice = ReturnType<typeof useAccountChoice>;

/** Trigger side of the menu. `count` = this backend's accounts on the VPS;
 *  with one, the trigger is a plain launcher and nothing here engages. */
export function useAccountChoice(count: number) {
  const multi = count > 1;
  const [opened, setOpened] = useState<Opened | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => { if (!multi) setOpened(null); }, [multi]);

  const setTrigger = useCallback((el: HTMLElement | null) => { trigger.current = el; }, []);
  const show = useCallback((focus: boolean) => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setOpened({ rect, focus });
  }, []);
  const close = useCallback((restoreFocus = false) => {
    clearTimers();
    setOpened(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, [clearTimers]);
  const keepOpen = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const leave = useCallback(() => {
    if (coarse()) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    keepOpen();
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpened(null); }, HOVER_CLOSE_MS);
  }, [keepOpen]);

  return {
    multi,
    opened,
    close,
    element: () => trigger.current,
    /** Spread on the launcher. */
    trigger: {
      ref: setTrigger,
      ...(multi ? {
        'aria-haspopup': 'menu' as const,
        'aria-expanded': !!opened,
        onMouseEnter: () => {
          // A coarse pointer synthesizes mouseenter on TAP; the click opens it.
          if (coarse()) return;
          keepOpen();
          if (opened || openTimer.current) return;
          openTimer.current = setTimeout(() => { openTimer.current = null; show(false); }, HOVER_OPEN_MS);
        },
        onMouseLeave: leave,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault(); e.stopPropagation();
          show(true);
        },
      } : {}),
    },
    /** Call first in the launcher's onClick: true = the click belonged to the
     *  menu (several accounts: the choice is always made in it). */
    takeClick(e: MouseEvent): boolean {
      if (!multi) return false;
      clearTimers();
      if (opened) setOpened(null);
      // Keyboard activation (detail 0) lands focus on the first account.
      else show(e.detail === 0);
      return true;
    },
    /** Spread on the menu, so walking into it keeps it open. */
    hover: { onMouseEnter: keepOpen, onMouseLeave: leave },
  };
}

type MenuProps = {
  choice: AccountChoice;
  vps: Vps;
  provider: AgentKind;
  profiles: AccountProfile[];
  /** A profile being signed out cannot launch. */
  busy?: (profile: AccountProfile) => boolean;
  /** Ready ⇒ launch on it; otherwise its repair (sign-in). */
  onPick: (profile: AccountProfile, launcher: BackendLauncher) => void;
  /** Right-click / long-press on a row: that account's own menu. */
  onContext?: (profile: AccountProfile, x: number, y: number) => void;
};

export function AccountChoiceMenu({ choice, vps, provider, profiles, busy, onPick, onContext }: MenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const { opened, close } = choice;

  useLayoutEffect(() => {
    if (!opened || !menu.current) { setPlace(null); return; }
    const { rect } = opened;
    const box = menu.current.getBoundingClientRect();
    const edge = 8;
    const left = Math.max(edge, Math.min(rect.left - MENU_INSET, innerWidth - box.width - edge));
    // In place, growing down; near the bottom it grows UP from the button.
    let top = rect.top - MENU_INSET;
    if (top + box.height > innerHeight - edge) top = rect.bottom + MENU_INSET - box.height;
    setPlace({ left, top: Math.max(edge, top) });
  }, [opened]);
  // Focus once PLACED: the measuring pass is `visibility: hidden`, and a
  // hidden element refuses focus.
  useEffect(() => {
    if (place && opened?.focus) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [place, opened]);

  useEffect(() => {
    if (!opened) return;
    // The trigger toggles through its own click (`takeClick`).
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !choice.element()?.contains(target)) close();
    };
    // Capture: Escape closes this menu, never the wizard around it.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      if (e.key === 'Tab') close();
    };
    // Anchored to a button that moves with its list: follow nothing, close.
    const onScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) close(); };
    const onResize = () => close();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [opened, close, choice]);

  if (!opened || typeof document === 'undefined') return null;

  function navigate(e: KeyboardEvent) {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  const list = (
    <div ref={menu} className="account-choice-menu" role="menu"
      aria-label={providerText.chooseAccount(provider)}
      style={{
        left: place?.left ?? opened.rect.left, top: place?.top ?? opened.rect.top,
        minWidth: opened.rect.width + MENU_INSET * 2,
        visibility: place ? undefined : 'hidden',
      }}
      {...choice.hover}
      onKeyDown={navigate}
      // A portal still bubbles through the React tree: rows inside a sidebar
      // card or the wizard must not reach their handlers.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}>
      {profiles.map((profile) => (
        <AccountChoiceRow key={profile.id} vps={vps} provider={provider} profile={profile}
          busy={busy?.(profile) ?? false}
          onPick={(launcher) => { close(); onPick(profile, launcher); }}
          onContext={onContext ? (x, y) => { close(); onContext(profile, x, y); } : undefined} />
      ))}
    </div>
  );
  // Inside the themed root, like every popup (PickerControl).
  return createPortal(list, choice.element()?.closest('.app-root') ?? document.body);
}

function AccountChoiceRow({ vps, provider, profile, busy, onPick, onContext }: {
  vps: Vps; provider: AgentKind; profile: AccountProfile; busy: boolean;
  onPick: (launcher: BackendLauncher) => void;
  onContext?: (x: number, y: number) => void;
}) {
  const launcher = backendLauncher(vpsForProfile(vps, provider, profile), provider);
  const disabled = busy || !launcher.enabled;
  const lp = useLongPress(({ x, y }) => { onContext?.(x, y); });
  const label = profileLabel(providerName(provider), profile);
  const note = busy ? 'Logging out…' : launcher.ready ? null : launcher.fix ? 'Sign in' : 'Unavailable';
  return (
    <button type="button" role="menuitem" tabIndex={-1}
      className={`account-choice-row${launcher.ready ? '' : ' needs-fix'}`}
      disabled={disabled} title={busy ? 'Logging out…' : `${label} — ${launcher.title}`}
      {...lp.handlers}
      onClick={() => { if (!lp.consume()) onPick(launcher); }}
      onContextMenu={(e) => {
        if (!onContext) return;
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}>
      <AgentLogo kind={provider} profileNumber={profile.number} size={16} title="" />
      <span className="account-choice-label">{label}</span>
      {note && <span className="account-choice-note">{note}</span>}
    </button>
  );
}

/** The corner mark: this launcher hides a choice of accounts. */
export function AccountChoiceMark() {
  return (
    <svg className="account-choice-mark" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="3.5" y="0.75" width="5.75" height="5.75" rx="1.5" />
      <rect x="0.75" y="3.5" width="5.75" height="5.75" rx="1.5" />
    </svg>
  );
}
