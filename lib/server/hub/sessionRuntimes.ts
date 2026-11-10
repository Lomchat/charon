import 'server-only';
import { and, eq, gt, ne } from 'drizzle-orm';
import { db, agentSessions, sessionMessages, sessionPendingPermissions, sessionPendingQuestions } from '@/lib/db';
import { publish } from '@/lib/server/sync/syncBus';
import { listAgentClients } from '@/lib/server/agent/AgentClientPool';
import type { AgentHelloResult } from '@/lib/server/agent/types';
import { runningBgTasksIfWarm, pruneStaleBgTasks } from './bgTaskState';
import { sanitizeRuntimeVersions, type RuntimeVersions } from '@/lib/runtimeUpdate';

/**
 * Hot agent updates (§14.117). On an agent that runs its sessions in RUNTIME
 * processes (`hello.hot_update`), an update restarts only the daemon: every
 * session keeps running the code of before the update ("outdated") until it
 * is moved, while idle, to the current runtime (`migrate_session`, a stop +
 * resume the agent hides from the hub).
 *
 * This module holds what the hub knows about it — memory only, re-stated by
 * every hello — and drives the moves: a session is moved only when nothing
 * would be lost (no turn, no human gate, no running background task, no
 * recent activity). The agent checks again, atomically, at the moment it
 * stops the session.
 */

type RuntimeState = {
  /** sessionId → outdated + what its runtime runs (only sessions an agent
   *  reported; `versions` null before agent 0.131.0). */
  outdated: Map<string, { vpsId: string; outdated: boolean; versions?: RuntimeVersions | null }>;
  /** vpsId → the agent's last `hello.hot_update`. */
  hot: Map<string, boolean>;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  /** VPS whose sessions are being moved right now. */
  moving: Set<string>;
};

// One process-wide copy (§14.106).
const g = globalThis as unknown as { _sessionRuntimes?: RuntimeState };
const state: RuntimeState = g._sessionRuntimes ??= {
  outdated: new Map(), hot: new Map(), timer: null, ticking: false, moving: new Set(),
};

const TICK_MS = 15_000;
/** No move this soon after the session's last persisted row (user typing,
 *  a turn that just ended, a scheduled task that just fired). */
const QUIET_MS = 60_000;
/** Moves per VPS per tick: each restarts one provider CLI. */
const MAX_MOVES_PER_TICK = 2;
const MIGRATE_TIMEOUT_MS = 120_000;

function setOutdated(vpsId: string, sessionId: string, outdated: boolean, rawVersions?: unknown): void {
  const prev = state.outdated.get(sessionId);
  const versions = outdated ? sanitizeRuntimeVersions(rawVersions) : null;
  state.outdated.set(sessionId, { vpsId, outdated, versions });
  if (prev?.outdated === outdated
    && JSON.stringify(prev.versions ?? null) === JSON.stringify(versions)) return;
  // The session header shows it (frame `runtime_outdated`, window GET's
  // `liveRuntimeOutdated`/`liveRuntimeVersions`). Absent before = not
  // outdated: no frame for that.
  if (!prev && !outdated) return;
  publish({ type: 'runtime_outdated', sessionId, outdated, versions });
}

/** Every (re)connect: the agent's whole truth for this VPS. */
export function noteHello(vpsId: string, hello: AgentHelloResult): void {
  state.hot.set(vpsId, hello.hot_update === true);
  const seen = new Set<string>();
  for (const s of hello.sessions ?? []) {
    if (!s?.session_id) continue;
    seen.add(s.session_id);
    setOutdated(vpsId, s.session_id, s.outdated === true, s.runtime_versions);
  }
  for (const [sid, entry] of state.outdated) {
    if (entry.vpsId === vpsId && !seen.has(sid)) {
      setOutdated(vpsId, sid, false);
      state.outdated.delete(sid);
    }
  }
  if (hello.hot_update === true) armRuntimeMigrations();
}

/** The agent's `session_runtime` event (a move, a restore). */
export function noteSessionRuntime(vpsId: string, sessionId: string, outdated: boolean, versions?: unknown): void {
  setOutdated(vpsId, sessionId, outdated, versions);
}

/** Does the session still run the code of before an agent update? */
export function isRuntimeOutdated(sessionId: string): boolean {
  return state.outdated.get(sessionId)?.outdated === true;
}

/** What the outdated runtime of this session runs (null = unknown). */
export function runtimeVersionsOf(sessionId: string): RuntimeVersions | null {
  const entry = state.outdated.get(sessionId);
  return entry?.outdated ? entry.versions ?? null : null;
}

/** The agent's last word: true = an update restarts no session.
 *  undefined until this hub has heard a hello from it. */
export function vpsHotUpdate(vpsId: string): boolean | undefined {
  return state.hot.get(vpsId);
}

/** A move in progress on this VPS: an update must wait for it. */
export function isVpsMigrating(vpsId: string): boolean {
  return state.moving.has(vpsId);
}

/** Why moving this session NOW could cost something, or null. */
export function migrationBlocker(sessionId: string, nowMs = Date.now()): string | null {
  const [row] = db.select({ status: agentSessions.status, archived: agentSessions.archived })
    .from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).all();
  if (!row) return 'unknown session';
  if (row.archived) return 'archived';
  if (row.status !== 'active' && row.status !== 'failed') return `status ${row.status}`;
  const perm = db.select({ id: sessionPendingPermissions.sessionId }).from(sessionPendingPermissions)
    .where(and(eq(sessionPendingPermissions.sessionId, sessionId), eq(sessionPendingPermissions.status, 'pending')))
    .limit(1).all();
  if (perm.length) return 'pending permission';
  // Async questions survive a restart (§14.96): only blocking ones count.
  const question = db.select({ id: sessionPendingQuestions.sessionId }).from(sessionPendingQuestions)
    .where(and(
      eq(sessionPendingQuestions.sessionId, sessionId),
      eq(sessionPendingQuestions.status, 'pending'),
      ne(sessionPendingQuestions.kind, 'async_question'),
    )).limit(1).all();
  if (question.length) return 'pending question';
  const recent = db.select({ id: sessionMessages.id }).from(sessionMessages)
    .where(and(
      eq(sessionMessages.sessionId, sessionId),
      gt(sessionMessages.createdAt, Math.floor((nowMs - QUIET_MS) / 1000)),
    )).limit(1).all();
  if (recent.length) return 'recent activity';
  // A background task dies with the provider CLI (§14.91). A cold registry
  // counts as busy until it has warmed.
  const running = runningBgTasksIfWarm(sessionId);
  if (running == null || pruneStaleBgTasks(running, Math.floor(nowMs / 1000))) return 'background task';
  return null;
}

async function tick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    for (const client of listAgentClients()) {
      const vpsId = client.vps.id;
      if (client.status !== 'connected' || state.hot.get(vpsId) !== true) continue;
      const candidates = [...state.outdated]
        .filter(([, e]) => e.vpsId === vpsId && e.outdated)
        .map(([sid]) => sid);
      let moved = 0;
      for (const sid of candidates) {
        if (moved >= MAX_MOVES_PER_TICK) break;
        let why: string | null;
        try { why = migrationBlocker(sid); } catch { continue; }
        if (why) continue;
        state.moving.add(vpsId);
        try {
          const res = await client.call<{ ok?: boolean; migrated?: boolean; noop?: boolean; busy?: boolean; reason?: string; error?: string }>(
            'migrate_session', { session_id: sid }, { timeoutMs: MIGRATE_TIMEOUT_MS });
          if (res?.migrated || res?.noop) {
            moved++;
            setOutdated(vpsId, sid, false);
            console.log(`[runtimes] ${sid} moved to the current agent runtime`);
          } else if (res?.error) {
            console.warn(`[runtimes] ${sid}: move failed: ${res.error}`);
          }
        } catch (e) {
          console.warn(`[runtimes] ${sid}: migrate_session failed: ${(e as Error)?.message ?? e}`);
        } finally {
          state.moving.delete(vpsId);
        }
      }
    }
  } finally {
    state.ticking = false;
  }
}

/** Idempotent; armed by the first hot-update hello. */
export function armRuntimeMigrations(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (state.timer) return;
  state.timer = setInterval(() => { void tick(); }, TICK_MS);
  state.timer.unref?.();
}
