import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { lspApplyEdit, lspClose, lspDiagnostics, lspOpen, lspRequest, lspStatus } from '@/lib/server/claude/lsp';

// Code intelligence — ONE route with an `op`, not five files. Every call is
// the same shape (a root, a file, and something to ask about it) and the
// editor makes them constantly; five near-identical route files would be five
// places to forget a guard. §14.89
//
//   GET  ?op=status&root=&path=
//   GET  ?op=diagnostics&root=&path=&since=&wait=     (long poll)
//   POST { op: 'open'|'close'|'request'|'apply', root, path, … }

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const url = new URL(req.url);
  const op = url.searchParams.get('op') ?? 'status';
  const root = url.searchParams.get('root') ?? '';
  const path = url.searchParams.get('path') ?? '';
  if (!root || !path) {
    return NextResponse.json({ ok: false, error: 'root and path required' }, { status: 400 });
  }
  if (op === 'diagnostics') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    // Bounded well under AgentClient's 60s RPC timeout: the agent holds the
    // request open until something changes, and a poll that outlives the
    // transport is just a broken poll.
    const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, 25));
    return NextResponse.json(await lspDiagnostics(id, root, path, since, wait));
  }
  return NextResponse.json(await lspStatus(id, root, path));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const op = String(body.op ?? '');
  const root = String(body.root ?? '');
  const path = String(body.path ?? '');
  if (!root || !path) {
    return NextResponse.json({ ok: false, error: 'root and path required' }, { status: 400 });
  }

  if (op === 'open') {
    const text = typeof body.text === 'string' ? body.text : null;
    if (text === null) return NextResponse.json({ ok: false, error: 'text required' }, { status: 400 });
    return NextResponse.json(await lspOpen(id, root, path, text));
  }
  if (op === 'close') return NextResponse.json(await lspClose(id, root, path));
  if (op === 'apply') {
    const changes = body.changes;
    if (!changes || typeof changes !== 'object') {
      return NextResponse.json({ ok: false, error: 'changes required' }, { status: 400 });
    }
    return NextResponse.json(await lspApplyEdit(id, root, changes as Record<string, unknown>));
  }
  if (op === 'request') {
    return NextResponse.json(await lspRequest(id, {
      root, path,
      method: String(body.method ?? ''),
      position: body.position,
      extra: body.extra,
      item: body.item,
    }));
  }
  return NextResponse.json({ ok: false, error: `unknown op: ${op}` }, { status: 400 });
}
