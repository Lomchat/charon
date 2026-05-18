import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { startLoginSession, stopLoginSession, getLoginSession } from '@/lib/server/agent/loginSession';

// POST /api/vps/[id]/login  → start (kill any existing)
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = startLoginSession(id);
  return NextResponse.json({ ok: true, exited: sess.exited });
}

// DELETE /api/vps/[id]/login → stop
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  stopLoginSession(id);
  return NextResponse.json({ ok: true });
}

// GET /api/vps/[id]/login → status only
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = getLoginSession(id);
  return NextResponse.json({
    active: !!sess && !sess.exited,
    exited: sess?.exited ?? null,
    exitCode: sess?.exitCode ?? null,
  });
}
