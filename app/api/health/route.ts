import { NextResponse } from 'next/server';
import { db, users } from '@/lib/db';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';

// GET /api/health — liveness + lightweight readiness probe.
//
// - No authentication. Intended for reverse proxies and container
//   orchestrators (Docker HEALTHCHECK, k8s liveness/readiness).
// - Returns 200 with a small JSON body when the DB is reachable.
// - Returns 503 when the DB ping fails.
// - Deliberately does not touch the agent pool (agents reconnect with
//   backoff; an unreachable VPS would otherwise mark the hub unhealthy).

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
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

  const body = {
    ok: dbOk,
    db: dbOk,
    agentPyzSha: getBuiltPyzSha(),
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    ...(dbError ? { dbError } : {}),
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
