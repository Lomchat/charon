// C17 — /desk SSR seeds the summary store exactly like `/`: the SAME builder
// (`ssrSummaries`), i.e. the list GET's summaries + the bus stamp read in the
// same synchronous section (I2), handed to <Desk> as `initialSummaries` /
// `initialSync` (the transport's first `?since=`).
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireSession: vi.fn(async () => ({ userId: 'u' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
// `/` reads the side-column layout cookie (app/panelLayout.ts); no request here.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
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
// The client shell (Three.js) is not under test: only the props it receives.
vi.mock('@/app/desk/Desk', () => ({ default: function Desk() { return null; } }));
vi.mock('@/app/HubPanel', () => ({ default: function HubPanel() { return null; } }));

const V = 'deskvps1';
const A = 'd1'.repeat(16);   // active, a pending permission
const B = 'd2'.repeat(16);   // sleeping, finished unread
const Z = 'd3'.repeat(16);   // archived: never in the summaries

type Element = { props: Record<string, any> };
let schema: any;
let deskPage: () => Promise<Element>;
let rootPage: () => Promise<Element>;
let bus: typeof import('@/lib/server/sync/syncBus');

beforeAll(async () => {
  schema = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(schema.db, { migrationsFolder: './drizzle' });
  schema.db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  schema.db.insert(schema.vps).values({ id: V, name: V, ip: '127.0.0.1', sshUser: 'root' }).run();
  schema.db.insert(schema.agentSessions).values([
    { id: A, vpsId: V, cwd: '/a', name: 'alpha', status: 'active', createdAt: 300 },
    { id: B, vpsId: V, cwd: '/b', name: 'beta', status: 'sleeping', unreadStop: 1, createdAt: 200 },
    { id: Z, vpsId: V, cwd: '/z', name: 'zeta', status: 'sleeping', archived: 1, createdAt: 100 },
  ]).run();
  schema.db.insert(schema.sessionPendingPermissions).values({
    id: 'perm-desk-1', sessionId: A, toolName: 'Bash', toolInput: '{"command":"ls"}',
    createdAt: Math.floor(Date.now() / 1000),
  }).run();
  // The pages compile with the classic JSX runtime here (tsconfig `preserve`).
  vi.stubGlobal('React', await import('react'));
  deskPage = (await import('@/app/desk/page')).default as unknown as () => Promise<Element>;
  rootPage = (await import('@/app/page')).default as unknown as () => Promise<Element>;
  bus = await import('@/lib/server/sync/syncBus');
});

describe('/desk SSR', () => {
  it('hands <Desk> the summaries and the bus stamp, built like `/`', async () => {
    const el = await deskPage();
    const { initialSummaries, initialSync, vpsList, folders } = el.props;
    expect(vpsList.map((v: { id: string }) => v.id)).toEqual([V]);
    expect(folders.map((f: { id: string }) => f.id)).toContain('default');

    // Non-archived summaries, full objects (gates + attention), list order.
    expect(initialSummaries.map((s: { id: string }) => s.id)).toEqual([A, B]);
    const a = initialSummaries.find((s: { id: string }) => s.id === A);
    expect(a.gates).toEqual([expect.objectContaining({ kind: 'permission', blocking: true, title: 'Bash' })]);
    expect(a.attention).toBe('blocked');
    const b = initialSummaries.find((s: { id: string }) => s.id === B);
    expect(b.unreadStop).toBe(1);

    // The stamp: the bus position at render time + this build's id.
    const now = bus.currentRev();
    expect(initialSync).toEqual({ epoch: now.epoch, rev: expect.any(Number), buildId: expect.any(String) });
    expect(initialSync.rev).toBeLessThanOrEqual(now.rev);

    // Same builder as `/`: the same summaries, the same kind of stamp.
    const root = await rootPage();
    expect(root.props.initialSummaries).toEqual(initialSummaries);
    expect(root.props.initialSync.epoch).toBe(initialSync.epoch);
    expect(root.props.initialSync.buildId).toBe(initialSync.buildId);
  });
});
