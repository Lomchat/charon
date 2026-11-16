import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getShell, stopShell, updateShellMeta } from '@/lib/server/shell/shellSession';

// GET /api/shells/[id]
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  return NextResponse.json(sh);
}

// PATCH /api/shells/[id]  Body: { name?, color? }
// Persisted to DB; survives Charon restart.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const updated = updateShellMeta(id, {
    name: 'name' in body ? body.name : undefined,
    color: 'color' in body ? body.color : undefined,
  });
  if (!updated) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  return NextResponse.json(updated);
}

// DELETE /api/shells/[id] — agent's `shell_kill` + drop the DB row.
// "Stop vs forget" (P0.6): by default the row is only dropped once the agent
// confirmed the kill; on failure → 502 with canForce:true and the caller may
// retry with ?force=1 to forget the shell anyway (VPS unreachable for good).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const force = new URL(req.url).searchParams.get('force') === '1';
  const r = await stopShell(id, { force });
  if (!r.ok) {
    if (r.notFound) return NextResponse.json({ error: r.error }, { status: 404 });
    return NextResponse.json({ ok: false, error: r.error, canForce: true }, { status: 502 });
  }
  return NextResponse.json({ ok: true, forced: r.forced ?? false });
}
