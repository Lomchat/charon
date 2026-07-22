import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/mode { mode }
// Kind-aware:
//   claude → 'normal' | 'acceptEdits' | 'auto' | 'plan'
//   codex  → 'read-only' | 'workspace-write' | 'full-access' (sandbox level;
//            Codex has no interactive approval — cf. migration-codex.md).
const CLAUDE_MODES = ['normal', 'acceptEdits', 'auto', 'plan'] as const;
const CODEX_MODES = ['read-only', 'workspace-write', 'full-access'] as const;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const allowed: readonly string[] = stream.kind === 'codex' ? CODEX_MODES : CLAUDE_MODES;
  const fallback = stream.kind === 'codex' ? 'workspace-write' : 'normal';
  const mode = allowed.includes(body?.mode) ? body.mode : fallback;
  try {
    await stream.setPermissionMode(mode as any);
    return NextResponse.json({ ok: true, mode });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
