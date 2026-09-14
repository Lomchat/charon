import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { connectionConfig, parseEndpoint, savedEndpoint } from '@/lib/server/customEndpoints';
import { probeEndpoint } from '@/lib/server/endpointProbe';
import { supportsCustomEndpoint } from '@/lib/customEndpoints';

export async function POST(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    const body = await req.json();
    if (!supportsCustomEndpoint(body.engine)) throw new Error('Unsupported endpoint engine.');
    const row = body.sessionId ? db.select().from(claudeSessions).where(eq(claudeSessions.id, body.sessionId)).get() : undefined;
    const previous = body.endpoint?.savedId ? savedEndpoint(body.endpoint.savedId)
      : body.endpoint?.useSessionCredential && row ? connectionConfig(row.codexConfig).customEndpoint : undefined;
    const endpoint = parseEndpoint(body.action === 'models' ? { ...body.endpoint, model: body.endpoint?.model || 'catalog' } : body.endpoint, previous);
    const vpsId = row?.vpsId || body.vpsId;
    if (typeof vpsId !== 'string' || !vpsId) throw new Error('Choose a VPS for the test.');
    return NextResponse.json(await probeEndpoint(endpoint, body.engine, vpsId, body.action === 'models' ? 'models' : 'test'));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Endpoint test failed.';
    return NextResponse.json({ error: /unknown method|no such method|-32601/i.test(message) ? 'Update the agent on this VPS to use custom endpoints.' : message }, { status: 400 });
  }
}
