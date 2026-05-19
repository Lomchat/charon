import { and, eq } from 'drizzle-orm';
import {
  db, claudeSessions, claudePendingPermissions, claudePendingQuestions,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { registerConnection } from '@/lib/server/agent/eventConnections';
import { getStream } from '@/lib/server/agent/sessionOps';
import type { GlobalSessionEvent } from '@/lib/server/agent/sessionOps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/claude/events?conn=<uuid>&focus=<sid>
//
// SSE multiplexée : remplace les anciens endpoints
// `/api/claude/sessions/[id]/stream` et `/api/claude/interactions/stream`.
// Le client browser ouvre UNE seule SSE persistante au mount ; les changements
// de session sont gérés via POST /api/claude/focus sans close/reopen.
//
// Snapshot initial : statuts de toutes les sessions vivantes + pendings en DB.
// Suite : flux live filtré par focus (cf. eventConnections.ts § registerConnection).
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;

  const url = new URL(req.url);
  const connId = url.searchParams.get('conn');
  if (!connId || connId.length < 8 || connId.length > 64) {
    return new Response('missing or invalid conn id', { status: 400 });
  }
  const initialFocus = url.searchParams.get('focus');

  const encoder = new TextEncoder();
  let hbTimer: NodeJS.Timeout | null = null;
  let unregister: (() => void) | null = null;

  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const sendRaw = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };
      const send = (ev: GlobalSessionEvent) => {
        sendRaw(`data: ${JSON.stringify(ev)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (hbTimer) clearInterval(hbTimer);
        if (unregister) { unregister(); unregister = null; }
        try { controller.close(); } catch {}
      };

      // Snapshot initial : status de toutes les sessions non-killed + pendings.
      // Le client peut ainsi peupler sa sidebar immédiatement sans dépendre du
      // GET /api/claude/sessions (qui sera aussi appelé en parallèle mais ces
      // events status le couvrent partiellement).
      try {
        const rows = db.select({ id: claudeSessions.id, status: claudeSessions.status })
          .from(claudeSessions).all();
        for (const row of rows) {
          if (row.status === 'killed') continue;
          // Préfère le status live (en mémoire) à celui DB si disponible.
          const live = getStream(row.id);
          const effective = live ? live.status : row.status;
          send({ type: 'status', sessionId: row.id, status: effective as any });
        }
        // Pendings : on les replay une fois pour repeupler les queues client
        // (la cross-session popup + la session focus en a besoin).
        const perms = db.select().from(claudePendingPermissions).where(
          eq(claudePendingPermissions.status, 'pending'),
        ).all();
        for (const p of perms) {
          let input: any = {};
          try { input = JSON.parse(p.toolInput); } catch {}
          send({ type: 'permission_request', sessionId: p.sessionId, id: p.id, tool: p.toolName, input });
        }
        const qs = db.select().from(claudePendingQuestions).where(
          eq(claudePendingQuestions.status, 'pending'),
        ).all();
        for (const q of qs) {
          let payload: any = {};
          try { payload = JSON.parse(q.payload); } catch {}
          if (q.kind === 'question') {
            send({ type: 'user_question', sessionId: q.sessionId, id: q.id, questions: payload });
          } else if (q.kind === 'exit_plan') {
            send({ type: 'exit_plan_request', sessionId: q.sessionId, id: q.id, plan: payload?.plan ?? '' });
          }
        }
      } catch {}

      // Branche au bus global avec filtrage par focus.
      unregister = registerConnection({ connId, send, initialFocus });

      hbTimer = setInterval(() => sendRaw(`: hb\n\n`), 15_000);

      // @ts-ignore — AbortSignal listener
      req.signal?.addEventListener('abort', close);
    },
    cancel() {
      if (hbTimer) clearInterval(hbTimer);
      if (unregister) { unregister(); unregister = null; }
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
