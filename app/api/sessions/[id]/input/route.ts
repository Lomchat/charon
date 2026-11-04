import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { emitGlobalTabsChanged, getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { pinTabForRef } from '@/lib/server/hub/tabs';
import { cancelPendingScheduledResumes } from '@/lib/server/agent/scheduledResume';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';

// POST /api/sessions/[id]/input
// Body: { content, clientMessageId? } -> user_message; or { type: 'interrupt' }
// `clientMessageId` (the browser's UUID for its optimistic bubble, ≤64 chars
// of [A-Za-z0-9-]) is the agent's input idempotency key and rides the
// `user_echo`: a POST retried with the same id after an ambiguous failure
// re-sends the input (the agent dedups it) without a second row or echo.
// Answers { ok, rowId, clientMessageId, sync } — `sync` (SPEC §3.5) is ≥ the
// summary frame carrying the send (the optimistic `thinking`, the read-ack).
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

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
    const rawClientMessageId: unknown = body.clientMessageId;
    if (rawClientMessageId != null
      && (typeof rawClientMessageId !== 'string' || !CLIENT_MESSAGE_ID_RE.test(rawClientMessageId))) {
      return NextResponse.json({ error: 'invalid clientMessageId' }, { status: 400 });
    }
    const clientMessageId = typeof rawClientMessageId === 'string' ? rawClientMessageId : crypto.randomUUID();
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
    const { rowId } = await stream.sendUserMessage(
      content, normalized as Array<Record<string, unknown>> | undefined, { clientMessageId },
    );
    // Talking to a session is the clearest possible signal that its tab has
    // stopped being a preview. Pin it so the next thing opened in this folder
    // can't evict the conversation you're having. §14.78 — announced only
    // when a tab actually changed (every send used to re-sync every tab bar).
    if (pinTabForRef('session', id)) emitGlobalTabsChanged();
    return NextResponse.json({ ok: true, rowId, clientMessageId, sync: syncAfter([id]) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
