import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { resumeSession } from '@/lib/server/agent/sessionOps';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    const stream = await resumeSession(id);
    return NextResponse.json({ ok: true, status: stream.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
