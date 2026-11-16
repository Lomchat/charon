import { Hono } from 'hono';

// THE API router: file routing over server/api/**/route.ts, served by Hono.
// A route module exports its handlers by method:
// `export async function GET(req: Request, { params }: { params: Promise<P> })`.
//
// Semantics:
//   - precedence per segment: static > [param] > [...all] > [[...optional]]
//     (`/sessions/import` beats `/sessions/[id]`; Hono runs the matching
//     routes in REGISTRATION order, so we register in that order);
//   - a matched path without the method answers 405 (+ Allow), never falls
//     through to a dynamic sibling; HEAD falls back to GET; OPTIONS → 204;
//   - params are decoded; a catch-all is the array of decoded segments,
//     absent when an optional one is empty;
//   - the legacy `/api/claude/<route>` aliases (old tabs) resolve to `/api/<route>`.

export type ApiRouteModule = Record<string, unknown>;
export type ApiRouteEntry = { file: string; mod: ApiRouteModule };

type Params = Record<string, string | string[]>;
type Handler = (req: Request, ctx: { params: Promise<Params> }) => Response | Promise<Response>;

type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'catchAll'; name: string; optional: boolean };

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

const LEGACY_ALIAS = /^\/api\/claude\/(events|focus|push|search|session-notifications|sessions|settings|telegram)(?=\/|$)/;

/** The path the router matches: the URL's pathname, legacy aliases resolved. */
export function apiPath(url: string): string {
  return new URL(url).pathname.replace(LEGACY_ALIAS, '/api/$1');
}

/** `sessions/[id]/route.ts` → its segments (the file name dropped). */
export function parseRouteFile(file: string): Segment[] {
  return file.split('/').slice(0, -1).map((dir): Segment => {
    let m = /^\[\[\.\.\.(\w+)\]\]$/.exec(dir);
    if (m) return { kind: 'catchAll', name: m[1], optional: true };
    m = /^\[\.\.\.(\w+)\]$/.exec(dir);
    if (m) return { kind: 'catchAll', name: m[1], optional: false };
    m = /^\[(\w+)\]$/.exec(dir);
    if (m) return { kind: 'param', name: m[1] };
    // Route groups, private folders, Hono metacharacters: not supported.
    if (!/^[A-Za-z0-9._-]+$/.test(dir) || dir.startsWith('_')) {
      throw new Error(`unsupported API route segment "${dir}" in ${file}`);
    }
    return { kind: 'static', value: dir };
  });
}

function rank(s: Segment): number {
  if (s.kind === 'static') return 0;
  if (s.kind === 'param') return 1;
  return s.optional ? 3 : 2;
}

function compareRoutes(a: Segment[], b: Segment[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = rank(a[i]) - rank(b[i]);
    if (d) return d;
  }
  return a.length - b.length;
}

function honoPaths(segs: Segment[]): string[] {
  let base = '/api';
  for (const s of segs) {
    if (s.kind === 'static') base += `/${s.value}`;
    else if (s.kind === 'param') base += `/:${s.name}`;
    else return s.optional ? [base, `${base}/*`] : [`${base}/*`];
  }
  return [base];
}

function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

function handlerFor(mod: ApiRouteModule, method: string): Handler | null {
  const fn = mod[method] ?? (method === 'HEAD' ? mod.GET : undefined);
  return typeof fn === 'function' ? (fn as Handler) : null;
}

function allowHeader(mod: ApiRouteModule): string {
  const allowed: string[] = METHODS.filter((m) => typeof mod[m] === 'function');
  if (allowed.includes('GET') && !allowed.includes('HEAD')) allowed.push('HEAD');
  if (!allowed.includes('OPTIONS')) allowed.push('OPTIONS');
  return allowed.join(', ');
}

export function buildApiApp(routes: ApiRouteEntry[]): Hono {
  const app = new Hono({ getPath: (req) => apiPath(req.url) });
  const parsed = routes
    .map((r) => ({ ...r, segs: parseRouteFile(r.file) }))
    .sort((a, b) => compareRoutes(a.segs, b.segs) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  for (const route of parsed) {
    const catchAllAt = route.segs.findIndex((s) => s.kind === 'catchAll');
    const catchAll = catchAllAt >= 0 ? (route.segs[catchAllAt] as Extract<Segment, { kind: 'catchAll' }>) : null;
    const dispatch = async (c: { req: { raw: Request; method: string; param: (n: string) => string | undefined } }): Promise<Response> => {
      const method = c.req.method.toUpperCase();
      const params: Params = {};
      for (const s of route.segs) {
        if (s.kind === 'param') params[s.name] = c.req.param(s.name) ?? '';
      }
      if (catchAll) {
        // `/api` + the segments before the catch-all, then the rest.
        const rest = apiPath(c.req.raw.url).split('/').filter(Boolean).slice(1 + catchAllAt).map(decode);
        if (rest.length) params[catchAll.name] = rest;
        else if (!catchAll.optional) return new Response('Not Found', { status: 404 });
      }
      const handler = handlerFor(route.mod, method);
      if (!handler) {
        const allow = allowHeader(route.mod);
        return method === 'OPTIONS'
          ? new Response(null, { status: 204, headers: { Allow: allow } })
          : new Response(null, { status: 405, headers: { Allow: allow } });
      }
      return handler(c.req.raw, { params: Promise.resolve(params) });
    };
    for (const p of honoPaths(route.segs)) app.all(p, dispatch);
  }

  app.notFound(() => new Response('Not Found', { status: 404 }));
  // A throwing handler: logged, empty 500.
  app.onError((err) => {
    console.error(err);
    return new Response(null, { status: 500 });
  });
  return app;
}
