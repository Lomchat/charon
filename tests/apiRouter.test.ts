import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApiApp, type ApiRouteEntry } from '@/server/apiRouter';

// The Hono router must route exactly like Next's file routing did: every /api
// call goes through it.

const echo = (name: string) => async (req: Request, ctx: { params: Promise<Record<string, unknown>> }) =>
  Response.json({ name, method: req.method, params: await ctx.params });

const ROUTES: ApiRouteEntry[] = [
  // Registered in the "wrong" order on purpose: precedence is the router's job.
  { file: 'sessions/[id]/route.ts', mod: { GET: echo('session'), POST: echo('session') } },
  { file: 'sessions/import/route.ts', mod: { POST: echo('import') } },
  { file: 'sessions/route.ts', mod: { GET: echo('list') } },
  { file: 'preview/[token]/[[...path]]/route.ts', mod: { GET: echo('preview') } },
];

async function call(method: string, url: string) {
  const res = await buildApiApp(ROUTES).fetch(new Request(`http://hub${url}`, { method }));
  const body = method !== 'HEAD' && res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { status: res.status, allow: res.headers.get('allow'), body };
}

describe('API router', () => {
  it('a static segment beats a param, and a missing method is a 405, not the param route', async () => {
    expect((await call('POST', '/api/sessions/import')).body.name).toBe('import');
    expect(await call('GET', '/api/sessions/import')).toMatchObject({ status: 405, allow: 'POST, OPTIONS' });
    expect((await call('GET', '/api/sessions/abc')).body).toEqual({ name: 'session', method: 'GET', params: { id: 'abc' } });
    expect((await call('GET', '/api/sessions')).body.name).toBe('list');
  });

  it('params are decoded; an optional catch-all is the segment array, absent when empty', async () => {
    expect((await call('GET', '/api/sessions/a%20b')).body.params).toEqual({ id: 'a b' });
    expect((await call('GET', '/api/preview/t1/dir/x%2By.html')).body.params).toEqual({ token: 't1', path: ['dir', 'x+y.html'] });
    expect((await call('GET', '/api/preview/t1')).body.params).toEqual({ token: 't1' });
  });

  it('HEAD falls back to GET, OPTIONS answers 204, an unknown path 404', async () => {
    expect((await call('HEAD', '/api/sessions')).status).toBe(200);
    expect(await call('OPTIONS', '/api/sessions/import')).toMatchObject({ status: 204, allow: 'POST, OPTIONS' });
    expect((await call('GET', '/api/nope')).status).toBe(404);
  });

  it('legacy /api/claude/<route> aliases reach the same handler', async () => {
    expect((await call('GET', '/api/claude/sessions/abc')).body.params).toEqual({ id: 'abc' });
  });

  it('the generated table lists every server/api route file', () => {
    const root = path.resolve(__dirname, '..');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'route.ts' ? [path.join(dir, e.name)] : []);
    const onDisk = walk(path.join(root, 'server/api')).map((f) => path.relative(path.join(root, 'server/api'), f)).sort();
    const table = fs.readFileSync(path.join(root, 'server/apiRoutes.generated.ts'), 'utf8');
    const listed = [...table.matchAll(/\{ file: "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(onDisk);
    // A route left under app/api would be served by Next, around the router.
    expect(walk(path.join(root, 'app/api')).map((f) => path.relative(root, f))).toEqual(['app/api/[...path]/route.ts']);
  });
});
