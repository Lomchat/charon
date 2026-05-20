import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getInstall, stopInstall } from '@/lib/server/install/installSession';

// GET /api/installs/[id] → info
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const inst = getInstall(id);
  if (!inst) return NextResponse.json({ error: 'install not found' }, { status: 404 });
  return NextResponse.json(inst.info());
}

// DELETE /api/installs/[id] → ferme la session install (retire du pool).
// Le run en cours côté SSH n'est pas vraiment annulé (cf. note dans stop()) ;
// on coupe juste le suivi côté UI.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const ok = stopInstall(id);
  return NextResponse.json({ ok });
}
