import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { bootstrapVps } from '@/lib/server/claude/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/vps/[id]/claude/bootstrap
// SSE qui stream la progression : verify → detect_os → install_python → install_sdk → verify → done.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return new Response('vps not found', { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (ev: any) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`)); }
        catch { closed = true; }
      };
      // @ts-ignore
      req.signal?.addEventListener('abort', () => { closed = true; try { controller.close(); } catch {} });
      try {
        for await (const ev of bootstrapVps(v)) {
          if (closed) break;
          send(ev);
        }
      } catch (e: any) {
        send({ phase: 'done', status: 'error', detail: String(e?.message ?? e) });
      } finally {
        try { controller.close(); } catch {}
      }
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
