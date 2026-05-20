'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

import type { LocalAgentStatus } from '@/lib/types/api';

// Small button in the header: invisible if the local agent is up to date,
// and becomes an amber "update local agent" button otherwise. Used to update
// the agent that runs on the dashboard machine itself (not a VPS).
//
// Fetches status at mount + after update. No polling: if a new version is
// deployed while a session is open, the user will see the change at the
// next refresh — that's OK.
export default function LocalAgentButton() {
  const [status, setStatus] = useState<LocalAgentStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.getLocalAgentStatus();
      setStatus(r);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!status) return null;
  // Not installed: we don't offer a local update — the user has to deploy
  // manually the first time (rare dev case).
  if (!status.installed) return null;
  // Up to date: we show nothing (saves space in the header).
  if (!status.outOfDate && !busy) return null;

  async function doUpdate() {
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
  }

  const tip = `local agent out of sync — ${status.deployedPyzSha ?? '??'} → ${status.builtPyzSha ?? '??'}\nclick to update (restart systemd-user)`;

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
