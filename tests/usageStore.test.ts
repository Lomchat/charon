import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountUsage } from '@/lib/server/hub/types';
import {
  accountScopedUsageKey, dropOtherLoginUsage, getUsageSnapshot, ingestUsageFrame, putUsage, readUsage,
  resetUsageStoreForTests, subscribeUsage, usageKeyOf,
} from '@/app/usageStore';

// The browser's account-usage store (app/usageStore.ts, CLAUDE.md §14.115):
// a hub account's reading lives under the ACCOUNT, a legacy one per VPS, and
// a reading that changes nothing publishes nothing (no re-render).

const ACCT = 'aaaaaaaaaaaaaaaa';
const hub = (extra: Partial<AccountUsage> = {}): AccountUsage => ({
  ok: true, fetchedAt: 10, provider: 'claude', accountProfile: ACCT, accountKey: 'K', scope: 'account', ...extra,
});
const legacy = (extra: Partial<AccountUsage> = {}): AccountUsage => ({
  ok: true, fetchedAt: 10, provider: 'codex', accountProfile: 'default', accountKey: 'L', ...extra,
});

beforeEach(() => { resetUsageStoreForTests(); });

describe('usage store keys', () => {
  it('a hub account reading is keyed by the account, whatever VPS carried it', () => {
    expect(usageKeyOf('v1', hub())).toBe(accountScopedUsageKey('claude', ACCT));
    expect(usageKeyOf(null, hub())).toBe(accountScopedUsageKey('claude', ACCT));
  });

  it('a legacy reading is keyed per VPS, and needs one', () => {
    expect(usageKeyOf('v1', legacy())).toBe('v1:codex:default');
    expect(usageKeyOf(null, legacy())).toBeNull();
  });

  it('the lookup prefers the account, then the VPS key', () => {
    const a = hub();
    const v = legacy();
    const map = { [accountScopedUsageKey('claude', ACCT)]: a, 'v1:codex:default': v };
    expect(readUsage(map, 'v9', 'claude', ACCT)).toBe(a);
    expect(readUsage(map, 'v1', 'codex', 'default')).toBe(v);
    expect(readUsage(map, 'v2', 'codex', 'default')).toBeNull();
  });
});

describe('usage store publishing', () => {
  it('publishes a new reading once; the same reading again, or an older one, publishes nothing', () => {
    let publishes = 0;
    const unsub = subscribeUsage(() => { publishes++; });
    putUsage('v1', hub({ fetchedAt: 20 }));
    expect(publishes).toBe(1);
    putUsage('v2', hub({ fetchedAt: 20 })); // same reading, another VPS asked
    expect(publishes).toBe(1);
    putUsage(null, hub({ fetchedAt: 5 })); // older
    expect(publishes).toBe(1);
    putUsage(null, hub({ fetchedAt: 30 }));
    expect(publishes).toBe(2);
    expect(readUsage(getUsageSnapshot(), 'any-vps', 'claude', ACCT)?.fetchedAt).toBe(30);
    unsub();
  });

  it('an SSE frame drops its envelope and lands under its scope', () => {
    ingestUsageFrame({ ...hub({ fetchedAt: 40 }), type: 'account_usage', sessionId: 'accounts' } as AccountUsage & { sessionId: string });
    ingestUsageFrame({ ...legacy({ fetchedAt: 41 }), type: 'account_usage', sessionId: 'v1' } as AccountUsage & { sessionId: string });
    const map = getUsageSnapshot();
    expect(Object.keys(map).sort()).toEqual([accountScopedUsageKey('claude', ACCT), 'v1:codex:default']);
    expect(map[accountScopedUsageKey('claude', ACCT)]).not.toHaveProperty('sessionId');
    expect(map[accountScopedUsageKey('claude', ACCT)]).not.toHaveProperty('type');
  });

  it('drops only gauges stamped with ANOTHER login', () => {
    putUsage('v1', legacy({ accountKey: 'OLD' }));
    dropOtherLoginUsage('v1', 'codex', 'default', 'OLD');
    expect(Object.keys(getUsageSnapshot())).toEqual(['v1:codex:default']);
    dropOtherLoginUsage('v1', 'codex', 'default', 'NEW');
    expect(getUsageSnapshot()).toEqual({});
  });
});
