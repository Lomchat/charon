import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// THE HTTP auth gate and the login endpoint (§12, server/http/): every page
// and API request of the hub crosses them, so a regression here is a hole.

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-gate-test-')), 'test.db');
process.env.SESSION_SECRET = 'test-session-secret-for-hmac';
process.env.MASTER_PASSWORD = 'correct horse';
process.env.MASTER_SALT = '00112233445566778899aabbccddeeff';
process.env.CHARON_DISABLE_AUTOCONNECT = '1';
const TOKEN = 'a'.repeat(40);

vi.mock('server-only', () => ({}));

let gate: typeof import('@/server/http/gate');
let login: typeof import('@/server/http/login');
let staticFiles: typeof import('@/server/http/static');
let cookie: string;

const H = 'hub.example';
const req = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://${H}${p}`, { ...init, headers: { host: H, ...(init.headers ?? {}) } });

async function freshCookie(ip: string): Promise<string> {
  const form = new FormData();
  form.set('password', 'correct horse');
  form.set('next', '/desk');
  const res = await login.loginPost(req('/login', { method: 'POST', body: form, headers: { 'x-forwarded-for': ip } }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, next: '/desk' });
  const set = res.headers.get('set-cookie') ?? '';
  expect(set).toMatch(/HttpOnly/);
  expect(set).toMatch(/SameSite=Lax/);
  return set.split(';')[0];
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(dbMod.db, { migrationsFolder: './drizzle' });
  gate = await import('@/server/http/gate');
  login = await import('@/server/http/login');
  staticFiles = await import('@/server/http/static');
  cookie = await freshCookie('10.0.0.1');
});

afterEach(() => {
  delete process.env.CHARON_AUTH_REQUIRED;
  delete process.env.CHARON_API_TOKEN;
});

describe('HTTP gate', () => {
  it('without a session: API 401, page → /login?next=, /login and the public API pass', async () => {
    const api = await gate.gate(req('/api/settings'));
    expect(api.pass).toBe(false);
    if (!api.pass) expect(api.response.status).toBe(401);
    // Behind the proxy, its origin; direct, the request's own.
    const page = await gate.gate(req('/desk?x=1', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'charon.example' } }));
    expect(page.pass).toBe(false);
    if (!page.pass) {
      expect(page.response.status).toBe(307);
      expect(page.response.headers.get('location')).toBe('https://charon.example/login?next=%2Fdesk%3Fx%3D1');
    }
    const direct = await gate.gate(req('/'));
    if (!direct.pass) expect(direct.response.headers.get('location')).toBe(`http://${H}/login`);
    expect((await gate.gate(req('/login'))).pass).toBe(true);
    expect((await gate.gate(req('/api/health'))).pass).toBe(true);
  });

  it('a valid session passes and its cookie is re-sent; a forged one does not', async () => {
    const ok = await gate.gate(req('/api/settings', { headers: { cookie } }));
    expect(ok.pass).toBe(true);
    if (ok.pass) expect(ok.setCookie).toMatch(/^charon_session=.*HttpOnly/);
    const forged = await gate.gate(req('/api/settings', { headers: { cookie: 'charon_session=' + 'f'.repeat(64) } }));
    expect(forged.pass).toBe(false);
  });

  it('cookie-authenticated mutations from another origin are refused, even with auth off', async () => {
    const foreign = await gate.gate(req('/api/settings', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } }));
    expect(foreign.pass).toBe(false);
    if (!foreign.pass) expect(foreign.response.status).toBe(403);
    expect((await gate.gate(req('/api/settings', { method: 'POST', headers: { cookie, origin: `https://${H}` } }))).pass).toBe(true);
    process.env.CHARON_AUTH_REQUIRED = 'false';
    expect((await gate.gate(req('/api/settings'))).pass).toBe(true);
    expect((await gate.gate(req('/api/settings', { method: 'POST', headers: { origin: 'https://evil.example' } }))).pass).toBe(false);
  });

  it('a Bearer is judged alone: right token on an allow-listed route only, never a cookie fallback', async () => {
    process.env.CHARON_API_TOKEN = TOKEN;
    expect((await gate.gate(req('/api/sessions', { headers: { authorization: `Bearer ${TOKEN}` } }))).pass).toBe(true);
    expect((await gate.gate(req('/api/settings', { headers: { authorization: `Bearer ${TOKEN}` } }))).pass).toBe(false);
    expect((await gate.gate(req('/api/sessions', { headers: { authorization: 'Bearer wrong', cookie } }))).pass).toBe(false);
  });
});

describe('POST /login', () => {
  it('refuses a wrong password, a foreign origin, and throttles repeated failures', async () => {
    const attempt = (password: string, headers: Record<string, string>) => {
      const form = new FormData();
      form.set('password', password);
      return login.loginPost(req('/login', { method: 'POST', body: form, headers }));
    };
    const wrong = await attempt('nope', { 'x-forwarded-for': '10.0.0.2' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect((await attempt('correct horse', { 'x-forwarded-for': '10.0.0.3', origin: 'https://evil.example' })).status).toBe(403);
    let last = wrong;
    for (let i = 0; i < 10 && last.status !== 429; i++) last = await attempt('nope', { 'x-forwarded-for': '10.0.0.4' });
    expect(last.status).toBe(429);
    // Throttled even with the right password.
    expect((await attempt('correct horse', { 'x-forwarded-for': '10.0.0.4' })).status).toBe(429);
  });
});

describe('client build files', () => {
  it('never serve a path outside their root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-static-test-'));
    fs.writeFileSync(path.join(root, 'a.js'), 'ok');
    const get = (rel: string) => staticFiles.fileResponse(req('/assets/x'), [root], rel, staticFiles.IMMUTABLE);
    expect(get('a.js')?.status).toBe(200);
    expect(get('..%2F..%2Fetc%2Fpasswd')).toBeNull();
    expect(get('../a.js')).toBeNull();
    expect(get('%00')).toBeNull();
  });
});
