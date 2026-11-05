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
  /** What the switch (a restart) waits for; null = free now. */
  waitFor: AccountSwitchWait | null;
};

/** The running turn, or background tasks the restart would kill with the CLI
 *  (§14.91). `tasks` = the summary's count, 0 while its registry warms. */
export type AccountSwitchWait = { kind: 'turn' } | { kind: 'background'; tasks: number };

/** The copy both account pickers show while a switch waits (the server
 *  refuses with 409 in both cases): the popover's header `note`, and the
 *  disabled rows' tooltip detail (`row`, after "<account> — "). */
export function accountSwitchWaitText(w: AccountSwitchWait): { note: string; row: string } {
  if (w.kind === 'turn') return {
    note: 'after this turn',
    row: 'available once the current turn ends: switching restarts the session',
  };
  const one = w.tasks === 1;
  return {
    note: w.tasks > 0 ? `${w.tasks} background task${one ? '' : 's'} running` : 'background tasks running',
    row: one ? 'available once the background task ends: switching restarts the session, which would stop it'
      : 'available once the background tasks end: switching restarts the session, which would stop them',
  };
}

/** The fuller of an account's 5h / 7d windows, or null before any reading. */
export function accountLoad(u: AccountUsage | null | undefined): number | null {
  if (!u?.ok) return null;
  const vals = [u.fiveHour?.utilization, u.sevenDay?.utilization].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.max(...vals) : null;
}

/**
 * "Switch account" under a session's usage gauges (§14.115): the provider's
 * other hub accounts with THEIR gauges — the same bars, same size, as the
 * session's own — most headroom first, one click to move the session (shared
 * history ⇒ same conversation; a restart of a few seconds). Without
 * `renderGauges` (the model picker's "Replies from") the same list, one line
 * per account.
 */
export default function UsageAccountSwitch({ target, provider, renderGauges, disabled, onDone }: {
  target: AccountSwitchTarget;
  provider: AgentKind;
  /** The account's bars, drawn by the meter so they match the session's exactly. */
  renderGauges?: (usage: AccountUsage | null) => ReactNode;
  /** The host is saving something else: no switch meanwhile. */
  disabled?: boolean;
  onDone: () => void;
}) {
  const { data } = useAccounts();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = providerName(provider);
  const others = data.accounts.filter((a) => a.provider === provider && a.id !== target.current);
  if (!others.length) return null;
  const wait = target.waitFor ? accountSwitchWaitText(target.waitFor) : null;
  const rank = (id: string, expired: boolean) => expired ? Infinity : accountLoad(data.usage[id]) ?? 50;
  others.sort((a, b) => rank(a.id, a.status === 'expired') - rank(b.id, b.status === 'expired'));

  return (
    <div className={`pop-tile um-switch${renderGauges ? '' : ' is-plain'}`} role="group" aria-label="Switch this session to another account">
      <div className="pop-tile-label">
        <span>Switch account</span>
        {wait && <span className="pop-tile-note">{wait.note}</span>}
      </div>
      {others.map((a) => {
        const label = providerAccountLabel(name, a);
        // The provider is the popover's own; the row names the login only.
        const who = a.name?.trim() || a.email?.trim() || a.displayName?.trim() || label;
        const expired = a.status === 'expired';
        return (
          <button key={a.id} type="button" className="um-switch-row"
            disabled={expired || !!wait || !!busyId || disabled}
            title={expired ? `${label} — signed out (Accounts)` : wait ? `${label} — ${wait.row}` : `Continue this session on ${label}`}
            onClick={async () => {
              setBusyId(a.id); setError(null);
              try { await api.switchSessionAccount(target.sessionId, a.id); onDone(); }
              catch (e) { setError(apiErrorText(e)); setBusyId(null); }
            }}>
            <span className="um-switch-who">
              <AgentLogo kind={provider} profileNumber={a.number} size={15} title="" />
              <span className="um-switch-label">{who}</span>
            </span>
            {busyId === a.id ? <span className="um-switch-note">switching…</span>
              : expired ? <span className="um-switch-note">signed out</span>
              : renderGauges?.(data.usage[a.id] ?? null)}
          </button>
        );
      })}
      {error && <div className="um-switch-error" role="alert">{error}</div>}
    </div>
  );
}
