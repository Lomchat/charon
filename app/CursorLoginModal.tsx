'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/db/schema';
import AgentLogo from './AgentLogo';
import { invalidateCursorModels } from './cursorModelsCache';

// Cursor's browser-link login (§14.104). The agent polls completion and stores
// the credential on the VPS; `onClose(true)` means that success was confirmed.

type Phase =
  | { kind: 'starting' }
  | { kind: 'pending'; loginId: string; url: string }
  | { kind: 'success' }
  | { kind: 'error'; msg: string };

const POLL_MS = 2500;

export default function CursorLoginModal({ vps, onClose }: {
  vps: Vps;
  onClose: (loggedIn: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Refs so the unmount cleanup cancels the RIGHT attempt without re-running
  // the effect on every phase change.
  const loginIdRef = useRef<string | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(loginId: string) {
      if (!alive) return;
      try {
        const r = await api.cursorLoginStatus(vps.id, loginId);
        if (!alive) return;
        if (!r.ok) {
          doneRef.current = true;
          setPhase({ kind: 'error', msg: r.error ?? 'sign-in attempt lost' });
          return;
        }
        if (r.status === 'success') {
          doneRef.current = true;
          invalidateCursorModels(vps.id);
          setPhase({ kind: 'success' });
          return;
        }
        if (r.status === 'error') {
          doneRef.current = true;
          setPhase({ kind: 'error', msg: r.error ?? 'sign-in failed' });
          return;
        }
      } catch {
        // transient (hub restart, ssh blip) — keep polling
      }
      timer = setTimeout(() => poll(loginId), POLL_MS);
    }

    api.startCursorLogin(vps.id)
      .then((r) => {
        if (!alive) return;
        if (!r.ok || !r.loginId || !r.url) {
          doneRef.current = true;
          setPhase({ kind: 'error', msg: r.error ?? 'could not start the Cursor sign-in' });
          return;
        }
        loginIdRef.current = r.loginId;
        setPhase({ kind: 'pending', loginId: r.loginId, url: r.url });
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
      // Closing mid-attempt cancels it agent-side: the helper holds the
      // verifier that redeems this login and would otherwise poll on alone.
      if (!doneRef.current && loginIdRef.current) {
        api.cancelCursorLogin(vps.id, loginIdRef.current).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vps.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(phase.kind === 'success'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase.kind]);

  function copyUrl(url: string) {
    try {
      navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  async function signOut() {
    if (busy) return;
    setBusy(true); setActionError(null);
    try {
      if (loginIdRef.current && !doneRef.current) {
        await api.cancelCursorLogin(vps.id, loginIdRef.current).catch(() => {});
      }
      doneRef.current = true;
      const r = await api.cursorSignOut(vps.id);
      if (!r.ok) throw new Error(r.error || 'sign-out failed');
      invalidateCursorModels(vps.id);
      onClose(false);
    } catch (e: any) { setActionError(String(e?.message || e)); setBusy(false); }
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(phase.kind === 'success'); }}>
      <div className="claude-modal codex-login-modal">
        <button className="modal-close" onClick={() => onClose(phase.kind === 'success')}>✕</button>
        <div className="cxl-head">
          <AgentLogo kind="cursor" size={18} />
          <h2>Cursor sign-in · {vps.name}</h2>
        </div>

        {phase.kind === 'starting' && (
          <div className="cxl-body">
            <div className="cxl-status">⟳ requesting a sign-in link…</div>
          </div>
        )}

        {phase.kind === 'pending' && (
          <div className="cxl-body">
            <div className="cxl-step">Open this page on any device and finish signing in:</div>
            <a className="cxl-url" href={phase.url} target="_blank" rel="noreferrer noopener">
              {phase.url} ↗
            </a>
            <button className="wiz-btn ghost" onClick={() => copyUrl(phase.url)}>
              {copied ? 'copied ✓' : 'Copy link'}
            </button>
            <div className="cxl-status">
              ⟳ waiting… nothing to paste back — the VPS stores its own credential when you finish.
            </div>
          </div>
        )}

        {phase.kind === 'success' && (
          <div className="cxl-body">
            <div className="cxl-status ok">✓ signed in — Cursor is ready on {vps.name}</div>
            <button className="wiz-btn primary" onClick={() => onClose(true)}>Done</button>
          </div>
        )}

        {vps.cursorLoggedIn === 1 && phase.kind !== 'success' && (
          <div className="cxl-body">
            <button className="wiz-btn ghost" disabled={busy} onClick={() => void signOut()}>
              {busy ? 'signing out…' : 'Sign out Cursor on this VPS'}
            </button>
            {/* Local-only, like the SDK's own logout: the minted key keeps
                working until it expires or is revoked in the dashboard. */}
            <div className="cxl-step">Forgets the stored key on this VPS. Revoke it in the Cursor dashboard to kill it everywhere.</div>
            {actionError && <div className="cxl-status err">⚠ {actionError}</div>}
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
