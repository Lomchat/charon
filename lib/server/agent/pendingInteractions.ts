import 'server-only';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';

/**
 * Repairs pending rows whose provider deadline passed while the hub was down
 * or while an older agent (which cannot emit interaction_resolved) was live.
 * The providers already deny/cancel at these deadlines; this only keeps the
 * durable UI projection honest.
 */
export function expireStalePendingInteractions(
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  db.update(claudePendingPermissions)
    .set({ status: 'expired', respondedAt: nowSeconds })
    .where(and(
      eq(claudePendingPermissions.status, 'pending'),
      isNotNull(claudePendingPermissions.expiresAt),
      lte(claudePendingPermissions.expiresAt, nowSeconds),
    )).run();
  db.update(claudePendingQuestions)
    .set({ status: 'expired', respondedAt: nowSeconds })
    .where(and(
      eq(claudePendingQuestions.status, 'pending'),
      isNotNull(claudePendingQuestions.expiresAt),
      lte(claudePendingQuestions.expiresAt, nowSeconds),
    )).run();
}
