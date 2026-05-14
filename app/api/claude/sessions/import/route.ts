import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { importExisting } from '@/lib/server/claude/SessionWorkerPool';

// POST /api/claude/sessions/import
// Body : { vpsId, claudeSessionId, cwd, name?, projectId?, permissionMode? }
// Crée un row claude_sessions en status='sleeping' avec le claudeSessionId
// connu. Le user peut ensuite resume → bridge lancé avec --session-id pour
// reprendre la conversation.
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
    const id = await importExisting({
      vpsId, cwd, claudeSessionId,
      name: body.name ? String(body.name) : null,
      projectId: body.projectId ? String(body.projectId) : null,
      permissionMode: (['normal', 'acceptEdits', 'bypass', 'plan'] as const).includes(body.permissionMode)
        ? body.permissionMode
        : 'normal',
    });
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
