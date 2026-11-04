import type { AccountUsage } from '@/lib/server/hub/types';

/** When the newest number on a snapshot was read: a live window update
 *  (`windowsAt`) outdates a poll with the same `fetchedAt`. §14.72. */
export function accountUsageReadAt(u: AccountUsage): number {
  return Math.max(u.fetchedAt, u.windowsAt ?? 0);
}

/** HTTP hydration can finish after a newer SSE update for the same account. */
export function newestAccountUsage(current: AccountUsage | undefined, incoming: AccountUsage): AccountUsage {
  if (incoming.accountKey !== undefined && current?.accountKey !== incoming.accountKey) return incoming;
  // Same login on both sides: an `account_changed` marker says nothing about
  // this account's numbers, so it never outranks (nor survives) a real reading.
  if (current?.ok && isAccountChangedMarker(incoming)) return current;
  if (incoming.ok && current && isAccountChangedMarker(current)) return incoming;
  return current && accountUsageReadAt(current) > accountUsageReadAt(incoming) ? current : incoming;
}

function isAccountChangedMarker(u: AccountUsage): boolean {
  return !u.ok && u.error === 'account_changed';
}
