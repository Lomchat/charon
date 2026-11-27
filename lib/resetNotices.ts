// The calendar's notice "a banked reset ends soon" (§14.126), shared by the
// hub (its acknowledgements) and the browser (what it shows).

/** A banked reset ending within this window lights the calendar's dot. */
export const RESET_NOTICE_WINDOW_MS = 48 * 3_600_000;

/** One notice per grant AND expiry (a re-dated grant asks again). The expiry
 *  leads: it alone tells the hub when an acknowledgement can be forgotten. */
export function resetNoticeKey(accountId: string, grantId: string, expiresAt: string): string {
  return `${expiresAt}|${accountId}|${grantId}`;
}

/** The expiry a key carries, NaN when it carries none. */
export function resetNoticeExpiry(key: string): number {
  const bar = key.indexOf('|');
  return bar > 0 ? Date.parse(key.slice(0, bar)) : NaN;
}
