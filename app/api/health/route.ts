import { NextResponse } from 'next/server';
import { db, users } from '@/lib/db';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';
import { getSession, SESSION_COOKIE } from '@/lib/server/auth';

// GET /api/health — liveness + lightweight readiness probe.
//
// - No authentication REQUIRED. Intended for reverse proxies and container
//   orchestrators (Docker HEALTHCHECK, k8s liveness/readiness).
// - UNAUTHENTICATED callers get the minimal `{ok, db}` — no build sha,
//   uptime, or internal error strings (P3.3: diagnostics are authed-only).
// - A valid charon_session cookie unlocks the diagnostic fields.
// - Returns 200 when the DB is reachable, 503 otherwise.
// - Deliberately does not touch the agent pool (agents reconnect with
//   backoff; an unreachable VPS would otherwise mark the hub unhealthy).

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const startedAt = Date.now();
  let dbOk = false;
  let dbError: string | undefined;
  try {
    // Lightweight existence-only read on a tiny table (users always has 0 or
    // 1 row in the single-user model). Touching the DB confirms the WAL is
    // readable; no schema parsing is performed.
    db.select({ id: users.id }).from(users).limit(1).all();
    dbOk = true;
  } catch (e: unknown) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  let authed = false;
  try {
    const cookie = req.headers.get('cookie') ?? '';
    const m = ('; ' + cookie).match(new RegExp('; ' + SESSION_COOKIE + '=([^;]+)'));
    if (m) authed = (await getSession(decodeURIComponent(m[1]))) != null;
  } catch {}

  const body = {
    ok: dbOk,
    db: dbOk,
    ...(authed
      ? {
          agentPyzSha: getBuiltPyzSha(),
          uptimeSeconds: Math.round(process.uptime()),
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          ...(dbError ? { dbError } : {}),
        }
      : {}),
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
