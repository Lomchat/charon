import 'server-only';
import type { Hono } from 'hono';
import { API_ROUTES } from './apiRoutes.generated';
import { buildApiApp } from './apiRouter';

// Every /api request, whoever hosts the server (Next's catch-all route
// app/api/[...path] today). Built once, on the first request.
let app: Hono | null = null;

export function handleApiRequest(req: Request): Promise<Response> {
  app ??= buildApiApp(API_ROUTES);
  return Promise.resolve(app.fetch(req));
}
