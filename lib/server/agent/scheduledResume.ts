import 'server-only';
import crypto from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import {
  db, claudeSessionMessages, claudeSessions, sessionScheduledResumes,
  type SessionScheduledResume,
} from '@/lib/db';
import {
  AUTO_RESUME_PROMPT, RESET_SAFETY_DELAY_MS, type ScheduledResumePayload,
} from '@/lib/scheduledResume';
import { getOrCreateStream } from './sessionOps';

const MAX_TIMER_MS = 2_147_000_000;
const RETRY_DELAYS_MS = [2, 5, 10, 20, 30].map((m) => m * 60_000);

const globalScheduler = globalThis as unknown as {
  _scheduledResumeArmed?: boolean;
  _scheduledResumeTimer?: ReturnType<typeof setTimeout> | null;
};

function payload(row: SessionScheduledResume): ScheduledResumePayload {
  return {
    type: 'scheduled_resume', scheduleId: row.id,
    status: row.status as ScheduledResumePayload['status'], runAt: row.runAt,
    content: row.content, attempts: row.attempts,
    lastError: row.lastError, sentAt: row.sentAt == null ? null : row.sentAt * 1000,
  };
}

function writeCard(row: SessionScheduledResume): void {
  const content = JSON.stringify(payload(row));
  db.transaction((tx) => {
    tx.update(claudeSessionMessages).set({ content, wireContent: null })
      .where(eq(claudeSessionMessages.id, row.messageId)).run();
    // Updating a row does not advance the chat's id cursor. This invisible
    // wake row makes the 5s delta safety poll notice a missed SSE and perform
    // its normal clean reload, so sent/retry/cancel state always self-heals.
    tx.insert(claudeSessionMessages).values({
      sessionId: row.sessionId, role: 'event',
      content: JSON.stringify({ type: 'scheduled_resume_update', messageId: row.messageId }),
      tsMs: Date.now(),
    }).run();
  });
  const stream = getOrCreateStream(row.sessionId);
  stream?.publishScheduledResume(row.messageId, content, row.createdAt);
}

function reload(id: string): SessionScheduledResume | null {
  return db.select().from(sessionScheduledResumes)
    .where(eq(sessionScheduledResumes.id, id)).get() ?? null;
}

function armNext(): void {
  if (globalScheduler._scheduledResumeTimer) clearTimeout(globalScheduler._scheduledResumeTimer);
  globalScheduler._scheduledResumeTimer = null;
  const next = db.select().from(sessionScheduledResumes)
    .where(eq(sessionScheduledResumes.status, 'scheduled'))
    .orderBy(asc(sessionScheduledResumes.runAt)).limit(1).get();
  if (!next) return;
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, next.runAt - Date.now()));
  globalScheduler._scheduledResumeTimer = setTimeout(() => {
    globalScheduler._scheduledResumeTimer = null;
    void runDue().finally(armNext);
  }, delay);
  globalScheduler._scheduledResumeTimer.unref?.();
}

async function deliver(id: string): Promise<void> {
  const claimed = db.update(sessionScheduledResumes).set({
    status: 'sending', updatedAt: Math.floor(Date.now() / 1000),
  }).where(and(eq(sessionScheduledResumes.id, id), eq(sessionScheduledResumes.status, 'scheduled'))).run();
  if (!claimed.changes) return;
  let row = reload(id);
  if (!row) return;
  writeCard(row);

  let insertedUser = false;
  if (row.userMessageId == null) {
    db.transaction((tx) => {
      const current = tx.select().from(sessionScheduledResumes)
        .where(eq(sessionScheduledResumes.id, id)).get();
      if (!current || current.userMessageId != null) return;
      const result = tx.insert(claudeSessionMessages).values({
        sessionId: current.sessionId, role: 'user', content: current.content,
        tsMs: Date.now(),
      }).run();
      tx.update(sessionScheduledResumes).set({ userMessageId: Number(result.lastInsertRowid) })
        .where(eq(sessionScheduledResumes.id, id)).run();
      insertedUser = true;
    });
    row = reload(id);
    if (!row) return;
  }

  try {
    const stream = getOrCreateStream(row.sessionId);
    if (!stream) throw new Error('session not found');
    await stream.sendUserMessage(row.content, undefined, {
      persist: false, broadcastUser: insertedUser, clientMessageId: row.clientMessageId,
    });
    db.update(sessionScheduledResumes).set({
      status: 'sent', sentAt: Math.floor(Date.now() / 1000), lastError: null,
      updatedAt: Math.floor(Date.now() / 1000),
    }).where(eq(sessionScheduledResumes.id, id)).run();
  } catch (error) {
    const attempts = row.attempts + 1;
    const retry = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    db.update(sessionScheduledResumes).set({
      status: 'scheduled', attempts, runAt: Date.now() + retry,
      lastError: String((error as Error)?.message ?? error).slice(0, 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    }).where(eq(sessionScheduledResumes.id, id)).run();
  }
  const final = reload(id);
  if (final) writeCard(final);
}

async function runDue(): Promise<void> {
  const due = db.select({ id: sessionScheduledResumes.id }).from(sessionScheduledResumes)
    .where(and(eq(sessionScheduledResumes.status, 'scheduled'),
      lte(sessionScheduledResumes.runAt, Date.now())))
    .orderBy(asc(sessionScheduledResumes.runAt)).limit(20).all();
  for (const job of due) await deliver(job.id);
}

/** Explicit tick for boot/tests; normal operation is driven by armNext. */
export async function runScheduledResumesDue(): Promise<void> {
  await runDue();
  armNext();
}

export function armScheduledResumes(): void {
  if (globalScheduler._scheduledResumeArmed) return;
  // A process may die after claiming but before recording success. Requeue;
  // the stable client_message_id makes an already-accepted agent input dedup.
  db.update(sessionScheduledResumes).set({ status: 'scheduled', runAt: Date.now() + 15_000 })
    .where(eq(sessionScheduledResumes.status, 'sending')).run();
  armNext();
  globalScheduler._scheduledResumeArmed = true;
}

export function createScheduledResume(input: {
  sessionId: string; sourceMessageId: number; resetAt: number;
}): SessionScheduledResume {
  const existing = db.select().from(sessionScheduledResumes)
    .where(eq(sessionScheduledResumes.sourceMessageId, input.sourceMessageId)).get();
  if (existing) return existing;
  const session = db.select({ id: claudeSessions.id }).from(claudeSessions)
    .where(eq(claudeSessions.id, input.sessionId)).get();
  if (!session) throw new Error('session not found');
  const id = crypto.randomUUID();
  const runAt = Math.max(Date.now() + 5_000, input.resetAt + RESET_SAFETY_DELAY_MS);
  try {
    db.transaction((tx) => {
      const initial: ScheduledResumePayload = {
        type: 'scheduled_resume', scheduleId: id, status: 'scheduled', runAt,
        content: AUTO_RESUME_PROMPT, attempts: 0, lastError: null, sentAt: null,
      };
      const card = tx.insert(claudeSessionMessages).values({
        sessionId: input.sessionId, role: 'scheduled_resume',
        content: JSON.stringify(initial), tsMs: Date.now(),
      }).run();
      tx.insert(sessionScheduledResumes).values({
        id, sessionId: input.sessionId, sourceMessageId: input.sourceMessageId,
        messageId: Number(card.lastInsertRowid), content: AUTO_RESUME_PROMPT,
        runAt, clientMessageId: crypto.randomUUID(),
      }).run();
    });
  } catch (error) {
    // Two tabs may click at once. The source UNIQUE turns the race into the
    // same idempotent response; any other DB error still surfaces.
    const raced = db.select().from(sessionScheduledResumes)
      .where(eq(sessionScheduledResumes.sourceMessageId, input.sourceMessageId)).get();
    if (raced) return raced;
    throw error;
  }
  const created = reload(id);
  if (!created) throw new Error('failed to create scheduled resume');
  writeCard(created);
  armNext();
  return created;
}

export function cancelScheduledResume(sessionId: string, id: string): SessionScheduledResume | null {
  const existing = reload(id);
  if (!existing || existing.sessionId !== sessionId) return null;
  db.update(sessionScheduledResumes).set({
    status: 'cancelled', updatedAt: Math.floor(Date.now() / 1000),
  }).where(and(eq(sessionScheduledResumes.id, id), eq(sessionScheduledResumes.sessionId, sessionId),
    eq(sessionScheduledResumes.status, 'scheduled'))).run();
  const row = reload(id);
  if (row) writeCard(row);
  armNext();
  return row;
}

export function cancelPendingScheduledResumes(sessionId: string): void {
  const rows = db.select().from(sessionScheduledResumes).where(and(
    eq(sessionScheduledResumes.sessionId, sessionId),
    eq(sessionScheduledResumes.status, 'scheduled'),
  )).all();
  for (const row of rows) cancelScheduledResume(sessionId, row.id);
}
