import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { retryInstall } from '@/lib/server/install/installSession';

// POST /api/installs/[id]/retry → re-runs bootstrap in the same session.
// The client stays connected to the same SSE and sees the new run in the log.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const inst = retryInstall(id);
  if (!inst) return NextResponse.json({ error: 'install not found' }, { status: 404 });
  return NextResponse.json(inst.info());
}
