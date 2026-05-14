import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { resume } from '@/lib/server/claude/SessionWorkerPool';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    const w = await resume(id);
    return NextResponse.json({ ok: true, status: w.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
