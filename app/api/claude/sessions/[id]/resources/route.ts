import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  return NextResponse.json(await callSessionRpc(id, 'codex_resources', {
    force_reload: new URL(req.url).searchParams.get('force') === '1',
  }));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!path || typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'path and enabled required' }, { status: 400 });
  }
  const result = await callSessionRpc(id, 'set_codex_skill', { path, enabled: body.enabled });
  return NextResponse.json(result, { status: result?.ok ? 200 : result?.reason === 'unsupported' ? 501 : 400 });
}
