'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { BgAgent } from './bgTasks';

/** Restore only this run's nodes when live progress was lost on reload. An
 * ended run is read once: its journal no longer changes. */
export function useBgWorkflowAgents(sessionId: string, task: string | undefined, running: boolean) {
  const [state, setState] = useState<{ agents: BgAgent[] | null; loading: boolean; error: string }>({ agents: null, loading: !!task, error: '' });
  useEffect(() => {
    if (!task) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        const result = await api.getWorkflowAgents(sessionId, task, controller.signal);
        if (stopped) return;
        if (!result.ok) { setState(s => ({ ...s, loading: false, error: result.error })); return; }
        setState({ agents: result.agents, loading: false, error: '' });
      } catch (err) {
        if (!stopped) setState(s => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        if (!stopped && running) timer = setTimeout(load, 15000);
      }
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, task, running]);
  return state;
}
