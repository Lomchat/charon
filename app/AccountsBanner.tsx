'use client';
import { useState } from 'react';
import { SESSION_PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';
import { loginDaysLeft, providerAccountLabel, LOGIN_EXPIRY_WARN_DAYS, type AccountsResponse } from '@/lib/providerAccounts';

/** What the hub's accounts need from the user (§14.115), most urgent first:
 *  a signed-out account, a sign-in ending soon, an enabled backend with no
 *  account at all. */
type Need = { key: string; text: string; action: string; provider: SessionProvider; accountId: string | null };

function needs(data: AccountsResponse, enabled: Record<SessionProvider, boolean>): Need[] {
  const out: Need[] = [];
  for (const a of data.accounts) {
    if (!enabled[a.provider]) continue;
    const label = providerAccountLabel(providerName(a.provider), a);
    if (a.status === 'expired') out.push({ key: `x:${a.id}`, text: `${label} is signed out.`, action: 'Sign in again', provider: a.provider, accountId: a.id });
    else {
      const days = loginDaysLeft(a);
      if (days != null && days <= LOGIN_EXPIRY_WARN_DAYS) out.push({ key: `e:${a.id}:${days}`,
        text: `${label}: its sign-in ends ${days <= 0 ? 'today' : `in ${days} day${days > 1 ? 's' : ''}`}.`, action: 'Sign in again', provider: a.provider, accountId: a.id });
    }
  }
  const missing = SESSION_PROVIDERS.filter((p) => enabled[p] && !data.accounts.some((a) => a.provider === p));
  // Cursor is optional: only nag about it once Claude/Codex are covered.
  for (const p of missing.filter((p) => p !== 'cursor')) out.push({ key: `m:${p}`,
    text: `Connect your ${providerName(p)} account — once, for every VPS.`, action: 'Add account', provider: p, accountId: null });
  return out;
}

export function accountsNeedAttention(data: AccountsResponse, enabled: Record<SessionProvider, boolean>): boolean {
  return needs(data, enabled).length > 0;
}

export default function AccountsBanner({ data, loaded, enabled, hasVps, onOpen, onLogin }: {
  data: AccountsResponse; loaded: boolean; enabled: Record<SessionProvider, boolean>; hasVps: boolean;
  onOpen: () => void; onLogin: (provider: SessionProvider, accountId: string | null) => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  if (!loaded || !hasVps) return null;
  const list = needs(data, enabled).filter((n) => !dismissed.has(n.key));
  if (!list.length) return null;
  const first = list[0];
  return (
    <div className="accounts-banner" role="status">
      <span className="accounts-banner-text">{first.text}{list.length > 1 ? ` (+${list.length - 1})` : ''}</span>
      <button type="button" className="wiz-btn primary" onClick={() => onLogin(first.provider, first.accountId)}>{first.action}</button>
      <button type="button" className="wiz-btn ghost" onClick={onOpen}>Accounts</button>
      <button type="button" className="accounts-banner-close" aria-label="dismiss"
        onClick={() => setDismissed(new Set([...dismissed, first.key]))}>✕</button>
    </div>
  );
}
