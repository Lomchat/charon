'use client';
import { IconClockHistory } from '../icons';
import type { MockVps } from './mock';

// Small "scan existing Claude sessions" button shown in each VPS header.
export function HistoryButton({ onClick }: { onClick?: () => void }) {
  return (
    <button className="dl-history-btn" title="scan existing Claude sessions (import)"
      onClick={onClick}>
      <IconClockHistory />
    </button>
  );
}

type AgentAction = 'install' | 'reinstall' | 'refresh' | 'update' | 'login';

// Agent status + the contextual action(s) for a VPS. Returns null when the
// agent is healthy, up to date and signed in (nothing to do → no clutter).
// Mirrors the real sidebar's logic (install / refresh+reinstall / update / login).
export function AgentBar({ vps, on }: { vps: MockVps; on?: (a: AgentAction) => void }) {
  const s = vps.agentStatus;

  if (s === 'missing') {
    if (vps.installing) {
      return (
        <div className="dl-agent-bar install">
          <span className="dl-install-dot" />
          <span className="dl-agent-meta">⚙ installation · running</span>
          <span className="dl-install-tag">install_sdk</span>
        </div>
      );
    }
    return (
      <div className="dl-agent-bar warn">
        <span className="dl-agent-meta">agent not installed</span>
        <button className="dl-agent-btn primary" onClick={() => on?.('install')}>▸ install agent</button>
      </div>
    );
  }

  if (s === 'error') {
    return (
      <div className="dl-agent-bar err">
        <span className="dl-agent-meta">agent unreachable</span>
        <button className="dl-agent-btn primary" onClick={() => on?.('refresh')}>↻ refresh</button>
        <button className="dl-agent-btn" onClick={() => on?.('reinstall')}>reinstall</button>
      </div>
    );
  }

  // ok
  if (vps.outdated) {
    return (
      <div className="dl-agent-bar update">
        <span className="dl-agent-meta">v{vps.agentVersion} · update available</span>
        <button className="dl-agent-btn update" onClick={() => on?.('update')}>⇪ update</button>
      </div>
    );
  }
  if (vps.loggedIn === false) {
    return (
      <div className="dl-agent-bar warn">
        <span className="dl-agent-meta">v{vps.agentVersion} · not signed in</span>
        <button className="dl-agent-btn" onClick={() => on?.('login')}>claude login</button>
      </div>
    );
  }
  return null; // healthy, up to date, signed in → nothing to show
}
