'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AgentKind, ModelNoticesResponse } from '@/lib/types/api';
import { subscribeAll } from './globalEventStream';
import { invalidateModels } from './modelsCache';
import { invalidateCodexModels } from './codexModelsCache';

const EMPTY: ModelNoticesResponse = { revision: -1, claude: [], codex: [] };

export function useModelNotices() {
  const [notices, setNotices] = useState(EMPTY);
  const accept = useCallback((next: ModelNoticesResponse) => {
    if (next.claude.length) invalidateModels();
    if (next.codex.length) invalidateCodexModels();
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

  return { notices, markSeen, hasNewModels: notices.claude.length + notices.codex.length > 0 };
}
