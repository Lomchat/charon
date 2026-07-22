'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/db/schema';
import AgentLogo from './AgentLogo';

// Codex sign-in via the ChatGPT DEVICE-CODE flow (agent >= 0.16.0, §14.61) —
// the Codex sibling of <LoginConsole>, without a PTY: POST start returns a
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
          </div>
        )}

        {phase.kind === 'success' && (
          <div className="cxl-body">
            <div className="cxl-status ok">✓ signed in — Codex is ready on {vps.name}</div>
            <button className="wiz-btn primary" onClick={() => onClose(true)}>Done</button>
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
