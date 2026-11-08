import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Sub-sessions (charon_peer start_sub_session): the mode ceiling, the depth and
// live-children limits, and the re-rooting of children when a parent is deleted.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/hub/webPush', () => ({ sendPushToAll: vi.fn(async () => {}) }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({
    setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {},
    call: vi.fn(async () => ({ ok: true })), status: 'connected',
  }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));

const VPS_ID = 'subvps';
let db: any;
let schema: any;
let sub: typeof import('@/lib/server/hub/subSessions');

function insert(id: string, extra: Record<string, unknown> = {}) {
  db.insert(schema.agentSessions).values({
    id, vpsId: VPS_ID, cwd: '/tmp/sub', name: id, status: 'active', ...extra,
  }).run();
}
const parentOf = (id: string) =>
  db.select().from(schema.agentSessions).all().find((r: any) => r.id === id)?.parentSessionId;

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'sub-vps', ip: '127.0.0.1', sshUser: 'root' })
    .onConflictDoNothing().run();
  sub = await import('@/lib/server/hub/subSessions');
});

beforeEach(() => {
  db.delete(schema.agentSessions).run();
});

describe('childSpawnMode', () => {
  const m = (parentKind: any, parentMode: string, childKind: any, requested?: string) =>
    sub.childSpawnMode({ parentKind, parentMode, childKind, requested });

  it('same provider: requested within the ceiling is kept, above it is clamped', () => {
    expect(m('claude', 'auto', 'claude', 'acceptEdits')).toEqual({ mode: 'acceptEdits', clamped: false });
    expect(m('claude', 'auto', 'claude', 'bypass')).toEqual({ mode: 'auto', clamped: true });
    expect(m('codex', 'workspace-write', 'codex', 'accept-all')).toEqual({ mode: 'workspace-write', clamped: true });
    expect(m('cursor', 'agent', 'cursor', 'force')).toEqual({ mode: 'agent', clamped: true });
    expect(m('cursor', 'force', 'cursor', 'force')).toEqual({ mode: 'force', clamped: false });
  });
  it('same provider, nothing requested: the parent mode', () => {
    expect(m('claude', 'acceptEdits', 'claude')).toEqual({ mode: 'acceptEdits', clamped: false });
    expect(m('codex', 'read-only', 'codex')).toEqual({ mode: 'read-only', clamped: false });
  });
  it('cross provider, nothing requested: highest mode within the normalized rank', () => {
    // claude auto = 2/3 -> codex workspace-write (1/2) is the highest <= 0.667
    expect(m('claude', 'auto', 'codex')).toEqual({ mode: 'workspace-write', clamped: false });
    // claude bypass = 1 -> everything allowed
    expect(m('claude', 'bypass', 'cursor')).toEqual({ mode: 'force', clamped: false });
    // codex read-only = 0 -> the least permissive
    expect(m('codex', 'read-only', 'cursor')).toEqual({ mode: 'plan', clamped: false });
    // codex workspace-write = 0.5 -> cursor sandbox (1/3) not agent (2/3)
    expect(m('codex', 'workspace-write', 'cursor')).toEqual({ mode: 'sandbox', clamped: false });
  });
  it('cross provider, requested: clamped to the ceiling; invalid request falls back', () => {
    expect(m('codex', 'read-only', 'claude', 'bypass')).toEqual({ mode: 'normal', clamped: true });
    expect(m('claude', 'bypass', 'codex', 'accept-all')).toEqual({ mode: 'accept-all', clamped: false });
    expect(m('claude', 'normal', 'codex', 'not-a-mode')).toEqual({ mode: 'read-only', clamped: false });
  });
});

describe('limits', () => {
  it('depth: a root parent => child depth 1; refused past MAX_SUBSESSION_DEPTH', () => {
    insert('r');
    insert('c1', { parentSessionId: 'r' });
    insert('c2', { parentSessionId: 'c1' });
    insert('c3', { parentSessionId: 'c2' });
    expect(sub.spawnLimitError('r')).toBeNull();     // child depth 1
    expect(sub.spawnLimitError('c2')).toBeNull();    // child depth 3
    expect(sub.spawnLimitError('c3')).toMatch(/depth/); // child depth 4
  });
  it('a parent cycle reads as too deep, never loops', () => {
    insert('x', { parentSessionId: 'y' });
    insert('y', { parentSessionId: 'x' });
    expect(sub.spawnLimitError('x')).toMatch(/depth/);
  });
  it('live children: only non-archived starting/active/thinking/background/failed count', () => {
    insert('p');
    for (let i = 0; i < sub.MAX_LIVE_SUBSESSIONS - 1; i++) insert(`k${i}`, { parentSessionId: 'p' });
    insert('sl', { parentSessionId: 'p', status: 'sleeping' });
    insert('ar', { parentSessionId: 'p', archived: 1 });
    expect(sub.liveChildCount('p')).toBe(sub.MAX_LIVE_SUBSESSIONS - 1);
    expect(sub.spawnLimitError('p')).toBeNull();
    insert('last', { parentSessionId: 'p', status: 'failed' });
    expect(sub.spawnLimitError('p')).toMatch(/too many/);
  });
});

describe('deleting a parent', () => {
  it('re-roots its children (no FK) and republishes their summaries', async () => {
    insert('par');
    insert('kid', { parentSessionId: 'par' });
    insert('other');
    const ops = await import('@/lib/server/agent/sessionOps');
    expect((await ops.deleteSession('par')).deleted).toBe(true);
    expect(parentOf('kid')).toBeNull();
    expect(parentOf('other')).toBeNull();
  });
  it('reparentChildren returns the re-rooted ids', () => {
    insert('p2');
    insert('a', { parentSessionId: 'p2' });
    expect(sub.reparentChildren('p2')).toEqual(['a']);
    expect(parentOf('a')).toBeNull();
  });
});
