import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';

/** GET  — per-server MCP health for this session.
 *  POST — { action: 'reconnect' | 'toggle', name, enabled? }
 *
 *  Charon exposed no MCP surface at all: a server that failed to connect was
 *  invisible — its tools simply were not there, and nothing said why. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  return NextResponse.json(await callSessionRpc(id, 'mcp_status'));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (body?.action === 'toggle') {
    return NextResponse.json(
      await callSessionRpc(id, 'mcp_toggle', { name, enabled: !!body.enabled }));
  }
  return NextResponse.json(await callSessionRpc(id, 'mcp_reconnect', { name }));
}
