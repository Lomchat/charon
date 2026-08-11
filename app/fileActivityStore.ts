'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { subscribeAll } from './globalEventStream';
import type { FileActivityEntry } from '@/lib/types/api';

/**
 * Live "an agent is touching this file", per VPS (§14.88).
 *
 * Two inputs: a snapshot fetched when a tree mounts (so it isn't blind about
 * what happened before it existed) and the LOW_VOLUME `file_activity` event.
 * Entries expire on their own — this is a liveness light, not a record, and a
 * stale eye icon next to a file nobody has looked at in an hour is worse than
 * no icon.
 *
 * Keyed on the VPS rather than the session because the interesting case is the
 * OTHER agent: with several sessions on one machine, "who else is in this
 * file" is exactly what you cannot see today.
 */
export type Activity = Omit<FileActivityEntry, 'vpsId'>;

const TTL_MS: Record<Activity['kind'], number> = { read: 90_000, write: 300_000 };
/** The tree only ever needs a repaint at human speed. */
const SWEEP_MS = 20_000;

type Entry = {
  /** absolute path → the latest touch. */
  byPath: Map<string, Activity>;
  subs: Set<() => void>;
  /** Replaced (never mutated) so `useSyncExternalStore` sees a new identity. */
  snapshot: ReadonlyMap<string, Activity>;
  fetchedAt: number;
};

const EMPTY: ReadonlyMap<string, Activity> = new Map();
const g = globalThis as unknown as {
  __charonFileActivity?: Map<string, Entry>;
  __charonFileActivityArmed?: boolean;
  __charonFileActivitySweep?: ReturnType<typeof setInterval>;
};
const store = (g.__charonFileActivity ??= new Map<string, Entry>());

function entryFor(vpsId: string): Entry {
  let e = store.get(vpsId);
  if (!e) {
    e = { byPath: new Map(), subs: new Set(), snapshot: EMPTY, fetchedAt: 0 };
    store.set(vpsId, e);
  }
  return e;
}

function publish(e: Entry) {
  e.snapshot = new Map(e.byPath);
  for (const cb of e.subs) cb();
}

/** Drop what has aged out. Returns true when something actually changed. */
function sweep(e: Entry, now = Date.now()): boolean {
  let changed = false;
  for (const [path, a] of e.byPath) {
    if (now - a.at > TTL_MS[a.kind]) { e.byPath.delete(path); changed = true; }
  }
  return changed;
}

function note(vpsId: string, a: Activity) {
  const e = entryFor(vpsId);
  const prev = e.byPath.get(a.path);
  // A write outranks a read for the same instant: an agent reads a file just
  // before editing it, and "being edited" is the useful half.
  if (prev && prev.at > a.at) return;
  e.byPath.set(a.path, a);
  publish(e);
}

// One listener for the whole app: the event is LOW_VOLUME and carries the vps.
function arm() {
  if (g.__charonFileActivityArmed) return;
  g.__charonFileActivityArmed = true;
  subscribeAll((ev: Record<string, unknown>) => {
    if (ev?.type !== 'file_activity') return;
    const vpsId = String(ev.sessionId ?? '');
    const path = String(ev.path ?? '');
    if (!vpsId || !path) return;
    note(vpsId, {
      path,
      kind: ev.kind === 'write' ? 'write' : 'read',
      sessionId: String(ev.activitySessionId ?? ''),
      sessionName: (ev.sessionName as string | null) ?? null,
      at: Number(ev.at) || Date.now(),
    });
  });
  g.__charonFileActivitySweep = setInterval(() => {
    for (const e of store.values()) {
      if (e.subs.size === 0) continue;
      if (sweep(e)) publish(e);
    }
  }, SWEEP_MS);
}

/**
 * Live activity map for a VPS: absolute path → who is touching it.
 * Returns a stable empty map when there is nothing to watch.
 */
export function useFileActivity(vpsId: string | null | undefined): ReadonlyMap<string, Activity> {
  const sub = useCallback((cb: () => void) => {
    if (!vpsId) return () => {};
    arm();
    const e = entryFor(vpsId);
    e.subs.add(cb);
    return () => { e.subs.delete(cb); };
  }, [vpsId]);
  const snap = useCallback(
    () => (vpsId ? entryFor(vpsId).snapshot : EMPTY),
    [vpsId],
  );

  // The snapshot: what was already happening before this tree mounted.
  useEffect(() => {
    if (!vpsId) return;
    const e = entryFor(vpsId);
    if (Date.now() - e.fetchedAt < 30_000) return;
    e.fetchedAt = Date.now();
    let alive = true;
    void api.getFileActivity(vpsId).then((r) => {
      if (!alive) return;
      for (const a of r.activity ?? []) {
        const { vpsId: _v, ...rest } = a;
        const prev = e.byPath.get(rest.path);
        if (!prev || prev.at < rest.at) e.byPath.set(rest.path, rest);
      }
      sweep(e);
      publish(e);
    }).catch(() => { /* the tree simply shows no activity */ });
    return () => { alive = false; };
  }, [vpsId]);

  return useSyncExternalStore(sub, snap, () => EMPTY);
}

/** "read by Sidebar files · 12s ago" — the tooltip on the row's icon. */
export function activityLabel(a: Activity, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - a.at) / 1000));
  const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  const who = a.sessionName || 'a session';
  return `${a.kind === 'write' ? 'written' : 'read'} by ${who} · ${age}\nclick to open that session`;
}
