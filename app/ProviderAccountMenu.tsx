'use client';
import { useState } from 'react';
import type { Vps } from '@/lib/db/schema';
import type { AgentKind } from '@/lib/types/api';
import type { AccountProfile } from '@/lib/accountProfiles';
import { api } from '@/lib/api';
import { PROVIDER_ACCOUNT_LINKS, providerName } from '@/lib/providerText';
import { apiErrorText, loginDaysLeft, providerAccountLabel } from '@/lib/providerAccounts';
import SessionContextMenu from './SessionContextMenu';
import { useAccounts } from './accountsStore';

type Props = {
  vps: Vps; provider: AgentKind; profile?: AccountProfile; x: number; y: number;
  /** Sign this account in again (or add one when there is none). */
  onLogin: () => void;
  /** Open the Accounts panel (rename, remove, reorder, add). */
  onManage: () => void;
  onClose: () => void;
};

/** A launcher's account menu. Accounts belong to the hub (§14.115): what a VPS
 *  shows is the account itself — the same wherever it is opened. */
export default function ProviderAccountMenu({ vps, provider, profile, x, y, onLogin, onManage, onClose }: Props) {
  const { data } = useAccounts();
  const account = profile ? data.accounts.find((a) => a.id === profile.id) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = providerName(provider);
  const days = account ? loginDaysLeft(account) : null;
  const details = account ? [
    ['Account', account.displayName], ['Email', account.email], ['Plan', account.plan], ['Organization', account.organization],
    ['Sign-in ends', account.loginExpiresAt && `${new Date(account.loginExpiresAt).toLocaleDateString()}${days != null ? ` (${days} d)` : ''}`],
  ].filter((row) => row[1]) : [];
  const status = !account ? 'No account yet'
    : account.status === 'expired' ? 'Signed out — sign in again'
    : account.status === 'error' ? `Refresh failing: ${account.lastError ?? 'retrying'}` : 'Connected';

  return <SessionContextMenu
    title={account ? providerAccountLabel(name, account) : name} subtitle={`every VPS · opened from ${vps.name}`} x={x} y={y}
    showRename={false} showColor={false} showDelete={false} onClose={onClose}
  >
    <div className="ctx-account" aria-live="polite" aria-busy={busy}>
      <div className="ctx-account-status">{status}</div>
      {details.length > 0 && <dl>{details.map(([label, value]) => <div key={String(label)}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}</dl>}
      {error && <div className="ctx-account-error">{error}</div>}
    </div>
    {account && account.provider !== 'cursor' && <button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { await api.refreshAccountUsage(account.id); onClose(); } catch (e) { setError(apiErrorText(e)); setBusy(false); }
    }}>Refresh limits</button>}
    <button type="button" onClick={() => { onLogin(); onClose(); }}>{account ? 'Sign in again…' : `Add a ${name} account…`}</button>
    <button type="button" onClick={() => { onManage(); onClose(); }}>Manage accounts…</button>
    <a role="menuitem" href={PROVIDER_ACCOUNT_LINKS[provider]} target="_blank" rel="noopener noreferrer"
      onClick={onClose}>Open account & billing ↗</a>
  </SessionContextMenu>;
}
