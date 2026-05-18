import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { importExistingSession } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/import
// Body : { vpsId, claudeSessionId, cwd, name?, permissionMode? }
// Crée un row claude_sessions en status='sleeping' avec le claudeSessionId connu.
// Au resume, l'agent fait start_session(claude_session_id=...) qui reprend
// la conversation côté SDK.
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const vpsId = String(body.vpsId ?? '').trim();
  const claudeSessionId = String(body.claudeSessionId ?? '').trim();
  const cwd = String(body.cwd ?? '').trim();
  if (!vpsId || !claudeSessionId || !cwd) {
    return NextResponse.json({ error: 'vpsId, claudeSessionId, cwd required' }, { status: 400 });
  }
  try {
    const id = await importExistingSession({
      vpsId, cwd, claudeSessionId,
      name: body.name ? String(body.name) : null,
      permissionMode: (['normal', 'acceptEdits', 'bypass', 'plan'] as const).includes(body.permissionMode)
        ? body.permissionMode
        : 'normal',
    });
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
