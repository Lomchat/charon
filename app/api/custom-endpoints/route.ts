import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, customEndpoints } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { parseEndpoint, publicEndpoint, savedEndpoint, saveEndpoint } from '@/lib/server/customEndpoints';
import { withEndpointChecks } from '@/lib/server/endpointProbe';

export async function GET() {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  return NextResponse.json({ endpoints: db.select().from(customEndpoints).all().map((r) => publicEndpoint({ ...JSON.parse(r.config), id: r.id })) });
}
export async function POST(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  try {
    const body = await req.json();
    const previous = body.id ? savedEndpoint(body.id) : undefined;
    const endpoint = withEndpointChecks(parseEndpoint(body.endpoint, previous), String(body.vpsId || ''));
    return NextResponse.json({ endpoint: saveEndpoint(endpoint, body.id) });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save endpoint.' }, { status: 400 }); }
}
export async function DELETE(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await req.json();
  if (typeof id !== 'string') return NextResponse.json({ error: 'Endpoint ID required.' }, { status: 400 });
  db.delete(customEndpoints).where(eq(customEndpoints.id, id)).run();
  return NextResponse.json({ ok: true });
}
