import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import {
  invalidateSessionInsightSnapshot,
  readSessionInsightSnapshot,
} from '@/lib/server/claude/sessionInsightSnapshot';

/** GET  — per-server MCP health for this session.
 *  POST — { action: 'reconnect' | 'toggle', name, enabled? }
 *
 *  Charon exposed no MCP surface at all: a server that failed to connect was
 *  invisible — its tools simply were not there, and nothing said why. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const force = new URL(req.url).searchParams.get('force') === '1';
  return NextResponse.json(readSessionInsightSnapshot(
    id, 'mcp', () => callSessionRpc(id, 'mcp_status'),
    { force, maxAgeMs: 30_000 },
  ));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (body?.action === 'toggle') {
    const result = await callSessionRpc(id, 'mcp_toggle', { name, enabled: !!body.enabled });
    invalidateSessionInsightSnapshot(id, 'mcp');
    return NextResponse.json(result);
  }
  if (body?.action === 'oauth') {
    const result = await callSessionRpc(id, 'mcp_oauth_login', { name });
    invalidateSessionInsightSnapshot(id, 'mcp');
    return NextResponse.json(result, {
      status: result?.ok ? 200 : result?.reason === 'unsupported' ? 501 : 400,
    });
  }
  const result = await callSessionRpc(id, 'mcp_reconnect', { name });
  invalidateSessionInsightSnapshot(id, 'mcp');
  return NextResponse.json(result);
}
