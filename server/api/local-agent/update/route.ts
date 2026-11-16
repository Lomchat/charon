import { requireApiSession } from '@/lib/server/session';
import { updateLocalAgent } from '@/lib/server/agent/localAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/local-agent/update
// Redeploys the embedded .pyz to ~/.charon/charon-agent.pyz then restarts
// the systemd-user service (nohup fallback).
export async function POST() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const result = await updateLocalAgent();
  if (!result.ok) {
    return Response.json({ ok: false, error: result.detail }, { status: 500 });
  }
  return Response.json(result);
}
