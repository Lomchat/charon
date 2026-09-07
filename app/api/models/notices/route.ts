import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getModelNotices, markModelsSeen } from '@/lib/server/claude/modelNotices';

export async function GET() {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  return NextResponse.json(getModelNotices());
}

export async function POST(req: Request) {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const body = await req.json().catch(() => null);
  if (!body || (body.provider !== 'claude' && body.provider !== 'codex')
      || !Array.isArray(body.ids) || body.ids.length > 1000
      || !body.ids.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
    return NextResponse.json({ error: 'provider and model ids required' }, { status: 400 });
  }
  return NextResponse.json(markModelsSeen(body.provider, body.ids));
}
