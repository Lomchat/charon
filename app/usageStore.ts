'use client';
import { useEffect, useSyncExternalStore } from 'react';
import type { AccountUsage } from '@/lib/server/hub/types';
import { asSessionProvider, type SessionProvider } from '@/lib/sessionCapabilities';
import { DEFAULT_ACCOUNT_PROFILE, profileUsageKey } from '@/lib/accountProfiles';
import { subscribeAll } from './globalEventStream';
import { newestAccountUsage } from './accountUsageState';

// The account-usage gauges, ONE store per tab (§14.58/§14.72/§14.115). Only
// the surfaces DRAWING a gauge subscribe (`useUsage`, `useUsageMap`): a reading
// re-renders those few components, never the hub root — held in HubPanel
// state, every reading re-rendered the whole app, chat included.
//
// Keys: a hub account's reading (`scope:'account'`) lives under the ACCOUNT,
// whatever VPS asks for it; a legacy per-VPS reading under
// `profileUsageKey(vps, provider, profile)`. A lookup tries the account first.

export type UsageMap = Readonly<Record<string, AccountUsage>>;

const EMPTY: UsageMap = {};
let snapshot: UsageMap = EMPTY;
const listeners = new Set<() => void>();

function publish(next: UsageMap): void {
  snapshot = next;
  for (const l of listeners) l();
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getUsageSnapshot(): UsageMap {
  return snapshot;
}

export function accountScopedUsageKey(provider: SessionProvider, accountId: string): string {
  return `acct:${provider}:${accountId}`;
}

/** Where a reading is stored; null = a per-VPS reading with no VPS. */
export function usageKeyOf(vpsId: string | null | undefined, usage: AccountUsage): string | null {
  const provider = asSessionProvider(usage.provider);
  const profile = usage.accountProfile ?? DEFAULT_ACCOUNT_PROFILE;
  if (usage.scope === 'account') return accountScopedUsageKey(provider, profile);
  return vpsId ? profileUsageKey(vpsId, provider, profile) : null;
}

/** The gauges a (VPS, provider, profile) shows: its account's, else its own. */
export function readUsage(
  map: UsageMap, vpsId: string, provider: SessionProvider, profile = DEFAULT_ACCOUNT_PROFILE,
): AccountUsage | null {
  return map[accountScopedUsageKey(provider, profile)] ?? map[profileUsageKey(vpsId, provider, profile)] ?? null;
}

function sameUsage(a: AccountUsage, b: AccountUsage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fold a reading in (newest wins, §14.72). Nothing new ⇒ nothing published. */
export function putUsage(vpsId: string | null | undefined, usage: AccountUsage): void {
  const key = usageKeyOf(vpsId, usage);
  if (!key) return;
  const current = snapshot[key];
  const next = newestAccountUsage(current, usage);
  if (next === current || (current && sameUsage(current, next))) return;
  publish({ ...snapshot, [key]: next });
}

/** No snapshot for the current login: gauges stamped with ANOTHER login
 *  (changed while the hub was down) must not stay on screen. */
export function dropOtherLoginUsage(
  vpsId: string, provider: SessionProvider, profile: string, accountKey: string,
): void {
  let next: Record<string, AccountUsage> | null = null;
  for (const key of [accountScopedUsageKey(provider, profile), profileUsageKey(vpsId, provider, profile)]) {
    const held = snapshot[key]?.accountKey;
    if (!held || held === accountKey) continue;
    next ??= { ...snapshot };
    delete next[key];
  }
  if (next) publish(next);
}

/** An SSE frame: the reading plus `type`/`sessionId` (= vpsId, or `accounts`). */
export function ingestUsageFrame(ev: { sessionId?: string | null } & AccountUsage): void {
  const { type: _type, sessionId, ...usage } = ev as AccountUsage & { type?: string; sessionId?: string | null };
  putUsage(usage.scope === 'account' ? null : sessionId, usage);
}

/** Feed the store from the bus while mounted (HubPanel). Renders nothing. */
export function useUsageFeed(): void {
  useEffect(() => subscribeAll((ev) => {
    if (ev.type === 'account_usage') ingestUsageFrame(ev as unknown as AccountUsage & { sessionId?: string });
  }), []);
}

export function useUsageMap(): UsageMap {
  return useSyncExternalStore(subscribeUsage, getUsageSnapshot, () => EMPTY);
}

export function useUsage(
  vpsId: string | null | undefined, provider: SessionProvider, profile = DEFAULT_ACCOUNT_PROFILE,
): AccountUsage | null {
  return useSyncExternalStore(
    subscribeUsage,
    () => (vpsId ? readUsage(snapshot, vpsId, provider, profile) : null),
    () => null,
  );
}

/** Test seam. */
export function resetUsageStoreForTests(): void {
  snapshot = EMPTY;
  listeners.clear();
}
