import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { resumeSession } from '@/lib/server/agent/sessionOps';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  console.warn(`[resume-debug] ${id} POST /resume received @${Date.now()}`);
  try {
    const stream = await resumeSession(id);
    console.warn(`[resume-debug] ${id} POST /resume returning {status: ${stream.status}} @${Date.now()}`);
    return NextResponse.json({ ok: true, status: stream.status });
  } catch (e: any) {
    console.warn(`[resume-debug] ${id} POST /resume FAILED: ${e?.message ?? e} @${Date.now()}`);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
