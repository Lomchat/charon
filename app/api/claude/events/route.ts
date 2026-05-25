import { and, eq } from 'drizzle-orm';
import {
  db, claudeSessions, claudePendingPermissions, claudePendingQuestions,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { registerConnection } from '@/lib/server/agent/eventConnections';
import { getStream } from '@/lib/server/agent/sessionOps';
import type { GlobalSessionEvent } from '@/lib/server/agent/sessionOps';
import {
  subscribeInstallBus, listInstalls,
  type InstallBusEvent,
} from '@/lib/server/install/installSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/claude/events?conn=<uuid>&focus=<sid>
//
// Multiplexed SSE: replaces the old endpoints
// `/api/claude/sessions/[id]/stream` and `/api/claude/interactions/stream`.
// The browser client opens ONE persistent SSE at mount; session changes
// are handled via POST /api/claude/focus without close/reopen.
//
// Initial snapshot: statuses of all live sessions + pendings in DB.
// Then: live stream filtered by focus (cf. eventConnections.ts § registerConnection).
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
  let unsubInstall: (() => void) | null = null;

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
      // Install events have no Claude sessionId and don't go through the
      // focus filter — they are broadcast to everyone, like a "hub"-level
      // notification (cf. installSession.ts § subscribeInstallBus).
      const sendInstall = (ev: InstallBusEvent) => {
        sendRaw(`data: ${JSON.stringify(ev)}\n\n`);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (hbTimer) clearInterval(hbTimer);
        if (unregister) { unregister(); unregister = null; }
        if (unsubInstall) { unsubInstall(); unsubInstall = null; }
        try { controller.close(); } catch {}
      };

      // Initial snapshot: status of all sessions + pendings. This lets the
      // client populate its sidebar immediately without depending on
      // GET /api/claude/sessions (which will also be called in parallel but
      // these status events cover it partially).
      //
      // Historical note: we used to filter `status='killed'` sessions here.
      // Since the kill->delete refactor (cf. CLAUDE.md §10), this status is
      // no longer persisted. The filter is kept as an idempotent safeguard
      // in case pre-migration data resurfaces, but should never match.
      try {
        const rows = db.select({ id: claudeSessions.id, status: claudeSessions.status })
          .from(claudeSessions).all();
        for (const row of rows) {
          if (row.status === 'killed') continue;
          // Prefer the live (in-memory) status over the DB one if available.
          const live = getStream(row.id);
          const effective = live ? live.status : row.status;
          send({ type: 'status', sessionId: row.id, status: effective as any });
        }
        // Pendings: we replay them once to repopulate the client queues
        // (the cross-session popup + the focused session need them).
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

      // Initial snapshot of installs: sends an install_started for each
      // install still active. Lets the client (Sidebar / popup) update
      // at mount without depending on a separate GET.
      try {
        for (const inst of listInstalls()) {
          if (inst.status === 'running') {
            sendInstall({
              type: 'install_started',
              installId: inst.id, vpsId: inst.vpsId, vpsName: inst.vpsName,
              status: 'running',
            });
          }
        }
      } catch {}

      // Connect to the global session bus with focus filtering.
      unregister = registerConnection({ connId, send, initialFocus });
      // Connect to the install bus (broadcast to everyone, no focus filter).
      unsubInstall = subscribeInstallBus(sendInstall);

      // Heartbeat: sent as a TYPED DATA event (not an SSE comment), because
      // EventSource does NOT surface comment lines (`: ...`) to JavaScript —
      // we need a JS-visible event so the client can track liveness and
      // detect silent stalls (TCP alive but proxy buffering / no data
      // flowing). The client filters out `heartbeat` in its routing.
      // Sent every 8s with a watchdog at 20s on the client → up to 2
      // missed beats before reconnect (margin against transient hiccups,
      // fast enough that the user notices recovery quickly).
      hbTimer = setInterval(() => {
        sendRaw(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
      }, 8_000);
      // Send a first heartbeat immediately so the client knows the
      // connection is alive without waiting 8s.
      sendRaw(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);

      // @ts-ignore — AbortSignal listener
      req.signal?.addEventListener('abort', close);
    },
    cancel() {
      if (hbTimer) clearInterval(hbTimer);
      if (unregister) { unregister(); unregister = null; }
      if (unsubInstall) { unsubInstall(); unsubInstall = null; }
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
