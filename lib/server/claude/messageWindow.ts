import 'server-only';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import type { ClaudeSessionMessage } from '@/lib/db/schema';
import { chronologicalKeys } from './messageOrder';

// Side-channel roles: loaded as attachments of the chat window, never counted
// against the pagination limit (CLAUDE.md §14.25).
export const NON_PAGINATED_ROLES: string[] = ['edit_snapshot', 'event'];

// ── Chronological pagination (Codex 18.1) ───────────────────────────────────
// Pages are slices of ONE global chronological order — not id-slices sorted
// after the fact. The distinction matters for crash-REPAIRED rows (inserted
// late → high id, but carrying the seq of the moment they belong to): an
// id-based `ORDER BY id DESC LIMIT n` would pull a repaired old row into the
// NEWEST page and leave a hole where it belongs; sorting that page locally
// can't fix a wrong selection, and prepending older pages client-side would
// strand it (sessionCache.extendWithOlder concatenates — which stays correct
// exactly BECAUSE pages are consecutive slices of the same global order).
//
// Mechanics: load a cheap SKELETON of the whole session (id, seq, role —
// no content), compute the chronological key (authentic seq, else a
// monotonic watermark of the last seq seen in id order — same rule as
// messageOrder.orderChronologically, user/legacy rows stay anchored), sort,
// slice, then fetch the full rows for just the window. The `before` cursor
// stays an id for API compatibility — it is resolved POSITIONALLY in the
// chronological chat order, so consecutive pages tile exactly.
export function loadMessageWindow(
  sessionId: string,
  limit: number,
  before: number | null,
): { messages: ClaudeSessionMessage[]; hasMore: boolean; oldestChatId: number | null } {
  const skel = db.select({
    id: claudeSessionMessages.id,
    seq: claudeSessionMessages.seq,
    role: claudeSessionMessages.role,
  }).from(claudeSessionMessages)
    .where(eq(claudeSessionMessages.sessionId, sessionId))
    .orderBy(asc(claudeSessionMessages.id))
    .all();
  if (skel.length === 0) return { messages: [], hasMore: false, oldestChatId: null };

  // Single source of the chronological key (messageOrder.chronologicalKeys —
  // Codex 20.3: one definition shared with the display sort, no drift).
  const ck = chronologicalKeys(skel); // skel is id-ascending
  const ordered = [...skel].sort((a, b) => (ck.get(a.id)! - ck.get(b.id)!) || (a.id - b.id));
  const chat = ordered.filter((r) => !NON_PAGINATED_ROLES.includes(r.role));

  // Cursor: position of the `before` id in chronological chat order (the id
  // the client got as oldestChatId). Fallback for a vanished row: id compare.
  let end = chat.length;
  if (before != null) {
    const idx = chat.findIndex((r) => r.id === before);
    end = idx >= 0 ? idx : chat.filter((r) => r.id < before).length;
  }
  const start = Math.max(0, end - limit);
  const windowChat = chat.slice(start, end);
  const hasMore = start > 0;
  if (windowChat.length === 0) {
    // Side-channel-only session (Codex 22.1): no chat rows at all, but the
    // skeleton isn't empty — imports, legacy fragments, or a lone persisted
    // replay_gap marker. Without this fallback those rows were unreachable
    // ("every attachment belongs to exactly one page" implicitly assumed a
    // chat row existed). Return the NEWEST `limit` side-channel rows,
    // bounded like any page (edit_snapshot content is stripped by the route
    // anyway); no cursor — a deeper archaeology of a chat-less session can
    // go through /export.
    if (chat.length === 0 && before == null && ordered.length > 0) {
      const tailRows = ordered.slice(Math.max(0, ordered.length - limit));
      const tailWanted = new Set(tailRows.map((r) => r.id));
      let tMin = tailRows[0].id, tMax = tailRows[0].id;
      for (const r of tailRows) { if (r.id < tMin) tMin = r.id; if (r.id > tMax) tMax = r.id; }
      const tailFull = db.select().from(claudeSessionMessages)
        .where(and(
          eq(claudeSessionMessages.sessionId, sessionId),
          gte(claudeSessionMessages.id, tMin),
          lte(claudeSessionMessages.id, tMax),
        ))
        .all()
        .filter((m) => tailWanted.has(m.id));
      const tailPos = new Map(tailRows.map((r, i) => [r.id, i] as const));
      tailFull.sort((a, b) => tailPos.get(a.id)! - tailPos.get(b.id)!);
      return { messages: tailFull, hasMore: ordered.length > limit, oldestChatId: null };
    }
    return { messages: [], hasMore: false, oldestChatId: null };
  }

  // Attachment ownership = half-open PARTITION of the whole `ordered` array
  // (Codex 20.1: an attachment sitting exactly between two pages' boundary
  // chat rows belonged to NEITHER page — closed bounds ended the old page at
  // its last chat and started the new one at its first chat, skipping what
  // sat in between). Rule: each chat row owns the attachments that follow it
  // up to the next chat row; the oldest page additionally owns the leading
  // attachments (lo=0), the newest page the trailing ones (hi=length). Every
  // attachment belongs to EXACTLY one page — full-history concatenation is
  // loss-free and duplicate-free.
  const posInOrdered = new Map(ordered.map((r, i) => [r.id, i] as const));
  const lo = start > 0 ? posInOrdered.get(windowChat[0].id)! : 0;
  const hi = end < chat.length ? posInOrdered.get(chat[end].id)! : ordered.length;
  const windowRows = ordered.slice(lo, hi);
  const wanted = new Set(windowRows.map((r) => r.id));
  let minId = windowRows[0].id;
  let maxId = windowRows[0].id;
  for (const r of windowRows) {
    if (r.id < minId) minId = r.id;
    if (r.id > maxId) maxId = r.id;
  }
  // Full rows via id-range + Set filter (avoids a >999-param IN clause).
  const full = db.select().from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      gte(claudeSessionMessages.id, minId),
      lte(claudeSessionMessages.id, maxId),
    ))
    .all()
    .filter((m) => wanted.has(m.id));
  const pos = new Map(windowRows.map((r, i) => [r.id, i] as const));
  full.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  return { messages: full, hasMore, oldestChatId: windowChat[0].id };
}
