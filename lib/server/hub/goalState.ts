// The hub's copy of a session's goal (lib/sessionGoal.ts, CLAUDE.md §14.119):
// the agent's latest `goal` event, persisted on the session row so it survives
// hub restarts and reaches every tab through the session summary.
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { goalFromWire, parseSessionGoal, type SessionGoal, type WireSessionGoal } from '@/lib/sessionGoal';

export function readGoal(sessionId: string): SessionGoal | null {
  const row = db.select({ json: agentSessions.goalJson }).from(agentSessions)
    .where(eq(agentSessions.id, sessionId)).get();
  return parseSessionGoal(row?.json);
}

/** Store the goal an agent reported. True (the caller marks the summary
 *  dirty) only when what a surface shows changed. A Claude goal the agent
 *  reports met/failed keeps showing until the user dismisses it or sets a
 *  new one; `null` from the provider (cleared) removes it. */
export function recordGoal(sessionId: string, raw: WireSessionGoal | null | undefined, atMs: number): boolean {
  const next = goalFromWire(raw);
  const prev = readGoal(sessionId);
  if (next && next.setAt == null) next.setAt = prev?.objective === next.objective ? prev.setAt : atMs;
  if (next && next.updatedAt == null) next.updatedAt = atMs;
  // The same goal re-reported (each start re-reads the transcript) stays
  // dismissed if the user closed it.
  if (prev?.dismissed && next && next.objective === prev.objective && next.status === prev.status
      && next.setAt === prev.setAt) return false;
  if (JSON.stringify(prev) === JSON.stringify(next)) return false;
  db.update(agentSessions).set({ goalJson: next ? JSON.stringify(next) : null })
    .where(eq(agentSessions.id, sessionId)).run();
  return true;
}

/** The user closed a reached / impossible goal from its bar. */
export function dismissGoal(sessionId: string): boolean {
  const prev = readGoal(sessionId);
  if (!prev || prev.dismissed) return false;
  db.update(agentSessions).set({ goalJson: JSON.stringify({ ...prev, dismissed: true }) })
    .where(eq(agentSessions.id, sessionId)).run();
  return true;
}
