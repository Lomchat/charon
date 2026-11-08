import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_PREVIEW_ESCAPE, LIVE_PREVIEW_ESCAPE_RELAY, LIVE_PREVIEW_SANDBOX, isLiveHtmlName, livePreviewMimeFor, livePreviewScope,
  livePreviewUrl, livePreviewWatches, parseLivePreviewPath,
} from '../lib/livePreview';
import {
  deriveLivePreviewKey, signLivePreviewToken, verifyLivePreviewToken,
} from '../lib/server/hub/livePreviewToken';

// §14.110: an HTML file's live view runs its scripts in an opaque origin and
// is authorized by its URL. These pin the three boundaries: what the URL can
// name, what the route will serve, and who can mint/replay the capability.

describe('live preview: the URL tail', () => {
  const p = (s: string) => parseLivePreviewPath(s.split('/'));

  it('accepts plain and encoded names, and maps a folder to its index', () => {
    expect(p('index.html')).toBe('index.html');
    expect(p('site/css/main.css')).toBe('site/css/main.css');
    expect(p('my%20page.html')).toBe('my page.html');
    expect(p('caf%C3%A9.html')).toBe('café.html');
    expect(parseLivePreviewPath([])).toBe('index.html');
    expect(p('docs/')).toBe('docs/index.html');
  });

  it('refuses parents, hidden segments, smuggled separators and controls', () => {
    for (const bad of [
      '..', '../etc/passwd.html', 'a/../b.html', '%2e%2e/x.html', '.', './a.html',
      '.env', '.git/config', 'site/.secret/a.css', 'a%2Fb.html', 'a%5Cb.html',
      'a%00.html', 'a%0a.html', 'a//b.html', '%E0%A4%A.html',
    ]) {
      expect(p(bad), bad).toBeNull();
    }
    expect(p('x'.repeat(5000) + '.html')).toBeNull();
  });
});

describe('live preview: what is served', () => {
  it('serves what a page loads, as the right type', () => {
    expect(livePreviewMimeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(livePreviewMimeFor('a/b/app.MJS')).toBe('text/javascript; charset=utf-8');
    expect(livePreviewMimeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(livePreviewMimeFor('data.json')).toBe('application/json; charset=utf-8');
    expect(livePreviewMimeFor('logo.svg')).toBe('image/svg+xml');
    expect(livePreviewMimeFor('font.woff2')).toBe('font/woff2');
    expect(livePreviewMimeFor('engine.wasm')).toBe('application/wasm');
  });

  it('serves nothing else — config, keys, source in other languages', () => {
    for (const name of ['.env', 'config.yaml', 'secrets.yml', 'id_rsa', 'server.key', 'cert.pem',
      'app.py', 'run.sh', 'db.sqlite', 'settings.toml', 'Makefile', 'archive.zip', 'notes.']) {
      expect(livePreviewMimeFor(name), name).toBeNull();
    }
  });

  it('offers the toggle to HTML files only', () => {
    expect(isLiveHtmlName('index.html')).toBe(true);
    expect(isLiveHtmlName('REPORT.HTM')).toBe(true);
    expect(isLiveHtmlName('page.xhtml')).toBe(true);
    expect(isLiveHtmlName('index.html.bak')).toBe(false);
    expect(isLiveHtmlName('style.css')).toBe(false);
  });

  it('never grants the page our origin or the top window', () => {
    expect(LIVE_PREVIEW_SANDBOX).toContain('allow-scripts');
    expect(LIVE_PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(LIVE_PREVIEW_SANDBOX).not.toContain('allow-top-navigation');
  });

  it('moves the scope under a hidden folder instead of refusing the page', () => {
    expect(livePreviewScope('/srv/app', 'site/index.html')).toEqual({ root: '/srv/app', path: 'site/index.html' });
    expect(livePreviewScope('/srv/app/', '.cache/report/index.html'))
      .toEqual({ root: '/srv/app/.cache', path: 'report/index.html' });
    expect(livePreviewScope('/srv', 'a/.b/c/.d/e/x.html')).toEqual({ root: '/srv/a/.b/c/.d', path: 'e/x.html' });
  });

  it('encodes each segment of the URL on its own', () => {
    expect(livePreviewUrl('lp1.a.b', 'my site/é#1.html')).toBe('/api/preview/lp1.a.b/my%20site/%C3%A9%231.html');
  });

  it('watches the page folder’s assets, not the whole repo', () => {
    expect(livePreviewWatches('/srv/app/site', '/srv/app/site/css/main.css')).toBe(true);
    expect(livePreviewWatches('/srv/app/site/', '/srv/app/site/index.html')).toBe(true);
    expect(livePreviewWatches('/srv/app/site', '/srv/app/site-old/a.css')).toBe(false);
    expect(livePreviewWatches('/srv/app/site', '/srv/app/server.py')).toBe(false);
    expect(livePreviewWatches('/srv/app/site', '/srv/app/site/.cache/a.js')).toBe(false);
    expect(livePreviewWatches('/srv/app/site', '/srv/app/site/build.sh')).toBe(false);
  });
});

describe('live preview: the capability token', () => {
  const key = deriveLivePreviewKey('test-secret');
  const now = 1_700_000_000;
  const claims = { vpsId: 'v1', root: '/srv/app', sid: 'abc', exp: now + 60 };

  it('round-trips its claims', () => {
    const t = signLivePreviewToken(claims, key);
    expect(t).toMatch(/^lp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyLivePreviewToken(t, key, now)).toEqual(claims);
  });

  it('rejects a forged, re-keyed, expired or malformed token', () => {
    const t = signLivePreviewToken(claims, key);
    const [, body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 'v1', r: '/', s: 'abc', e: now + 60 })).toString('base64url');
    expect(verifyLivePreviewToken(`lp1.${forged}.${sig}`, key, now)).toBeNull();
    expect(verifyLivePreviewToken(t, deriveLivePreviewKey('other-secret'), now)).toBeNull();
    expect(verifyLivePreviewToken(t, key, now + 60)).toBeNull();
    expect(verifyLivePreviewToken(`lp2.${body}.${sig}`, key, now)).toBeNull();
    expect(verifyLivePreviewToken(`lp1.${body}`, key, now)).toBeNull();
    expect(verifyLivePreviewToken(`lp1.${body}.${sig}x`, key, now)).toBeNull();
    expect(verifyLivePreviewToken('', key, now)).toBeNull();
    const relative = signLivePreviewToken({ ...claims, root: 'srv/app' }, key);
    expect(verifyLivePreviewToken(relative, key, now)).toBeNull();
  });

  it('derives a domain-separated key, random without any secret', () => {
    expect(deriveLivePreviewKey('s').equals(Buffer.from('s'))).toBe(false);
    expect(deriveLivePreviewKey('s').equals(deriveLivePreviewKey('s'))).toBe(true);
    expect(deriveLivePreviewKey(null).equals(deriveLivePreviewKey(null))).toBe(false);
  });
});

// ── The route itself, against a fake agent ─────────────────────────────────
const files: Record<string, string | Buffer> = {};
const calls: string[] = [];
const fakeClient = {
  status: 'connected',
  call: vi.fn(async (method: string, params: { root: string; path: string }) => {
    calls.push(`${method} ${params.root} ${params.path}`);
    const f = files[`${params.root}/${params.path}`];
    if (method === 'fs_stat') {
      if (f == null) return { ok: true, exists: false };
      return { ok: true, exists: true, size: Buffer.byteLength(f), version: 'v' };
    }
    if (method === 'fs_read') {
      if (f == null) return { ok: false, error: 'not found' };
      return Buffer.isBuffer(f)
        ? { ok: true, encoding: 'base64', content: f.toString('base64'), truncated: false, too_large: false }
        : { ok: true, encoding: 'utf8', content: f, truncated: false, too_large: false };
    }
    throw new Error(`unexpected ${method}`);
  }),
};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => fakeClient }));
vi.mock('@/lib/server/session', () => ({
  AUTH_DISABLED_SESSION_ID: 'auth-disabled',
  requireApiSession: vi.fn(async () => ({ userId: 1, sessionId: 'sess-live', aesKey: null })),
}));

describe('live preview: the routes', () => {
  let db: any;
  let schema: any;
  let GET: typeof import('@/app/api/preview/[token]/[[...path]]/route').GET;
  let MINT: typeof import('@/app/api/vps/[id]/fs/preview/route').POST;
  let key: Buffer;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'route-test-secret';
    const dbMod = await import('@/lib/db');
    db = dbMod.db;
    schema = dbMod;
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    migrate(db, { migrationsFolder: './drizzle' });
    db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
    db.insert(schema.vps).values({ id: 'v1', name: 'v', ip: '127.0.0.1', sshUser: 'root', agentVersion: '0.107.0' })
      .onConflictDoNothing().run();
    db.insert(schema.users).values({ passwordHash: 'x', passwordSalt: 'x', keyCheck: 'x' }).run();
    const [u] = db.select().from(schema.users).all();
    db.insert(schema.sessions).values({ id: 'sess-live', userId: u.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 }).run();
    db.insert(schema.sessions).values({ id: 'sess-old', userId: u.id, expiresAt: Math.floor(Date.now() / 1000) - 10 }).run();
    ({ GET } = await import('@/app/api/preview/[token]/[[...path]]/route'));
    ({ POST: MINT } = await import('@/app/api/vps/[id]/fs/preview/route'));
    key = (await import('@/lib/server/hub/livePreviewAuth')).livePreviewKey();
  });

  beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(files)) delete files[k];
    files['/srv/app/site/index.html'] = '<!doctype html><link rel=stylesheet href=main.css><p>héllo</p>';
    files['/srv/app/site/main.css'] = 'p{color:red}';
    files['/srv/app/site/logo.png'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    files['/srv/app/.env'] = 'SECRET=1';
    files['/srv/app/docs/index.html'] = '<p>docs</p>';
  });

  const token = (over: Partial<{ root: string; sid: string; exp: number; vpsId: string }> = {}) =>
    signLivePreviewToken({
      vpsId: 'v1', root: '/srv/app', sid: 'sess-live', exp: Math.floor(Date.now() / 1000) + 600, ...over,
    }, key);
  const get = (url: string, init?: RequestInit) => GET(new Request(`http://hub${url}`, init));

  it('mints a URL the route then serves, sandboxed, without a cookie', async () => {
    const minted = await MINT(new Request('http://hub/api/vps/v1/fs/preview', {
      method: 'POST', body: JSON.stringify({ root: '/srv/app', path: 'site/index.html' }),
    }), { params: Promise.resolve({ id: 'v1' }) });
    const body = await minted.json();
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^\/api\/preview\/lp1\.[^/]+\/site\/index\.html$/);

    const page = await get(body.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toBe(`sandbox ${LIVE_PREVIEW_SANDBOX}`);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('access-control-allow-origin')).toBe('*');
    const html = await page.text();
    expect(html).toContain('héllo');
    // Hub markup goes after the doctype (no quirks mode), before the page's
    // own: the scrollbar, then the framed-only Esc relay to the full-screen pane.
    expect(html.startsWith(`<!doctype html><style data-charon-scrollbar>`)).toBe(true);
    expect(html).toContain(`</style>${LIVE_PREVIEW_ESCAPE_RELAY}<link rel=stylesheet`);
    expect(LIVE_PREVIEW_ESCAPE_RELAY).toContain('if(window.parent===window)return;');
    expect(LIVE_PREVIEW_ESCAPE_RELAY.match(/postMessage\(([^)]*)\)/g)).toEqual([`postMessage("${LIVE_PREVIEW_ESCAPE}","*")`]);

    const css = await get(body.url.replace('index.html', 'main.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('refuses to mint for anything but HTML', async () => {
    const r = await MINT(new Request('http://hub/api/vps/v1/fs/preview', {
      method: 'POST', body: JSON.stringify({ root: '/srv/app', path: '.env' }),
    }), { params: Promise.resolve({ id: 'v1' }) });
    expect(r.status).toBe(400);
  });

  it('serves binary assets byte-exact, with ranges', async () => {
    const r = await get(`/api/preview/${token()}/site/logo.png`);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(files['/srv/app/site/logo.png']);
    const part = await get(`/api/preview/${token()}/site/logo.png`, { headers: { range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/8');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([0x4e, 0x47, 0]);
  });

  it('never reads a hidden file, an unlisted type, or a path outside the scope', async () => {
    for (const tail of ['.env', 'site/%2e%2e/.env', 'site/run.sh', 'site/a%2F..%2F.env']) {
      const r = await get(`/api/preview/${token()}/${tail}`);
      expect(r.status, tail).toBe(404);
      expect(r.headers.get('content-security-policy')).toContain('sandbox');
    }
    expect(calls).toEqual([]);
  });

  it('answers 403 to a dead, forged or logged-out token — before touching the VPS', async () => {
    for (const t of [
      token({ exp: Math.floor(Date.now() / 1000) - 1 }),
      token({ sid: 'sess-old' }),
      token({ sid: 'nobody' }),
      token({ sid: 'auth-disabled' }),
      token().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
    ]) {
      const r = await get(`/api/preview/${t}/site/index.html`);
      expect(r.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('answers a folder link with its index', async () => {
    const r = await get(`/api/preview/${token()}/docs`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('docs/index.html');
    const missing = await get(`/api/preview/${token()}/nothing`);
    expect(missing.status).toBe(404);
  });

  it('answers 404 for a missing asset', async () => {
    const r = await get(`/api/preview/${token()}/site/missing.js`);
    expect(r.status).toBe(404);
  });
});
