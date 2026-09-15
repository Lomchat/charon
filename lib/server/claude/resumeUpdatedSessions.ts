import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionLogs } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { resumeSession } from '@/lib/server/agent/sessionOps';

/** Confirm startup on the replacement daemon, rather than counting RPC acks. */
export async function resumeUpdatedSessions(vpsId: string, sessionIds: string[]) {
  const resumedSessionIds: string[] = [];
  const warnings: string[] = [];
  const pending = new Set<string>();
  const wanted = (id: string) => {
    const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
    return row && !row.archived && !row.sleepRequested && row.resumePending;
  };
  const failed = (id: string, reason: string) => {
    warnings.push(`Session ${id} did not resume: ${reason}`);
    db.insert(claudeSessionLogs).values({ sessionId: id, level: 'warn',
      event: 'post_update_resume', detail: JSON.stringify({ err: reason }) }).run();
  };

  await Promise.all(sessionIds.map(async (id) => {
    // An explicit pause/archive/delete during the update cancels this intent.
    if (!wanted(id)) {
      // The reconnect hook may already have completed this same recovery.
      const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
      if (row && !row.archived && !row.sleepRequested &&
          ['active', 'thinking', 'background'].includes(row.status)) pending.add(id);
      return;
    }
    try {
      await resumeSession(id);
      pending.add(id);
    } catch (error) {
      if (wanted(id)) failed(id, (error as Error).message);
    }
  }));

  const client = getAgentClientForVpsId(vpsId);
  const deadline = Date.now() + 45_000;
  while (pending.size) {
    let sessions: { session_id: string; status: string }[];
    try {
      sessions = await client.call('list_sessions');
      if (!Array.isArray(sessions)) throw new Error('invalid session list from agent');
    } catch (error) {
      for (const id of pending) if (wanted(id)) failed(id, (error as Error).message);
      break;
    }
    const statuses = new Map(sessions.map((s) => [s.session_id, s.status]));
    for (const id of pending) {
      const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
      if (!row || row.archived || row.sleepRequested || (!row.resumePending && row.status === 'sleeping')) {
        pending.delete(id);
        continue;
      }
      const status = statuses.get(id);
      if (status === 'active' || status === 'thinking') {
        db.update(claudeSessions).set({ resumePending: 0 }).where(eq(claudeSessions.id, id)).run();
        db.insert(claudeSessionLogs).values({ sessionId: id, level: 'info',
          event: 'post_update_resume', detail: JSON.stringify({ status }) }).run();
        resumedSessionIds.push(id);
        pending.delete(id);
      } else if (status !== 'starting' || Date.now() >= deadline) {
        failed(id, status === 'starting' ? 'startup timed out' : `agent status: ${status ?? 'missing'}`);
        pending.delete(id);
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { resumedSessionIds, warnings };
}
