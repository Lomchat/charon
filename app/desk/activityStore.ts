'use client';
// What each session is doing right now, for the panels (the board keeps its
// own copy for the effects). Fed by Desk.tsx from the LOW `session_activity`
// frames and the snapshot GET; only the components showing ONE session
// subscribe, so a busy fleet re-renders a panel, never the page.
import { useSyncExternalStore } from 'react';
import type { SessionActivity } from '@/lib/sessionActivity';

const current = new Map<string, SessionActivity>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const l of listeners) l();
}

export function putActivity(id: string, activity: SessionActivity): void {
  if (activity.beat === 'stop') current.delete(id);
  else {
    // One-shot beats (prompt, peer…) carry the turn's counters but are not a
    // state: keep what the session was doing, refresh the counters.
    const before = current.get(id);
    const state = activity.beat === 'tool' || activity.beat === 'think' || activity.beat === 'say' || activity.beat === 'compact';
    if (state) current.set(id, activity);
    else if (before) current.set(id, { ...before, turnStartedAt: activity.turnStartedAt, turnTools: activity.turnTools });
    else return;
  }
  publish();
}

/** The snapshot: it is the truth for every session at once. */
export function replaceActivities(all: Record<string, SessionActivity>): void {
  current.clear();
  for (const [id, a] of Object.entries(all)) current.set(id, a);
  publish();
}

export function dropActivity(id: string): void {
  if (current.delete(id)) publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActivity(id: string | null | undefined): SessionActivity | null {
  return useSyncExternalStore(subscribe, () => (id ? current.get(id) ?? null : null), () => null);
}
