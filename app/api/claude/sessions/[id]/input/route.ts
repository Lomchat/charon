import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalTabsChanged, getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { pinTabForRef } from '@/lib/server/claude/tabs';
import { cancelPendingScheduledResumes } from '@/lib/server/agent/scheduledResume';

// POST /api/claude/sessions/[id]/input
// Body: { content } -> user_message; or { type: 'interrupt' }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json();
  try {
    if (body.type === 'interrupt') {
      await stream.sendInterrupt();
      return NextResponse.json({ ok: true });
    }
    const content = String(body.content ?? '').trim();
    if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });
    const codexInputs = Array.isArray(body.codexInputs) ? body.codexInputs : undefined;
    if (codexInputs && (codexInputs.length > 16 || codexInputs.some((item: unknown) =>
      !item || typeof item !== 'object' || Array.isArray(item)))) {
      return NextResponse.json({ error: 'invalid codexInputs' }, { status: 400 });
    }
    const normalized = codexInputs?.map((raw: any) => {
      if (raw.type === 'text' && typeof raw.text === 'string') {
        return { type: 'text', text: raw.text.slice(0, 100_000) };
      }
      if ((raw.type === 'skill' || raw.type === 'mention')
          && typeof raw.name === 'string' && typeof raw.path === 'string') {
        return { type: raw.type, name: raw.name.slice(0, 256), path: raw.path.slice(0, 4096) };
      }
      return null;
    });
    if (normalized?.some((item: unknown) => item == null)) {
      return NextResponse.json({ error: 'unsupported codex input item' }, { status: 400 });
    }
    // A manual prompt supersedes any delayed quota-recovery prompt for this
    // session; leaving it armed would unexpectedly send a second continuation.
    cancelPendingScheduledResumes(id);
    await stream.sendUserMessage(content, normalized as Array<Record<string, unknown>> | undefined);
    // Talking to a session is the clearest possible signal that its tab has
    // stopped being a preview. Pin it so the next thing opened in this folder
    // can't evict the conversation you're having. §14.78
    pinTabForRef('session', id);
    emitGlobalTabsChanged();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
