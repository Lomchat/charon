'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { subscribeAll } from './globalEventStream';

import type { LocalAgentStatus } from '@/lib/types/api';

// Small button in the header: invisible if the local agent is up to date,
// and becomes an amber "update local agent" button otherwise. Used to update
// the agent that runs on the dashboard machine itself (not a VPS).
//
// ⚠ It must clear ITSELF. This used to fetch once at mount and never again
// ("the user will see the change at the next refresh — that's OK"), which it
// was not: the local agent is updated by the auto-update tick, by another tab,
// or — when the hub hosts its own VPS row — as a side effect of updating that
// VPS. In every one of those cases the button stayed lit until F5, advertising
// work that was already done. There is no bus event for the LOCAL agent (it is
// not a `vps` row, so no `vps_status`), hence three cheap re-checks:
//
//   - the tab becoming visible again (you were away while the tick ran);
//   - any `vps_status` — the fleet moved, and on a self-hosted box that IS
//     this agent being replaced;
//   - a slow tick armed ONLY while the button is on screen. Up to date is the
//     common case and costs nothing; when it IS showing we are precisely
//     waiting for it to stop being true.
//
// `getLocalAgentStatus` spawns `systemctl is-active`, so the re-checks are
// coalesced (`inflight`) — a fleet reconnect storm is one probe, not twenty.

const RECHECK_MS = 30_000;

export default function LocalAgentButton() {
  const [status, setStatus] = useState<LocalAgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await api.getLocalAgentStatus();
      // Preserve identity when nothing moved, so the header doesn't re-render
      // once per probe.
      setStatus((prev) =>
        prev
          && prev.installed === r.installed
          && prev.outOfDate === r.outOfDate
          && prev.deployedAgentVersion === r.deployedAgentVersion
          && prev.builtAgentVersion === r.builtAgentVersion
          && prev.deployedPyzSha === r.deployedPyzSha
          && prev.builtPyzSha === r.builtPyzSha
          ? prev
          : r);
    } catch {
      setStatus(null);
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Event-driven convergence — no timer in the common (up-to-date) case.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    const unsub = subscribeAll((ev) => { if (ev.type === 'vps_status') refresh(); });
    return () => { document.removeEventListener('visibilitychange', onVis); unsub(); };
  }, [refresh]);

  const showing = !!status?.installed && (status.outOfDate || busy);

  // Armed only while the button is visible: the one state we actively want to
  // see end. Stops as soon as it clears.
  useEffect(() => {
    if (!showing) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
    }, RECHECK_MS);
    return () => clearInterval(t);
  }, [showing, refresh]);

  const doUpdate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateLocalAgent();
      await refresh();
    } catch (e: any) {
      // Displayed in the tooltip; no toast for now
      console.error('update local agent:', e);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  if (!status) return null;
  // Not installed: we don't offer a local update — the user has to deploy
  // manually the first time (rare dev case).
  if (!status.installed) return null;
  // Up to date: we show nothing (saves space in the header).
  if (!status.outOfDate && !busy) return null;

  const tip = `local agent out of date — v${status.deployedAgentVersion ?? '?'} → v${status.builtAgentVersion ?? '?'}`
    + ` (${status.deployedPyzSha ?? '??'} → ${status.builtPyzSha ?? '??'})`
    + `\nclick to update (restart systemd-user)`;

  return (
    <button
      className="head-btn local-agent-update"
      onClick={doUpdate}
      disabled={busy}
      title={tip}
      aria-label="update local agent"
    >
      {busy ? '⟳' : '⇪'} agent
    </button>
  );
}
