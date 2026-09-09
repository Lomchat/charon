import 'server-only';
import { and, asc, eq, like } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import {
  applyBgTaskEvent, BG_TASK_MAX_AGE_S, bgTasksToArray, isTerminalBgStatus,
  type BgTask,
} from '@/app/bgTasks';

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
type BgTaskRow = { content: string; createdAt: number; seq: number | null; tsMs: number | null };

function bgTaskRowsFromDb(sessionId: string): BgTaskRow[] {
  try {
    return db.select({ content: claudeSessionMessages.content, createdAt: claudeSessionMessages.createdAt,
      seq: claudeSessionMessages.seq, tsMs: claudeSessionMessages.tsMs })
      .from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, sessionId),
        eq(claudeSessionMessages.role, 'event'),
        like(claudeSessionMessages.content, '%"bg_task"%'),
      ))
      .orderBy(asc(claudeSessionMessages.id))
      .all();
  } catch { return []; }
}

/** Tasks whose latest recorded activity predates a native snapshot. A replay
 * sees the CURRENT DB registry, which may contain tasks created after that
 * snapshot. Absence from an older snapshot cannot close those tasks (§14.91).
 * Prefer event time across sequence resets, then seq for same-ms/legacy rows.
 * Missing ordering evidence is deliberately not permission to close work. */
export function bgTaskIdsBeforeEventFromDb(
  sessionId: string,
  boundary: { seq: number | null; tsMs: number | null },
): Set<string> {
  const eligible = new Set<string>();
  for (const row of bgTaskRowsFromDb(sessionId)) {
    try {
      const ev = JSON.parse(row.content);
      if (ev?.type !== 'bg_task' || typeof ev.taskId !== 'string') continue;
      let before = false;
      if (boundary.tsMs != null && row.tsMs != null && row.tsMs !== boundary.tsMs) {
        before = row.tsMs < boundary.tsMs;
      } else if (boundary.seq != null && row.seq != null) {
        before = row.seq < boundary.seq;
      } else if (boundary.tsMs != null) {
        // createdAt has only second precision: an equal second is ambiguous.
        before = row.createdAt < Math.floor(boundary.tsMs / 1000);
      }
      if (before) eligible.add(ev.taskId);
      else eligible.delete(ev.taskId);
    } catch { /* malformed lifecycle rows cannot authorize a closure */ }
  }
  return eligible;
}

function reduceBgTasksFromDb(sessionId: string): {
  running: Map<string, number>;
  details: Map<string, BgTask>;
} {
  const running = new Map<string, number>(); // taskId → startedAt
  const details = new Map<string, BgTask>();
  for (const r of bgTaskRowsFromDb(sessionId)) {
    try {
      const ev = JSON.parse(r.content);
      if (ev?.type !== 'bg_task' || !ev.taskId) continue;
      applyBgTaskEvent(details, ev, r.createdAt);
      const task = details.get(ev.taskId)!;
      if (task.status !== 'running') running.delete(ev.taskId);
      else running.set(ev.taskId, task.startedAt);
    } catch { /* a corrupt row must not blind the whole registry */ }
  }
  return { running, details };
}

export function runningBgTasksFromDb(sessionId: string): Map<string, number> {
  return reduceBgTasksFromDb(sessionId).running;
}

/** Compact ACTIVE-task projection for the session-detail API. Unlike the
 * chat window it scans the complete lifecycle, then applies the same 24h
 * belief cap as the status/quiet-gate reducer. */
export function runningBgTaskDetailsFromDb(
  sessionId: string,
  nowS = Math.floor(Date.now() / 1000),
): BgTask[] {
  const { running, details } = reduceBgTasksFromDb(sessionId);
  pruneStaleBgTasks(running, nowS);
  const active = new Map<string, BgTask>();
  for (const [taskId, startedAt] of running) {
    const detail = details.get(taskId);
    active.set(taskId, {
      taskId,
      description: detail?.description ?? null,
      command: detail?.command ?? null,
      toolUseId: detail?.toolUseId ?? null,
      taskType: detail?.taskType ?? null,
      status: 'running',
      startedAt,
      endedAt: null,
      outputFile: detail?.outputFile ?? null,
      summary: null,
      workflowName: detail?.workflowName ?? null,
      usage: null,
      lastToolName: null,
      agents: null,
    });
  }
  return bgTasksToArray(active);
}

/** Drop the tasks too old to still be believed. Mutates, and answers whether
 *  anything is left. */
export function pruneStaleBgTasks(running: Map<string, number>, nowS: number): boolean {
  for (const [id, startedAt] of running) {
    if (nowS - startedAt >= BG_TASK_MAX_AGE_S) running.delete(id);
  }
  return running.size > 0;
}
