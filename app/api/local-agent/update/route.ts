import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { updateLocalAgent } from '@/lib/server/agent/localAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/local-agent/update
// Redéploie le .pyz embarqué sur ~/.charon/charon-agent.pyz puis restart le
// service systemd-user (fallback nohup).
export async function POST() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const result = await updateLocalAgent();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.detail }, { status: 500 });
  }
  return NextResponse.json(result);
}
