import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { retryInstall } from '@/lib/server/install/installSession';

// POST /api/installs/[id]/retry → relance le bootstrap dans la même session.
// Le client reste connecté à la même SSE et voit le nouveau run dans le log.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const inst = retryInstall(id);
  if (!inst) return NextResponse.json({ error: 'install not found' }, { status: 404 });
  return NextResponse.json(inst.info());
}
