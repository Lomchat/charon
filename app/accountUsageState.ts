import type { AccountUsage } from '@/lib/server/claude/types';

/** HTTP hydration can finish after a newer SSE update for the same account. */
export function newestAccountUsage(current: AccountUsage | undefined, incoming: AccountUsage): AccountUsage {
  return current && current.fetchedAt > incoming.fetchedAt ? current : incoming;
}
