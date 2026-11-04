import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import {
  db, agentSessions, sessionMessages, sessionPendingPermissions, sessionPendingQuestions,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { connectionFocusOf, pushHeartbeatTo } from '@/lib/server/agent/eventConnections';
import { currentRev, sessionRevOf } from '@/lib/server/sync/syncBus';
import { timeSection } from '@/lib/server/perf/loopLag';
import { isRenderedRow, type TranscriptView } from '@/lib/transcriptRows';
import type { SessionProbeResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rows looked at past `afterId` (one indexed range), and rows reported. */
const PROBE_SCAN_ROWS = 200;
const PROBE_NEW_ROWS = 50;

// GET /api/sessions/[id]/probe?conn=<uuid>&afterId=<rowId>&view=full|conversation
//
// The transcript's O(1) consistency check (sync refonte C12; replaces the 5 s
// escalating delta poll). FIRST pushes one heartbeat to `conn`: everything the
// SSE owed that connection up to the response's `rev` is then queued ahead of
// a frame whose id ≥ `rev`, so the client decides as soon as its stream has
// delivered that far (rev-gated) — an idle connection on a busy hub need not
// wait for the 8 s registry tick. Then `SessionProbeResponse`: the bus
// revision, this session's last browser-routed frame rev, whether `conn` is
// focused on it, the max row id, rendered rows past `afterId` (≤ 50, of one
// ≤ 200-row indexed range) and the pending gate ids. Point lookups and one
// bounded range only: never a window query, a LIKE, a scan or the sweep.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  return timeSection('probe', () => {
    try {
      const url = new URL(req.url);
      const conn = url.searchParams.get('conn');
      const afterRaw = url.searchParams.get('afterId');
      const afterId = afterRaw != null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : 0;
      const view: TranscriptView = url.searchParams.get('view') === 'conversation' ? 'conversation' : 'full';

      // Heartbeat first, THEN read the revision: its id ≥ the response's rev.
      if (conn) pushHeartbeatTo(conn);
      const { epoch, rev } = currentRev();

      const exists = db.select({ id: agentSessions.id }).from(agentSessions)
        .where(eq(agentSessions.id, id)).get();
      if (!exists) return NextResponse.json({ error: 'not found' }, { status: 404 });

      const maxRow = db.select({ m: sql<number>`max(${sessionMessages.id})` })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, id))
        .get();
      const maxMessageId = maxRow?.m ?? 0;

      let newRows: number[] = [];
      let newRowsTruncated = false;
      if (maxMessageId > afterId) {
        const rows = db.all(sql`
          SELECT id, role,
            CASE WHEN role = 'event' AND json_valid(content) THEN json_extract(content, '$.type') END AS et
          FROM session_messages
          WHERE session_id = ${id} AND id > ${afterId}
          ORDER BY id
          LIMIT ${PROBE_SCAN_ROWS}
        `) as Array<{ id: number; role: string; et: unknown }>;
        const rendered = rows
          .filter((r) => isRenderedRow(r.role, typeof r.et === 'string' ? r.et : null, view))
          .map((r) => r.id);
        newRows = rendered.slice(0, PROBE_NEW_ROWS);
        // More rendered rows than reported, or a full range that may hide more.
        newRowsTruncated = rendered.length > PROBE_NEW_ROWS || rows.length >= PROBE_SCAN_ROWS;
      }

      const perms = db.select({ id: sessionPendingPermissions.id }).from(sessionPendingPermissions)
        .where(and(eq(sessionPendingPermissions.sessionId, id), eq(sessionPendingPermissions.status, 'pending')))
        .all();
      const qs = db.select({ id: sessionPendingQuestions.id }).from(sessionPendingQuestions)
        .where(and(eq(sessionPendingQuestions.sessionId, id), eq(sessionPendingQuestions.status, 'pending')))
        .all();

      const body: SessionProbeResponse = {
        epoch, rev,
        sessionRev: sessionRevOf(id),
        focused: conn != null && connectionFocusOf(conn) === id,
        maxMessageId,
        newRows,
        newRowsTruncated,
        pendingIds: [...perms.map((p) => p.id), ...qs.map((q) => q.id)],
      };
      return NextResponse.json(body);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(`[api/sessions/${id}/probe GET] failed:`, e?.stack ?? e);
      return NextResponse.json({ error: e?.message ?? String(e) }, { status: 503 });
    }
  });
}
