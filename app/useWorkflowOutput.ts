'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { WorkflowOutputQuery } from '@/lib/types/api';
import { getActivityEntry, mergeActivityPage, newActivityEntry, saveActivityEntry, type ActivityCacheEntry } from './workflowActivityCache';

/** A selected node owns one sequential reader. Cached pages survive remounts;
 * periodic checks request only bytes after the last complete native record. */
export function useWorkflowOutput(sessionId: string, query: WorkflowOutputQuery, running: boolean, identity: string) {
  const key = JSON.stringify([sessionId, identity, query.task, query.label, query.phase, query.agent]);
  const [initial] = useState(() => getActivityEntry(key));
  const entry = useRef<ActivityCacheEntry>(initial);
  const [state, setState] = useState(() => ({ ...entry.current, loading: !entry.current.linked, readingEarlier: false, error: '', notice: '' }));
  const active = useRef(running); active.current = running;
  const previousRunning = useRef(running);
  const request = useRef<((older?: boolean) => Promise<void>) | null>(null);
  const queryRef = useRef(query); queryRef.current = query;
  useEffect(() => {
    let disposed = false, busy = false, queuedOlder = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const publish = (patch = {}) => {
      saveActivityEntry(key, entry.current);
      if (!disposed) setState(s => ({ ...s, ...entry.current, ...patch }));
    };
    const load = async (older = false) => {
      if (disposed || document.visibilityState !== 'visible') return;
      if (busy) { queuedOlder ||= older; return; }
      const item = entry.current;
      if (older && item.before == null) return;
      clearTimeout(timer); busy = true;
      publish({ readingEarlier: older, error: '' });
      let soon = false;
      try {
        const q: WorkflowOutputQuery = { ...queryRef.current };
        if (item.linked) {
          q.expectedAgent = item.agentId; q.fileId = item.fileId;
          if (older) q.before = item.before!;
          else { q.after = item.after; q.cursor = item.cursor; }
        }
        const data = await api.getWorkflowOutput(sessionId, q, controller.signal);
        if (disposed) return;
        if (!data.ok) {
          if (data.reason === 'reset') {
            entry.current = newActivityEntry();
            publish({ loading: true, notice: data.error }); soon = true; return;
          }
          throw new Error(data.error);
        }
        const firstPage = !item.linked;
        mergeActivityPage(item, data, older);
        // Native logs contain whole pages of provider bookkeeping/thinking.
        // Continue the requested history read until there is public activity.
        if ((older || firstPage || !item.entries.length) && !data.entries.length && item.before != null) queuedOlder = true;
        publish({ loading: false });
        soon = !older && data.moreAfter;
      } catch (err) {
        if (!disposed) publish({ error: err instanceof Error ? err.message : String(err), loading: false });
      } finally {
        busy = false;
        if (!disposed) {
          publish({ readingEarlier: false });
          if (queuedOlder) { queuedOlder = false; timer = setTimeout(() => void load(true), 150); }
          else if (soon || active.current || !entry.current.linked) timer = setTimeout(() => void load(), soon ? 150 : 5000);
        }
      }
    };
    request.current = load;
    const wake = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', wake);
    // Reopen instantly from cache, then check the cursor (no tail refetch).
    void load();
    return () => {
      disposed = true; controller.abort(); clearTimeout(timer); request.current = null;
      document.removeEventListener('visibilitychange', wake); saveActivityEntry(key, entry.current);
    };
  }, [sessionId, key]);
  useEffect(() => {
    if (previousRunning.current !== running) { previousRunning.current = running; void request.current?.(); }
  }, [running]);
  return { ...state, view: entry.current.view, loadEarlier: () => request.current?.(true), refresh: () => request.current?.(false) };
}
