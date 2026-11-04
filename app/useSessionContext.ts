'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  insightSnapshotRequestState,
  keepRecordedUsage,
  RECORDED_PENDING_RETRY_MS,
  recordedPendingRetry,
  type SessionContextUsage,
} from './sessionInsightState';

type Snapshot = {
  sessionId: string;
  context: SessionContextUsage | null;
  loaded: boolean;
  loading: boolean;
};

const FOCUS_REFRESH_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;

type Inflight = { promise: Promise<void>; controller: AbortController };

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
  const inflight = useRef<Inflight | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const lastStartedAt = useRef(0);
  const forceAfterInflight = useRef(false);
  // The one `recordedPending` re-request of the current pending streak is spent.
  const recordedRetried = useRef(false);
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  const load = useCallback((force = false): Promise<void> => {
    if (inflight.current) {
      // A turn may finish while the cold snapshot is still loading. Remember
      // the explicit refresh instead of creating a second request burst.
      if (force) forceAfterInflight.current = true;
      return inflight.current.promise;
    }
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    lastStartedAt.current = Date.now();
    setSnapshot((current) => current.sessionId === sessionId
      ? { ...current, loading: true }
      : { sessionId, context: null, loaded: false, loading: true });

    const promise = (async () => {
      let context: SessionContextUsage | null;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('context request timed out', 'TimeoutError'));
      }, REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/context${force ? '?force=1' : ''}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        const body = await response.json().catch(() => null);
        context = response.ok
          ? body
          : { ok: false, error: body?.error || `context request failed (${response.status})` };
      } catch (error) {
        if (generation.current !== currentGeneration || (controller.signal.aborted && !timedOut)) return;
        context = {
          ok: false,
          error: timedOut
            ? 'context details took too long to load; the chat remains available'
            : String((error as Error)?.message || error),
        };
      } finally {
        clearTimeout(timeout);
      }
      if (generation.current !== currentGeneration) return;
      const requestState = insightSnapshotRequestState(context);
      if (requestState.waiting) {
        // Keep a previous good gauge on screen. On a cold mount retain the
        // loading envelope only as diagnostic state; `loaded:false` keeps the
        // UI's honest loading presentation.
        setSnapshot((current) => current.sessionId === sessionId
          ? {
            ...current,
            context: current.loaded ? current.context : context,
            loading: true,
          }
          : { sessionId, context, loaded: false, loading: true });
      } else {
        // A recorded figure re-warming hub-side keeps the last one shown.
        setSnapshot((current) => ({
          sessionId,
          context: keepRecordedUsage(current.sessionId === sessionId ? current.context : null, context),
          loaded: true,
          loading: requestState.refreshing,
        }));
      }

      const recordedRetry = recordedPendingRetry(context, recordedRetried.current, requestState.shouldRetry);
      recordedRetried.current = recordedRetry.retried;
      if (requestState.shouldRetry) {
        const attempt = ++retryAttempt.current;
        const backoff = Math.min(10_000, 500 * (2 ** Math.min(5, attempt)));
        const delay = Math.max(requestState.retryAfterMs, backoff);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          void loadRef.current(false);
        }, delay);
      } else {
        retryAttempt.current = 0;
        // The hub's recorded-usage fold was still warming: ask once more.
        if (recordedRetry.retry) {
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            void loadRef.current(false);
          }, RECORDED_PENDING_RETRY_MS);
        }
      }
    })().finally(() => {
      if (inflight.current?.controller === controller) inflight.current = null;
      if (generation.current === currentGeneration && forceAfterInflight.current) {
        forceAfterInflight.current = false;
        if (retryTimer.current) {
          clearTimeout(retryTimer.current);
          retryTimer.current = null;
        }
        queueMicrotask(() => { void loadRef.current(true); });
      }
    });
    inflight.current = { promise, controller };
    return promise;
  }, [sessionId]);
  loadRef.current = load;

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    retryAttempt.current = 0;
    forceAfterInflight.current = false;
    recordedRetried.current = false;
    void load(false);
    return () => {
      generation.current += 1;
      forceAfterInflight.current = false;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      const active = inflight.current;
      inflight.current = null;
      active?.controller.abort(new DOMException('context view changed', 'AbortError'));
    };
  }, [load]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (inflight.current || retryTimer.current) return;
      if (Date.now() - lastStartedAt.current < FOCUS_REFRESH_AFTER_MS) return;
      void load(false);
    };
    window.addEventListener('focus', refreshOnReturn);
    return () => window.removeEventListener('focus', refreshOnReturn);
  }, [load]);

  const current = snapshot.sessionId === sessionId;
  return {
    context: current ? snapshot.context : null,
    loaded: current ? snapshot.loaded : false,
    loading: current ? snapshot.loading : true,
    refresh,
  };
}
