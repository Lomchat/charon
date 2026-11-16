// Routines (CLAUDE.md §14.120): a prompt the HUB sends to a NEW session on a
// weekly schedule — the hub's own clock, not the CLI's crons (those fire only
// while their session is awake and expire after 7 days). Each run is a real
// session: visible, unattended (§14.119), notifying like any other.
import 'server-only';
import crypto from 'node:crypto';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, agentSessions, routines, vps, type Routine } from '@/lib/db';
import { peekStream, startNewSession } from '@/lib/server/agent/sessionOps';
import { archiveSession } from '@/lib/server/hub/sessionArchive';
import { markSummaryDirty } from '@/lib/server/sync/syncBus';
import { asSessionProvider, isSessionMode, isSessionProvider } from '@/lib/sessionCapabilities';
import { isValidSchedule, nextRunAt, type RoutineSchedule } from '@/lib/routineSchedule';
import type { RoutineRun, RoutineView, RoutineInput } from '@/lib/types/api';

const TICK_MS = 30_000;
/** A run missed by more than this (hub down) is skipped, not caught up. */
const CATCH_UP_MS = 6 * 3600_000;
/** How long a run waits for its new session to be ready for the prompt. */
const READY_TIMEOUT_MS = 120_000;
const BUSY = new Set(['starting', 'thinking', 'background']);

type State = { timer: ReturnType<typeof setInterval> | null; running: Set<string> };
const g = globalThis as typeof globalThis & { __charonRoutines?: State };

function scheduleOf(r: Pick<Routine, 'days' | 'time' | 'timezone'>): RoutineSchedule {
  let days: number[] = [];
  try { days = JSON.parse(r.days); } catch {}
  return { days: Array.isArray(days) ? days : [], time: r.time, timezone: r.timezone };
}

function nextFor(r: Pick<Routine, 'days' | 'time' | 'timezone' | 'enabled'>, after: number): number | null {
  return r.enabled ? nextRunAt(scheduleOf(r), after) : null;
}

/** Validate a create/update body. Throws a user-facing message. */
export function parseRoutineInput(raw: unknown, partial = false): Partial<RoutineInput> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<RoutineInput> = {};
  const text = (k: string, max: number): string | undefined => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} must be a non-empty string`);
    return v.trim().slice(0, max);
  };
  const name = text('name', 120); if (name !== undefined) out.name = name;
  const prompt = text('prompt', 20_000); if (prompt !== undefined) out.prompt = prompt;
  const cwd = text('cwd', 4096);
  if (cwd !== undefined) {
    if (!cwd.startsWith('/')) throw new Error('cwd must be an absolute path');
    out.cwd = cwd;
  }
  const vpsId = text('vpsId', 64);
  if (vpsId !== undefined) {
    if (!db.select({ id: vps.id }).from(vps).where(eq(vps.id, vpsId)).get()) throw new Error('unknown VPS');
    out.vpsId = vpsId;
  }
  if (b.kind !== undefined) {
    if (!isSessionProvider(b.kind)) throw new Error('unknown backend');
    out.kind = b.kind;
  }
  for (const k of ['model', 'effort', 'permissionMode'] as const) {
    const v = b[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') throw new Error(`${k} must be a string or null`);
    out[k] = typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
  }
  if (b.enabled !== undefined) out.enabled = b.enabled === true;
  if (b.keepRuns !== undefined) {
    const n = Number(b.keepRuns);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('keepRuns must be between 1 and 50');
    out.keepRuns = n;
  }
  if (b.days !== undefined || b.time !== undefined || b.timezone !== undefined) {
    const s = { days: b.days, time: b.time, timezone: b.timezone } as RoutineSchedule;
    if (!isValidSchedule(s)) throw new Error('schedule needs at least one day, a HH:MM time and a valid time zone');
    out.days = [...new Set(s.days)].sort((x, y) => x - y);
    out.time = s.time;
    out.timezone = s.timezone;
  }
  if (!partial) {
    for (const k of ['name', 'prompt', 'cwd', 'vpsId', 'days', 'time', 'timezone'] as const) {
      if (out[k] === undefined) throw new Error(`${k} is required`);
    }
  }
  return out;
}

function liveStatus(sessionId: string, dbStatus: string): string {
  return peekStream(sessionId)?.status ?? dbStatus;
}

export function listRoutines(): RoutineView[] {
  const rows = db.select().from(routines).orderBy(routines.createdAt).all();
  const vpsNames = new Map(db.select({ id: vps.id, name: vps.name }).from(vps).all().map((v) => [v.id, v.name] as const));
  const lastIds = rows.map((r) => r.lastSessionId).filter((x): x is string => !!x);
  const lastRows = lastIds.length
    ? new Map(db.select({ id: agentSessions.id, status: agentSessions.status, archived: agentSessions.archived })
      .from(agentSessions).where(inArray(agentSessions.id, lastIds)).all().map((s) => [s.id, s] as const))
    : new Map();
  return rows.map((r) => {
    const last = r.lastSessionId ? lastRows.get(r.lastSessionId) : undefined;
    return {
      id: r.id, name: r.name, enabled: r.enabled === 1, ...scheduleOf(r),
      vpsId: r.vpsId, vpsName: vpsNames.get(r.vpsId) ?? null, cwd: r.cwd,
      kind: asSessionProvider(r.kind), model: r.model, effort: r.effort, permissionMode: r.permissionMode,
      prompt: r.prompt, keepRuns: r.keepRuns, nextRunAt: r.nextRunAt, lastRunAt: r.lastRunAt,
      lastSessionId: last ? r.lastSessionId : null,
      lastStatus: last ? (last.archived ? 'archived' : liveStatus(r.lastSessionId!, last.status)) : null,
      lastError: r.lastError,
    };
  });
}

/** Every run still in the database, newest first. */
export function listRoutineRuns(limit = 100): RoutineRun[] {
  const names = new Map(db.select({ id: routines.id, name: routines.name }).from(routines).all().map((r) => [r.id, r.name] as const));
  return db.select({
    id: agentSessions.id, name: agentSessions.name, routineId: agentSessions.routineId,
    status: agentSessions.status, archived: agentSessions.archived, createdAt: agentSessions.createdAt,
    kind: agentSessions.kind, unreadStop: agentSessions.unreadStop,
  }).from(agentSessions).where(isNotNull(agentSessions.routineId))
    .orderBy(desc(agentSessions.createdAt)).limit(limit).all()
    .map((s) => ({
      sessionId: s.id, name: s.name ?? '', routineId: s.routineId!, routineName: names.get(s.routineId!) ?? null,
      kind: asSessionProvider(s.kind), startedAt: s.createdAt * 1000, archived: s.archived === 1,
      status: s.archived ? 'archived' : liveStatus(s.id, s.status), unread: s.unreadStop === 1,
    }));
}

export function createRoutine(input: RoutineInput): string {
  const id = crypto.randomBytes(8).toString('hex');
  const row = {
    id, name: input.name, enabled: input.enabled === false ? 0 : 1,
    days: JSON.stringify(input.days), time: input.time, timezone: input.timezone,
    vpsId: input.vpsId, cwd: input.cwd, kind: input.kind ?? 'claude',
    model: input.model ?? null, effort: input.effort ?? null, permissionMode: input.permissionMode ?? null,
    prompt: input.prompt, keepRuns: input.keepRuns ?? 4,
  };
  db.insert(routines).values({ ...row, nextRunAt: nextFor(row, Date.now()) }).run();
  return id;
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>): boolean {
  const cur = db.select().from(routines).where(eq(routines.id, id)).get();
  if (!cur) return false;
  const next = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
    ...(patch.days !== undefined ? { days: JSON.stringify(patch.days), time: patch.time!, timezone: patch.timezone! } : {}),
    ...(patch.vpsId !== undefined ? { vpsId: patch.vpsId } : {}),
    ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
    ...(patch.keepRuns !== undefined ? { keepRuns: patch.keepRuns } : {}),
  };
  const merged = { ...cur, ...next };
  db.update(routines).set({
    ...next, nextRunAt: nextFor(merged, Date.now()), updatedAt: Math.floor(Date.now() / 1000),
  }).where(eq(routines.id, id)).run();
  return true;
}

export function deleteRoutine(id: string): boolean {
  const n = db.delete(routines).where(eq(routines.id, id)).run().changes;
  if (n) {
    // Its runs stay ordinary sessions.
    db.update(agentSessions).set({ routineId: null }).where(eq(agentSessions.routineId, id)).run();
  }
  return n > 0;
}

async function waitReady(sessionId: string): Promise<void> {
  const until = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const st = peekStream(sessionId)?.status;
    if (st === 'active' || st === 'thinking') return;
    if (st === 'error' || st === 'killed') throw new Error(`the new session failed to start (${st})`);
    if (Date.now() > until) throw new Error('the new session did not become ready in time');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Archive this routine's runs past the newest `keepRuns`, idle ones only. */
async function pruneRuns(r: Routine): Promise<void> {
  const runs = db.select({ id: agentSessions.id, status: agentSessions.status }).from(agentSessions)
    .where(and(eq(agentSessions.routineId, r.id), eq(agentSessions.archived, 0)))
    .orderBy(desc(agentSessions.createdAt)).all();
  for (const run of runs.slice(r.keepRuns)) {
    if (BUSY.has(liveStatus(run.id, run.status))) continue;
    try { await archiveSession(run.id); } catch (e) {
      console.warn(`[routines] ${r.name}: archiving run ${run.id} failed: ${(e as Error)?.message ?? e}`);
    }
  }
}

function runName(r: Routine, at: number): string {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, day: '2-digit', month: '2-digit' }).format(at);
  return `${r.name} · ${d}`;
}

/** Start one run now: a NEW unattended session, then the prompt. One run at
 *  a time per routine. Throws a user-facing message. */
export async function runRoutine(id: string): Promise<{ sessionId: string }> {
  const state = (g.__charonRoutines ??= { timer: null, running: new Set() });
  const r = db.select().from(routines).where(eq(routines.id, id)).get();
  if (!r) throw new Error('routine not found');
  if (state.running.has(id)) throw new Error('this routine is already starting a run');
  if (r.lastSessionId) {
    const last = db.select({ status: agentSessions.status, archived: agentSessions.archived })
      .from(agentSessions).where(eq(agentSessions.id, r.lastSessionId)).get();
    if (last && !last.archived && BUSY.has(liveStatus(r.lastSessionId, last.status))) {
      throw new Error('its previous run is still working');
    }
  }
  state.running.add(id);
  const now = Date.now();
  try {
    const kind = asSessionProvider(r.kind);
    const stream = await startNewSession({
      vpsId: r.vpsId, cwd: r.cwd, kind, name: runName(r, now),
      model: r.model, effort: r.effort,
      permissionMode: isSessionMode(kind, r.permissionMode) ? r.permissionMode : undefined,
      unattended: true,
    });
    db.update(agentSessions).set({ routineId: r.id }).where(eq(agentSessions.id, stream.id)).run();
    markSummaryDirty(stream.id);
    db.update(routines).set({ lastRunAt: now, lastSessionId: stream.id, lastError: null })
      .where(eq(routines.id, r.id)).run();
    await waitReady(stream.id);
    await stream.sendUserMessage(r.prompt);
    void pruneRuns(r);
    return { sessionId: stream.id };
  } catch (e) {
    const msg = ((e as Error)?.message ?? String(e)).slice(0, 500);
    db.update(routines).set({ lastError: msg }).where(eq(routines.id, r.id)).run();
    throw new Error(msg);
  } finally {
    state.running.delete(id);
  }
}

/** One scheduler pass: advance every due routine's `nextRunAt` FIRST (a
 *  compare-and-set: at most one run per slot), then start it — or skip a slot
 *  the hub slept through. */
export function tickRoutines(now = Date.now()): void {
  for (const r of db.select().from(routines).where(eq(routines.enabled, 1)).all()) {
    if (r.nextRunAt == null) {
      db.update(routines).set({ nextRunAt: nextFor(r, now) }).where(eq(routines.id, r.id)).run();
      continue;
    }
    if (r.nextRunAt > now) continue;
    const claimed = db.update(routines).set({ nextRunAt: nextFor(r, now) })
      .where(and(eq(routines.id, r.id), eq(routines.nextRunAt, r.nextRunAt))).run().changes;
    if (!claimed) continue;
    if (now - r.nextRunAt > CATCH_UP_MS) {
      db.update(routines).set({ lastError: `skipped the run of ${new Date(r.nextRunAt).toISOString()}: the hub was down` })
        .where(eq(routines.id, r.id)).run();
      continue;
    }
    void runRoutine(r.id).catch((e) => console.warn(`[routines] ${r.name}: ${(e as Error)?.message ?? e}`));
  }
}

/** Start the scheduler once per process (seed calls it from several paths). */
export function armRoutineScheduler(): void {
  const state = (g.__charonRoutines ??= { timer: null, running: new Set() });
  if (state.timer) return;
  state.timer = setInterval(() => {
    try { tickRoutines(); } catch (e) { console.warn('[routines] tick failed:', e); }
  }, TICK_MS);
  state.timer.unref?.();
}
