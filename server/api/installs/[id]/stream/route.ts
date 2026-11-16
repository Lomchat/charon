import crypto from 'node:crypto';
import { requireApiSession } from '@/lib/server/session';
import { getInstall, type InstallStreamMessage } from '@/lib/server/install/installSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/installs/[id]/stream  → SSE of bootstrap events + status updates.
// On subscribe, sends replay_begin -> ring buffer events -> replay_end ->
// current status. Then live.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const inst = getInstall(id);
  if (!inst) return new Response('install not found', { status: 404 });

  const encoder = new TextEncoder();
  const subId = crypto.randomBytes(6).toString('hex');
  let hbTimer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (msg: InstallStreamMessage) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (hbTimer) clearInterval(hbTimer);
        try { controller.close(); } catch {}
        inst.unsubscribe(subId);
      };
      inst.subscribe({ id: subId, send, close });
      hbTimer = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { closed = true; }
      }, 15_000);
      // @ts-ignore
      req.signal?.addEventListener('abort', close);
    },
    cancel() {
      if (hbTimer) clearInterval(hbTimer);
      inst.unsubscribe(subId);
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
