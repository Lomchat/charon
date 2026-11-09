import { beforeAll, describe, expect, it, vi } from 'vitest';

// Hot agent updates (§14.117): the hub moves an outdated session to the new
// agent runtime by stopping and resuming its provider CLI. That kills whatever
// the CLI was doing — so the move must be refused while anything runs: a
// turn, a human gate, a background task, recent activity.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ listAgentClients: () => [] }));

let db: any;
let schema: any;
let mod: typeof import('@/lib/server/hub/sessionRuntimes');

const VPS = 'rt-vps';
const OLD_S = Math.floor(Date.now() / 1000) - 3600;
let n = 0;

function session(status = 'active'): string {
  const id = (++n).toString(16).padStart(32, 'a');
  db.insert(schema.agentSessions).values({ id, vpsId: VPS, cwd: '/tmp', name: 'rt', status, kind: 'claude' }).run();
  // One old row: a session with a history, quiet for an hour.
  db.insert(schema.sessionMessages).values({ sessionId: id, role: 'user', content: 'hi', createdAt: OLD_S }).run();
  return id;
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'rt', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  mod = await import('@/lib/server/hub/sessionRuntimes');
});

/** The registry folds cold sessions in background slices: wait it out. */
async function settled(id: string): Promise<string | null> {
  let why = mod.migrationBlocker(id);
  for (let i = 0; i < 200 && why === 'background task'; i++) {
    await new Promise((r) => setTimeout(r, 50));
    why = mod.migrationBlocker(id);
  }
  return why;
}

describe('migrationBlocker', () => {
  it('lets an idle session move', async () => {
    expect(await settled(session())).toBeNull();
  });

  it('refuses while a turn runs or the session is not live', () => {
    expect(mod.migrationBlocker(session('thinking'))).toBe('status thinking');
    expect(mod.migrationBlocker(session('sleeping'))).toBe('status sleeping');
  });

  it('refuses while a human gate waits', () => {
    const id = session();
    db.insert(schema.sessionPendingPermissions).values({
      id: `perm-${id}`, sessionId: id, toolName: 'Bash', toolInput: '{}', status: 'pending',
    }).run();
    expect(mod.migrationBlocker(id)).toBe('pending permission');
  });

  it('refuses right after activity', () => {
    const id = session();
    db.insert(schema.sessionMessages).values({ sessionId: id, role: 'assistant', content: 'done' }).run();
    expect(mod.migrationBlocker(id)).toBe('recent activity');
  });

  it('refuses while a background task runs, and not once it ended', async () => {
    const id = session();
    const started = OLD_S + 600;
    db.insert(schema.sessionMessages).values({
      sessionId: id, role: 'event', createdAt: started,
      content: JSON.stringify({ type: 'bg_task', kind: 'started', taskId: 't1', description: 'dev server' }),
    }).run();
    // A cold registry is busy too, so the answer is the same while it warms.
    let why: string | null = null;
    for (let i = 0; i < 40; i++) {
      why = mod.migrationBlocker(id);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(why).toBe('background task');

    const ended = session();
    for (const [kind, extra] of [['started', {}], ['finished', { status: 'completed', terminal: true }]] as const) {
      db.insert(schema.sessionMessages).values({
        sessionId: ended, role: 'event', createdAt: started,
        content: JSON.stringify({ type: 'bg_task', kind, taskId: 't2', ...extra }),
      }).run();
    }
    expect(await settled(ended)).toBeNull();
  });
});
