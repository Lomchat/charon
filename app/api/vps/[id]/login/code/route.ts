import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getLoginSession } from '@/lib/server/agent/loginSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/login/code  Body: { code: string }
// Hands the OAuth code the user pasted back from platform.claude.com to the
// waiting `claude auth login`. The verdict is NOT in the response: the
// session flips to 'verifying' and confirms via `claude auth status --json`,
// which the modal picks up by polling GET /api/vps/[id]/login (§14.64).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = getLoginSession(id);
  if (!sess) return NextResponse.json({ ok: false, error: 'no active login attempt' }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const code = typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code : '';
  if (!code.trim()) return NextResponse.json({ ok: false, error: 'code required' }, { status: 400 });
  try {
    sess.submitCode(code);
    return NextResponse.json({ ok: true, ...sess.status() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 409 });
  }
}
