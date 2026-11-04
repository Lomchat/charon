import 'server-only';
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { db, sessionPendingPermissions, sessionPendingQuestions } from '@/lib/db';

// Import-cycle-free on purpose (sessionOps imports this module): publishing
// lives in sessionOps (`publishInteractionResolved`, `sweepExpiredInteractions`).
// Everything here only writes the gate tables and RETURNS what it changed — a
// caller that removes a gate owes its `interaction_resolved` frame (G7).

/** A human gate as the wire names it (`interaction_resolved.kind`). */
export type GateKind = 'permission' | 'question' | 'exit_plan';
export type GateOutcome = 'answered' | 'denied' | 'expired' | 'cancelled';
export type GateRef = { kind: GateKind; id: string; sessionId: string };

/** `session_pending_questions.kind` → wire kind (an async question is a question). */
export function questionGateKind(kind: string): 'question' | 'exit_plan' {
  return kind === 'exit_plan' ? 'exit_plan' : 'question';
}

/** A resolved row's `status` → the outcome the live path publishes for it
 *  (a permission row stores `allowed`, its frame says `answered`). */
export function gateOutcome(status: string): GateOutcome {
  switch (status) {
    case 'allowed':
    case 'answered':
      return 'answered';
    case 'denied':
    case 'expired':
    case 'cancelled':
      return status;
    default:
      return 'cancelled';
  }
}

/**
 * Repairs pending rows whose provider deadline passed while the hub was down
 * or while an older agent (which cannot emit interaction_resolved) was live.
 * The providers already deny/cancel at these deadlines; this only keeps the
 * durable UI projection honest. Returns the rows it expired: the caller
 * publishes each (sessionOps § sweepExpiredInteractions). Async questions
 * carry no deadline, so they are never swept (§14.96).
 */
export function expireStalePendingInteractions(
  nowSeconds = Math.floor(Date.now() / 1000),
): GateRef[] {
  const perms = db.update(sessionPendingPermissions)
    .set({ status: 'expired', respondedAt: nowSeconds })
    .where(and(
      eq(sessionPendingPermissions.status, 'pending'),
      isNotNull(sessionPendingPermissions.expiresAt),
      lte(sessionPendingPermissions.expiresAt, nowSeconds),
    ))
    .returning({ id: sessionPendingPermissions.id, sessionId: sessionPendingPermissions.sessionId })
    .all();
  const questions = db.update(sessionPendingQuestions)
    .set({ status: 'expired', respondedAt: nowSeconds })
    .where(and(
      eq(sessionPendingQuestions.status, 'pending'),
      isNotNull(sessionPendingQuestions.expiresAt),
      lte(sessionPendingQuestions.expiresAt, nowSeconds),
    ))
    .returning({
      id: sessionPendingQuestions.id, sessionId: sessionPendingQuestions.sessionId,
      kind: sessionPendingQuestions.kind,
    })
    .all();
  return [
    ...perms.map((p) => ({ kind: 'permission' as const, id: p.id, sessionId: p.sessionId })),
    ...questions.map((q) => ({ kind: questionGateKind(q.kind), id: q.id, sessionId: q.sessionId })),
  ];
}

/**
 * Cancel the BLOCKING gates of a session that left the live states (sleep,
 * error, killed, force-stop): their provider future died with the worker, so
 * no answer can ever reach it. Async questions survive — answering one
 * resumes the session (§14.49/96). Returns the cancelled gates to publish.
 */
export function cancelBlockingGateRows(
  sessionId: string, nowSeconds = Math.floor(Date.now() / 1000),
): GateRef[] {
  return db.transaction(() => {
    const perms = db.update(sessionPendingPermissions)
      .set({ status: 'cancelled', respondedAt: nowSeconds })
      .where(and(
        eq(sessionPendingPermissions.sessionId, sessionId),
        eq(sessionPendingPermissions.status, 'pending'),
      ))
      .returning({ id: sessionPendingPermissions.id })
      .all();
    const questions = db.update(sessionPendingQuestions)
      .set({ status: 'cancelled', respondedAt: nowSeconds })
      .where(and(
        eq(sessionPendingQuestions.sessionId, sessionId),
        eq(sessionPendingQuestions.status, 'pending'),
        inArray(sessionPendingQuestions.kind, ['question', 'exit_plan']),
      ))
      .returning({ id: sessionPendingQuestions.id, kind: sessionPendingQuestions.kind })
      .all();
    return [
      ...perms.map((p) => ({ kind: 'permission' as const, id: p.id, sessionId })),
      ...questions.map((q) => ({ kind: questionGateKind(q.kind), id: q.id, sessionId })),
    ];
  });
}

/**
 * Cancel ONE still-pending BLOCKING gate of a session: its provider answered
 * `resolved:false` (no live future: the worker died without an event, or the
 * resolution was lost), so no answer can ever reach it. true iff THIS update
 * changed the row — a concurrent answer from another device keeps its own
 * outcome and is not re-announced. Async questions are never touched (§14.96).
 */
export function cancelPendingGateRow(
  kind: GateKind, id: string, sessionId: string, nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (kind === 'permission') {
    return db.update(sessionPendingPermissions)
      .set({ status: 'cancelled', respondedAt: nowSeconds })
      .where(and(
        eq(sessionPendingPermissions.id, id),
        eq(sessionPendingPermissions.sessionId, sessionId),
        eq(sessionPendingPermissions.status, 'pending'),
      )).run().changes > 0;
  }
  return db.update(sessionPendingQuestions)
    .set({ status: 'cancelled', respondedAt: nowSeconds })
    .where(and(
      eq(sessionPendingQuestions.id, id),
      eq(sessionPendingQuestions.sessionId, sessionId),
      eq(sessionPendingQuestions.status, 'pending'),
      eq(sessionPendingQuestions.kind, kind),
    )).run().changes > 0;
}

/**
 * Delete EVERY gate row of a session (archive, rollback, session delete) and
 * return the ones that were still PENDING; the caller publishes `cancelled`
 * for each after its transaction committed. Meant to run inside that
 * transaction (one SQLite connection: `db` inside `db.transaction` is in it).
 */
export function deleteSessionGates(sessionId: string): GateRef[] {
  const perms = db.select({ id: sessionPendingPermissions.id }).from(sessionPendingPermissions)
    .where(and(
      eq(sessionPendingPermissions.sessionId, sessionId),
      eq(sessionPendingPermissions.status, 'pending'),
    )).all();
  const questions = db.select({ id: sessionPendingQuestions.id, kind: sessionPendingQuestions.kind })
    .from(sessionPendingQuestions)
    .where(and(
      eq(sessionPendingQuestions.sessionId, sessionId),
      eq(sessionPendingQuestions.status, 'pending'),
    )).all();
  db.delete(sessionPendingPermissions).where(eq(sessionPendingPermissions.sessionId, sessionId)).run();
  db.delete(sessionPendingQuestions).where(eq(sessionPendingQuestions.sessionId, sessionId)).run();
  return [
    ...perms.map((p) => ({ kind: 'permission' as const, id: p.id, sessionId })),
    ...questions.map((q) => ({ kind: questionGateKind(q.kind), id: q.id, sessionId })),
  ];
}
