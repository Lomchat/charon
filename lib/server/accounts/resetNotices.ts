import 'server-only';
import { getSetting, setSetting } from '@/lib/server/hub/settings';
import { emitGlobalAccountProfiles } from '@/lib/server/agent/sessionOps';
import { resetNoticeExpiry } from '@/lib/resetNotices';

/** The calendar's acknowledged "a banked reset ends soon" notices (§14.126):
 *  ONE hub list, so an OK clears the notice in every browser. A key is kept
 *  only until the expiry it names. */

const MAX_KEYS = 200;
const MAX_KEY_LEN = 300;

function live(keys: unknown[], now: number): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY_LEN) continue;
    const at = resetNoticeExpiry(k);
    if (Number.isFinite(at) && at > now) out.add(k);
  }
  return [...out].slice(-MAX_KEYS);
}

export function seenResetNotices(now = Date.now()): string[] {
  const raw = getSetting('accounts.reset_notices_seen');
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? live(v, now) : [];
  } catch { return []; }
}

/** Persist, then tell every browser (they refetch the account list). */
export function markResetNoticesSeen(keys: string[], now = Date.now()): string[] {
  const next = live([...seenResetNotices(now), ...keys], now);
  setSetting('accounts.reset_notices_seen', JSON.stringify(next));
  try { emitGlobalAccountProfiles('global'); } catch { /* bus is best-effort */ }
  return next;
}
