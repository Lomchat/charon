'use client';
import { useState } from 'react';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';
import { loginDaysLeft, providerAccountLabel, LOGIN_EXPIRY_WARN_DAYS } from '@/lib/providerAccounts';
import type { AccountList } from './accountsStore';

/** What the hub's accounts need from the user (§14.115), most urgent first:
 *  a signed-out account, a sign-in ending soon. A backend with NO account is
 *  not a problem — a box may serve its own model (§8 custom endpoints) — and
 *  its launcher already leads to sign-in. */
type Need = { key: string; text: string; action: string; provider: SessionProvider; accountId: string | null };

function needs(data: AccountList, enabled: Record<SessionProvider, boolean>): Need[] {
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
  return out;
}

export function accountsNeedAttention(data: AccountList, enabled: Record<SessionProvider, boolean>): boolean {
  return needs(data, enabled).length > 0;
}

/** A sidebar notice shaped like a VPS update bar (`.cs-agent-bar update`):
 *  one line, one action, a dismiss. */
export default function AccountsBanner({ data, loaded, enabled, hasVps, onLogin }: {
  data: AccountList; loaded: boolean; enabled: Record<SessionProvider, boolean>; hasVps: boolean;
  onLogin: (provider: SessionProvider, accountId: string | null) => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  if (!loaded || !hasVps) return null;
  const list = needs(data, enabled).filter((n) => !dismissed.has(n.key));
  if (!list.length) return null;
  const first = list[0];
  return (
    <div className="cs-agent-bar update cs-notice" role="status">
      <span className="cs-agent-meta">{first.text}{list.length > 1 ? ` (+${list.length - 1})` : ''}</span>
      <button type="button" className="cs-agent-btn update" onClick={() => onLogin(first.provider, first.accountId)}>{first.action}</button>
      <button type="button" className="cs-notice-close" aria-label="dismiss" title="dismiss"
        onClick={() => setDismissed(new Set([...dismissed, first.key]))}>✕</button>
    </div>
  );
}
