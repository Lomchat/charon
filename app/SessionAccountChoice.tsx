'use client';
import type { AgentKind } from '@/lib/types/api';
import { providerName } from '@/lib/providerText';
import { providerAccountLabel } from '@/lib/providerAccounts';
import AgentLogo from './AgentLogo';
import { useProviderAccounts } from './accountsStore';
import UsageAccountSwitch, { type AccountSwitchTarget } from './UsageAccountSwitch';

/**
 * "Replies from" — which hub account answers this session (§14.115), laid out
 * like the usage popover: a tile with the account answering now, then the
 * "Switch account" tile (the same list, without the gauges).
 * History is shared, so the conversation carries over; the CLI binds its
 * account at start, so a running session restarts (a few seconds) to switch.
 * While a turn or background tasks run (`target.waitFor`) the rows are
 * disabled; the server refuses too (409).
 */
export default function SessionAccountChoice({ target, kind, disabled, onSwitched }: {
  target: AccountSwitchTarget; kind: AgentKind; disabled?: boolean; onSwitched: () => void;
}) {
  const accounts = useProviderAccounts(kind);
  const current = accounts.find((a) => a.id === target.current);
  if (accounts.length < 2 && current) return null;
  const name = providerName(kind);
  const who = current && (current.name?.trim() || current.email?.trim() || current.displayName?.trim());
  return <>
    <div className="pop-tile" role="group" aria-label="Account answering this session">
      <div className="pop-tile-label">Replies from</div>
      {current
        ? <div className="pop-row is-static" title={providerAccountLabel(name, current)}>
            <AgentLogo kind={kind} profileNumber={current.number} size={15} title="" />
            <span className="pop-row-main">
              <b>{name}{current.number > 1 ? ` ${current.number}` : ''}</b>
              {who ? <small>{who}</small> : null}
            </span>
          </div>
        : <p className="pop-tile-text">This session still runs on a VPS login — pick an account.</p>}
    </div>
    <UsageAccountSwitch target={target} provider={kind} disabled={disabled} onDone={onSwitched} />
  </>;
}
