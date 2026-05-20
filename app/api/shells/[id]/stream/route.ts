import crypto from 'node:crypto';
import { requireApiSession } from '@/lib/server/session';
import { getShell } from '@/lib/server/shell/shellSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/shells/[id]/stream  → SSE stdout/stderr/meta of the shell
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const sh = getShell(id);
  if (!sh) return new Response('shell not found', { status: 404 });
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
        sh.unsubscribe(subId);
      };
      sh.subscribe({ id: subId, send, close });
      hbTimer = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { closed = true; }
      }, 15_000);
      // @ts-ignore
      req.signal?.addEventListener('abort', close);
    },
    cancel() {
      if (hbTimer) clearInterval(hbTimer);
      sh.unsubscribe(subId);
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
