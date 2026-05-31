import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getShell } from '@/lib/server/shell/shellSession';

// POST /api/shells/[id]/resize  Body: { cols: number, rows: number }
// Forwards the browser terminal dimensions to the node-pty attach, which
// propagates SIGWINCH through SSH to the remote tmux client → the window
// resizes. Without this, ncurses apps (htop, vim, …) render at a fixed size.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return NextResponse.json({ error: 'shell not found' }, { status: 404 });
  let body: { cols?: number; rows?: number } = {};
  try { body = await req.json(); } catch {}
  const cols = Number(body.cols);
  const rows = Number(body.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return NextResponse.json({ error: 'cols/rows required' }, { status: 400 });
  }
  sh.resize(cols, rows);
  return NextResponse.json({ ok: true });
}
