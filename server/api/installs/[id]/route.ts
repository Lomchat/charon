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

// DELETE /api/installs/[id] → closes the install session (removes from pool).
// The ongoing SSH run is not really cancelled (cf. note in stop());
// we just stop tracking it on the UI side.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const ok = stopInstall(id);
  return NextResponse.json({ ok });
}
