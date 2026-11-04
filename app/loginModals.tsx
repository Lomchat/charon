'use client';
// ── Per-provider sign-in surfaces, declared once ─────────────────────────────
// Every "Sign in" (sidebar bar, health-chip fix, auth-error bubble, wizard row,
// launcher) lands here. Logins belong to the HUB (§14.115): each entry opens
// the hub account sign-in for its provider; the VPS it came from is irrelevant.
// A missing entry is a compile error (`Record` over the union), never a login
// button that opens nothing.
import type { ComponentType } from 'react';
import dynamic from 'next/dynamic';
import type { Vps } from '@/lib/db/schema';
import type { SessionProvider } from '@/lib/sessionCapabilities';

// Lazy: a login modal is rare and pulls its own polling logic — keep it out of
// the dashboard bootstrap chunk (§11).
const AccountLoginModal = dynamic(() => import('./AccountLoginModal'), { ssr: false });

/** Every provider's modal takes the same pair, so one renderer serves all. */
export type LoginModalProps = {
  vps: Vps;
  profile?: import("@/lib/accountProfiles").AccountProfile;
  /** `true` only on a CONFIRMED sign-in — the caller patches the row then. */
  onClose: (loggedIn: boolean) => void;
};

export type ProviderLoginSurface = {
  Modal: ComponentType<LoginModalProps>;
  signOut: (vpsId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Whether opening it closes the new-session wizard. Claude's flow asks the
   *  user to paste a code, so the wizard would sit under a modal it cannot
   *  finish; Codex's device code overlays deliberately — after signing in, the
   *  row's Codex ＋ re-enables live and the user launches from where they were. */
  closesWizard: boolean;
  /** Re-read the login state when the modal closes WITHOUT confirming, in case
   *  the user signed in (or out) by another route. Absent means "trust the flag
   *  we already have". */
  recheck?: (vpsId: string) => Promise<{ loggedIn: boolean; checkedAt?: number | null } | null>;
};

// Accounts belong to the HUB (§14.115): whichever VPS a "Sign in" came from,
// it signs a hub account in (or the profile's account again) — never a VPS.
function hubLogin(provider: SessionProvider): ComponentType<LoginModalProps> {
  function HubAccountLogin({ profile, onClose }: LoginModalProps) {
    const accountId = profile && profile.id !== 'default' ? profile.id : null;
    return <AccountLoginModal provider={provider} accountId={accountId} onClose={onClose} />;
  }
  HubAccountLogin.displayName = `HubAccountLogin(${provider})`;
  return HubAccountLogin;
}

const noLocalSignOut = async () => ({ ok: false, error: 'Accounts are managed once for every VPS — open Accounts.' });

export const PROVIDER_LOGIN: Record<SessionProvider, ProviderLoginSurface> = {
  claude: { Modal: hubLogin('claude'), signOut: noLocalSignOut, closesWizard: true },
  codex: { Modal: hubLogin('codex'), signOut: noLocalSignOut, closesWizard: false },
  cursor: { Modal: hubLogin('cursor'), signOut: noLocalSignOut, closesWizard: false },
};
