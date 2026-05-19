import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getLocalAgentStatus } from '@/lib/server/agent/localAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/local-agent/status
// Renvoie l'état de l'agent qui tourne sur la machine du dashboard.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const status = await getLocalAgentStatus();
  return NextResponse.json(status);
}
