'use client';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { SESSION_PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';
import { apiErrorText, loginDaysLeft, providerAccountLabel, LOGIN_EXPIRY_WARN_DAYS, type ProviderAccount } from '@/lib/providerAccounts';
import AgentLogo from './AgentLogo';
import { UsageRings } from './UsageMeter';
import { refreshAccounts, useAccounts } from './accountsStore';

/**
 * Accounts (§14.115): every Claude, Codex and Cursor login, owned by the hub
 * and usable on every VPS. Sign in once here; the hub keeps each login fresh
 * and hands the VPSes short-lived credentials.
 */
export default function AccountsModal({ enabled, onLogin, onClose }: {
  /** Backends switched on in Settings (others are hidden). */
  enabled: (provider: SessionProvider) => boolean;
  /** Open the sign-in for a provider (`account` = sign that one in again). */
  onLogin: (provider: SessionProvider, account?: ProviderAccount) => void;
  onClose: () => void;
}) {
  const { data, loaded } = useAccounts();
  const providers = SESSION_PROVIDERS.filter(enabled);
  const { waiting, unmatched } = data.migration;

  const modal = (
    <div className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-modal accounts-modal" role="dialog" aria-label="Accounts">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="cxl-head"><h2>Accounts</h2></div>
        <p className="accounts-intro">Sign in once: every account works on every VPS, and Charon keeps it signed in.</p>
        {(waiting > 0 || unmatched > 0) && (
          <div className="accounts-migration">
            {waiting > 0 && <div>⟳ {waiting} session{waiting > 1 ? 's' : ''} will move to {waiting > 1 ? 'their' : 'its'} account at a quiet moment.</div>}
            {unmatched > 0 && <div>⚠ {unmatched} session{unmatched > 1 ? 's' : ''} still run{unmatched > 1 ? '' : 's'} on a VPS login: add {unmatched > 1 ? 'their accounts' : 'its account'}, or pick one in the session.</div>}
          </div>
        )}
        {!loaded && <div className="cxl-status">⟳ loading…</div>}
        {loaded && providers.map((provider) => {
          const list = data.accounts.filter((a) => a.provider === provider);
          return (
            <section key={provider} className="accounts-provider">
              <div className="accounts-provider-head">
                <AgentLogo kind={provider} size={16} />
                <span>{providerName(provider)}</span>
                <button className="wiz-btn ghost accounts-add" onClick={() => onLogin(provider)}>＋ Add account</button>
              </div>
              {list.length === 0 && <div className="accounts-empty">No {providerName(provider)} account yet.</div>}
              {list.map((a, i) => (
                <AccountRow key={a.id} account={a} usage={data.usage[a.id] ?? null}
                  canUp={i > 0} canDown={i < list.length - 1}
                  onMove={(dir) => {
                    const order = list.map((x) => x.id);
                    const j = i + dir;
                    [order[i], order[j]] = [order[j], order[i]];
                    void api.reorderAccounts(provider, order).then(() => refreshAccounts());
                  }}
                  onLogin={() => onLogin(provider, a)} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(modal, document.querySelector('.app-root') ?? document.body);
}

function AccountRow({ account: a, usage, canUp, canDown, onMove, onLogin }: {
  account: ProviderAccount; usage: import('@/lib/server/hub/types').AccountUsage | null;
  canUp: boolean; canDown: boolean; onMove: (dir: -1 | 1) => void; onLogin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = providerAccountLabel(providerName(a.provider), a);
  const days = loginDaysLeft(a);
  const ending = days != null && days <= LOGIN_EXPIRY_WARN_DAYS;
  const status = a.status === 'expired' ? { cls: 'err', text: 'Signed out' }
    : a.status === 'error' ? { cls: 'warn', text: 'Refresh failing' }
    : ending ? { cls: 'warn', text: days! <= 0 ? 'Ends today' : `Ends in ${days} d` } : { cls: 'ok', text: 'Connected' };

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await refreshAccounts(); } catch (e) { setError(apiErrorText(e)); }
  }

  return (
    <div className={`accounts-row ${a.status}`}>
      <AgentLogo kind={a.provider} profileNumber={a.number} size={16} />
      <div className="accounts-who">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); setEditing(false); void run(() => api.renameAccount(a.id, name)); }}>
            <input className="cxl-input" value={name} autoFocus maxLength={80} placeholder="name (optional)"
              onChange={(e) => setName(e.target.value)} onBlur={() => setEditing(false)} />
          </form>
        ) : (
          <button type="button" className="accounts-name" title="rename" onClick={() => setEditing(true)}>{label}</button>
        )}
        <div className="accounts-meta">
          {[a.plan, a.displayName].filter(Boolean).join(' · ')}
          {a.loginExpiresAt && <span title="Providers end a sign-in after a while; sign in again before.">
            {' · '}sign-in ends {new Date(a.loginExpiresAt).toLocaleDateString()}</span>}
        </div>
        {a.status !== 'ok' && a.lastError && <div className="accounts-error">{a.lastError}</div>}
        {error && <div className="accounts-error">{error}</div>}
      </div>
      <span className={`accounts-status ${status.cls}`}>{status.text}</span>
      {a.provider !== 'cursor' && (
        <UsageRings usage={usage} accountLabel={label} kind={a.provider} className="accounts-usage"
          onRefresh={() => void api.refreshAccountUsage(a.id).catch(() => {})} />
      )}
      <div className="accounts-actions">
        <button type="button" className="wiz-btn ghost" disabled={!canUp} title="move up" onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="wiz-btn ghost" disabled={!canDown} title="move down" onClick={() => onMove(1)}>↓</button>
        <button type="button" className={`wiz-btn ${a.status === 'ok' && !ending ? 'ghost' : 'primary'}`} onClick={onLogin}>Sign in again</button>
        {confirmRemove
          ? <button type="button" className="wiz-btn danger" onClick={() => void run(() => api.removeAccount(a.id))}
              onBlur={() => setConfirmRemove(false)} autoFocus>Confirm remove</button>
          : <button type="button" className="wiz-btn ghost" onClick={() => setConfirmRemove(true)}>Remove</button>}
      </div>
    </div>
  );
}
