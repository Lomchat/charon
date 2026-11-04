import type { SessionProvider } from './sessionCapabilities';

/** A hub-owned provider account (CLAUDE.md §14.115), browser-safe: never a
 *  credential. `id` doubles as the session's `providerConfig.accountProfile`. */
export type ProviderAccount = {
  id: string;
  provider: SessionProvider;
  /** Rank within its provider, 1-based: the logo badge. */
  number: number;
  name: string;
  email: string | null;
  displayName: string | null;
  organization: string | null;
  plan: string | null;
  accountKey: string | null;
  /** 'ok' | 'expired' (sign in again) | 'error' (a refresh failed, retrying). */
  status: 'ok' | 'expired' | 'error';
  lastError: string | null;
  accessExpiresAt: number | null;
  /** When the sign-in itself ends (Claude ~28 days after login, Cursor key). */
  loginExpiresAt: number | null;
  lastRefreshAt: number | null;
  createdAt: number;
};

/** "Claude 2 · Perso" style: the user's name when given, else the login's
 *  EMAIL (unique — two accounts of one person share a display name). */
export function providerAccountLabel(providerName: string, a: Pick<ProviderAccount, 'number' | 'name' | 'displayName' | 'email'>): string {
  const who = a.name?.trim() || a.email?.trim() || a.displayName?.trim() || '';
  return `${providerName}${a.number > 1 ? ` ${a.number}` : ''}${who ? ` · ${who}` : ''}`;
}

/** Days before the sign-in ends; the banner warns from `LOGIN_EXPIRY_WARN_DAYS`. */
export const LOGIN_EXPIRY_WARN_DAYS = 4;
export function loginDaysLeft(a: Pick<ProviderAccount, 'loginExpiresAt'>, now = Date.now()): number | null {
  return a.loginExpiresAt ? Math.floor((a.loginExpiresAt - now) / 86_400_000) : null;
}

/** A sign-in in progress at the hub (POST /api/accounts/login). */
export type AccountLoginAttempt = {
  id: string;
  provider: SessionProvider;
  /** code = open the link, paste the code back (Claude); device = enter
   *  `userCode` on the page (Codex); link = just open it (Cursor). */
  kind: 'code' | 'device' | 'link';
  url: string;
  userCode?: string;
  phase: 'pending' | 'verifying' | 'success' | 'error';
  error?: string;
  account?: ProviderAccount;
  /** Set when re-signing an existing account. */
  accountId: string | null;
};

export type AccountsResponse = {
  accounts: ProviderAccount[];
  usage: Record<string, import('@/lib/server/hub/types').AccountUsage | null>;
  /** Sessions still on a pre-§14.115 local login: `waiting` = their account
   *  exists (moving at a quiet moment), `unmatched` = add their account. */
  migration: { waiting: number; unmatched: number };
};

/** Strip the API client's "POST /api/x → 400: " prefix for display. */
export function apiErrorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^[A-Z]+ \S+ → \d+: /, '');
}
