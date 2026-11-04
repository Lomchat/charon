// C13 — GET /api/sessions serves session SUMMARIES (§14.108) + `sync`.
// Default call: the COMPLETE non-archived list, reconciled (diffs and removals
// published). Filters: matching summaries only, no removal published.
// `includeArchived=1`: the matching archived rows as plain annotated items
// (`archived: 1`) — never built as summaries, never published (ResumeModal).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

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

const V1 = 'listvps1';
const V2 = 'listvps2';
const A = 'a3'.repeat(16);   // V1, active
const B = 'b3'.repeat(16);   // V2, sleeping
const Z = 'c3'.repeat(16);   // V1, archived

let db: any;
let schema: any;
let route: typeof import('@/app/api/sessions/route');
let sums: typeof import('@/lib/server/sync/sessionSummaries');
let bus: typeof import('@/lib/server/sync/syncBus');
let frames: Array<{ rev: number; type: string; sessionId: string | null; ev: any }> = [];
let off: (() => void) | null = null;

const tick = () => new Promise<void>((r) => setImmediate(r));
const get = async (qs = '') => {
  const res = await route.GET(new Request(`http://hub.test/api/sessions${qs}`));
  expect(res.status).toBe(200);
  return res.json();
};
const summaryFrames = () => frames.filter((f) => f.type === 'session_summary');

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  for (const id of [V1, V2]) {
    db.insert(schema.vps).values({ id, name: id, ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  }
  route = await import('@/app/api/sessions/route');
  sums = await import('@/lib/server/sync/sessionSummaries');
  bus = await import('@/lib/server/sync/syncBus');
});

beforeEach(async () => {
  db.delete(schema.sessionPendingPermissions).run();
  db.delete(schema.sessionPendingQuestions).run();
  db.delete(schema.agentSessions).run();
  db.insert(schema.agentSessions).values([
    { id: A, vpsId: V1, cwd: '/a', name: 'alpha', status: 'active', createdAt: 300 },
    { id: B, vpsId: V2, cwd: '/b', name: 'beta', status: 'sleeping', createdAt: 200 },
    { id: Z, vpsId: V1, cwd: '/z', name: 'zeta', status: 'sleeping', archived: 1, createdAt: 250 },
  ]).run();
  await tick();
  sums.resetSessionSummariesForTests();
  frames = [];
  off = bus.subscribeFrames((f, ev) => { frames.push({ rev: f.rev, type: f.type, sessionId: f.sessionId, ev }); });
});

afterEach(() => {
  off?.();
  off = null;
});

describe('GET /api/sessions', () => {
  it('default call: every non-archived summary, newest first, with `sync` ≥ every published frame', async () => {
    db.insert(schema.sessionPendingPermissions).values({
      id: 'p1', sessionId: A, toolName: 'Edit', toolInput: '{"file_path":"/a/x"}', status: 'pending',
    }).run();
    const body = await get();
    expect(body.sessions.map((s: any) => s.id)).toEqual([A, B]);
    expect(body.sessions.some((s: any) => s.archived)).toBe(false);
    const a = body.sessions[0];
    expect(a).toMatchObject({ liveStatus: 'active', pendingBlocking: 1, pendingAsync: 0, attention: 'blocked' });
    expect(a.gates).toEqual([expect.objectContaining({ id: 'p1', kind: 'permission', title: 'Edit' })]);
    expect(a.providerConfig).toBeUndefined();
    expect(body.vpsRuntime.map((v: any) => v.id).sort()).toEqual([V1, V2]);
    expect(body.meta).toBeTruthy();
    expect(body.sync).toEqual(bus.currentRev());
    // The first list after boot announces both to the other tabs (heal).
    expect(summaryFrames().map((f) => f.sessionId).sort()).toEqual([A, B].sort());
    for (const f of frames) expect(f.rev).toBeLessThanOrEqual(body.sync.rev);
  });

  it('heals: a write behind the bus is published, a vanished session publishes null', async () => {
    await get();
    frames = [];
    db.update(schema.agentSessions).set({ name: 'alpha 2' }).where(eq(schema.agentSessions.id, A)).run();
    db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, B)).run();
    const body = await get();
    expect(body.sessions.map((s: any) => s.id)).toEqual([A]);
    expect(summaryFrames().map((f) => [f.sessionId, f.ev.summary?.name ?? null])).toEqual(
      expect.arrayContaining([[A, 'alpha 2'], [B, null]]),
    );
    expect(summaryFrames()).toHaveLength(2);
    // Nothing changed ⇒ nothing published.
    frames = [];
    await get();
    expect(summaryFrames()).toHaveLength(0);
  });

  it('a filtered call returns the matching summaries and publishes no removal', async () => {
    await get();
    frames = [];
    const byVps = await get(`?vpsId=${V2}`);
    expect(byVps.sessions.map((s: any) => s.id)).toEqual([B]);
    expect(byVps.sessions[0]).toMatchObject({ liveStatus: 'sleeping', attention: null, gates: [] });
    const byStatus = await get('?status=active');
    expect(byStatus.sessions.map((s: any) => s.id)).toEqual([A]);
    // A (not in the V2 answer) and B (not in the status answer) stay known.
    expect(summaryFrames().filter((f) => f.ev.summary === null)).toHaveLength(0);
    expect(byStatus.sync).toEqual(bus.currentRev());
    // A change behind the bus is still healed by a filtered call (no removal).
    db.update(schema.agentSessions).set({ name: 'beta 2' }).where(eq(schema.agentSessions.id, B)).run();
    frames = [];
    const healed = await get(`?vpsId=${V2}`);
    expect(summaryFrames().map((f) => [f.sessionId, f.ev.summary?.name])).toEqual([[B, 'beta 2']]);
    for (const f of frames) expect(f.rev).toBeLessThanOrEqual(healed.sync.rev);
  });

  it('includeArchived=1 adds the archived rows as plain items and publishes nothing for them', async () => {
    const body = await get('?includeArchived=1');
    expect(body.sessions.map((s: any) => s.id)).toEqual([A, Z, B]);   // createdAt desc
    const z = body.sessions.find((s: any) => s.id === Z);
    expect(z.archived).toBe(1);
    expect(z.liveStatus).toBe('sleeping');
    expect(z.gates).toBeUndefined();
    expect(z.attention).toBeUndefined();
    expect(z.providerConfig).toBeUndefined();
    expect(frames.filter((f) => f.sessionId === Z)).toHaveLength(0);
    // Scoped by vpsId too (ResumeModal asks per VPS).
    const v2 = await get(`?includeArchived=1&vpsId=${V2}`);
    expect(v2.sessions.map((s: any) => s.id)).toEqual([B]);
    const v1 = await get(`?includeArchived=1&vpsId=${V1}`);
    expect(v1.sessions.map((s: any) => s.id)).toEqual([A, Z]);
    expect(frames.filter((f) => f.sessionId === Z)).toHaveLength(0);
  });

  it('the default list never seeds an archived row, even one published before it was archived', async () => {
    db.update(schema.agentSessions).set({ archived: 0 }).where(eq(schema.agentSessions.id, Z)).run();
    await get();
    db.update(schema.agentSessions).set({ archived: 1 }).where(eq(schema.agentSessions.id, Z)).run();
    frames = [];
    const body = await get();
    expect(body.sessions.map((s: any) => s.id)).not.toContain(Z);
    // It left the list: `null` once.
    expect(summaryFrames().filter((f) => f.sessionId === Z).map((f) => f.ev.summary)).toEqual([null]);
  });
});
