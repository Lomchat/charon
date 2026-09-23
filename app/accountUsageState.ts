import type { AccountUsage } from '@/lib/server/claude/types';

/** When the newest number on a snapshot was read: a live window update
 *  (`windowsAt`) outdates a poll with the same `fetchedAt`. §14.72. */
export function accountUsageReadAt(u: AccountUsage): number {
  return Math.max(u.fetchedAt, u.windowsAt ?? 0);
}

/** HTTP hydration can finish after a newer SSE update for the same account. */
export function newestAccountUsage(current: AccountUsage | undefined, incoming: AccountUsage): AccountUsage {
  return current && accountUsageReadAt(current) > accountUsageReadAt(incoming) ? current : incoming;
}
