'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { InstallStatus } from '@/lib/types/api';
import { IconTools, IconRobot } from './icons';

// Local mirror of BootstrapEvent (defined server-side in
// `lib/server/claude/bootstrap.ts`). We redeclare it to avoid importing a
// 'server-only' module on the client side.
export type BootstrapEvent = {
  phase: 'verify' | 'detect_os' | 'install_python' | 'install_sdk'
       | 'install_codex'
       | 'install_claude_cli'
       | 'install_agent' | 'install_service' | 'ping_agent'
       | 'check_login' | 'done';
  status: 'running' | 'ok' | 'error' | 'warn';
  detail?: string;
};

type Props = {
  installId: string;
  vpsId: string;
  vpsName: string;
  onClosed: () => void;
  /** Callback when the install finishes OK and we need to offer "Setup login".
   *  The component doesn't know how to open the Claude login modal — that's the
   *  parent ClaudePanel's job. */
  onSetupLogin?: () => void;
  /** Callback when the agent is OK, to signal that the user wants to "close
   *  + open a Claude session" (pleasant post-install UX). */
  onInstallSuccess?: () => void;
};

const PHASE_LABEL: Record<BootstrapEvent['phase'], string> = {
  verify:             'verifying python + claude SDK',
  detect_os:          'detecting OS',
  install_python:     'installing python',
  install_sdk:        'installing claude-agent-sdk',
  install_codex:      'installing openai-codex',
  install_claude_cli: 'installing claude CLI',
  install_agent:      'deploying charon-agent',
  install_service:    'systemd-user service',
  ping_agent:         'pinging daemon',
  check_login:        'checking claude login',
  done:               'done',
};

// Lines of live output kept under the running phase. Enough to see progress
// (pip prints one line per resolved wheel), few enough that the phase list
// stays the thing you read.
const LIVE_LINES = 6;

const STATUS_GLYPH: Record<BootstrapEvent['status'], string> = {
  running: '▸',
  ok:      '✓',
  warn:    '⚠',
  error:   '✗',
};

/**
 * Full-screen view (occupies `claude-main`) that displays the log of an
 * agent install session. SSE stream from `/api/installs/[id]/stream`,
 * ring buffer replayed at mount, then live.
 *
 * Differs from the old BootstrapBanner:
 *  - Full-screen (not a top banner)
 *  - The state is server-side (ring buffer); the client reconnects without
 *    losing history
 *  - Retry / Setup Login button depending on the final status
 */
export default function InstallSessionView({
  installId, vpsId, vpsName, onClosed, onSetupLogin, onInstallSuccess,
}: Props) {
  const [events, setEvents] = useState<BootstrapEvent[]>([]);
  // Live stdout of the phase in flight (apt / pip / curl). Live-only: it is
  // never ringed server-side, so it starts wherever the run is when this view
  // connects and disappears when the phase reaches its verdict — the point is
  // "something is happening", not a second copy of the log.
  const [live, setLive] = useState<{ phase: BootstrapEvent['phase']; lines: string[] } | null>(null);
  const [status, setStatus] = useState<InstallStatus>('running');
  const [needsClaudeLogin, setNeedsClaudeLogin] = useState(false);
  const [busy, setBusy] = useState<null | 'retry' | 'close'>(null);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLUListElement>(null);
  // "Replay in progress" flag: during this window we replace rather than
  // append (otherwise double display). Set to false on replay_end.
  const replayingRef = useRef(false);
  // Tracker to call onInstallSuccess EXACTLY ONCE when the status
  // transitions running → success.
  const lastStatusRef = useRef<InstallStatus>('running');

  useEffect(() => {
    const es = new EventSource(`/api/installs/${installId}/stream`);
    esRef.current = es;
    let aborted = false;

    es.onmessage = (e) => {
      if (aborted) return;
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.kind === 'replay_begin') {
        replayingRef.current = true;
        // Reset local history — we'll rehydrate from the server ring buffer
        setEvents([]);
        setLive(null);
        return;
      }
      if (msg.kind === 'log') {
        const incoming: string[] = Array.isArray(msg.lines) ? msg.lines : [];
        setLive((prev) => ({
          phase: msg.phase,
          lines: (prev && prev.phase === msg.phase ? [...prev.lines, ...incoming] : incoming).slice(-LIVE_LINES),
        }));
        return;
      }
      if (msg.kind === 'replay_end') {
        replayingRef.current = false;
        return;
      }
      if (msg.kind === 'event') {
        const ev: BootstrapEvent = msg.ev;
        // A verdict retires its own tail: the detail line replaces it.
        if (ev.status !== 'running') setLive((prev) => (prev?.phase === ev.phase ? null : prev));
        setEvents((prev) => {
          // Coalescing heuristic: if the last entry has the same phase
          // and was `running`, we replace it (intra-phase status update).
          // Otherwise append. Copied straight from BootstrapBanner.
          const last = prev[prev.length - 1];
          if (last && last.phase === ev.phase && last.status === 'running') {
            return [...prev.slice(0, -1), ev];
          }
          return [...prev, ev];
        });
        return;
      }
      if (msg.kind === 'status') {
        const next: InstallStatus = msg.status;
        setStatus(next);
        // The login probe is silent (no phase row): whether this VPS still
        // needs `claude login` rides on the status message instead.
        if (typeof msg.needsClaudeLogin === 'boolean') setNeedsClaudeLogin(msg.needsClaudeLogin);
        if (lastStatusRef.current === 'running' && next === 'success') {
          onInstallSuccess?.();
        }
        lastStatusRef.current = next;
        return;
      }
    };
    es.onerror = () => {
      // EventSource reconnects automatically. We do NOT close — the user
      // closes via the X in the header, the right-click Close, or by
      // unmounting the component. The server-side ring survives drops.
    };
    return () => {
      aborted = true;
      try { es.close(); } catch {}
    };
  }, [installId, onInstallSuccess]);

  // Auto-scroll to the bottom when new events — or new live output — arrive
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, live]);

  async function doRetry() {
    if (busy) return;
    setBusy('retry');
    try {
      await api.retryInstall(installId);
    } catch (e: any) {
      setEvents((prev) => [...prev, { phase: 'done', status: 'error', detail: 'retry failed: ' + (e?.message ?? e) }]);
    } finally {
      setBusy(null);
    }
  }

  async function doClose() {
    if (busy) return;
    setBusy('close');
    try {
      await api.closeInstall(installId);
    } catch {}
    onClosed();
  }

  // Offer "setup claude login" on a successful install of a VPS that is not
  // signed in — the flag comes from the status message (the probe itself no
  // longer prints a phase: "not signed in" is the expected state on a fresh
  // box and a trailing ⚠ made a clean install look broken).
  const needsLogin = status === 'success' && needsClaudeLogin;

  return (
    <main className="claude-main install-main">
      <header className={`install-head install-status-${status}`}>
        <span className="install-icon"><IconTools /></span>
        <div className="install-titles">
          <span className="install-title">agent installation</span>
          <span className="install-sub">{vpsName}</span>
        </div>
        <span className={`install-pill pill-${status}`}>
          {status === 'running' ? <><span className="dot" /> running…</>
            : status === 'success' ? '✓ done'
            : '✗ failed'}
        </span>
        <div className="install-head-actions">
          {status === 'error' && (
            <button
              className="install-btn primary"
              onClick={doRetry}
              disabled={busy !== null}
              title="restart the installation from the beginning"
            >{busy === 'retry' ? '⟳ retry…' : '⟳ retry'}</button>
          )}
          {needsLogin && onSetupLogin && (
            <button
              className="install-btn primary"
              onClick={onSetupLogin}
              title="open the claude login terminal for this VPS"
            ><IconRobot /> setup claude login</button>
          )}
          <button
            className="install-btn"
            onClick={doClose}
            disabled={busy !== null}
            title="close this install session (the install itself is not cancelled)"
          >{busy === 'close' ? '⟳' : '✕'} close</button>
        </div>
      </header>
      <ul className="install-steps" ref={logRef}>
        {events.length === 0 && (
          <li className="install-step status-running">
            <span className="glyph">▸</span>
            <span className="label">connecting to stream…</span>
          </li>
        )}
        {events.map((ev, i) => (
          <li key={i} className={`install-step status-${ev.status}`}>
            <span className="glyph">{STATUS_GLYPH[ev.status]}</span>
            <span className="label">{PHASE_LABEL[ev.phase]}</span>
            {ev.detail && <span className="detail">{ev.detail}</span>}
          </li>
        ))}
        {/* The tail of the phase in flight. Rendered as its own row under the
            last step: a `pip install` is minutes of silence otherwise. */}
        {live && live.lines.length > 0 && status === 'running' && (
          <li className="install-live" aria-live="polite">
            {live.lines.map((line, i) => (
              <span key={i} className="install-live-line">{line}</span>
            ))}
          </li>
        )}
        {status === 'success' && (
          <li className="install-footer-msg ok">
            ✓ the agent is installed and operational on <strong>{vpsName}</strong>.
            {needsLogin
              ? <> Finish by running <em>claude login</em> via the button above.</>
              : <> You can now open a Claude session from the sidebar.</>}
          </li>
        )}
        {status === 'error' && (
          <li className="install-footer-msg err">
            ✗ installation failed. Review the log above, fix the issue,
            then click <strong>retry</strong>.
          </li>
        )}
      </ul>
    </main>
  );
}
