import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/auth/check — tiny authenticated liveness probe.
//
// Returns 200 {ok:true} when the session cookie is valid; the middleware
// returns 401 for an unauthenticated API route before this handler even runs.
//
// Used by globalEventStream's reconnect logic (CLAUDE.md §14.45 / §14.24) to
// DISTINGUISH the two "Apache returned non-200" cases when the SSE keeps
// failing to reconnect — the EventSource API cannot expose the HTTP status:
//   - 401  → the 24h session lapsed during a long outage. Every SSE reconnect
//            then 401s forever (silent). The client hard-reloads → middleware
//            sends it cleanly to /login?next=… .
//   - 200  → authed; the server is merely down/restarting (the normal backoff
//            + onmessage auto-reload path recovers it) or the reverse proxy
//            isn't forwarding the stream.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json({ ok: true });
}
