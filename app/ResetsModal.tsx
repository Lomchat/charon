'use client';
// Pick a banked limit reset and spend it (§14.126). Irreversible at the
// provider: the button names what it spends, the grant must be one the hub
// read, and the answer — refilled, or nothing used — replaces the list.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { providerName } from '@/lib/providerText';
import { apiErrorText } from '@/lib/providerAccounts';
import type { AccountResetGrant, AccountResetOutcome, AccountUsage } from '@/lib/server/hub/types';
import AgentLogo from './AgentLogo';
import { IconArrowCounterclockwise } from './icons';
import { putAccountUsage, useAccounts } from './accountsStore';
import { putUsage } from './usageStore';
import { accountShortName, blockedText, fmtDay, fmtIn, grantWindows, type ResetWindow } from './accountResets';
import { fmtPct, sevClass } from './usageGauges';

const OUTCOME: Record<AccountResetOutcome, { text: string; ok?: boolean }> = {
  reset: { text: 'Limits reset', ok: true },
  nothing_to_reset: { text: 'Nothing to reset — no reset used' },
  no_credit: { text: 'No reset left' },
  already_used: { text: 'Already used' },
  cooldown: { text: 'Cooling down — try later' },
  ineligible: { text: 'Not eligible' },
  unavailable: { text: 'Unavailable' },
  error: { text: 'Failed' },
};

function Gauge({ w, after }: { w: ResetWindow; after?: boolean }) {
  const pct = w.pct;
  return (
    <span className="rst-gauge" title={`${w.label} · ${fmtPct(pct)} used`}>
      <span className="rst-gauge-label">{w.label}</span>
      <span className={`rst-gauge-bar um-${sevClass(undefined, pct)}`} aria-hidden>
        <span style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
      </span>
      <span className="rst-gauge-pct">{fmtPct(pct)}{after ? null : <em> → 0</em>}</span>
    </span>
  );
}

function Expiry({ at, now }: { at: string | null; now: number }) {
  if (!at) return <span className="rst-expiry">no expiry</span>;
  const t = Date.parse(at);
  const soon = t - now < 3 * 86_400_000;
  return <span className={`rst-expiry${soon ? ' is-soon' : ''}`} title={new Date(t).toLocaleString()}>until {fmtDay(t, now)} · {fmtIn(t, now)}</span>;
}

function GrantRow({ g, usage, selected, onPick, now, disabled }: {
  g: AccountResetGrant; usage: AccountUsage | null; selected: boolean; onPick: () => void; now: number; disabled: boolean;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} className="rst-grant" data-selected={selected}
      disabled={disabled || !g.usable} onClick={onPick} title={g.description ?? undefined}>
      <span className="rst-radio" aria-hidden />
      <span className="rst-grant-body">
        <span className="rst-grant-title">
          <b>{g.title}</b>
          {g.left > 1 && <span className="rst-count">×{g.left}</span>}
        </span>
        <span className="rst-gauges">{grantWindows(g, usage).map((w) => <Gauge key={w.key} w={w} />)}</span>
        <span className="rst-grant-meta">
          <Expiry at={g.expiresAt} now={now} />
          {!g.usable && <span className="rst-blocked">{blockedText(g.blockedBy)}</span>}
        </span>
      </span>
    </button>
  );
}

export default function ResetsModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { data } = useAccounts();
  const account = data.accounts.find((a) => a.id === accountId) ?? null;
  const usage = data.usage[accountId] ?? null;
  const grants = useMemo(() => usage?.resets?.grants ?? [], [usage]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: AccountResetOutcome; reason: string | null; grant: AccountResetGrant } | null>(null);
  const [now] = useState(() => Date.now());
  // The provider's soonest-expiring usable grant, until the user picks.
  const selected = grants.find((g) => g.id === picked && g.usable) ?? grants.find((g) => g.usable) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function spend() {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.claimAccountReset(accountId, selected.id);
      if (r.usage) { putUsage(null, r.usage); putAccountUsage(r.usage); }
      setResult({ outcome: r.outcome, reason: r.reason, grant: selected });
    } catch (e) {
      setError(apiErrorText(e));
    } finally { setBusy(false); }
  }

  const who = account ? accountShortName(account) : '';
  const left = usage?.resets?.available ?? 0;
  const verdict = result ? OUTCOME[result.outcome] : null;
  const body = (
    <div className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="app-modal confirm neutral rst-modal" role="dialog" aria-modal="true" aria-label="Limit resets">
        <div className="confirm-head">
          <span className="confirm-ico"><IconArrowCounterclockwise /></span>
          <div className="rst-head">
            <h2>{result ? (verdict?.ok ? 'Reset used' : 'No reset used') : `${left} reset${left === 1 ? '' : 's'}`}</h2>
            {account && (
              <span className="rst-who">
                <AgentLogo kind={account.provider} profileNumber={account.number} size={13} title="" />
                <span>{providerName(account.provider)}{who ? ` · ${who}` : ''}</span>
              </span>
            )}
          </div>
        </div>
        {result ? (
          <div className={`rst-result${verdict?.ok ? ' is-ok' : ''}`}>
            <div className="rst-result-line">
              <span aria-hidden>{verdict?.ok ? '✓' : '·'}</span>
              <b>{verdict?.text}</b>
              {result.reason && !verdict?.ok && <span className="rst-reason">{result.reason.replace(/_/g, ' ')}</span>}
            </div>
            {/* The windows it refilled, read fresh after the claim. */}
            {verdict?.ok && <div className="rst-gauges">{grantWindows({ ...result.grant, used: null }, usage).map((w) => <Gauge key={w.key} w={w} after />)}</div>}
          </div>
        ) : grants.length ? (
          <div className="rst-list" role="radiogroup" aria-label="Resets">
            {grants.map((g) => (
              <GrantRow key={g.id} g={g} usage={usage} now={now} disabled={busy}
                selected={selected?.id === g.id} onPick={() => setPicked(g.id)} />
            ))}
          </div>
        ) : (
          <p className="confirm-text">No reset left.</p>
        )}
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          {result ? (
            <button type="button" className="confirm-btn primary" autoFocus onClick={onClose}>done</button>
          ) : <>
            <button type="button" className="confirm-btn ghost" autoFocus disabled={busy} onClick={onClose}>cancel</button>
            <button type="button" className="confirm-btn primary rst-spend" disabled={!selected || busy} onClick={() => void spend()}>
              <IconArrowCounterclockwise />
              {busy ? 'resetting…' : 'use reset'}
            </button>
          </>}
        </div>
      </div>
    </div>
  );
  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
