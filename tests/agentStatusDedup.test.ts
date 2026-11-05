import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

// An agent that stays down must not re-publish the same `vps_status` on every
// reconnect attempt (CLAUDE.md §14.52: the WRITE owes the frame — no change,
// no write, no frame). Each identical frame re-rendered every tab's hub.

vi.mock('server-only', () => ({}));

const VPS_ID = 'v-dedup';
const DAEMON_DOWN = 'charon-agent: socket /root/.charon/agent.sock not found (daemon not started?)';
let db: any;
let AgentClient: any;
const emitted: Array<{ status: string; extra: unknown }> = [];

beforeAll(async () => {
  ({ db } = await import('@/lib/db'));
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '192.0.2.9', sshUser: 'root', agentStatus: 'ok' }).onConflictDoNothing().run();
  const mod = await import('@/lib/server/agent/AgentClient');
  AgentClient = mod.AgentClient;
  mod.setVpsStatusEmitter((_id: string, status: string, extra: unknown) => { emitted.push({ status, extra }); });
});

beforeEach(() => {
  emitted.length = 0;
  db.update(schema.vps).set({ agentStatus: 'ok', agentLastError: null }).where(eq(schema.vps.id, VPS_ID)).run();
});

function downClient() {
  const client = new AgentClient({ id: VPS_ID, name: 'test' }, new Promise<void>(() => {}));
  (client as any)._scheduleReconnect = () => {};
  (client as any).reconnectAttempts = 5; // past the transient-drop gate
  return client;
}

function fail(client: any, stderr = DAEMON_DOWN, code = 2) {
  client.stderrBuf = stderr;
  client._handleExit(code);
}

const row = () => db.select().from(schema.vps).where(eq(schema.vps.id, VPS_ID)).get();

describe('agent failure status', () => {
  it('persists and publishes a NEW verdict once, then stays silent while it repeats', () => {
    const client = downClient();
    fail(client);
    expect(row().agentStatus).toBe('error');
    expect(row().agentLastError).toMatch(/^daemon-down/);
    expect(emitted).toHaveLength(1);
    fail(client);
    fail(client);
    expect(emitted).toHaveLength(1);
  });

  it('publishes again when the verdict changes, or when another writer moved the row', () => {
    const client = downClient();
    fail(client);
    fail(client, 'ssh: connect to host 192.0.2.9 port 22: Connection timed out', 255);
    expect(emitted).toHaveLength(2);
    expect(row().agentLastError).toMatch(/^ssh-unreachable/);
    // A refresh/update marked it ok meanwhile: the same failure is news again.
    db.update(schema.vps).set({ agentStatus: 'ok', agentLastError: null }).where(eq(schema.vps.id, VPS_ID)).run();
    fail(client, 'ssh: connect to host 192.0.2.9 port 22: Connection timed out', 255);
    expect(emitted).toHaveLength(3);
    expect(row().agentStatus).toBe('error');
  });

  it('a transient drop below the gate writes nothing', () => {
    const client = downClient();
    (client as any).reconnectAttempts = 0;
    fail(client);
    expect(emitted).toHaveLength(0);
    expect(row().agentStatus).toBe('ok');
  });
});
