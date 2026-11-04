'use client';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '@/lib/api';
import type { WorkflowOutputQuery } from '@/lib/types/api';
import { prettyOutputJson } from './backgroundOutput';
import { backgroundWorkText as text } from '@/lib/providerText';

/** The selected workflow child alone is read; polls pause while reading history.
 * Earlier pages use stable byte boundaries and are prepended chronologically. */
export function useWorkflowOutput(sessionId: string, task: string | undefined, label: string | undefined,
  phase: string | undefined, running: boolean, follow: MutableRefObject<boolean>) {
  const [state, setState] = useState({ content: '', error: '', loading: !!task, readingEarlier: false, linked: false, hasMore: false });
  const active = useRef(running);
  active.current = running;
  const request = useRef<((older?: boolean, force?: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!task || !label) return;
    let disposed = false, busy = false, nextBefore: number | null = null, agentId = '', content = '', linked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async (older = false, force = false) => {
      if (disposed || busy || document.visibilityState !== 'visible') return;
      if (older && nextBefore == null) return;
      if (!older && !force && linked && !active.current) { timer = setTimeout(load, 5000); return; }
      if (!older && !follow.current) { timer = setTimeout(load, 3000); return; }
      clearTimeout(timer); busy = true;
      if (older) setState(s => ({ ...s, readingEarlier: true }));
      try {
        const query: WorkflowOutputQuery = { task, label, phase: phase || '' };
        if (older) { query.before = nextBefore!; query.expectedAgent = agentId; }
        const data = await api.getWorkflowOutput(sessionId, query, controller.signal);
        if (data.ok !== true) throw new Error(data.error || text.outputError);
        if (disposed || (!older && !follow.current)) return;
        const page = data.blocks.map((s: string) => prettyOutputJson(s)).join('\n\n');
        content = older ? [page, content].filter(Boolean).join('\n\n') : page;
        linked = true; nextBefore = data.nextBefore; agentId = data.agentId;
        setState({ content, error: '', loading: false, readingEarlier: false, linked, hasMore: nextBefore != null });
      } catch (err) {
        if (!disposed) setState(s => ({ ...s, error: err instanceof Error ? err.message : text.outputError, loading: false, readingEarlier: false }));
      } finally {
        busy = false;
        if (!disposed) timer = setTimeout(load, 5000);
      }
    };
    request.current = load;
    void load();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); request.current = null; };
  }, [sessionId, task, label, phase, follow]);
  return { ...state, loadEarlier: () => request.current?.(true), latest: () => request.current?.(false, true) };
}
