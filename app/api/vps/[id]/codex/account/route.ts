import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';

async function load(id: string) {
  return db.select().from(vpsTable).where(eq(vpsTable.id, id)).get() ?? null;
}

function persist(vpsId: string, loggedIn: 0 | 1) {
  db.update(vpsTable).set({
    codexLoggedIn: loggedIn,
    codexLoggedInCheckedAt: Math.floor(Date.now() / 1000),
  }).where(eq(vpsTable.id, vpsId)).run();
  emitGlobalVpsStatus(vpsId, 'ok', { codexLoggedIn: loggedIn });
}

/** API-key login is one-shot: the key is sent to app-server and never stored by
 * Charon. Codex persists its own resulting account state under ~/.codex. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const vps = await load(id);
  if (!vps) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) return NextResponse.json({ ok: false, error: 'API key required' }, { status: 400 });
  try {
    const result = await getAgentClient(vps).call<{ ok?: boolean; error?: string }>(
      'codex_login_api_key', { api_key: apiKey },
    );
    if (!result?.ok) return NextResponse.json(result, { status: 400 });
    persist(id, 1);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const vps = await load(id);
  if (!vps) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  try {
    const result = await getAgentClient(vps).call<{ ok?: boolean; error?: string }>('codex_logout', {});
    if (!result?.ok) return NextResponse.json(result, { status: 400 });
    persist(id, 0);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
