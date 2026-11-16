import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import type { HistoryPreviewResponse } from '@/lib/types/api';

// GET /api/vps/[id]/history/preview?kind=&id=&turns= — one session's first
// request and last exchanges, read from its transcript on the VPS (history.py:
// the agent resolves the id inside the provider's history folder only).
const ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? '';
  const sessionId = url.searchParams.get('id') ?? '';
  const turns = Math.max(1, Math.min(30, Number(url.searchParams.get('turns')) || 3));
  if (!(SESSION_PROVIDERS as readonly string[]).includes(kind) || !ID.test(sessionId)) {
    return NextResponse.json<HistoryPreviewResponse>({ ok: false, reason: 'invalid', error: 'kind and id are required' }, { status: 400 });
  }
  const [v] = db.select({ id: vps.id }).from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json<HistoryPreviewResponse>({ ok: false, reason: 'error', error: 'vps not found' }, { status: 404 });
  try {
    const r = await getAgentClientForVpsId(id).call('history_preview', {
      kind, session_id: sessionId, turns,
    }) as HistoryPreviewResponse;
    return NextResponse.json<HistoryPreviewResponse>(r);
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === -32601) {
      return NextResponse.json<HistoryPreviewResponse>({ ok: false, reason: 'unsupported' });
    }
    return NextResponse.json<HistoryPreviewResponse>({
      ok: false, reason: 'offline', error: e instanceof Error ? e.message : String(e),
    }, { status: 502 });
  }
}
