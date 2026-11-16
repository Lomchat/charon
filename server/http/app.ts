import 'server-only';
import path from 'node:path';
import { Hono } from 'hono';
import { runWithRequest } from '@/lib/server/requestContext';
import { handleApiRequest } from '../apiApp';
import { gate } from './gate';
import { securityHeaders, withHeaders } from './headers';
import { fileResponse, IMMUTABLE, publicEntries, REVALIDATE } from './static';
import { deskPage, hubPage, loginPage, mobileRedirect, viewPage, type TemplateLoader } from './pages';
import { loginPost, logoutPost } from './login';

// THE HTTP app, every request but the shell WebSocket (server.js). In order:
// request context → security headers → trailing-slash redirect → client
// build files (no auth) → the auth gate (gate.ts) → /api (apiRouter.ts),
// /login, /logout and the pages.

export type HttpAppOptions = {
  templates: TemplateLoader;
  /** dist/client in production; null in dev (Vite serves the files). */
  clientDir: string | null;
  /** Previous builds' assets (stale tabs' lazy chunks), or null. */
  assetArchiveDir: string | null;
};

const NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 — Charon</title></head>'
  + '<body style="font-family:system-ui;padding:40px"><h1>404</h1><p>This page could not be found.</p></body></html>';

export function createHttpApp(opts: HttpAppOptions): Hono {
  const app = new Hono();

  app.use('*', (c, next) => runWithRequest(c.req.raw, next));

  app.use('*', async (c, next) => {
    await next();
    c.res = withHeaders(c.res, securityHeaders(new URL(c.req.url).pathname), 'default');
  });

  // `/desk/` → `/desk`, as Next did.
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      return new Response(null, { status: 308, headers: { Location: url.pathname.replace(/\/+$/, '') + url.search } });
    }
    return next();
  });

  if (opts.clientDir) {
    const clientDir = opts.clientDir;
    const assetRoots = [path.join(clientDir, 'assets'), ...(opts.assetArchiveDir ? [opts.assetArchiveDir] : [])];
    const publics = publicEntries(clientDir);
    app.on(['GET', 'HEAD'], '*', async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname.startsWith('/assets/')) {
        return fileResponse(c.req.raw, assetRoots, pathname.slice('/assets/'.length), IMMUTABLE)
          ?? new Response('Not Found', { status: 404 });
      }
      const first = pathname.split('/')[1] ?? '';
      if (first && publics.has(first)) {
        const res = fileResponse(c.req.raw, [clientDir], pathname.slice(1), REVALIDATE);
        if (res) return res;
      }
      return next();
    });
  }

  app.use('*', async (c, next) => {
    const g = await gate(c.req.raw);
    if (!g.pass) return g.response;
    await next();
    if (g.setCookie) c.res = withHeaders(c.res, [['Set-Cookie', g.setCookie]], 'append');
  });

  app.all('/api/*', (c) => handleApiRequest(c.req.raw));
  app.get('/', (c) => hubPage(opts.templates, c.req.raw));
  app.get('/desk', (c) => deskPage(opts.templates, c.req.raw));
  app.get('/view', (c) => viewPage(opts.templates, c.req.raw));
  app.get('/login', (c) => loginPage(opts.templates, c.req.raw));
  app.post('/login', (c) => loginPost(c.req.raw));
  app.post('/logout', (c) => logoutPost(c.req.raw));
  app.get('/m', (c) => mobileRedirect(c.req.raw));
  app.get('/m/*', (c) => mobileRedirect(c.req.raw));

  app.notFound(() => new Response(NOT_FOUND_HTML, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  app.onError((err) => {
    console.error(err);
    return new Response(null, { status: 500 });
  });
  return app;
}
