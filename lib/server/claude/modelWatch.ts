import 'server-only';
import { listAgentClients } from '@/lib/server/agent/AgentClientPool';
import { getCodexModelsForVps } from './codexModels';
import { refreshCursorModelsForVps } from './cursorModels';
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
        if (client.status !== 'connected') continue;
        if (client.hello?.codex_available) {
          await getCodexModelsForVps(client.vps.id);
        }
        // Cursor's catalog costs a bridge launch, so this tick is also what
        // keeps the picker instant: it refreshes the stored copy in the
        // background instead of making whoever opens the control wait.
        if (client.hello?.cursor_available) {
          const r = await refreshCursorModelsForVps(client.vps.id);
          if (r.ok && r.models.length) {
            observeModels('cursor', r.models.map((m) => ({ id: m.id, label: m.label })));
          }
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
