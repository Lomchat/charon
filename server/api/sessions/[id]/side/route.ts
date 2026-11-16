import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { asSessionProvider, supportsSessionCapability } from '@/lib/sessionCapabilities';

const LIVE = new Set(['active', 'thinking', 'starting', 'background', 'failed']);

// POST /api/sessions/[id]/side  Body: { question }  (CLAUDE.md §14.119)
// A question beside the conversation: answered without touching it, even
// while a turn runs. Answers at once with the question's row; the answer
// follows as a `side_answer` frame (and in the same row).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return Response.json({ error: 'session not found' }, { status: 404 });
  if (!supportsSessionCapability(asSessionProvider(stream.kind), 'sideQuestion')) {
    return Response.json({ error: 'This backend cannot answer side questions.' }, { status: 400 });
  }
  if (!LIVE.has(stream.status)) {
    return Response.json({ error: 'Resume the session to ask it a side question.' }, { status: 409 });
  }
  const body = await req.json().catch(() => null) as { question?: unknown } | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return Response.json({ error: 'question must be a non-empty string' }, { status: 400 });
  if (question.length > 20_000) return Response.json({ error: 'question is too long' }, { status: 400 });
  try {
    const { rowId } = await stream.askSideQuestion(question);
    return Response.json({ ok: true, rowId, sync: syncAfter([id]) });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 500 });
  }
}
