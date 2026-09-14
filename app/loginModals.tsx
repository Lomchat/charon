'use client';
// ── Per-provider sign-in surfaces, declared once ─────────────────────────────
// Signing in is genuinely bespoke per backend — Claude runs the hosted
// OAuth-code flow (§14.64), Codex a ChatGPT device code (§14.61) — so the
// MODALS stay separate components. What used to be duplicated is everything
// AROUND them: one `useState` per provider in ClaudePanel, one close handler
// hard-coding that provider's DB columns, one `on<Provider>LoginAgent` prop
// threaded through Sidebar, and one branch per provider at each opener.
//
// This is the registry for that wrapper (§14.102). A new backend adds ONE entry
// and gets: the sidebar sign-in bar, the health-chip fix button, the auth-error
// bubble's "Sign in", the install console's button and the wizard's row — all
// routed to its modal. A missing entry is a compile error (`Record` over the
// union), never a login button that opens nothing.
import type { ComponentType } from 'react';
import dynamic from 'next/dynamic';
import type { Vps } from '@/lib/db/schema';
import { api } from '@/lib/api';
import type { SessionProvider } from '@/lib/sessionCapabilities';

// Lazy: a login modal is rare and pulls its own polling logic — keep both out
// of the dashboard bootstrap chunk (§11).
const ClaudeLoginModal = dynamic(() => import('./ClaudeLoginModal'), { ssr: false });
const CodexLoginModal = dynamic(() => import('./CodexLoginModal'), { ssr: false });
const CursorLoginModal = dynamic(() => import('./CursorLoginModal'), { ssr: false });

/** Every provider's modal takes the same pair, so one renderer serves all. */
export type LoginModalProps = {
  vps: Vps;
  /** `true` only on a CONFIRMED sign-in — the caller patches the row then. */
  onClose: (loggedIn: boolean) => void;
};

export type ProviderLoginSurface = {
  Modal: ComponentType<LoginModalProps>;
  /** Whether opening it closes the new-session wizard. Claude's flow asks the
   *  user to paste a code, so the wizard would sit under a modal it cannot
   *  finish; Codex's device code overlays deliberately — after signing in, the
   *  row's Codex ＋ re-enables live and the user launches from where they were. */
  closesWizard: boolean;
  /** Re-read the login state when the modal closes WITHOUT confirming, in case
   *  the user signed in (or out) by another route. Only providers with a probe
   *  route have one; absent means "trust the flag we already have". */
  recheck?: (vpsId: string) => Promise<{ loggedIn: boolean; checkedAt?: number | null } | null>;
};

export const PROVIDER_LOGIN: Record<SessionProvider, ProviderLoginSurface> = {
  claude: {
    Modal: ClaudeLoginModal,
    closesWizard: true,
    recheck: async (vpsId) => {
      // Best-effort: on an SSH failure keep the value we already show.
      const r = await api.checkVpsClaudeLogin(vpsId).catch(() => null);
      return r?.ok ? { loggedIn: r.loggedIn, checkedAt: r.checkedAt } : null;
    },
  },
  codex: {
    Modal: CodexLoginModal,
    closesWizard: false,
  },
  cursor: {
    Modal: CursorLoginModal,
    // Overlays like Codex's: the user finishes in another tab/device and comes
    // back to a launcher that has re-enabled itself, still on the same screen.
    closesWizard: false,
    recheck: async (vpsId) => {
      const r = await api.checkVpsCursorLogin(vpsId).catch(() => null);
      return r?.ok ? { loggedIn: r.loggedIn, checkedAt: r.checkedAt } : null;
    },
  },
};
