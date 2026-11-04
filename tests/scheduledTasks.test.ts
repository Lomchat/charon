// A session's scheduled tasks (lib/scheduledTasks.ts): the CLI's list, as the
// agent forwards it on `turn_end`, kept on the session row and shipped in the
// summary; the `scheduled_fire` marker that opens the turn a task starts.
// Pure helpers first, then the real stream against the hermetic DB.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  describeSchedule, dueScheduledTask, fireKey, matchFiredTask, parseScheduledFire, scheduledFireContent,
  scheduledTaskBody, scheduledTaskTitle, type ScheduledTask,
} from '@/lib/scheduledTasks';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'u' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: vi.fn(async () => {}) }));
vi.mock('@/lib/server/hub/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(() => {}),
  sendPlainToTelegram: vi.fn(async () => {}),
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: async () => ({ ok: true }), status: 'connected',
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: 'aaaaaaaa', schedule: '7 20 * * *', recurring: true, prompt: '', nextFireAt: null, createdAt: 0, ...over,
});

describe('schedule in words', () => {
  it.each([
    ['7 20 * * *', true, 'every day at 20:07'],
    ['13 19 29 10 *', false, 'Oct 29 at 19:13'],
    ['13 19 29 10 *', true, 'every year on Oct 29 at 19:13'],
    ['*/5 * * * *', true, 'every 5 minutes'],
    ['* * * * *', true, 'every minute'],
    ['15 * * * *', true, 'every hour at :15'],
    ['0 */2 * * *', true, 'every 2 hours at :00'],
    ['30 8 * * 1-5', true, 'weekdays at 08:30'],
    ['0 9 * * 1', true, 'every Monday at 09:00'],
    ['0 9 * * 7', true, 'every Sunday at 09:00'],
    ['0 9 1 * *', true, 'monthly on day 1 at 09:00'],
    ['0 9 1,15 * *', true, 'cron 0 9 1,15 * *'],
    ['nonsense', true, 'nonsense'],
  ])('%s (recurring=%s) → %s', (cron, recurring, words) => {
    expect(describeSchedule(cron, recurring)).toBe(words);
  });
});

describe('title, body, fired-prompt matching', () => {
  it('a bracketed label is the title, the rest the body', () => {
    const t = task({ prompt: '[Recheck 2/3 — radar v2]  La condition est la suivante.' });
    expect(scheduledTaskTitle(t)).toBe('Recheck 2/3 — radar v2');
    expect(scheduledTaskBody(t)).toBe('La condition est la suivante.');
    expect(scheduledTaskTitle(task({ prompt: 'check the build\nthen report' }))).toBe('check the build');
    expect(scheduledTaskTitle(task({ prompt: '  ', id: 'c8eeae28' }))).toBe('task c8eeae28');
  });

  it('a fired prompt finds its task, clipped list prompts included', () => {
    const tasks = [
      task({ id: 'short', prompt: '[Recheck] look' }),
      task({ id: 'long', prompt: '[Recheck] look again… [+812 chars]' }),
      task({ id: 'other', prompt: 'unrelated' }),
    ];
    expect(matchFiredTask(tasks, '[Recheck] look again, then decide')?.id).toBe('long');
    expect(matchFiredTask(tasks, '[Recheck] look')?.id).toBe('short');
    expect(matchFiredTask(tasks, 'something else')).toBeNull();
    expect(matchFiredTask([task({ prompt: '' })], 'anything')).toBeNull();
  });

  it('the task a self-opened turn is the fire of: the most overdue due one, once', () => {
    const now = 1_000_000_000;
    const tasks = [
      task({ id: 'later', nextFireAt: now + 3_600_000 }),
      task({ id: 'early', nextFireAt: now + 60_000 }),        // a one-shot fired 90 s early
      task({ id: 'past', nextFireAt: now - 600_000 }),        // came due while the session worked
    ];
    expect(dueScheduledTask(tasks, now)?.id).toBe('past');
    expect(dueScheduledTask(tasks, now, new Set([fireKey(tasks[2])]))?.id).toBe('early');
    expect(dueScheduledTask([tasks[0]], now)).toBeNull();
    // A one-shot whose time passed has no next run: still due. A recurring
    // task without one is not.
    expect(dueScheduledTask([task({ id: 'gone', recurring: false })], now)?.id).toBe('gone');
    expect(dueScheduledTask([task({ id: 'unknown', recurring: true })], now)).toBeNull();
  });

  it('the marker content round-trips', () => {
    const c = scheduledFireContent({ type: 'scheduled_fire', source: 'schedule_wakeup', prompt: 'p', taskId: 'x', schedule: '* * * * *', recurring: true, rowId: 4 });
    expect(parseScheduledFire(c)).toEqual({ prompt: 'p', source: 'schedule_wakeup', taskId: 'x', schedule: '* * * * *', recurring: true });
    expect(parseScheduledFire('not json')).toBeNull();
  });
});

const VPS_ID = 'schedvps';
const SID = 'c'.repeat(32);
const T0 = Date.UTC(2026, 9, 28, 9, 0);

let db: any;
let schema: any;
let ops: typeof import('@/lib/server/agent/sessionOps');
let sums: typeof import('@/lib/server/sync/sessionSummaries');
let rebuild: typeof import('@/app/sessionRebuild').rebuildStateFromMessages;
let seq = 1;

function stamp(e: Record<string, unknown>, atMs = T0 + seq * 1000) {
  return { session_id: SID, seq: seq++, ts: atMs / 1000, ...e };
}
function rows() {
  return db.select().from(schema.sessionMessages).all().filter((r: any) => r.sessionId === SID);
}
const WIRE = [
  { id: '4a0671cb', schedule: '7 20 * * *', recurring: true, prompt: '[Recheck 3/3] daily', next_fire_at: T0 + 11 * 3600_000 },
  { id: 'c8eeae28', schedule: '13 19 29 10 *', recurring: false, prompt: '[Recheck 2/3] decide', next_fire_at: T0 + 34 * 3600_000 },
];

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'sched', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  db.insert(schema.agentSessions).values({ id: SID, vpsId: VPS_ID, cwd: '/tmp', status: 'active' }).onConflictDoNothing().run();
  db.insert(schema.appSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();
  ops = await import('@/lib/server/agent/sessionOps');
  sums = await import('@/lib/server/sync/sessionSummaries');
  ({ rebuildStateFromMessages: rebuild } = await import('@/app/sessionRebuild'));
});

afterEach(() => {
  for (const s of ops.listStreams()) s.detach();
  (globalThis as any)._sessionStreams?.clear();
  db.delete(schema.sessionMessages).where(eq(schema.sessionMessages.sessionId, SID)).run();
  db.update(schema.agentSessions).set({ scheduledTasksJson: null, lastSeenSeq: null, pendingAssistantMessageId: null })
    .where(eq(schema.agentSessions.id, SID)).run();
});

describe('the hub keeps the CLI list', () => {
  it('turn_end records the list on the session and its summary carries it', () => {
    // The CronCreate result is when the CLI created the task.
    db.insert(schema.sessionMessages).values({
      sessionId: SID, role: 'tool_result', tsMs: T0 - 86_400_000,
      content: JSON.stringify({ type: 'tool_result', tool_use_id: 'tu', content: 'Scheduled recurring job 4a0671cb (Every day at 8:07 PM). Next run: …' }),
    }).run();
    const s = ops.getOrCreateStream(SID)! as any;
    s._onAgentEvent(stamp({ event: 'turn_end', background_tasks: [], scheduled_tasks: WIRE, schedule_tz: { name: 'CET', offset_min: 60 } }));

    const sum = sums.buildSessionSummary(SID)!;
    expect(sum.scheduledTasks?.tz).toEqual({ name: 'CET', offsetMin: 60 });
    expect(sum.scheduledTasks?.tasks.map((t) => [t.id, t.recurring, t.nextFireAt])).toEqual([
      ['4a0671cb', true, T0 + 11 * 3600_000],
      ['c8eeae28', false, T0 + 34 * 3600_000],
    ]);
    const [daily, once] = sum.scheduledTasks!.tasks;
    expect(daily.createdAt).toBe(T0 - 86_400_000);
    // No CronCreate row: first seen = the turn end that reported it.
    expect(once.createdAt).toBe(T0 + 1000 * (seq - 1));
    // The raw column never reaches a browser.
    expect(JSON.parse(JSON.stringify(sum))).not.toHaveProperty('scheduledTasksJson');
  });

  it('an unchanged list is not rewritten; an absent one changes nothing; an empty one clears', async () => {
    const { recordScheduledTasks, readScheduledTasks } = await import('@/lib/server/hub/scheduledTaskState');
    expect(recordScheduledTasks(SID, WIRE, { name: 'CET', offset_min: 60 }, T0)).toBe(true);
    expect(recordScheduledTasks(SID, WIRE, { name: 'CET', offset_min: 60 }, T0 + 60_000)).toBe(false);
    expect(readScheduledTasks(SID)?.asOf).toBe(T0);

    const s = ops.getOrCreateStream(SID)! as any;
    s._onAgentEvent(stamp({ event: 'turn_end', background_tasks: [] }));
    expect(readScheduledTasks(SID)?.tasks).toHaveLength(2);
    // createdAt survives a later report of the same id.
    s._onAgentEvent(stamp({ event: 'turn_end', scheduled_tasks: [WIRE[0]], schedule_tz: { name: 'CET', offset_min: 60 } }));
    expect(readScheduledTasks(SID)?.tasks.map((t) => [t.id, t.createdAt])).toEqual([['4a0671cb', T0]]);
    s._onAgentEvent(stamp({ event: 'turn_end', scheduled_tasks: [], schedule_tz: { name: 'CET', offset_min: 60 } }));
    expect(readScheduledTasks(SID)?.tasks).toEqual([]);
  });
});

describe('a fired task opens its turn', () => {
  function fire(s: any, e: Record<string, unknown>, atMs?: number) {
    const frames: any[] = [];
    const spy = vi.spyOn(s, '_emitBroadcast').mockImplementation(((f: any) => { frames.push(f); }) as any);
    s._onAgentEvent(stamp(e, atMs));
    spy.mockRestore();
    return frames;
  }
  const markers = () => rows().filter((r: any) => r.role === 'event' && JSON.parse(r.content).type === 'scheduled_fire');

  it('an unprompted turn names the task that was due, which the rebuild renders', () => {
    const s = ops.getOrCreateStream(SID)! as any;
    s._onAgentEvent(stamp({ event: 'turn_end', scheduled_tasks: WIRE, schedule_tz: { name: 'CET', offset_min: 60 } }));
    // The daily task's slot: T0 + 11 h.
    const frames = fire(s, { event: 'unprompted_turn' }, T0 + 11 * 3600_000 + 2_000);

    const [row] = markers();
    expect(JSON.parse(row.content)).toEqual({
      type: 'scheduled_fire', source: 'schedule', prompt: '[Recheck 3/3] daily',
      taskId: '4a0671cb', schedule: '7 20 * * *', recurring: true,
    });
    expect(frames.find((f) => f.type === 'scheduled_fire')?.rowId).toBe(row.id);

    const msgs = rebuild([{ id: row.id, role: 'event', content: row.content, createdAt: 1 }] as any, 'active').messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['scheduled_fire']);
    expect(parseScheduledFire(msgs[0].content)?.taskId).toBe('4a0671cb');

    // That turn failed (no turn_end): the same fire is never named twice.
    fire(s, { event: 'unprompted_turn' }, T0 + 11 * 3600_000 + 90_000);
    expect(markers()).toHaveLength(1);
  });

  it('nothing due ⇒ no row; a prompt the opener carried wins', () => {
    const s = ops.getOrCreateStream(SID)! as any;
    s._onAgentEvent(stamp({ event: 'turn_end', scheduled_tasks: WIRE, schedule_tz: { name: 'CET', offset_min: 60 } }));
    expect(fire(s, { event: 'unprompted_turn' }, T0 + 3_600_000).some((f) => f.type === 'scheduled_fire')).toBe(false);
    expect(markers()).toHaveLength(0);

    fire(s, { event: 'unprompted_turn', prompt: '[Recheck 2/3] decide, then report' }, T0 + 3_600_000);
    expect(JSON.parse(markers()[0].content)).toMatchObject({ taskId: 'c8eeae28', prompt: '[Recheck 2/3] decide, then report' });
    // Text that is no task's prompt never stands in for the due one's.
    fire(s, { event: 'unprompted_turn', prompt: '<system-reminder>x</system-reminder>' }, T0 + 11 * 3600_000);
    expect(JSON.parse(markers()[1].content)).toMatchObject({ taskId: '4a0671cb', prompt: '[Recheck 3/3] daily' });
  });
});
