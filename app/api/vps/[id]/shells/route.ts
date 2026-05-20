import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { startShell, listShells } from '@/lib/server/shell/shellSession';

// GET /api/vps/[id]/shells → lists active shells for this VPS
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const shells = listShells().filter((sh) => sh.vpsId === id).map((sh) => sh.info());
  return NextResponse.json({ shells });
}

// POST /api/vps/[id]/shells  Body: { cwd? }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let body: { cwd?: string | null } = {};
  try { body = await req.json(); } catch {}
  try {
    const shell = startShell(id, body.cwd ?? null);
    return NextResponse.json(shell.info());
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
