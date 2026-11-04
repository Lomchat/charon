'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';
import { apiErrorText, providerAccountLabel, type AccountLoginAttempt } from '@/lib/providerAccounts';
import AgentLogo from './AgentLogo';
import { refreshAccounts } from './accountsStore';

/**
 * Sign an account in at the HUB (§14.115) — once, for every VPS. One modal,
 * three shapes (`attempt.kind`): Claude gives a link then wants the code it
 * shows back; Codex shows a device code to type on its page; Cursor's link
 * completes by itself. Re-signing an account passes its id.
 */
export default function AccountLoginModal({ provider, accountId, onClose }: {
  provider: SessionProvider;
  accountId?: string | null;
  onClose: (loggedIn: boolean) => void;
}) {
  const [attempt, setAttempt] = useState<AccountLoginAttempt | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const live = useRef<string | null>(null);
  const done = useRef(false);

  const begin = useCallback(() => {
    setAttempt(null); setStartError(null); setCode('');
    api.startAccountLogin(provider, accountId ?? null)
      .then((r) => { live.current = r.attempt.id; setAttempt(r.attempt); })
      .catch((e) => setStartError(apiErrorText(e)));
  }, [provider, accountId]);

  useEffect(() => {
    begin();
    return () => {
      if (live.current && !done.current) void api.cancelAccountLogin(live.current).catch(() => {});
    };
  }, [begin]);

  // Codex and Cursor finish on another page: poll until the hub has it.
  useEffect(() => {
    if (!attempt || attempt.kind === 'code' || attempt.phase === 'success' || attempt.phase === 'error') return;
    const t = setTimeout(() => {
      api.accountLoginStatus(attempt.id).then((r) => setAttempt(r.attempt))
        .catch((e) => setAttempt({ ...attempt, phase: 'error', error: apiErrorText(e) }));
    }, 2_500);
    return () => clearTimeout(t);
  }, [attempt]);

  useEffect(() => {
    if (attempt?.phase === 'success') { done.current = true; void refreshAccounts(); }
  }, [attempt?.phase]);

  async function submit() {
    if (!attempt || !code.trim() || busy) return;
    setBusy(true);
    try { setAttempt((await api.submitAccountLoginCode(attempt.id, code.trim())).attempt); }
    catch (e) { setAttempt({ ...attempt, error: apiErrorText(e) }); }
    finally { setBusy(false); }
  }

  function copy(value: string) {
    try { void navigator.clipboard?.writeText(value); setCopied(value); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  }

  const name = providerName(provider);
  const close = () => onClose(attempt?.phase === 'success');
  const phase = startError ? 'error' : attempt?.phase ?? 'starting';

  return (
    <div className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="app-modal claude-login-modal account-login-modal">
        <button className="modal-close" onClick={close}>✕</button>
        <div className="cxl-head">
          <AgentLogo kind={provider} size={18} />
          <h2>{accountId ? `Sign in again · ${name}` : `Add a ${name} account`}</h2>
        </div>

        {phase === 'starting' && <div className="cxl-body"><div className="cxl-status">⟳ preparing the sign-in…</div></div>}

        {attempt && (phase === 'pending' || phase === 'verifying') && (
          <div className="cxl-body">
            {attempt.error && <div className="cxl-warn">⚠ {attempt.error}</div>}
            <div className="cxl-step">1 · Open this page on any device and sign in:</div>
            <div className="cxl-url-row">
              <a className="cxl-url" href={attempt.url} target="_blank" rel="noreferrer noopener">{attempt.url} ↗</a>
              <button className="cxl-copy" onClick={() => copy(attempt.url)} title="copy the link">{copied === attempt.url ? 'copied ✓' : 'copy'}</button>
            </div>
            {attempt.kind === 'code' && <>
              <div className="cxl-step">2 · Paste the code it gives you back:</div>
              <div className="cxl-code-row">
                <input className="cxl-input" value={code} placeholder="paste the code here" spellCheck={false} autoComplete="off" autoFocus
                  disabled={phase === 'verifying'} onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
                <button className="wiz-btn primary" disabled={!code.trim() || busy || phase === 'verifying'} onClick={() => void submit()}>
                  {phase === 'verifying' || busy ? '⟳' : 'Sign in'}
                </button>
              </div>
            </>}
            {attempt.kind === 'device' && attempt.userCode && <>
              <div className="cxl-step">2 · Enter this code:</div>
              <button className="cxl-code" onClick={() => copy(attempt.userCode!)} title="click to copy">
                {attempt.userCode}{copied === attempt.userCode ? <span className="cxl-copied">copied ✓</span> : null}
              </button>
            </>}
            <div className="cxl-status">
              {phase === 'verifying' ? '⟳ finishing the sign-in…'
                : attempt.kind === 'code' ? 'Charon keeps this login for every VPS — sign in once.'
                : '⟳ waiting for you to finish signing in… Charon keeps the login for every VPS.'}
            </div>
          </div>
        )}

        {phase === 'success' && attempt?.account && (
          <div className="cxl-body">
            <div className="cxl-status ok">✓ {providerAccountLabel(name, attempt.account)} is ready on every VPS</div>
            {attempt.account.plan && <div className="cxl-account">{[attempt.account.plan, attempt.account.email].filter(Boolean).join(' · ')}</div>}
            <button className="wiz-btn primary" onClick={() => onClose(true)}>Done</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="cxl-body">
            <div className="cxl-status err">⚠ {startError ?? attempt?.error ?? 'Sign-in failed'}</div>
            <div className="cxl-code-row">
              <button className="wiz-btn primary" onClick={begin}>Try again</button>
              <button className="wiz-btn ghost" onClick={() => onClose(false)}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
