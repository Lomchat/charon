// The hub's copy of a session's scheduled tasks (lib/scheduledTasks.ts): the
// CLI's own list as of its latest turn end, persisted on the session row so it
// survives hub restarts and reaches every tab through the session summary.
import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import {
  parseScheduledTasks, type ScheduledTask, type ScheduledTasksState, type WireScheduledTask, type WireScheduleTz,
} from '@/lib/scheduledTasks';

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** When the CLI created the task: its CronCreate result ("Scheduled recurring
 *  job <id> (…" / "Scheduled one-shot task <id> (…"). Read once per new id,
 *  over the head of this session's tool results only. */
function createdAtFromTranscript(sessionId: string, id: string): number | null {
  if (!SAFE_ID.test(id)) return null;
  const row = db.get(sql`
    SELECT ts_ms AS ts FROM session_messages
    WHERE session_id = ${sessionId} AND role = 'tool_result'
      AND snapshot_file_path IS NULL AND snapshot_phase IS NULL
      AND substr(content, 1, 400) LIKE ${`%Scheduled % ${id} (%`}
    ORDER BY id DESC LIMIT 1
  `) as { ts: number | null } | undefined;
  return typeof row?.ts === 'number' ? row.ts : null;
}

export function readScheduledTasks(sessionId: string): ScheduledTasksState | null {
  const row = db.select({ json: agentSessions.scheduledTasksJson }).from(agentSessions)
    .where(eq(agentSessions.id, sessionId)).get();
  return parseScheduledTasks(row?.json);
}

/** Replace the session's list with the one a turn end reported. Written, and
 *  true returned (the caller marks the summary dirty), only when what a
 *  surface shows changed: `asOf` is when the list last changed. */
export function recordScheduledTasks(
  sessionId: string, raw: WireScheduledTask[], tz: WireScheduleTz | undefined, atMs: number,
): boolean {
  const prev = readScheduledTasks(sessionId);
  const prevById = new Map((prev?.tasks ?? []).map((t) => [t.id, t] as const));
  const tasks: ScheduledTask[] = [];
  for (const t of raw) {
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.schedule !== 'string') continue;
    const known = prevById.get(t.id);
    tasks.push({
      id: t.id,
      schedule: t.schedule,
      recurring: t.recurring === true,
      prompt: typeof t.prompt === 'string' ? t.prompt : '',
      nextFireAt: typeof t.next_fire_at === 'number' && Number.isFinite(t.next_fire_at) ? t.next_fire_at : null,
      createdAt: known?.createdAt ?? createdAtFromTranscript(sessionId, t.id) ?? atMs,
    });
  }
  const next: ScheduledTasksState = {
    tasks, asOf: atMs,
    ...(tz && typeof tz.offset_min === 'number'
      ? { tz: { name: typeof tz.name === 'string' ? tz.name : '', offsetMin: tz.offset_min } } : {}),
  };
  const shown = (s: ScheduledTasksState | null) => JSON.stringify(s ? { tasks: s.tasks, tz: s.tz ?? null } : null);
  if (shown(prev) === shown(next)) return false;
  // An empty list is written too (not NULL): "nothing scheduled" is a fact.
  db.update(agentSessions).set({ scheduledTasksJson: JSON.stringify(next) })
    .where(eq(agentSessions.id, sessionId)).run();
  return true;
}
