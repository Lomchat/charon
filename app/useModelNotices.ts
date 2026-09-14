'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AgentKind, ModelNoticesResponse } from '@/lib/types/api';
import { subscribeAll } from './globalEventStream';
import { PROVIDER_CATALOGS } from './modelPickers';
import { SESSION_PROVIDERS } from '@/lib/sessionCapabilities';

// Derived, so a new provider gets its (empty) bucket without an edit here.
const EMPTY: ModelNoticesResponse = {
  revision: -1,
  ...Object.fromEntries(SESSION_PROVIDERS.map((k) => [k, []])),
} as ModelNoticesResponse;

export function useModelNotices() {
  const [notices, setNotices] = useState(EMPTY);
  const accept = useCallback((next: ModelNoticesResponse) => {
    // A provider that just announced new models has a stale catalog cached;
    // clear it through its registry entry (§14.102), never a per-name pair.
    for (const p of SESSION_PROVIDERS) {
      if (next[p]?.length) PROVIDER_CATALOGS[p].invalidate();
    }
    setNotices((current) => next.revision > current.revision ? next : current);
  }, []);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try { const next = await api.getModelNotices(); if (!disposed) accept(next); }
      catch { /* SSE or the next visible poll repairs a failed request. */ }
      finally { refreshing = false; }
    };
    const unsubscribe = subscribeAll((event) => {
      if (event.type === 'model_notices') accept(event.notices);
    });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [accept]);

  const markSeen = useCallback(async (provider: AgentKind, ids: string[]) => {
    accept(await api.markModelsSeen({ provider, ids }));
  }, [accept]);

  return {
    notices,
    markSeen,
    hasNewModels: SESSION_PROVIDERS.some((provider) => notices[provider].length > 0),
  };
}
