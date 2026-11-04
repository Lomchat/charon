'use client';
import { useEffect, useSyncExternalStore } from 'react';
import type { AccountsResponse, ProviderAccount } from '@/lib/providerAccounts';
import type { AccountUsage } from '@/lib/server/hub/types';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import { api } from '@/lib/api';
import { subscribeAll } from './globalEventStream';
import { createRerunner } from './sync/revResource';
import { newestAccountUsage } from './accountUsageState';

// Hub-owned provider accounts (§14.115), one store per tab: the list from
// GET /api/accounts, refetched on `account_profiles_changed`, gauges kept live
// from `account_usage` frames (the engine fans one per VPS — same reading).

type Snapshot = { loaded: boolean; data: AccountsResponse };
const EMPTY: AccountsResponse = { accounts: [], usage: {}, migration: { waiting: 0, unmatched: 0 } };
let snapshot: Snapshot = { loaded: false, data: EMPTY };
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: Snapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

const rerunner = createRerunner(async () => {
  try {
    const data = await api.listAccounts();
    // A live reading may be newer than the one this GET saw.
    const usage: AccountsResponse['usage'] = {};
    for (const a of data.accounts) {
      const live = snapshot.data.usage[a.id];
      const got = data.usage[a.id];
      usage[a.id] = live && got ? newestAccountUsage(live, got) : got ?? live ?? null;
    }
    publish({ loaded: true, data: { ...data, usage } });
  } catch {
    publish({ ...snapshot, loaded: true });
  }
});

export function refreshAccounts(): Promise<void> {
  return rerunner.trigger();
}

function ingestUsage(u: AccountUsage): void {
  const id = u.accountProfile;
  if (!id || !snapshot.data.accounts.some((a) => a.id === id)) return;
  const current = snapshot.data.usage[id];
  const next = current ? newestAccountUsage(current, u) : u;
  if (next === current) return;
  publish({ ...snapshot, data: { ...snapshot.data, usage: { ...snapshot.data.usage, [id]: next } } });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribe) {
    unsubscribe = subscribeAll((event) => {
      if (event.type === 'account_profiles_changed') void refreshAccounts();
      else if (event.type === 'account_usage') ingestUsage(event as unknown as AccountUsage);
    });
    void refreshAccounts();
  }
  if (!timer) timer = setInterval(() => { if (!document.hidden) void refreshAccounts(); }, 60_000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.(); unsubscribe = null;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

export function useAccounts(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function useProviderAccounts(provider?: SessionProvider): ProviderAccount[] {
  const { data } = useAccounts();
  return provider ? data.accounts.filter((a) => a.provider === provider) : data.accounts;
}

/** Keep the store warm while mounted (e.g. HubPanel), so modals open filled. */
export function useAccountsWarm(): void {
  useEffect(() => subscribe(() => {}), []);
}
