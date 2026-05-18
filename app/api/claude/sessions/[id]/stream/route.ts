import crypto from 'node:crypto';
import { requireApiSession } from '@/lib/server/session';
import { getStream } from '@/lib/server/agent/sessionOps';
import type { WorkerEvent } from '@/lib/server/claude/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/claude/sessions/[id]/stream
// SSE : envoie d'abord le ring buffer (history_begin … history_end), puis stream live.
// Heartbeat toutes les 15s pour garder la connexion à travers Apache.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const stream = getStream(id);
  if (!stream) {
    return new Response('session not found', { status: 404 });
  }
  const encoder = new TextEncoder();
  const subId = crypto.randomBytes(6).toString('hex');
  let hbTimer: NodeJS.Timeout | null = null;

  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (ev: WorkerEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (hbTimer) clearInterval(hbTimer);
        try { controller.close(); } catch {}
        stream.unsubscribe(subId);
      };
      stream.subscribe({ id: subId, send, close });
      hbTimer = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { closed = true; }
      }, 15_000);
      // @ts-ignore — AbortSignal listener
      req.signal?.addEventListener('abort', close);
    },
    cancel() {
      if (hbTimer) clearInterval(hbTimer);
      stream.unsubscribe(subId);
    },
  });

  return new Response(sseStream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
