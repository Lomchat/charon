import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  return NextResponse.json(await callSessionRpc(id, 'list_background_terminals'));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const processId = typeof body?.processId === 'string' ? body.processId : '';
  if (!processId) return NextResponse.json({ ok: false, error: 'processId required' }, { status: 400 });
  return NextResponse.json(await callSessionRpc(id, 'stop_background_terminal', {
    process_id: processId,
  }));
}
