'use client';
// The accounts' limits, always on screen: one row per hub account (§14.115),
// its rate-limit windows as gauges. The numbers, their severity and the pace
// mark are Charon's own (`app/usageGauges.ts`, the cells of the header's
// usage widget); the store is the accounts modal's (`app/accountsStore.ts`),
// kept live by `account_usage` frames.
import { useEffect, useMemo, useState } from 'react';
import { useAccounts } from '@/app/accountsStore';
import { fmtPct, fmtReset, paceFraction, sevClass, usageCells, type UsageCell } from '@/app/usageGauges';
import { providerAccountLabel } from '@/lib/providerAccounts';
import { PROVIDERS } from '@/lib/sessionCapabilities';
import type { SessionSummary } from '@/lib/sessionSummary';
import Portrait from './Portrait';

type Props = {
  sessions: SessionSummary[];
  open: boolean;
  onToggle: () => void;
};

/** "2h 10m" / "4d 3h": when the window empties again. */
function resetIn(resetsAt: string | null): string {
  return fmtReset(resetsAt).replace(/^resets (in )?/, '');
}

function tip(cell: UsageCell, pace: number | null): string {
  const facts = [cell.name, `${fmtPct(cell.pct)} used`];
  if (pace != null) facts.push(`${Math.round(pace * 100)}% of the time elapsed`);
  const reset = fmtReset(cell.resetsAt);
  if (reset) facts.push(reset);
  return facts.join(' · ');
}

export function Gauge({ cell, now }: { cell: UsageCell; now: number }) {
  const pace = paceFraction(cell.resetsAt, cell.windowMs, now);
  const pct = cell.pct == null ? null : Math.max(0, Math.min(100, cell.pct));
  return (
    <div className="dk-gauge" data-sev={pct == null ? 'none' : sevClass(cell.sev, cell.pct)} title={tip(cell, pace)}>
      <span className="dk-gauge-key">{cell.k}</span>
      <span className="dk-gauge-bar">
        <span className="dk-gauge-fill" style={{ width: `${pct ?? 0}%` }} />
        {pace != null && <i className="dk-gauge-pace" style={{ left: `${pace * 100}%` }} />}
      </span>
      <b>{fmtPct(cell.pct)}</b>
      <time>{resetIn(cell.resetsAt)}</time>
    </div>
  );
}

export default function LimitsPanel({ sessions, open, onToggle }: Props) {
  const { data } = useAccounts();
  // Pace marks and countdowns move with the minute.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const robots = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of sessions) if (s.accountProfile) count.set(s.accountProfile, (count.get(s.accountProfile) ?? 0) + 1);
    return count;
  }, [sessions]);

  const rows = data.accounts.map((account) => {
    const usage = data.usage[account.id] ?? null;
    const cells = usageCells(usage?.ok ? usage : null);
    const known = cells.filter((c) => c.pct != null);
    // The fullest window says how close the account is to stopping.
    const worst = known.reduce<UsageCell | null>((top, c) => (!top || (c.pct ?? 0) > (top.pct ?? 0) ? c : top), null);
    return { account, usage, cells: known.length ? cells : [], worst };
  });
  if (!rows.length) return null;

  return (
    <section className="dk-limits" data-open={open || undefined} aria-label="account limits">
      <button type="button" className="dk-limits-head" onClick={onToggle} aria-expanded={open}>
        <span className="dk-quests-title">LIMITS</span>
        {/* Folded, the panel still says the one number that matters per account. */}
        {!open && (
          <span className="dk-limits-brief">
            {rows.map(({ account, worst }) => (
              <span key={account.id} data-sev={worst ? sevClass(worst.sev, worst.pct) : 'none'} title={providerAccountLabel(PROVIDERS[account.provider].label, account)}>
                <i data-kind={account.provider} aria-hidden="true" />
                {worst ? fmtPct(worst.pct) : '—'}
              </span>
            ))}
          </span>
        )}
        <span className="dk-spacer" />
        <i aria-hidden="true">{open ? '▾' : '▸'}</i>
      </button>
      {open && (
        <div className="dk-limits-list">
          {rows.map(({ account, usage, cells }) => {
            const label = providerAccountLabel(PROVIDERS[account.provider].label, account);
            const n = robots.get(account.id) ?? 0;
            const trouble = account.status === 'expired' ? 'sign in again'
              : account.status === 'error' ? 'refresh failed'
              : usage?.degraded ? 'reading delayed' : null;
            return (
              <article key={account.id} className="dk-account" data-trouble={trouble ? account.status : undefined}>
                <Portrait kind={account.provider} mood="idle" scale={1} />
                <div className="dk-account-body">
                  <header>
                    <b title={label}>{label}</b>
                    {trouble ? <em>{trouble}</em> : null}
                    <span title={`${n} robot${n === 1 ? '' : 's'} on this account`}>×{n}</span>
                  </header>
                  {cells.length
                    ? cells.map((cell) => <Gauge key={cell.k} cell={cell} now={now} />)
                    : <p className="dk-account-none">no reading yet</p>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
