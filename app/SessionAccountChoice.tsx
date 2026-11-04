'use client';
import { useState } from 'react';
import type { AgentKind } from '@/lib/types/api';
import { api } from '@/lib/api';
import { providerName } from '@/lib/providerText';
import { apiErrorText, providerAccountLabel } from '@/lib/providerAccounts';
import AgentLogo from './AgentLogo';
import { useProviderAccounts } from './accountsStore';

/**
 * "Replies from" — which hub account answers this session (§14.115). History
 * is shared, so the conversation carries over; the CLI binds its account at
 * start, so a running session restarts (a few seconds) to switch. Mid-turn the
 * server refuses and the user retries when the turn ends.
 */
export default function SessionAccountChoice({ sessionId, kind, current, disabled, onSwitched }: {
  sessionId: string; kind: AgentKind; current: string; disabled?: boolean; onSwitched?: () => void;
}) {
  const accounts = useProviderAccounts(kind);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (accounts.length < 2 && accounts.some((a) => a.id === current)) return null;
  const name = providerName(kind);
  return (
    <div className="session-account-choice" role="group" aria-label="Account answering this session">
      <div className="runtime-choice-title">Replies from</div>
      {accounts.map((a) => {
        const label = providerAccountLabel(name, a);
        const on = a.id === current;
        return (
          <button key={a.id} type="button" className={`session-account-row${on ? ' is-on' : ''}`}
            disabled={disabled || !!busy || on || a.status === 'expired'}
            title={a.status === 'expired' ? `${label} — sign in again (Accounts)` : on ? `${label} — answering now` : `Switch to ${label}`}
            onClick={async () => {
              setBusy(a.id); setError(null);
              try { await api.switchSessionAccount(sessionId, a.id); onSwitched?.(); }
              catch (e) { setError(apiErrorText(e)); }
              finally { setBusy(null); }
            }}>
            <AgentLogo kind={kind} profileNumber={a.number} size={14} title="" />
            <span>{label}</span>
            {on && <span aria-hidden="true">✓</span>}
            {busy === a.id && <span className="runtime-pending">⟳ switching…</span>}
            {a.status === 'expired' && <span className="session-account-note">signed out</span>}
          </button>
        );
      })}
      {!accounts.some((a) => a.id === current) && <p className="runtime-choice-note">This session still runs on a VPS login — pick an account.</p>}
      {error && <p className="runtime-choice-error" role="alert">{error}</p>}
    </div>
  );
}
