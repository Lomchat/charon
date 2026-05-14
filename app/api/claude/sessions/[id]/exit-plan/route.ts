import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getWorker } from '@/lib/server/claude/SessionWorkerPool';

// POST /api/claude/sessions/[id]/exit-plan
// Body : { id: qid, decision: 'approve' | 'reject', feedback?: string }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const w = getWorker(id);
  if (!w) return NextResponse.json({ error: 'session not active' }, { status: 409 });
  const body = await req.json();
  const qid = String(body.id ?? '').trim();
  const decision = body.decision === 'approve' ? 'approve' : 'reject';
  const feedback = typeof body.feedback === 'string' ? body.feedback : '';
  if (!qid) return NextResponse.json({ error: 'qid required' }, { status: 400 });
  try {
    await w.respondExitPlan(qid, decision, feedback);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
