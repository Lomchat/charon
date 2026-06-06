import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { startShell, listShells } from '@/lib/server/shell/shellSession';

// GET /api/vps/[id]/shells → DB-backed list of shells for this VPS.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const shells = listShells().filter((sh) => sh.vpsId === id);
  return NextResponse.json({ shells });
}

// POST /api/vps/[id]/shells  Body: { cwd?, name?, cols?, rows? }
// Creates the agent-hosted PTY + inserts the DB row.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let body: { cwd?: string | null; name?: string | null; cols?: number; rows?: number } = {};
  try { body = await req.json(); } catch {}
  try {
    const shell = await startShell(id, body.cwd ?? null, {
      name: body.name ?? null,
      cols: typeof body.cols === 'number' ? body.cols : undefined,
      rows: typeof body.rows === 'number' ? body.rows : undefined,
    });
    return NextResponse.json(shell);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
