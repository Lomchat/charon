import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { startInstall, getInstallByVps } from '@/lib/server/install/installSession';

// GET /api/vps/[id]/installs → install courante pour ce VPS (ou null)
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const inst = getInstallByVps(id);
  return NextResponse.json({ install: inst?.info() ?? null });
}

// POST /api/vps/[id]/installs → démarre (ou récupère) une install pour ce VPS.
// Si une install est déjà en cours, retourne l'existante (focus, pas double-run).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  try {
    const inst = startInstall(id);
    return NextResponse.json(inst.info());
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
