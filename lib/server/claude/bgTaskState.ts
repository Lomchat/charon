import 'server-only';
import { and, asc, eq, like } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import { BG_TASK_MAX_AGE_S, isTerminalBgStatus } from '@/app/bgTasks';

/**
 * "Does this session still have background work running?" — hub-side.
 *
 * There is no bg-task table: the lifecycle is PERSISTED as ordinary `event`
 * rows (`sessionOps § case 'bg_task'`) and the registry is derived from them,
 * client-side by `app/bgTasks.ts` and here for the two server-side readers —
 * the session's own `background` status (§14.91) and the auto-update quiet gate
 * (`sdkWatch § isVpsBusy`). One reducer for both, because the two used to
 * disagree about what "still running" means and the answer decides whether a
 * VPS gets restarted from under a running task.
 */

/** A "running" task older than this counts as gone: a lost `finished` event
 *  would otherwise wedge a session as forever-busy. Re-exported from the
 *  shared client reducer — the cap must be the same number on both sides or
 *  the bar and the session status disagree about what is still running. */
export { BG_TASK_MAX_AGE_S };

/** The terminal-event rule, shared so the two callers cannot drift — and now
 *  sharing its VOCABULARY with `app/bgTasks.ts` too. The word list used to be
 *  duplicated as a regex here, and the copies disagreed: `error`/`timeout`
 *  ended the task client-side but not here (session stuck violet
 *  `background`), and `stop` — the word a stop_task kill reports — ended it
 *  nowhere. `updated` carries a free-form status string from the SDK, hence
 *  matching on the word rather than on an enum. */
export function isBgTaskDone(
  ev: { kind?: unknown; status?: unknown; terminal?: unknown },
): boolean {
  if (ev.kind === 'finished') return true;
  // agent >= 0.36.0 ships the SDK's own verdict on the event. It outranks our
  // word list: that list is a reimplementation of the SDK constant, and the
  // failure it was written about is precisely "a status word we didn't think
  // of". Older agents omit the flag → fall through to the words.
  if (typeof ev.terminal === 'boolean') return ev.kind === 'updated' && ev.terminal;
  return ev.kind === 'updated' && isTerminalBgStatus(ev.status);
}

/** taskId → startedAt (unix seconds), rebuilt from the persisted event rows.
 *  Full-history scan: cheap enough at the call rate (stream hydration once per
 *  session, and one auto-update tick every 30 min), and the alternative is a
 *  column that can silently disagree with the rows it is derived from. */
export function runningBgTasksFromDb(sessionId: string): Map<string, number> {
  const running = new Map<string, number>(); // taskId → startedAt
  let rows: { content: string; createdAt: number }[];
  try {
    rows = db.select({ content: claudeSessionMessages.content, createdAt: claudeSessionMessages.createdAt })
      .from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, sessionId),
        eq(claudeSessionMessages.role, 'event'),
        like(claudeSessionMessages.content, '%"bg_task"%'),
      ))
      .orderBy(asc(claudeSessionMessages.id))
      .all();
  } catch { return running; }
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.content);
      if (ev?.type !== 'bg_task' || !ev.taskId) continue;
      if (isBgTaskDone(ev)) running.delete(ev.taskId);
      else if (!running.has(ev.taskId)) running.set(ev.taskId, r.createdAt);
    } catch { /* a corrupt row must not blind the whole registry */ }
  }
  return running;
}

/** Drop the tasks too old to still be believed. Mutates, and answers whether
 *  anything is left. */
export function pruneStaleBgTasks(running: Map<string, number>, nowS: number): boolean {
  for (const [id, startedAt] of running) {
    if (nowS - startedAt >= BG_TASK_MAX_AGE_S) running.delete(id);
  }
  return running.size > 0;
}
