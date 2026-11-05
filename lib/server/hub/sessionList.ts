import 'server-only';
import { parsePromptCache } from '@/lib/promptCache';
import { eq, sql } from 'drizzle-orm';
import { accountProfileId, accountProfileNumber } from '@/lib/accountProfiles';
import { publicConnection } from '@/lib/server/customEndpoints';
import { db, sessionPendingPermissions, sessionPendingQuestions, type AgentSession } from '@/lib/db';
import { listStreams } from '@/lib/server/agent/sessionOps';
import { pruneStaleBgTasks, runningBgTasksIfWarm } from '@/lib/server/hub/bgTaskState';
import { listVpsRuntimeSnapshots } from '@/lib/server/agent/vpsRuntimeSnapshot';
import { compareVersions } from '@/lib/version';
import { parseScheduledTasks } from '@/lib/scheduledTasks';
import { SESSION_PEER_AGENT_VERSION } from '@/lib/sessionHandle';
import type { SessionListItem, VpsRuntimeSnapshot } from '@/lib/types/api';

/** The sidebar's background-task count (§14.91). A live stream's registry is
 *  the truth and is cached after its first read. Without a stream, only a row
 *  parked `background` can have any, so only that one pays for a history scan;
 *  a paused session's children died with its CLI. */
function runningBgTasksFor(
  id: string, liveStatus: string, stream: ReturnType<typeof listStreams>[number] | undefined,
): number {
  if (liveStatus === 'sleeping' || liveStatus === 'error' || liveStatus === 'killed') return 0;
  if (stream) return stream.runningBgTaskCount();
  if (liveStatus !== 'background') return 0;
  // A cold registry warms in background slices (bgTaskState.ts): 0 meanwhile
  // (the count is cosmetic; the row stays `background`).
  const running = runningBgTasksIfWarm(id);
  if (running == null) return 0;
  pruneStaleBgTasks(running, Math.floor(Date.now() / 1000));
  return running.size;
}

/**
 * Annotate `agent_sessions` rows into the list shape every surface reads
 * (list GET; the SSR seed and the session summaries build on it): live status,
 * bg-task count, peer addressability, first prompt, last activity, and the
 * pending-gate counts. `pendingBlocking` = permissions + blocking questions +
 * plan reviews; `pendingAsync` = async questions (never block, never expire,
 * §14.96); `pendingPermissions` stays their SUM for older tabs. Reads only: the
 * caller sweeps expired gates first (sessionOps § sweepExpiredInteractions).
 */
export function annotateSessionRows(
  rows: AgentSession[],
  opts: {
    vpsRuntime?: VpsRuntimeSnapshot[];
    /** The session summaries (C13, lib/server/sync/sessionSummaries.ts) pass
     *  their own indexed, cached readers: a one-session build must never pay
     *  the whole-table GROUP BYs below. Same semantics, same values. */
    firstUserMessage?: (sessionId: string) => string | null;
    pendingCounts?: (sessionId: string) => { permissions: number; blockingQuestions: number; asyncQuestions: number };
  } = {},
): SessionListItem[] {
  const streams = new Map(listStreams().map((s) => [s.id, s] as const));
  const pendingBySession = new Map<string, number>();
  const blockingQBySession = new Map<string, number>();
  const asyncQBySession = new Map<string, number>();
  if (opts.pendingCounts) {
    for (const r of rows) {
      const c = opts.pendingCounts(r.id);
      pendingBySession.set(r.id, c.permissions);
      blockingQBySession.set(r.id, c.blockingQuestions);
      asyncQBySession.set(r.id, c.asyncQuestions);
    }
  } else {
    const pendingRows = db.select({
      sessionId: sessionPendingPermissions.sessionId,
      n: sql<number>`count(*)`.as('n'),
    })
      .from(sessionPendingPermissions)
      .where(eq(sessionPendingPermissions.status, 'pending'))
      .groupBy(sessionPendingPermissions.sessionId)
      .all();
    for (const r of pendingRows) pendingBySession.set(r.sessionId, Number(r.n));
    const pendingQRows = db.select({
      sessionId: sessionPendingQuestions.sessionId,
      kind: sessionPendingQuestions.kind,
      n: sql<number>`count(*)`.as('n'),
    })
      .from(sessionPendingQuestions)
      .where(eq(sessionPendingQuestions.status, 'pending'))
      .groupBy(sessionPendingQuestions.sessionId, sessionPendingQuestions.kind)
      .all();
    for (const r of pendingQRows) {
      const into = r.kind === 'async_question' ? asyncQBySession : blockingQBySession;
      into.set(r.sessionId, (into.get(r.sessionId) ?? 0) + Number(r.n));
    }
  }

  let firstMsgBySession: Map<string, string | null>;
  if (opts.firstUserMessage) {
    const read = opts.firstUserMessage;
    firstMsgBySession = new Map(rows.map((r) => [r.id, read(r.id)] as const));
  } else {
    const firstMsgRows = db.all(sql`
      SELECT session_id as sessionId, content
      FROM session_messages
      WHERE id IN (
        SELECT MIN(id) FROM session_messages
        WHERE role = 'user'
        GROUP BY session_id
      )
    `) as Array<{ sessionId: string; content: string }>;
    firstMsgBySession = new Map(firstMsgRows.map((r) => [r.sessionId, r.content] as const));
  }

  // When each session last said anything — what "finished 4 minutes ago"
  // orders on, and the one fact no other column carries (`unreadStop` is a
  // flag, `createdAt` is the launch). One indexed seek PER SESSION rather
  // than `GROUP BY session_id`: the group-by scans the whole message index
  // (~200ms here), the seeks are a rounding error, and this runs on a 60s
  // poll in every open tab.
  const lastActivityBySession = new Map(rows.map((r) => {
    const hit = db.get(sql`
      SELECT MAX(ts_ms) AS ts FROM session_messages WHERE session_id = ${r.id}
    `) as { ts: number | null } | undefined;
    return [r.id, hit?.ts ?? null] as const;
  }));

  const vpsRuntime = opts.vpsRuntime ?? listVpsRuntimeSnapshots();
  const agentVersions = new Map(vpsRuntime.map((v) => [v.id, v.agentVersion] as const));

  return rows.map((r): SessionListItem => {
    const stream = streams.get(r.id);
    const perms = pendingBySession.get(r.id) ?? 0;
    const blockingQs = blockingQBySession.get(r.id) ?? 0;
    const asyncQs = asyncQBySession.get(r.id) ?? 0;
    const firstMsg = firstMsgBySession.get(r.id) ?? null;
    const liveStatus = stream ? stream.status : r.status;
    const peerAgentReady = compareVersions(
      agentVersions.get(r.vpsId), SESSION_PEER_AGENT_VERSION,
    ) >= 0;
    return {
      ...r,
      // Private construction JSON (credentials, env) never leaves the hub;
      // `undefined` drops the key from the JSON body.
      providerConfig: undefined as unknown as AgentSession['providerConfig'],
      scheduledTasksJson: undefined as unknown as AgentSession['scheduledTasksJson'],
      scheduledTasks: parseScheduledTasks(r.scheduledTasksJson),
      promptCacheJson: undefined as unknown as AgentSession['promptCacheJson'],
      promptCache: parsePromptCache(r.promptCacheJson),
      accountProfile: accountProfileId(r.providerConfig), accountProfileNumber: accountProfileNumber(r.providerConfig),
      endpoint: publicConnection(r.providerConfig),
      liveStatus,
      // Handles are durable for both providers. Only a sufficiently recent
      // live daemon can route them, so sleeping/stale targets stay out of the
      // composer menu without hiding their identity in the sidebar.
      addressable: !!r.handle && peerAgentReady
        && ['starting', 'active', 'thinking', 'background', 'failed'].includes(liveStatus),
      runningBgTasks: runningBgTasksFor(r.id, liveStatus, stream),
      pendingPermissions: perms + blockingQs + asyncQs,
      pendingBlocking: perms + blockingQs,
      pendingAsync: asyncQs,
      firstUserMessage: firstMsg ? firstMsg.slice(0, 180) : null,
      lastActivityMs: lastActivityBySession.get(r.id) ?? null,
    };
  });
}
