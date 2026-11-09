// The sidebar's focus chips (Sidebar § cs-focus): list only what finished
// unread, what is running and/or what still has a warm prompt cache. They ADD
// up — several on admits any of their kinds — and no chip on admits
// everything. "Unread" is the cards' own ✓ or red ! (attention 'unread' |
// 'error', §14.47); "running" is the header nav's "Working": a working
// status, or a busy shell;
// "warm" is the card's flame (lib/promptCache.ts): the sessions worth
// answering before their cache expires.
import { attentionForRow, isUnseenFinish, rowStatus, shellAttention } from '@/lib/sessionAttention';
import { cacheReading, isCacheWarm } from '@/lib/promptCache';
import { isWorkingStatus } from './sessionUnread';
import type { SessionListItem } from '@/lib/types/api';

export type Focus = { unread: boolean; running: boolean; warm?: boolean };
export type FocusFacts = { unread: boolean; running: boolean; warm?: boolean };

type FocusShell = { id: string; unreadFinish?: boolean; liveStatus?: string | null; exited?: boolean };

/** `cacheNow` = the shared cache clock (PromptCacheMarks § useCacheTick);
 *  0 (server render) reads no cache as warm. */
export function sessionFocusFacts(s: SessionListItem, cacheNow = 0): FocusFacts {
  const status = rowStatus(s);
  return {
    // A finish that ended in an error is unread too (the red twin).
    unread: isUnseenFinish(attentionForRow(s)),
    running: isWorkingStatus(status),
    warm: cacheNow > 0 && isCacheWarm(cacheReading(s.promptCache, {
      now: cacheNow, busy: status === 'thinking' || status === 'starting',
      model: s.model ?? null, account: s.accountProfile,
    })),
  };
}

export function shellFocusFacts(sh: FocusShell): FocusFacts {
  return {
    unread: shellAttention(sh) === 'unread',
    running: !sh.exited && sh.liveStatus === 'busy',
  };
}

export function focusAdmits(focus: Focus, facts: FocusFacts): boolean {
  if (!focus.unread && !focus.running && !focus.warm) return true;
  return (focus.unread && facts.unread) || (focus.running && facts.running) || (!!focus.warm && !!facts.warm);
}

/** What the sidebar says when a focus is on and nothing matches. */
export function focusEmptyText(focus: Focus): string {
  const kinds = [focus.unread && 'unread', focus.running && 'running', focus.warm && 'with a warm cache']
    .filter((k): k is string => !!k);
  if (!kinds.length) return 'Nothing running.';
  return `Nothing ${kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`}.`;
}
