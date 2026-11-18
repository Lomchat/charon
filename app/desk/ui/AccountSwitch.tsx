'use client';
// The account a robot runs on, and the way to move it to another one of the
// same provider — from the unit panel. Charon's own switch (§14.115):
// `api.switchSessionAccount` restarts the session on the other account, same
// conversation; it waits for a running turn or background tasks
// (`accountSwitchWaitOf`), and offers the accounts with the most headroom
// first (`accountLoad`), exactly as the session header's "Switch account".
import { useEffect, useRef, useState } from 'react';
import { useAccounts } from '@/app/accountsStore';
import { accountLoad, accountSwitchWaitOf, accountSwitchWaitText } from '@/app/UsageAccountSwitch';
import { usageCells } from '@/app/usageGauges';
import { accountProfileId } from '@/lib/accountProfiles';
import { api } from '@/lib/api';
import { apiErrorText, providerAccountLabel, type ProviderAccount } from '@/lib/providerAccounts';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';
import type { SessionSummary } from '@/lib/sessionSummary';
import { Gauge } from './LimitsPanel';

/** The login itself: the provider is said by the chip's colour and context. */
function who(a: ProviderAccount, fallback: string): string {
  return a.name?.trim() || a.email?.trim() || a.displayName?.trim() || fallback;
}

export default function AccountSwitch({ session }: { session: SessionSummary }) {
  const { data } = useAccounts();
  const root = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  // Another robot: its own list, closed.
  useEffect(() => { setOpen(false); setBusyId(null); setError(null); }, [session.id]);

  // Open: the gauges' clock, and the ways out (a click elsewhere, Escape —
  // caught before the board's own Escape, which would deselect the robot).
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);

  const provider = asSessionProvider(session.kind);
  const name = PROVIDERS[provider].label;
  const all = data.accounts.filter((a) => a.provider === provider);
  if (!all.length) return <span>{name}</span>;

  const currentId = accountProfileId(session);
  const current = all.find((a) => a.id === currentId) ?? null;
  const rank = (a: ProviderAccount) => (a.status === 'expired' ? Infinity : accountLoad(data.usage[a.id]) ?? 50);
  const others = all.filter((a) => a.id !== currentId).sort((a, b) => rank(a) - rank(b));
  const wait = accountSwitchWaitOf(session);
  const waiting = wait ? accountSwitchWaitText(wait) : null;
  // The machine's own login, when the session is not on a hub account.
  const label = current ? providerAccountLabel(name, current) : `${name} · machine login`;

  const move = async (account: ProviderAccount) => {
    setBusyId(account.id);
    setError(null);
    try {
      await api.switchSessionAccount(session.id, account.id);
      setOpen(false);
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <span className="dk-acct" ref={root}>
      <button
        type="button"
        className="dk-acct-chip"
        data-kind={provider}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!others.length}
        onClick={() => setOpen((on) => !on)}
        title={others.length ? `${label} — click to move this robot to another ${name} account` : `${label} — the only ${name} account`}
      >
        <i aria-hidden="true" />
        <span>{label}</span>
        {others.length > 0 && <em aria-hidden="true">{open ? '▴' : '▾'}</em>}
      </button>
      {open && (
        <span className="dk-acct-pop" role="menu">
          <strong>Switch account{waiting ? <em>{waiting.note}</em> : null}</strong>
          {waiting && <span className="dk-acct-hint">{waiting.row.replace(/: switching restarts the session.*/, '')}</span>}
          {others.map((account) => {
            const expired = account.status === 'expired';
            const usage = data.usage[account.id] ?? null;
            const cells = usageCells(usage?.ok ? usage : null).filter((c) => c.pct != null);
            return (
              <button
                key={account.id}
                type="button"
                role="menuitem"
                className="dk-acct-row"
                disabled={expired || !!wait || !!busyId}
                onClick={() => { void move(account); }}
              >
                <span className="dk-acct-who">
                  <b>{who(account, providerAccountLabel(name, account))}</b>
                  {busyId === account.id ? <em>switching…</em> : expired ? <em data-bad>signed out</em> : null}
                </span>
                {!expired && cells.map((cell) => <Gauge key={cell.k} cell={cell} now={now} />)}
                {!expired && !cells.length && <span className="dk-account-none">no reading yet</span>}
              </button>
            );
          })}
          {error && <span className="dk-acct-error" role="alert">{error}</span>}
        </span>
      )}
    </span>
  );
}
