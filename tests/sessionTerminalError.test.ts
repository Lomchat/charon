import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'charon-terminal-error-test-')),
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

const VPS_ID = 'terminalvps';
const SID = 'b'.repeat(32);

let db: any;
let schema: any;
let SessionStream: any;

function createStream(
  kind: 'claude' | 'codex' = 'claude',
  status: 'active' | 'failed' = 'active',
) {
  return new SessionStream({
    id: SID,
    vpsId: VPS_ID,
    vpsName: 'test-vps',
    name: 'build',
    status,
    permissionMode: 'normal',
    claudeSessionId: null,
    kind,
  }) as any;
}

function sessionStatus(): string | undefined {
  return db.select().from(schema.claudeSessions).all()
    .find((row: any) => row.id === SID)?.status;
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });

  db.insert(schema.vpsFolders).values({
    id: 'default', name: 'default', position: 0,
  }).onConflictDoNothing().run();
  db.insert(schema.vps).values({
    id: VPS_ID, name: 'test-vps', ip: '127.0.0.1', sshUser: 'root',
  }).onConflictDoNothing().run();
  db.insert(schema.claudeSettings).values({
    key: 'notif.global_enabled', value: 'false',
  }).onConflictDoNothing().run();

  ({ SessionStream } = await import('@/lib/server/agent/sessionOps'));
});

beforeEach(() => {
  telegramMocks.sendPlainToTelegram.mockClear();
  db.delete(schema.claudeSessionMessages).run();
  db.delete(schema.claudeSessions).run();
  db.insert(schema.claudeSessions).values({
    id: SID, vpsId: VPS_ID, cwd: '/tmp', name: 'build', status: 'active',
  }).run();
});

describe('terminal Claude assistant errors', () => {
  it('keeps API Error turns connected as failed, then Continue can recover to ready', async () => {
    const stream = createStream();
    stream._onAgentEvent({
      event: 'effective_model', session_id: SID, model: '<synthetic>', seq: 1,
    });
    stream._onAgentEvent({
      event: 'assistant_text', session_id: SID,
      delta: 'API Error: 529 {"type":"overloaded_error"}', seq: 2,
    });
    stream._onAgentEvent({
      event: 'stop', session_id: SID, subtype: 'error', seq: 3,
    });
    // This is the daemon's normal idle frame after ResultMessage. It must not
    // erase the terminal error selected from the final Claude bubble.
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'active', seq: 4,
    });

    expect(stream.status).toBe('failed');
    expect(sessionStatus()).toBe('failed');
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendPlainToTelegram).toHaveBeenCalledWith(
      expect.stringContaining('Claude ended with an API error'),
      `/?session=${SID}`,
    );
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('API Error: 529');

    await stream.sendUserMessage('Continue');
    expect(stream.status).toBe('thinking');
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'thinking', seq: 5,
    });
    stream._onAgentEvent({
      event: 'assistant_text', session_id: SID, delta: 'Recovered successfully.', seq: 6,
    });
    stream._onAgentEvent({
      event: 'stop', session_id: SID, subtype: 'end_turn', seq: 7,
    });
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'active', seq: 8,
    });
    expect(stream.status).toBe('active');
    expect(sessionStatus()).toBe('active');
  });

  it('latches an authentication failure and does not send the success wording', () => {
    const stream = createStream();
    stream._onAgentEvent({
      event: 'assistant_text', session_id: SID,
      delta: 'Failed to authenticate. API Error: 401 Unauthorized', seq: 10,
    });
    stream._onAgentEvent({
      event: 'stop', session_id: SID, subtype: 'error', seq: 11,
    });

    expect(sessionStatus()).toBe('failed');
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .toContain('Claude ended with an authentication error');
    expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
      .not.toContain('Claude finished its response');
  });

  it('preserves a durable connected failure when reconnect sees the daemon idle', () => {
    db.update(schema.claudeSessions).set({ status: 'failed' }).run();
    const stream = createStream('claude', 'failed');

    stream._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 1 });
    stream._onAgentEvent({
      event: 'stop', session_id: SID, subtype: 'duplicate', seq: 15,
    });
    stream._onAgentEvent({ event: 'replay_end', session_id: SID });
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'active', seq: 16,
    });

    expect(stream.status).toBe('failed');
    expect(sessionStatus()).toBe('failed');
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
  });

  it('keeps a real stopped SDK error distinct from a failed turn', () => {
    const stream = createStream();
    stream._onAgentEvent({
      event: 'error', session_id: SID, msg: 'client transport died', fatal: true, seq: 16,
    });
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'error', seq: 17,
    });

    expect(stream.status).toBe('error');
    expect(sessionStatus()).toBe('error');
  });

  it('replay clears an older failed turn when a later assistant turn succeeded', () => {
    const stream = createStream();
    stream._onAgentEvent({
      event: 'replay_begin', session_id: SID, count: 8,
    });
    stream._onAgentEvent({
      event: 'effective_model', session_id: SID, model: '<synthetic>', seq: 30,
    });
    stream._onAgentEvent({
      event: 'assistant_text', session_id: SID,
      delta: 'API Error: 529 Overloaded.', seq: 31,
    });
    stream._onAgentEvent({
      event: 'stop', session_id: SID, subtype: 'error', seq: 32,
    });
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'active', seq: 33,
    });
    stream._onAgentEvent({
      event: 'status', session_id: SID, status: 'thinking', seq: 34,
    });
    stream._onAgentEvent({
      event: 'effective_model', session_id: SID, model: 'claude-opus-5', seq: 35,
    });
    stream._onAgentEvent({
      event: 'assistant_text', session_id: SID,
      delta: 'The work completed successfully.', seq: 36,
    });
    stream._onAgentEvent({
      event: 'stop', session_id: SID, subtype: 'end_turn', seq: 37,
    });
    stream._onAgentEvent({
      event: 'replay_end', session_id: SID,
    });

    expect(stream.status).toBe('active');
    expect(sessionStatus()).toBe('active');
    expect(telegramMocks.sendPlainToTelegram).not.toHaveBeenCalled();
  });

  it('keeps ordinary and Codex turns on the normal finished path', () => {
    for (const [kind, text] of [
      ['claude', 'The requested work is complete.'],
      ['codex', 'API Error: this is Codex text and is outside this rule.'],
    ] as const) {
      telegramMocks.sendPlainToTelegram.mockClear();
      const stream = createStream(kind);
      stream._onAgentEvent({
        event: 'assistant_text', session_id: SID, delta: text, seq: 20,
      });
      stream._onAgentEvent({
        event: 'stop', session_id: SID, subtype: 'end_turn', seq: 21,
      });
      stream._onAgentEvent({
        event: 'status', session_id: SID, status: 'active', seq: 22,
      });

      expect(stream.status).toBe('active');
      expect(sessionStatus()).toBe('active');
      expect(telegramMocks.sendPlainToTelegram.mock.calls[0][0])
        .toContain('Claude finished its response');
    }
  });
});
