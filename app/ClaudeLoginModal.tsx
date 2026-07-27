'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/db/schema';
import type { ClaudeLoginAccount, ClaudeLoginPhase, ClaudeLoginStatusResponse } from '@/lib/types/api';
import AgentLogo from './AgentLogo';

// Claude sign-in via the hosted OAuth code flow (§14.64) — the Claude twin of
// <CodexLoginModal>, and the replacement for the old xterm/PTY <LoginConsole>.
//
// `claude auth login` on the VPS prints an authorize url whose redirect_uri is
// platform.claude.com (NOT localhost), so the user can complete it on ANY
// device; it then hands back a code to paste. Hence one extra step vs Codex
// (which persists its own credentials): open url → paste code.
//
// A rejected code is NOT terminal: the CLI keeps the session (and the SAME
// url) alive and accepts codes in a loop, so the server puts us back in
// 'pending' with a non-fatal `error` and the user simply pastes again. The
// success verdict comes from `claude auth status --json`, never from scraping
// stdout.
//
// `onClose(loggedIn)` — loggedIn=true only on confirmed success (the parent
// patches vps.claudeLoggedIn locally; the server already persisted and
// broadcast `vps_status`, so other tabs follow on their own).

const POLL_MS = 1200;

export default function ClaudeLoginModal({ vps, onClose }: {
  vps: Vps;
  onClose: (loggedIn: boolean) => void;
}) {
  const [phase, setPhase] = useState<ClaudeLoginPhase>('starting');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<ClaudeLoginAccount | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const aliveRef = useRef(true);
  const doneRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const phaseRef = useRef<ClaudeLoginPhase>('starting');
  const inputRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((r: ClaudeLoginStatusResponse) => {
    if (!aliveRef.current) return;
    if (!r.ok) {
      doneRef.current = true;
      setPhase('error');
      setError(r.error ?? 'login attempt lost');
      return;
    }
    const p = r.phase ?? 'starting';
    const prev = phaseRef.current;
    phaseRef.current = p;
    setPhase(p);
    setUrl(r.url ?? null);
    setError(r.error ?? null);
    setAccount(r.account ?? null);
    // Drop what was typed once it's been consumed: either the code was
    // rejected (verifying → pending, the SAME url stays valid — the CLI keeps
    // the session open and accepts codes in a loop, verified), or a brand new
    // url showed up. Both mean the field should be empty for the next paste.
    if (prev === 'verifying' && p === 'pending') setCode('');
    if (typeof r.attempt === 'number' && r.attempt !== attemptRef.current) {
      attemptRef.current = r.attempt;
      setCode('');
    }
    if (p === 'success' || p === 'error') doneRef.current = true;
  }, []);

  // One poll loop for the whole attempt: it drives 'starting' → 'pending'
  // (url appears), survives an Invalid-code round trip, and settles the
  // 'verifying' → 'success'/'error' verdict.
  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (!aliveRef.current || doneRef.current) return;
      try {
        apply(await api.claudeLoginStatus(vps.id));
      } catch {
        // transient (hub restart, ssh blip) — keep polling
      }
      if (aliveRef.current && !doneRef.current) schedule();
    }, POLL_MS);
  }, [apply, vps.id]);

  const begin = useCallback(() => {
    doneRef.current = false;
    attemptRef.current = 0;
    phaseRef.current = 'starting';
    setPhase('starting');
    setUrl(null);
    setError(null);
    setAccount(null);
    setCode('');
    api.startClaudeLogin(vps.id)
      .then((r) => { apply(r); schedule(); })
      .catch((e) => {
        if (!aliveRef.current) return;
        doneRef.current = true;
        setPhase('error');
        setError(String(e?.message ?? e));
      });
  }, [apply, schedule, vps.id]);

  useEffect(() => {
    aliveRef.current = true;
    begin();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      // Closing mid-attempt kills the remote `claude auth login` + its ssh.
      if (!doneRef.current) api.cancelClaudeLogin(vps.id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vps.id]);

  const close = useCallback(() => onClose(phase === 'success'), [onClose, phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Focus the code field as soon as the url is up — the user comes back from
  // another device/tab straight into a paste.
  useEffect(() => {
    if (phase === 'pending' && url) inputRef.current?.focus();
  }, [phase, url]);

  async function submit() {
    const clean = code.trim();
    if (!clean || submitting) return;
    setSubmitting(true);
    setError(null);
    setPhase('verifying');
    try {
      apply(await api.submitClaudeLoginCode(vps.id, clean));
      schedule();
    } catch (e: any) {
      if (aliveRef.current) { setPhase('pending'); setError(String(e?.message ?? e)); }
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }

  function copyUrl(u: string) {
    try {
      navigator.clipboard?.writeText(u);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  const accountLine = account
    ? [account.subscriptionType, account.email, account.orgName].filter(Boolean).join(' · ')
    : '';

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="claude-modal claude-login-modal">
        <button className="modal-close" onClick={close}>✕</button>
        <div className="cxl-head">
          <AgentLogo kind="claude" size={18} />
          <h2>Claude login · {vps.name}</h2>
        </div>

        {phase === 'starting' && (
          <div className="cxl-body">
            <div className="cxl-status">⟳ starting <code>claude auth login</code> on {vps.name}…</div>
          </div>
        )}

        {(phase === 'pending' || phase === 'verifying') && (
          <div className="cxl-body">
            {error && <div className="cxl-warn">⚠ {error}</div>}
            <div className="cxl-step">1 · Open this page on any device and approve:</div>
            {url ? (
              <div className="cxl-url-row">
                <a className="cxl-url" href={url} target="_blank" rel="noreferrer noopener">{url} ↗</a>
                <button className="cxl-copy" onClick={() => copyUrl(url)} title="copy the url">
                  {copied ? 'copied ✓' : 'copy'}
                </button>
              </div>
            ) : (
              <div className="cxl-status">⟳ waiting for the sign-in url…</div>
            )}
            <div className="cxl-step">2 · Paste the code it gives you back:</div>
            <div className="cxl-code-row">
              <input
                ref={inputRef}
                className="cxl-input"
                value={code}
                placeholder="paste the code here"
                spellCheck={false}
                autoComplete="off"
                disabled={phase === 'verifying' || !url}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
              />
              <button
                className="wiz-btn primary"
                disabled={!code.trim() || submitting || phase === 'verifying' || !url}
                onClick={() => void submit()}
              >
                {phase === 'verifying' ? '⟳' : 'Sign in'}
              </button>
            </div>
            <div className="cxl-status">
              {phase === 'verifying'
                ? '⟳ confirming the sign-in on the VPS…'
                : 'The VPS stores its own credentials — nothing is kept by Charon.'}
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="cxl-body">
            <div className="cxl-status ok">✓ signed in — Claude is ready on {vps.name}</div>
            {accountLine && <div className="cxl-account">{accountLine}</div>}
            <button className="wiz-btn primary" onClick={() => onClose(true)}>Done</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="cxl-body">
            <div className="cxl-status err">⚠ {error ?? 'login failed'}</div>
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
