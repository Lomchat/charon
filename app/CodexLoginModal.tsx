'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/db/schema';
import AgentLogo from './AgentLogo';

// Codex sign-in via the ChatGPT DEVICE-CODE flow (agent >= 0.16.0, §14.61) —
// the Codex sibling of <ClaudeLoginModal> (§14.64): POST start returns a
// verification URL + short code; the user opens the URL on ANY device (this
// browser, a phone…), types the code, and the VPS's codex app-server persists
// its own credentials. We poll GET status until success/error.
//
// `onClose(loggedIn)` — loggedIn=true only on a confirmed success (the parent
// patches vps.codexLoggedIn locally; the server has already persisted +
// broadcast `vps_status`, so other tabs follow on their own).

type Phase =
  | { kind: 'starting' }
  | { kind: 'pending'; loginId: string; url: string; code: string }
  | { kind: 'success' }
  | { kind: 'error'; msg: string };

const POLL_MS = 2500;

export default function CodexLoginModal({ vps, onClose }: {
  vps: Vps;
  onClose: (loggedIn: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [copied, setCopied] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  // Refs so the unmount cleanup can cancel the RIGHT attempt without
  // re-running the effect on each phase change.
  const loginIdRef = useRef<string | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(loginId: string) {
      if (!alive) return;
      try {
        const r = await api.codexLoginStatus(vps.id, loginId);
        if (!alive) return;
        if (!r.ok) {
          doneRef.current = true;
          setPhase({ kind: 'error', msg: r.error ?? 'login attempt lost' });
          return;
        }
        if (r.status === 'success') {
          doneRef.current = true;
          setPhase({ kind: 'success' });
          return;
        }
        if (r.status === 'error') {
          doneRef.current = true;
          setPhase({ kind: 'error', msg: r.error ?? 'login failed' });
          return;
        }
      } catch {
        // transient (hub restart, ssh blip) — keep polling
      }
      timer = setTimeout(() => poll(loginId), POLL_MS);
    }

    api.startCodexLogin(vps.id)
      .then((r) => {
        if (!alive) return;
        if (!r.ok || !r.loginId || !r.verificationUrl || !r.userCode) {
          doneRef.current = true;
          setPhase({ kind: 'error', msg: r.error ?? 'could not start codex login' });
          return;
        }
        loginIdRef.current = r.loginId;
        setPhase({ kind: 'pending', loginId: r.loginId, url: r.verificationUrl, code: r.userCode });
        timer = setTimeout(() => poll(r.loginId!), POLL_MS);
      })
      .catch((e) => {
        if (!alive) return;
        doneRef.current = true;
        setPhase({ kind: 'error', msg: String(e?.message ?? e) });
      });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      // Closing mid-attempt cancels it agent-side (frees the app-server child).
      if (!doneRef.current && loginIdRef.current) {
        api.cancelCodexLogin(vps.id, loginIdRef.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vps.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(phase.kind === 'success'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase.kind]);

  function copyCode(code: string) {
    try {
      navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  async function loginWithApiKey() {
    if (!apiKey.trim() || accountBusy) return;
    setAccountBusy(true); setAccountError(null);
    try {
      if (loginIdRef.current && !doneRef.current) {
        await api.cancelCodexLogin(vps.id, loginIdRef.current).catch(() => {});
      }
      doneRef.current = true;
      const r = await fetch(`/api/vps/${vps.id}/codex/account`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || 'API-key login failed');
      setApiKey(''); setPhase({ kind: 'success' });
    } catch (e: any) { setAccountError(String(e?.message || e)); }
    finally { setAccountBusy(false); }
  }

  async function logout() {
    if (accountBusy) return;
    setAccountBusy(true); setAccountError(null);
    try {
      if (loginIdRef.current && !doneRef.current) {
        await api.cancelCodexLogin(vps.id, loginIdRef.current).catch(() => {});
      }
      doneRef.current = true;
      const r = await fetch(`/api/vps/${vps.id}/codex/account`, { method: 'DELETE' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || 'logout failed');
      onClose(false);
    } catch (e: any) { setAccountError(String(e?.message || e)); setAccountBusy(false); }
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(phase.kind === 'success'); }}>
      <div className="claude-modal codex-login-modal">
        <button className="modal-close" onClick={() => onClose(phase.kind === 'success')}>✕</button>
        <div className="cxl-head">
          <AgentLogo kind="codex" size={18} />
          <h2>Codex login · {vps.name}</h2>
        </div>

        {phase.kind === 'starting' && (
          <div className="cxl-body">
            <div className="cxl-status">⟳ requesting a device code…</div>
          </div>
        )}

        {phase.kind === 'pending' && (
          <div className="cxl-body">
            <div className="cxl-step">1 · Open this page on any device:</div>
            <a className="cxl-url" href={phase.url} target="_blank" rel="noreferrer noopener">
              {phase.url} ↗
            </a>
            <div className="cxl-step">2 · Enter this code:</div>
            <button className="cxl-code" onClick={() => copyCode(phase.code)} title="click to copy">
              {phase.code}{copied ? <span className="cxl-copied">copied ✓</span> : null}
            </button>
            <div className="cxl-status">⟳ waiting for you to finish signing in… (the VPS saves its own credentials)</div>
            <div className="cxl-step">or sign in directly with an API key (Charon does not store it):</div>
            <input className="nw-input mono" type="text" autoComplete="off"
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
            <button className="wiz-btn ghost" disabled={accountBusy || !apiKey.trim()}
              onClick={() => void loginWithApiKey()}>{accountBusy ? 'signing in…' : 'Use API key'}</button>
            {accountError && <div className="cxl-status err">⚠ {accountError}</div>}
          </div>
        )}

        {phase.kind === 'success' && (
          <div className="cxl-body">
            <div className="cxl-status ok">✓ signed in — Codex is ready on {vps.name}</div>
            <button className="wiz-btn primary" onClick={() => onClose(true)}>Done</button>
          </div>
        )}

        {vps.codexLoggedIn === 1 && phase.kind !== 'success' && (
          <div className="cxl-body">
            <button className="wiz-btn ghost" disabled={accountBusy} onClick={() => void logout()}>
              {accountBusy ? 'signing out…' : 'Sign out Codex on this VPS'}
            </button>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="cxl-body">
            <div className="cxl-status err">⚠ {phase.msg}</div>
            <button className="wiz-btn ghost" onClick={() => onClose(false)}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
