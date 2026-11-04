'use client';
import { useEffect, useState } from 'react';
import { sessionCapabilities, type SessionProvider } from '@/lib/sessionCapabilities';
import { backgroundWorkText as text } from '@/lib/providerText';

export type NativeBgAgent = { id: string; name?: string | null; role?: string | null; status?: string; preview?: string };
/** Session inventory, never inferred to be children of the selected workflow. */
export function useBgSessionAgents(sessionId: string, provider: SessionProvider) {
  const enabled = sessionCapabilities(provider).subagents !== 'none';
  const [agents, setAgents] = useState<NativeBgAgent[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      let delay = 15000;
      try {
        if (document.visibilityState !== 'visible') return;
        const response = await fetch(`/api/sessions/${sessionId}/subagents`, { signal: controller.signal });
        const data = await response.json();
        if (stopped) return;
        if (data.reason === 'loading') { delay = 1000; return; }
        if (!response.ok || data.ok === false) throw new Error(data.reason === 'unsupported' ? text.needsAgentUpdate : data.error || text.inventoryUnavailable);
        if (Array.isArray(data.agents)) setAgents(data.agents.flatMap((item: unknown) => {
          if (typeof item === 'string') return [{ id: item }];
          if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') return [item as NativeBgAgent];
          return [];
        }).slice(0, 200));
        setLoading(false); setError(data._snapshot?.last_error || '');
        if (data._snapshot?.state === 'refreshing') delay = 1000;
      } catch (err) {
        if (!stopped) { setLoading(false); setError(err instanceof Error ? err.message : text.inventoryUnavailable); }
      } finally {
        if (!stopped) timer = setTimeout(load, delay);
      }
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, enabled]);
  return { agents, loading, error, enabled };
}
