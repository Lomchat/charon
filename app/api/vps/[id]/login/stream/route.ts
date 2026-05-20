import crypto from 'node:crypto';
import { requireApiSession } from '@/lib/server/session';
import { getLoginSession } from '@/lib/server/agent/loginSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/vps/[id]/login/stream  → SSE stdout/stderr/meta of `claude login`
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sess = getLoginSession(id);
  if (!sess) {
    return new Response('no active login session — POST /login first', { status: 404 });
  }
  const encoder = new TextEncoder();
  const subId = crypto.randomBytes(6).toString('hex');
  let hbTimer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string, kind: 'stdout' | 'stderr' | 'meta' = 'stdout') => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind, text })}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (hbTimer) clearInterval(hbTimer);
        try { controller.close(); } catch {}
        sess.unsubscribe(subId);
      };
      sess.subscribe({ id: subId, send, close });
      hbTimer = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { closed = true; }
      }, 15_000);
      // @ts-ignore
      req.signal?.addEventListener('abort', close);
    },
    cancel() {
      if (hbTimer) clearInterval(hbTimer);
      sess.unsubscribe(subId);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
