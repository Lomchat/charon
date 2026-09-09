import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-bg-status-test-')),
  'test.db',
);

const telegramMocks = vi.hoisted(() => ({
  sendPlainToTelegram: vi.fn(async (_text: string, _linkPath?: string, _event?: string) => {}),
}));
const pushMocks = vi.hoisted(() => ({ sendPushToAll: vi.fn(async (_payload: any) => {}) }));
vi.mock('@/lib/server/claude/webPush', () => pushMocks);
const bgMocks = vi.hoisted(() => ({ read: vi.fn(async (..._args: any[]): Promise<any[]> => []) }));
vi.mock('@/lib/server/claude/codexBgState', () => ({ readCodexBgState: bgMocks.read }));

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
let recordedSessionUsage: any;
let runningBgTaskDetailsFromDb: any;
let setSetting: any;

function createStream(status: string = 'active', kind: 'claude' | 'codex' = 'claude') {
  return new SessionStream({
    id: SID, vpsId: VPS_ID, vpsName: 'test-vps', name: 'build',
    status, permissionMode: kind === 'codex' ? 'workspace-write' : 'normal',
    claudeSessionId: null, kind,
    lastStopNotifiedSeq: sessionRow()?.lastStopNotifiedSeq,
  }) as any;
}

function sessionRow(): any {
  return db.select().from(schema.claudeSessions).all().find((r: any) => r.id === SID);
}

/** The agent's own event shape for a background task lifecycle frame. */
function bgTask(seq: number, kind: string, taskId: string, status?: string) {
  return {
    event: 'bg_task', session_id: SID, seq, kind, task_id: taskId, ts: Date.now() / 1000,
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
  ({ recordedSessionUsage } = await import('@/lib/server/agent/sessionUsage'));
  ({ runningBgTaskDetailsFromDb } = await import('@/lib/server/claude/bgTaskState'));
  ({ setSetting } = await import('@/lib/server/claude/settings'));
});

beforeEach(() => {
  vi.useFakeTimers();
  telegramMocks.sendPlainToTelegram.mockClear();
  pushMocks.sendPushToAll.mockClear();
  setSetting('notif.global_enabled', 'false');
  bgMocks.read.mockReset().mockResolvedValue([]);
  db.delete(schema.claudeSessionMessages).run();
  db.delete(schema.claudeSessions).run();
  db.insert(schema.claudeSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'build', status: 'active',
  }).run();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('provider-neutral durable turn usage', () => {
  it('stores only final frames and aggregates Claude tree + Codex turn totals identically', () => {
    const claude = createStream('active', 'claude');
    claude._onAgentEvent({
      event: 'usage', session_id: SID, output_tokens: 9, input_tokens: 10,
      final: false,
    });
    claude._onAgentEvent({
      event: 'usage', session_id: SID, output_tokens: 90, input_tokens: 100,
      cache_read_tokens: 20, final: true, duration_ms: 1000, cost_usd: 0.1,
      tree: {
        input_tokens: 150, output_tokens: 120, cache_read_tokens: 30,
        cache_write_tokens: 5, cost_usd: 0.2, models: ['claude-test'],
      },
    });
    const codex = createStream('active', 'codex');
    codex._onAgentEvent({
      event: 'usage', session_id: SID, output_tokens: 80, input_tokens: 200,
      cache_read_tokens: 40, final: true, duration_ms: 2000,
    });

    const rows = db.select().from(schema.claudeSessionMessages).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row: any) => JSON.parse(row.content).provider)).toEqual(['claude', 'codex']);
    expect(recordedSessionUsage(SID)).toEqual({
      turns: 2,
      input_tokens: 350,
      output_tokens: 200,
      cache_read_tokens: 70,
      cache_write_tokens: 5,
      duration_ms: 3000,
      cost_usd: 0.2,
      models: ['claude-test'],
    });
  });
});

describe('a turn that ends with background tasks still running (§14.91)', () => {
  it.each(['claude', 'codex'] as const)('counts only live tasks and deduplicates %s notices across replay/restart', (kind) => {
    setSetting('notif.global_enabled', 'true');
    const stream = createStream('thinking', kind);
    stream._onAgentEvent(bgTask(1, 'started', 'expired'));
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    stream._onAgentEvent(bgTask(2, 'started', 'finished'));
    stream._onAgentEvent(bgTask(3, 'finished', 'finished'));
    stream._onAgentEvent(bgTask(4, 'started', 'live'));
    const stop = { event: 'stop', session_id: SID, subtype: 'end_turn', seq: 5 };
    stream._onAgentEvent(stop);
    stream._onAgentEvent(stop);
    const revived = createStream('background', kind);
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent(stop);
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    revived._onAgentEvent(stop);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    const body = `${kind === 'codex' ? 'Codex' : 'Claude'} finished its response — 1 background task still running`;
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledWith(
      `✓ test-vps · build\n${body}`, `/?session=${SID}`, 'session_background',
    );
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith({
      event: 'session_background', title: '✓ test-vps · build', body, tag: `stop-${SID}`,
      sessionId: SID, url: `/?session=${SID}`,
    });
    expect(sessionRow().unreadStop).toBe(0);
  });

  it('notifies a fatal error without needing a stop, and deduplicates a later stop', () => {
    const stream = createStream('thinking');
    stream._onAgentEvent({ event: 'error', session_id: SID, fatal: true, msg: 'SDK crashed', seq: 1 });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ event: 'session_error' }));
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'error', seq: 2 });
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
  });

  it('does not notify a background stop first seen during replay', () => {
    setSetting('notif.global_enabled', 'true');
    const stream = createStream();
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2 });
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    vi.advanceTimersByTime(60_000);
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
    expect(pushMocks.sendPushToAll).not.toHaveBeenCalled();
  });

  it('persists Stop-hook reconciliation for the bar, reload and quiet gate', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2, subtype: 'end_turn' });
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 3, background_tasks: [] });
    expect(stream.status).toBe('active');
    expect(runningBgTaskDetailsFromDb(SID)).toEqual([]);
    expect(createStream().hasRunningBgTasks()).toBe(false);
    const before = db.select().from(schema.claudeSessionMessages).all().length;
    stream._onAgentEvent({ event: 'replay_begin', session_id: SID });
    stream._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 3, background_tasks: [] });
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(db.select().from(schema.claudeSessionMessages).all()).toHaveLength(before);
  });

  it.each(['turn_end', 'ready'])('replaying %s without a prior receipt preserves newer persisted tasks', (event) => {
    const stream = createStream();
    const old = { event, session_id: SID, seq: 2, background_tasks: [] };
    stream._onAgentEvent(old); // Nothing to bury, hence no identity receipt.
    stream._onAgentEvent(bgTask(3, 'started', 'new-child'));
    const before = db.select().from(schema.claudeSessionMessages).all().length;
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent(old);
    revived._onAgentEvent(bgTask(3, 'started', 'new-child'));
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(runningBgTaskDetailsFromDb(SID).map((t: any) => t.taskId)).toEqual(['new-child']);
    expect(revived.hasRunningBgTasks()).toBe(true);
    expect(revived.status).toBe('background');
    expect(db.select().from(schema.claudeSessionMessages).all()).toHaveLength(before);
  });

  it('a replayed Stop hook still closes older absent tasks while preserving later ones', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'old-child'));
    stream._onAgentEvent(bgTask(3, 'started', 'new-child'));
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 2, background_tasks: [] });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(runningBgTaskDetailsFromDb(SID).map((t: any) => t.taskId)).toEqual(['new-child']);
    expect([...revived.bgRunning.keys()]).toEqual(['new-child']);
  });

  it('uses event time across sequence resets and protects a reused task from old hooks', () => {
    const stream = createStream();
    const now = Date.now() / 1000;
    stream._onAgentEvent({ ...bgTask(100, 'started', 'reused'), ts: now - 20 });
    stream._onAgentEvent({ ...bgTask(101, 'finished', 'reused'), ts: now - 10 });
    stream._onAgentEvent({ ...bgTask(1, 'updated', 'reused', 'running'), terminal: false, ts: now });
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 102, ts: now - 5, background_tasks: [] });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(revived.hasRunningBgTasks()).toBe(true);
    // A newer hook in the new sequence epoch can close it normally.
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, seq: 2, ts: now + 1, background_tasks: [] });
    expect(createStream().hasRunningBgTasks()).toBe(false);
  });

  it('does not let an undated legacy replay close hydrated tasks', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    const revived = createStream('background');
    revived._onAgentEvent({ event: 'replay_begin', session_id: SID });
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, background_tasks: [] });
    revived._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(revived.hasRunningBgTasks()).toBe(true);
    revived._onAgentEvent({ event: 'turn_end', session_id: SID, background_tasks: [] });
    expect(revived.hasRunningBgTasks()).toBe(false);
  });

  it.each(['turn_end', 'ready'])('keeps a task visible when the %s receipt cannot be persisted', (event) => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'child'));
    const persist = vi.spyOn(stream, '_persist').mockReturnValue(false);
    const broadcast = vi.spyOn(stream, '_broadcast');
    stream._onAgentEvent({ event, session_id: SID, seq: 2, background_tasks: [] });
    expect(stream.hasRunningBgTasks()).toBe(true);
    expect(broadcast.mock.calls.some(([ev]: any[]) => ev.type === 'bg_task' && ev.kind === 'finished')).toBe(false);
    persist.mockRestore();
    stream._onAgentEvent({ event, session_id: SID, seq: 2, background_tasks: [] });
    expect(createStream().hasRunningBgTasks()).toBe(false);
  });

  it('repairs a Codex child from native completion and ignores late metadata', async () => {
    const stream = createStream('active', 'codex');
    stream.claudeSessionId = 'parent';
    stream._onAgentEvent({ ...bgTask(1, 'started', 'child'), task_type: 'codex_subagent', ts: 100 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, seq: 2, subtype: 'end_turn' });
    stream.attach();
    bgMocks.read.mockResolvedValue([{ taskId: 'child', status: 'completed', at: Date.now() / 1000 + 1 }]);
    await stream._reconcileCodexBgTasks();
    expect(stream.status).toBe('active');
    expect(runningBgTaskDetailsFromDb(SID)).toEqual([]);
    stream._onAgentEvent({ ...bgTask(3, 'updated', 'child'), task_type: 'codex_subagent' });
    expect(stream.hasRunningBgTasks()).toBe(false);
    expect(createStream('active', 'codex').hasRunningBgTasks()).toBe(false);
    stream.detach();
  });

  it('keeps native running/unknown tasks and ignores an observation superseded by activity', async () => {
    const stream = createStream('active', 'codex');
    stream.claudeSessionId = 'parent';
    stream._onAgentEvent({ ...bgTask(1, 'started', 'child'), task_type: 'codex_subagent' });
    stream.attach();
    await stream._reconcileCodexBgTasks();
    expect(stream.hasRunningBgTasks()).toBe(true);
    let resolve!: (rows: any[]) => void;
    bgMocks.read.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const read = stream._reconcileCodexBgTasks();
    stream._onAgentEvent({ ...bgTask(2, 'updated', 'child'), task_type: 'codex_subagent' });
    resolve([{ taskId: 'child', status: 'completed', at: Date.now() / 1000 + 1 }]);
    await read;
    expect(stream.hasRunningBgTasks()).toBe(true);
    stream.detach();
  });
  it('adopts a background task discovered just after the provider stop', () => {
    const stream = createStream();
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 1 });
    expect(stream.status).toBe('active');
    stream._onAgentEvent(bgTask(2, 'started', 'codex-terminal:pty-1'));
    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
    expect(sessionRow().unreadStop).toBe(0);
  });

  it('goes background instead of done, and stays there under the daemon idle frame', () => {
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'launched it', seq: 2 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 3 });

    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
    // Announce the response while preserving the background status/marker.
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledWith(
      '✓ test-vps · build\nClaude finished its response — 1 background task still running',
      `/?session=${SID}`, 'session_background',
    );
    // Browser filtering is now per subscription, inside webPush.
    expect(pushMocks.sendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ event: 'session_background' }));
    expect(sessionRow().unreadStop).toBe(0);

    // The daemon goes idle the moment the turn ends and knows nothing about
    // the task it left running: its `active` must not repaint the session.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });
    expect(stream.status).toBe('background');
    expect(sessionRow().status).toBe('background');
  });

  it('announces the response, then completion once the last task ends', () => {
    setSetting('notif.global_enabled', 'true');
    const stream = createStream();
    stream._onAgentEvent(bgTask(1, 'started', 'task-a'));
    stream._onAgentEvent(bgTask(2, 'started', 'task-b'));
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 3 });
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 4 });

    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('2 background tasks still running');
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(1);
    expect(pushMocks.sendPushToAll.mock.calls[0][0].body)
      .toBe('Claude finished its response — 2 background tasks still running');
    // One of two: still background, no additional notice.
    stream._onAgentEvent(bgTask(5, 'finished', 'task-a'));
    expect(stream.status).toBe('background');
    vi.advanceTimersByTime(60_000);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);

    stream._onAgentEvent(bgTask(6, 'finished', 'task-b'));
    expect(stream.status).toBe('active');
    expect(sessionRow().status).toBe('active');
    // …but the notification waits out the grace, in case the model takes the
    // session back for a follow-up turn.
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(2);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[1][0])
      .toContain('background tasks finished');
    expect(pushMocks.sendPushToAll).toHaveBeenCalledTimes(2);
    expect(pushMocks.sendPushToAll.mock.calls[1][0].body).toBe('background tasks finished');
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

    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(stream.status).toBe('thinking');

    // That turn's own stop is a normal finish and notifies normally.
    stream._onAgentEvent({ event: 'assistant_text', session_id: SID, delta: 'all done', seq: 5 });
    stream._onAgentEvent({ event: 'stop', session_id: SID, subtype: 'end_turn', seq: 6 });
    // Nothing is running now, so the daemon's idle frame is adopted as usual.
    stream._onAgentEvent({ event: 'status', session_id: SID, status: 'active', seq: 7 });
    expect(stream.status).toBe('active');
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(2);
    expect(telegramMocks.sendPlainToTelegram.mock.calls[1][0])
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

  it('projects a running task even after it falls beyond the 200-message chat window', () => {
    const stream = createStream();
    stream._onAgentEvent({
      ...bgTask(1, 'started', 'task-beyond-window'),
      description: 'wait for the long benchmark',
      task_type: 'local_bash',
    });
    db.insert(schema.claudeSessionMessages).values(Array.from({ length: 201 }, (_, i) => ({
      sessionId: SID,
      role: 'user',
      content: `later message ${i}`,
      createdAt: Math.floor(Date.now() / 1000) + i + 1,
    }))).run();

    expect(runningBgTaskDetailsFromDb(SID)).toEqual([
      expect.objectContaining({
        taskId: 'task-beyond-window',
        description: 'wait for the long benchmark',
        taskType: 'local_bash',
        status: 'running',
      }),
    ]);
  });
});
