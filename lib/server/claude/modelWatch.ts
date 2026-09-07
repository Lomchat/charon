import 'server-only';
import { listAgentClients } from '@/lib/server/agent/AgentClientPool';
import { getCodexModelsForVps } from './codexModels';
import { getMergedModels, refreshModelsIfStale } from './modelSync';
import { observeModels } from './modelNotices';

const INTERVAL_MS = 5 * 60_000;
const g = globalThis as unknown as {
  _modelWatch?: { timer: ReturnType<typeof setInterval>; running: boolean };
};

export function armModelWatch(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build' || g._modelWatch) return;
  const tick = async () => {
    const state = g._modelWatch!;
    if (state.running) return;
    state.running = true;
    try {
      observeModels('claude', getMergedModels());
      refreshModelsIfStale();
      // Sequential and connected-only: do not queue RPCs on offline machines.
      for (const client of listAgentClients()) {
        if (client.status === 'connected' && client.hello?.codex_available) {
          await getCodexModelsForVps(client.vps.id);
        }
      }
    } catch (error) {
      console.warn('[modelWatch] catalog refresh failed', error);
    } finally { state.running = false; }
  };
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref?.();
  g._modelWatch = { timer, running: false };
  // Establish Claude's baseline before resumed sessions report CLI catalogs.
  observeModels('claude', getMergedModels());
  const first = setTimeout(() => { void tick(); }, 30_000);
  first.unref?.();
}
