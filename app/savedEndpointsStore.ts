'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { supportsCustomEndpoint, type CustomEndpoint } from '@/lib/customEndpoints';
import type { AgentKind } from '@/lib/types/api';
import { createRerunner } from './sync/revResource';

// The hub's saved custom endpoints, shared by every launcher. A session born on
// one needs no provider account (§14.115), so "not signed in" stops blocking a
// backend the moment one exists (`vpsHealth § backendAvailability`).
let endpoints: CustomEndpoint[] = [];
let started = false;
const NONE: CustomEndpoint[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

// One GET at a time; a failed one keeps the last good list.
const rerunner = createRerunner(async () => {
  endpoints = (await api.listCustomEndpoints()).endpoints;
  notify();
});

export function refreshSavedEndpoints(): Promise<void> {
  started = true;
  return rerunner.trigger();
}

/** Settings already holds a fresh list after each save/delete. */
export function publishSavedEndpoints(list: CustomEndpoint[]): void {
  started = true;
  endpoints = list;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) void refreshSavedEndpoints();
  return () => { listeners.delete(listener); };
}

/** Saved endpoints a `kind` session can be born on (none for an engine
 *  without endpoint support). `fresh` re-reads them on mount. */
export function useSavedEndpoints(kind?: AgentKind, fresh = false): CustomEndpoint[] {
  const all = useSyncExternalStore(subscribe, () => endpoints, () => NONE);
  useEffect(() => { if (fresh) void refreshSavedEndpoints(); }, [fresh]);
  return kind && !supportsCustomEndpoint(kind) ? NONE : all;
}

/** At least one saved endpoint to fall back on (`backendAvailability`
 *  still checks the engine supports endpoints). */
export function useHasSavedEndpoints(): boolean {
  return useSyncExternalStore(subscribe, () => endpoints.length > 0, () => false);
}
