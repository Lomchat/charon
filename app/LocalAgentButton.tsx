'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

import type { LocalAgentStatus } from '@/lib/types/api';

// Petit bouton dans le header : invisible si l'agent local est à jour, et
// devient un bouton ambré "update local agent" sinon. Sert à mettre à jour
// l'agent qui tourne sur la machine du dashboard lui-même (pas un VPS).
//
// Fetch le status au mount + après update. Pas de polling : si une nouvelle
// version est déployée pendant qu'une session est ouverte, le user verra le
// changement au prochain refresh — c'est OK.
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
  // Pas installé : on ne propose pas d'update local — le user doit déployer
  // manuellement la première fois (rare cas dev).
  if (!status.installed) return null;
  // À jour : on ne montre rien (économise la place dans le header).
  if (!status.outOfDate && !busy) return null;

  async function doUpdate() {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateLocalAgent();
      await refresh();
    } catch (e: any) {
      // Affiche dans le tooltip ; pas de toast pour l'instant
      console.error('update local agent:', e);
    } finally {
      setBusy(false);
    }
  }

  const tip = `agent local désynchronisé — ${status.deployedPyzSha ?? '??'} → ${status.builtPyzSha ?? '??'}\nclic pour mettre à jour (restart systemd-user)`;

  return (
    <button
      className="head-btn local-agent-update"
      onClick={doUpdate}
      disabled={busy}
      title={tip}
      aria-label="mettre à jour l'agent local"
    >
      {busy ? '⟳' : '⇪'} agent
    </button>
  );
}
