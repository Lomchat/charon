import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { connectionConfig, parseEndpoint, publicConnection, savedEndpoint, saveEndpoint } from '@/lib/server/customEndpoints';
import { withEndpointChecks } from '@/lib/server/endpointProbe';
import { queueEndpoint } from '@/lib/server/agent/endpointOps';
import { emitGlobalSessionListChanged } from '@/lib/server/agent/sessionOps';
import { supportsCustomEndpoint } from '@/lib/customEndpoints';
import { enrichEndpoint } from '@/lib/server/opencodeModels';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
  if (!row) return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
  const state = publicConnection(row.codexConfig);
  if (state.active) state.active = await enrichEndpoint(state.active);
  if (state.pending?.endpoint) state.pending.endpoint = await enrichEndpoint(state.pending.endpoint);
  return NextResponse.json(state);
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get();
  if (!row) return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
  try {
    if (!supportsCustomEndpoint(row.kind)) throw new Error('Custom endpoints are not supported by this engine.');
    if (row.archived) throw new Error('Unarchive this session before changing its connection.');
    const body = await req.json();
    const current = connectionConfig(row.codexConfig);
    if (body.cancelPending) {
      current.pendingConnection = null; current.endpointError = null;
      db.update(claudeSessions).set({ codexConfig: JSON.stringify(current) }).where(eq(claudeSessions.id, id)).run();
      emitGlobalSessionListChanged(id);
      return NextResponse.json(publicConnection(JSON.stringify(current)));
    }
    let endpoint = null;
    if (body.endpoint !== null) {
      const previous = body.endpoint?.savedId ? savedEndpoint(body.endpoint.savedId)
        : body.endpoint?.useSessionCredential ? current.customEndpoint : undefined;
      endpoint = withEndpointChecks(parseEndpoint(body.endpoint, previous), row.vpsId);
    }
    const result = await queueEndpoint(id, endpoint);
    if (endpoint && body.saveForReuse === true) saveEndpoint(endpoint);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not configure endpoint.';
    return NextResponse.json({ error: /unknown method|no such method|-32601/i.test(message) ? 'Update the agent on this VPS to use custom endpoints.' : message }, { status: 400 });
  }
}
