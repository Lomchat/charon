import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

// The request being served, for code deep in a handler that needs a cookie or
// a header (`session.ts § readSession`). The HTTP app (server/http/app.ts)
// runs every request inside `runWithRequest`; outside one, there is no request.

type Store = { req: Request };

const g = globalThis as typeof globalThis & { __charonRequestContext?: AsyncLocalStorage<Store> };
const als = (g.__charonRequestContext ??= new AsyncLocalStorage<Store>());

export function runWithRequest<T>(req: Request, fn: () => T): T {
  return als.run({ req }, fn);
}

export function currentRequest(): Request | null {
  return als.getStore()?.req ?? null;
}

/** One cookie of a `Cookie` header (decoded), or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

/** A cookie of the current request, or null outside a request. */
export function requestCookie(name: string): string | null {
  return readCookie(currentRequest()?.headers.get('cookie'), name);
}
