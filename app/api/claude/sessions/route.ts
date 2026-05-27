import { NextResponse } from 'next/server';
import { desc, eq, and, sql } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { startNewSession, listStreams } from '@/lib/server/agent/sessionOps';
import { focusCountFor } from '@/lib/server/agent/eventConnections';

// GET /api/claude/sessions
// Query: ?vpsId= ?status=
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  try {
    const url = new URL(req.url);
    const filters: any[] = [];
    const vpsId = url.searchParams.get('vpsId');
    const status = url.searchParams.get('status');
    if (vpsId) filters.push(eq(claudeSessions.vpsId, vpsId));
    if (status) filters.push(eq(claudeSessions.status, status));
    const where = filters.length ? and(...filters) : undefined;
    const rows = db.select().from(claudeSessions)
      .where(where as any)
      .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
      .all();

    // Annotate with live status + subs count + pendingPermissions
    const streams = new Map(listStreams().map((s) => [s.id, s] as const));
    const pendingRows = db.select({
      sessionId: claudePendingPermissions.sessionId,
      n: sql<number>`count(*)`.as('n'),
    })
      .from(claudePendingPermissions)
      .where(eq(claudePendingPermissions.status, 'pending'))
      .groupBy(claudePendingPermissions.sessionId)
      .all();
    const pendingBySession = new Map(pendingRows.map((r) => [r.sessionId, Number(r.n)] as const));
    const pendingQRows = db.select({
      sessionId: claudePendingQuestions.sessionId,
      n: sql<number>`count(*)`.as('n'),
    })
      .from(claudePendingQuestions)
      .where(eq(claudePendingQuestions.status, 'pending'))
      .groupBy(claudePendingQuestions.sessionId)
      .all();
    const pendingQBySession = new Map(pendingQRows.map((r) => [r.sessionId, Number(r.n)] as const));

    const firstMsgRows = db.all(sql`
      SELECT session_id as sessionId, content
      FROM claude_session_messages
      WHERE id IN (
        SELECT MIN(id) FROM claude_session_messages
        WHERE role = 'user'
        GROUP BY session_id
      )
    `) as Array<{ sessionId: string; content: string }>;
    const firstMsgBySession = new Map(firstMsgRows.map((r) => [r.sessionId, r.content] as const));

    const annotated = rows.map((r) => {
      const stream = streams.get(r.id);
      const perms = pendingBySession.get(r.id) ?? 0;
      const qs = pendingQBySession.get(r.id) ?? 0;
      const firstMsg = firstMsgBySession.get(r.id) ?? null;
      return {
        ...r,
        liveStatus: stream ? stream.status : r.status,
        subscribers: focusCountFor(r.id),
        pendingPermissions: perms + qs,
        firstUserMessage: firstMsg ? firstMsg.slice(0, 180) : null,
      };
    });
    return NextResponse.json({ sessions: annotated });
  } catch (e: any) {
    // Never let a transient DB hiccup surface as an unhandled 500 (which
    // returns an HTML error page that breaks the client's JSON parsing and
    // can cascade into a "stuck" UI). Log the real cause, return a clean,
    // retryable 503 — the client's 5s poll / sidebar refresh will retry.
    // eslint-disable-next-line no-console
    console.error('[api/claude/sessions GET] failed:', e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e), sessions: [] }, { status: 503 });
  }
}

// POST /api/claude/sessions
// Body: { vpsId, cwd, name?, permissionMode? }
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const vpsId = String(body.vpsId ?? '').trim();
  const cwd = String(body.cwd ?? '').trim();
  if (!vpsId || !cwd) {
    return NextResponse.json({ error: 'vpsId, cwd required' }, { status: 400 });
  }
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const ALLOWED_MODES = ['normal', 'acceptEdits', 'auto', 'plan'] as const;
  type Mode = (typeof ALLOWED_MODES)[number];
  const permissionMode: Mode = ALLOWED_MODES.includes(body.permissionMode)
    ? body.permissionMode
    : 'auto';
  try {
    const stream = await startNewSession({
      vpsId, cwd,
      name: body.name ? String(body.name) : null,
      permissionMode,
    });
    return NextResponse.json({
      id: stream.id, status: stream.status, claudeSessionId: stream.claudeSessionId,
      vpsId, cwd, name: stream.name, permissionMode,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
