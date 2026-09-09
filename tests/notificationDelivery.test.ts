import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTIFICATION_EVENTS, normalizeBrowserNotifications, parseBrowserNotifications } from '@/lib/notificationPreferences';

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-notifications-')), 'test.db');
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({})) }));
vi.mock('@/lib/server/agent/sessionOps', () => ({ getOrCreateStream: vi.fn(), emitGlobalSettingsChanged: vi.fn() }));
const push = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
  setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({})),
}));
vi.mock('web-push', () => ({ default: push }));
let db: any, schema: any, setSetting: any, sendPushToAll: any, telegram: any;
beforeAll(async () => {
  schema = await import('@/lib/db'); db = schema.db;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  ({ setSetting } = await import('@/lib/server/claude/settings'));
  ({ sendPushToAll } = await import('@/lib/server/claude/webPush'));
  telegram = await import('@/lib/server/claude/telegram');
});
beforeEach(() => {
  vi.useFakeTimers();
  push.sendNotification.mockClear();
  db.delete(schema.claudePushSubs).run();
  db.delete(schema.sessionNotificationSettings).run();
  db.delete(schema.claudeSessions).run();
  db.insert(schema.vps).values({ id: 'notify-vps', name: 'Test VPS', ip: '127.0.0.1', sshUser: 'test' }).onConflictDoNothing().run();
  for (const [id, status, archived] of [['session-a', 'active', 0], ['session-b', 'sleeping', 0], ['archived', 'sleeping', 1], ['killed', 'killed', 0]]) {
    db.insert(schema.claudeSessions).values({ id, vpsId: 'notify-vps', cwd: '/tmp/test', name: id, status, archived }).run();
  }
  setSetting('telegram.enabled', 'true');
  setSetting('telegram.bot_token', 'test-token');
  setSetting('telegram.chat_id', 'test-chat');
  for (const { id } of NOTIFICATION_EVENTS) setSetting(`telegram.notify.${id}`, 'true');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function browser(id: string, value: unknown) {
  db.insert(schema.claudePushSubs).values({ id, endpoint: `https://push.example/${id}`,
    p256dh: 'key', authKey: 'auth', preferences: JSON.stringify(value) }).run();
}
describe('independent notification channels', () => {
  it('sends only to browsers which enable that event, with their own sound setting', async () => {
    browser('desktop', normalizeBrowserNotifications({ enabled: true, sound: false, events: { session_finished: false } }));
    browser('phone', normalizeBrowserNotifications({ enabled: true }));
    browser('off', normalizeBrowserNotifications({ enabled: false }));
    setSetting('notif.global_enabled', 'false'); // obsolete global flag cannot override a browser
    setSetting('telegram.enabled', 'false');
    await sendPushToAll({ event: 'session_finished', title: 'Done', body: 'Done' });
    expect(push.sendNotification.mock.calls).toHaveLength(1);
    expect((push.sendNotification.mock.calls as any)[0][0].endpoint).toContain('/phone');
    push.sendNotification.mockClear();
    await sendPushToAll({ event: 'session_error', title: 'Error', body: 'Error' });
    const sent = (push.sendNotification.mock.calls as any[]).map(([sub, body]) => ({ endpoint: sub.endpoint, body: JSON.parse(body) }));
    expect(sent).toHaveLength(2);
    expect(sent.find((s) => s.endpoint.endsWith('/desktop'))!.body.silent).toBe(true);
    expect(sent.find((s) => s.endpoint.endsWith('/phone'))!.body.silent).toBe(false);
  });
  it.each(NOTIFICATION_EVENTS)('Telegram respects its global $id switch without affecting browser preferences', async ({ id }) => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }));
    vi.stubGlobal('fetch', fetch);
    setSetting(`telegram.notify.${id}`, 'false');
    await telegram.sendPlainToTelegram('notice', '/', id);
    expect(fetch).not.toHaveBeenCalled();
    setSetting(`telegram.notify.${id}`, 'true');
    await telegram.sendPlainToTelegram('notice', '/', id);
    expect(fetch).toHaveBeenCalledTimes(1);
    setSetting('telegram.enabled', 'false');
    await telegram.sendPlainToTelegram('notice', '/', id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('filters interactive Telegram messages before sending buttons', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    setSetting('telegram.notify.permission', 'false');
    setSetting('telegram.notify.question', 'false');
    await telegram.sendPermissionToTelegram('session', 'permission', 'Bash', {});
    await telegram.sendQuestionToTelegram('session', 'question', []);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('browser exceptions replace defaults only for the selected session and endpoint', async () => {
    const override = normalizeBrowserNotifications({ enabled: true, sound: false, events: { question: false } });
    browser('desktop', normalizeBrowserNotifications({ enabled: false, sessions: { 'session-a': override } }));
    browser('phone', normalizeBrowserNotifications({ enabled: false }));
    await sendPushToAll({ event: 'session_finished', sessionId: 'session-a', title: 'Done', body: '' });
    expect(push.sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse((push.sendNotification.mock.calls as any)[0][1]).silent).toBe(true);
    await sendPushToAll({ event: 'session_finished', sessionId: 'session-b', title: 'Done', body: '' });
    await sendPushToAll({ event: 'question', sessionId: 'session-a', title: 'Question', body: '' });
    await sendPushToAll({ event: 'updates', title: 'Update', body: '' });
    expect(push.sendNotification).toHaveBeenCalledTimes(1);
  });
  it('Telegram exceptions can enable one session while global delivery is off, and inherit again after reset', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }));
    vi.stubGlobal('fetch', fetch);
    setSetting('telegram.enabled', 'false');
    const route = await import('@/app/api/claude/sessions/[id]/notifications/route');
    const context = { params: Promise.resolve({ id: 'session-a' }) };
    const put = (telegram: unknown) => route.PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ telegram }) }), context);
    expect((await put({ enabled: true, events: { session_error: false } })).status).toBe(200);
    await telegram.sendPlainToTelegram('done', '/?session=session-a', 'session_finished');
    await telegram.sendPlainToTelegram('done', '/?session=session-b', 'session_finished');
    await telegram.sendPlainToTelegram('error', '/?session=session-a', 'session_error');
    await telegram.sendPlainToTelegram('update', '/', 'updates');
    expect(fetch).toHaveBeenCalledTimes(1);
    await put(null);
    await telegram.sendPlainToTelegram('done', '/?session=session-a', 'session_finished');
    expect(fetch).toHaveBeenCalledTimes(1);
    setSetting('telegram.enabled', 'true');
    await telegram.sendPlainToTelegram('done', '/?session=session-a', 'session_finished');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('exception candidates include sleeping sessions and exclude archived/deleted ones; deletion cascades', async () => {
    const route = await import('@/app/api/claude/sessions/[id]/notifications/route');
    for (const id of ['session-b', 'archived', 'killed']) {
      await route.PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ telegram: { enabled: false } }) }), { params: Promise.resolve({ id }) });
    }
    const list = await import('@/app/api/claude/session-notifications/route');
    const rows = await (await list.GET()).json();
    expect(rows.map((r: any) => r.id).sort()).toEqual(['session-a', 'session-b']);
    expect(rows.find((r: any) => r.id === 'session-b').telegramException).toBe(true);
    expect(rows.find((r: any) => r.id === 'session-a').telegramException).toBe(false);
    db.delete(schema.claudeSessions).run();
    expect(db.select().from(schema.sessionNotificationSettings).all()).toHaveLength(0);
  });
  it('session preferences reject unknown sessions and malformed bodies', async () => {
    const route = await import('@/app/api/claude/sessions/[id]/notifications/route');
    expect((await route.GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'missing' }) })).status).toBe(404);
    for (const body of ['oops', { telegram: { enabled: 'false' } }, {}]) {
      expect((await route.PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'session-a' }) })).status).toBe(400);
    }
  });
  it('normalizes old or malformed preferences without treating string false as a boolean', () => {
    expect(parseBrowserNotifications(null).enabled).toBe(true);
    expect(parseBrowserNotifications('{broken', false).enabled).toBe(false);
    expect(normalizeBrowserNotifications({ enabled: 'false', events: { question: false } })).toMatchObject({
      enabled: false, sound: true, events: { question: false, permission: true },
    });
  });
});
