import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/model
// Body: { model: string | null, fallbackModel?: string | null }
//
// `model` is a free string (e.g. 'claude-opus-4-7-...' / 'claude-opus-4-8-...').
// Validity is checked by the SDK at the next start_session; if invalid the
// session emits an `error` event with the SDK's complaint.
//
// `fallbackModel` is also free. The SDK falls back to it if the primary is
// rate-limited. Pass null/empty to clear back to the global default.
//
// Takes effect on the NEXT SDK start (sleep + resume). See agent/session.py
// `set_model` for the deferred-apply rationale.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  // Normalise: empty string → null (= clear back to global default).
  const model = typeof body?.model === 'string' && body.model.length > 0 ? body.model : null;
  const fallbackModel = typeof body?.fallbackModel === 'string' && body.fallbackModel.length > 0
    ? body.fallbackModel : null;
  try {
    await stream.setModel(model, fallbackModel);
    // The model_changed event handler will persist + broadcast. We don't
    // return the new value here — clients listen to the SSE for the
    // authoritative confirmation. Returning the optimistic local values
    // would let the UI show a "saved" state for an invalid input.
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
