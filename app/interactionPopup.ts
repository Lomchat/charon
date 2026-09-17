// What the cross-session interaction popup should show, and in what order.
//
// The popup exists for interactions you would otherwise miss: a session that
// is NOT the one on your screen has stopped and is waiting on you. Two rules
// follow from that, and both used to be wrong.
//
//   - It must leave the focused session alone. That session already renders
//     its pending interaction inline, in the composer slot — pinned to the
//     bottom of the view, never scrolled away, and strictly richer than the
//     popup (a tool-input summary, a longer preview). Showing the popup too
//     put the same request on screen twice, the worse copy on top.
//
//   - It must cover questions and exit plans, not just permissions. The hub
//     surfaces all three identically — broadcast, web push
//     (`NOTIFICATION_EVENTS` has `permission`, `question` and `plan`) and
//     Telegram — but the popup only ever read the permission queue. A
//     question on a background session was left to the sidebar lock and the
//     tab dot, which is no signal at all when push is unavailable.
//
// Not everything can be answered from a popup, though. A permission is a tool
// name and a short input preview, which fits. A question can carry several
// prompts with long option lists, and a plan runs to pages — rendering either
// in a corner card means truncating the thing you need to read before you can
// answer. Those get identified and a way in; the answering happens in the
// session, where the real card lives.

export type PopupKind = 'permission' | 'question' | 'exit_plan';

/** Only the fields the popup needs, so the policy stays testable. */
export type PermissionLike = {
  id: string; sessionId: string; tool: string; createdAt: number; expiresAt?: number;
};
export type QuestionLike = {
  id: string; sessionId: string; createdAt: number; expiresAt?: number;
  questions?: ReadonlyArray<{ question?: string }>;
};
export type ExitPlanLike = {
  id: string; sessionId: string; createdAt: number; expiresAt?: number;
};

export type PopupItem = {
  kind: PopupKind;
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
  /** One line identifying what is being asked. */
  label: string;
  /**
   * Whether this can be resolved from the popup. Permissions can; anything
   * whose content does not survive truncation cannot, and offers the session
   * instead.
   */
  answerable: boolean;
};

/** First non-empty question text, which is what the push body uses too. */
function questionLabel(q: QuestionLike): string {
  const first = q.questions?.find((entry) => entry?.question?.trim());
  return first?.question?.trim() || 'question awaiting your reply';
}

/**
 * The popup's queue: every pending interaction that is NOT the focused
 * session's, oldest first.
 *
 * Oldest first because these expire — the one that has been waiting longest is
 * the one closest to being auto-denied, so it is the one worth your attention.
 * `id` breaks ties so the order cannot flicker between renders when two
 * interactions share a timestamp.
 */
export function buildInteractionPopupQueue(input: {
  perms: readonly PermissionLike[];
  questions: readonly QuestionLike[];
  exitPlans: readonly ExitPlanLike[];
  /** The session whose cards are already pinned in the composer slot. */
  currentSessionId: string | null;
}): PopupItem[] {
  const items: PopupItem[] = [];
  for (const p of input.perms) {
    items.push({
      kind: 'permission', id: p.id, sessionId: p.sessionId,
      createdAt: p.createdAt, expiresAt: p.expiresAt,
      label: p.tool, answerable: true,
    });
  }
  for (const q of input.questions) {
    items.push({
      kind: 'question', id: q.id, sessionId: q.sessionId,
      createdAt: q.createdAt, expiresAt: q.expiresAt,
      label: questionLabel(q), answerable: false,
    });
  }
  for (const e of input.exitPlans) {
    items.push({
      kind: 'exit_plan', id: e.id, sessionId: e.sessionId,
      createdAt: e.createdAt, expiresAt: e.expiresAt,
      label: 'plan ready for approval', answerable: false,
    });
  }
  return items
    .filter((item) => item.sessionId !== input.currentSessionId)
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
