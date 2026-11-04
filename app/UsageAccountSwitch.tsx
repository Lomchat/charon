'use client';
import { useState, type ReactNode } from 'react';
import type { AgentKind } from '@/lib/types/api';
import type { AccountUsage } from '@/lib/server/hub/types';
import { api } from '@/lib/api';
import { providerName } from '@/lib/providerText';
import { apiErrorText, providerAccountLabel } from '@/lib/providerAccounts';
import AgentLogo from './AgentLogo';
import { useAccounts } from './accountsStore';

/** What a session's usage popover needs to offer its other accounts. */
export type AccountSwitchTarget = {
  sessionId: string;
  /** The account answering now (`providerConfig.accountProfile`). */
  current: string;
  /** A turn is running: the switch (a restart) waits for its end. */
  busy: boolean;
};

/** The fuller of an account's 5h / 7d windows, or null before any reading. */
export function accountLoad(u: AccountUsage | null | undefined): number | null {
  if (!u?.ok) return null;
  const vals = [u.fiveHour?.utilization, u.sevenDay?.utilization].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.max(...vals) : null;
}

/**
 * "Switch account" under a session's usage gauges (§14.115): the provider's
 * other hub accounts with THEIR 5h/7d, most headroom first, one click to move
 * the session (shared history ⇒ same conversation; a restart of a few seconds).
 */
export default function UsageAccountSwitch({ target, provider, renderGauges, onDone }: {
  target: AccountSwitchTarget;
  provider: AgentKind;
  /** The compact 5h/7d pills, drawn by the meter so they match it exactly. */
  renderGauges: (usage: AccountUsage | null) => ReactNode;
  onDone: () => void;
}) {
  const { data } = useAccounts();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = providerName(provider);
  const others = data.accounts.filter((a) => a.provider === provider && a.id !== target.current);
  if (!others.length) return null;
  const rank = (id: string, expired: boolean) => expired ? Infinity : accountLoad(data.usage[id]) ?? 50;
  others.sort((a, b) => rank(a.id, a.status === 'expired') - rank(b.id, b.status === 'expired'));
  const currentLoad = accountLoad(data.usage[target.current]);
  const best = others[0];
  const bestLoad = best && best.status !== 'expired' ? accountLoad(data.usage[best.id]) : null;

  return (
    <div className="um-switch" role="group" aria-label="Switch this session to another account">
      <div className="um-switch-head">
        <span>Switch account</span>
        {target.busy && <span className="um-switch-note">after this turn</span>}
      </div>
      {others.map((a) => {
        const label = providerAccountLabel(name, a);
        // The provider is the popover's own; the row names the login only.
        const who = a.name?.trim() || a.email?.trim() || a.displayName?.trim() || label;
        const expired = a.status === 'expired';
        const roomiest = a === best && bestLoad != null && currentLoad != null && bestLoad < currentLoad;
        return (
          <button key={a.id} type="button" className={`um-switch-row${expired ? ' is-off' : ''}`}
            disabled={expired || target.busy || !!busyId}
            title={expired ? `${label} — signed out (Accounts)` : target.busy ? `${label} — available once the current turn ends` : `Continue this session on ${label}`}
            onClick={async () => {
              setBusyId(a.id); setError(null);
              try { await api.switchSessionAccount(target.sessionId, a.id); onDone(); }
              catch (e) { setError(apiErrorText(e)); setBusyId(null); }
            }}>
            <span className="um-switch-who">
              <AgentLogo kind={provider} profileNumber={a.number} size={14} title="" />
              <span className="um-switch-label">{who}</span>
              {roomiest && <span className="um-switch-tag">most room</span>}
            </span>
            <span className="um-switch-gauges">
              {busyId === a.id ? <span className="um-switch-note">switching…</span>
                : expired ? <span className="um-switch-note">signed out</span>
                : renderGauges(data.usage[a.id] ?? null)}
            </span>
          </button>
        );
      })}
      {error && <div className="um-switch-error" role="alert">{error}</div>}
    </div>
  );
}
