import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { startLoginSession, stopLoginSession, getLoginSession } from '@/lib/server/agent/loginSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Claude sign-in as a structured device-code flow (§14.64) — the Claude
// sibling of /api/vps/[id]/codex/login, replacing the old PTY console
// (the /login/stream SSE + /login/input routes are gone with it).
//   POST   → start an attempt (cancels any previous one for this VPS)
//   GET    → poll { phase, url, error, account, attempt }
//   DELETE → cancel (modal closed before completion)
// The code the user pastes back goes to POST /api/vps/[id]/login/code.

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = startLoginSession(id);
  return NextResponse.json({ ok: true, ...sess.status() });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = getLoginSession(id);
  if (!sess) {
    return NextResponse.json({ ok: false, error: 'no active login attempt' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...sess.status() });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  stopLoginSession(id);
  return NextResponse.json({ ok: true });
}
