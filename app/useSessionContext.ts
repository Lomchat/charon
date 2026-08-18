'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionContextUsage } from './sessionInsightState';

type Snapshot = {
  sessionId: string;
  context: SessionContextUsage | null;
  loaded: boolean;
  loading: boolean;
};

/**
 * One context request shared by the header and Tools inspector.
 *
 * The previous inspector owned this request, which meant adding a header gauge
 * would either duplicate it or let the two displays drift. The selected
 * session owns it now: last-good data remains visible during refresh, focus
 * refreshes it, and callers explicitly refresh after a turn or compaction.
 */
export function useSessionContext(sessionId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    sessionId,
    context: null,
    loaded: false,
    loading: true,
  }));
  const generation = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    const currentGeneration = ++generation.current;
    setSnapshot((current) => current.sessionId === sessionId
      ? { ...current, loading: true }
      : { sessionId, context: null, loaded: false, loading: true });

    return (async () => {
      let context: SessionContextUsage | null;
      try {
        const response = await fetch(`/api/claude/sessions/${sessionId}/context`, {
          cache: 'no-store',
        });
        const body = await response.json().catch(() => null);
        context = response.ok
          ? body
          : { ok: false, error: body?.error || `context request failed (${response.status})` };
      } catch (error) {
        context = { ok: false, error: String((error as Error)?.message || error) };
      }
      if (generation.current !== currentGeneration) return;
      setSnapshot({ sessionId, context, loaded: true, loading: false });
    })();
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', refreshOnReturn);
    return () => window.removeEventListener('focus', refreshOnReturn);
  }, [refresh]);

  const current = snapshot.sessionId === sessionId;
  return {
    context: current ? snapshot.context : null,
    loaded: current ? snapshot.loaded : false,
    loading: current ? snapshot.loading : true,
    refresh,
  };
}
