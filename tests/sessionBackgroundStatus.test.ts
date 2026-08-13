import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-bg-status-test-')),
  'test.db',
);

const telegramMocks = vi.hoisted(() => ({
  sendPlainToTelegram: vi.fn(async (_text: string, _linkPath?: string) => {}),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/telegram', () => ({
  sendPermissionToTelegram: vi.fn(async () => {}),
  sendQuestionToTelegram: vi.fn(async () => {}),
  markInteractionResolvedInTelegram: vi.fn(async () => {}),
  sendPlainToTelegram: telegramMocks.sendPlainToTelegram,
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    call: async () => ({ status: 'active' }),
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'bgvps';
const SID = 'c'.repeat(32);

let db: any;
let schema: any;
let SessionStream: any;

function createStream(status: string = 'active') {
  return new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test-vps', name: 'build',
    status, permissionMode: 'normal', claudeSessionId: null, kind: 'claude',
  }) as any;
}

function sessionRow(): any {
  return db.select().from(schema.claudeSessions).all().find((r: any) => r.id === SID);
}

/** The agent's own event shape for a background task lifecycle frame. */
function bgTask(seq: number, kind: string, taskId: string, status?: string) {
  return {
    event: 'bg_task', session_id: SID, seq, kind, task_id: taskId,
    ...(status ? { status } : {}),
  };
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });

  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 })
    .onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  db.insert(schema.claudeSettings).values({ key: 'notif.global_enabled', value: 'false' })
    .onConflictDoNothing().run();

  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
});

beforeEach(() => {
  vi.useFakeTimers();
  telegramMocks.sendPlainToTelegram.mockClear();
  db.delete(schema.claudeSessionMessages).run();
  db.delete(schema.claudeSessions).run();
  db.insert(schema.claudeSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'build', status: 'active',
  }).run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a turn that ends with background tasks still running (§14.91)', () => {
  it('goes background instead of done, and stays there under the daemon idle frame', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'launched it', seq: 2 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 3 });

    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
    // The finish is not announced and the card must not glow green.
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(sessionRow().unreadStop).toBe(0);

    // The daemon goes idle the moment the turn ends and knows nothing about
    // the task it left running: its `active` must not repaint the session.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });
    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
  });

  it('announces the finish only once the last task ends', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent(bgTask(2, 'started', 'task-b'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 3 });
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });

    // One of two: still background, still silent.
    stream._onAgentEvent(bgTask(5, 'finished', 'task-a'));
    expect(stream.status).toBe('background');
    vi.advanceTimersByTime(60_000);
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();

    stream._onAgentEvent(bgTask(6, 'finished', 'task-b'));
    expect(stream.status).toBe('active');
    expect(sessionRow().status).toBe('active');
    // …but the notification waits out the grace, in case the model takes the
    // session back for a follow-up turn.
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('background tasks finished');
    expect(sessionRow().unreadStop).toBe(1);
  });

  it('drops the deferred notice when a follow-up turn claims the session', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    stream._onAgentEvent(bgTask(3, 'finished', 'task-a'));
    // The finished task re-invoked the model (§14.54) before the grace ran out.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'thinking', seq: 4 });
    vi.advanceTimersByTime(60_000);

    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(stream.status).toBe('thinking');

    // That turn's own stop is a normal finish and notifies normally.
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'all done', seq: 5 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 6 });
    // Nothing is running now, so the daemon's idle frame is adopted as usual.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 7 });
    expect(stream.status).toBe('active');
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('Claude finished its response');
  });

  it('a task reported as completed via `updated` counts as finished', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('background');
    stream._onAgentEvent(bgTask(3, 'updated', 'task-a', 'completed'));
    expect(stream.status).toBe('active');
  });

  it('a normal turn with no background work is unaffected', () => {
    const stream = createStream();
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'done', seq: 1 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('active');
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('Claude finished its response');
    expect(sessionRow().unreadStop).toBe(1);
  });

  it('a sleeping session buries its background tasks instead of resurrecting them', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('background');

    // The CLI process is what runs those children: pausing it kills them.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'sleeping', seq: 3 });
    expect(stream.hasRunningBgTasks()).toBe(false);

    // A fresh stream (hub restart / resume) rebuilds the registry from the
    // rows: it must NOT come back believing the task is still running.
    const revived = createStream('active');
    expect(revived.hasRunningBgTasks()).toBe(false);
    revived._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 4 });
    expect(revived.status).toBe('active');
  });

  it('a restarted CLI (`ready`) buries the tasks the dead one left running', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 2 });
    expect(stream.status).toBe('background');

    // The daemon was restarted under the session (crash, OOM, systemctl): it
    // rebuilds the session with a BRAND-NEW ClaudeSDKClient and announces it
    // with `ready`. The old CLI's children died with it — nothing will ever
    // report that task finished.
    stream._onAgentEvent({ event: 'ready', session_id: SID, seq: 3 });
    expect(stream.hasRunningBgTasks()).toBe(false);

    // …so the fresh client's idle frame is adopted: the session is `active`
    // ("ready" in the sidebar) AND nothing claims to still be working.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });
    expect(stream.status).toBe('active');
    expect(sessionRow().status).toBe('active');

    // Durable: the burial is persisted as terminal rows, so neither a hub
    // restart nor sdkWatch's quiet gate sees a phantom running task.
    expect(createStream('active').hasRunningBgTasks()).toBe(false);
  });

  it('a replayed `ready` buries what preceded it, never what came after', () => {
    const stream = createStream();
    // The restart that matters usually drops the SSH connection too, so the
    // whole sequence arrives inside the reconnect replay.
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'ready', session_id: SID, seq: 2 });
    stream._onAgentEvent(bgTask(3, 'started', 'task-b'));
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });

    expect(stream.hasRunningBgTasks()).toBe(true);
    expect([...stream.bgRunning.keys()]).toEqual(['task-b']);
    // task-a is buried in the ROWS, so nothing resurrects it later.
    expect(createStream('background').hasRunningBgTasks()).toBe(true);

    // `ready` persists no row, so it has no identity gate: replaying the same
    // range again must not bury the task the ready itself started.
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    revived._onAgentEvent(bgTask(1, 'started', 'task-a'));
    revived._onAgentEvent({ event: 'ready', session_id: SID, seq: 2 });
    revived._onAgentEvent(bgTask(3, 'started', 'task-b'));
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(revived.hasRunningBgTasks()).toBe(true);
    expect([...revived.bgRunning.keys()]).toEqual(['task-b']);
  });

  it('rebuilds a still-running task from the persisted rows after a hub restart', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    expect(stream.hasRunningBgTasks()).toBe(true);

    const revived = createStream('background');
    expect(revived.hasRunningBgTasks()).toBe(true);
    revived._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 2 });
    expect(revived.status).toBe('background');
  });
});
