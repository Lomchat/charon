import { NextResponse } from 'next/server';
import { desc, eq, and, sql } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable, claudePendingPermissions, claudePendingQuestions, claudeSessionMessages } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { startNew, listWorkers } from '@/lib/server/claude/SessionWorkerPool';

// GET /api/claude/sessions
// Query : ?vpsId= ?projectId= ?status=
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const url = new URL(req.url);
  const filters: any[] = [];
  const vpsId = url.searchParams.get('vpsId');
  const projectId = url.searchParams.get('projectId');
  const status = url.searchParams.get('status');
  if (vpsId) filters.push(eq(claudeSessions.vpsId, vpsId));
  if (projectId) filters.push(eq(claudeSessions.projectId, projectId));
  if (status) filters.push(eq(claudeSessions.status, status));
  const where = filters.length ? and(...filters) : undefined;
  const rows = db.select().from(claudeSessions)
    .where(where as any)
    // Ordre figé par date de création (la plus récente en haut). On NE TRIE
    // PAS par lastUsedAt : les sessions ne doivent pas bouger quand on les
    // utilise — un refresh/un autre device doivent toujours voir le même ordre.
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();

  // Annoter avec statut live + subs count + pendingPermissions
  const workers = new Map(listWorkers().map((w) => [w.id, w] as const));
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

  // Premier message user de chaque session (pour aperçu dans la sidebar).
  // Le sous-select MIN(id) garantit qu'on prend bien le tout premier, pas
  // un row arbitraire choisi par SQLite via le GROUP BY bare-column.
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
    const w = workers.get(r.id);
    const perms = pendingBySession.get(r.id) ?? 0;
    const qs = pendingQBySession.get(r.id) ?? 0;
    const firstMsg = firstMsgBySession.get(r.id) ?? null;
    return {
      ...r,
      liveStatus: w ? w.status : r.status,
      subscribers: w ? w.subscribersCount() : 0,
      pendingPermissions: perms + qs,
      firstUserMessage: firstMsg ? firstMsg.slice(0, 180) : null,
    };
  });
  return NextResponse.json({ sessions: annotated });
}

// POST /api/claude/sessions
// Body : { vpsId, cwd, name?, projectId?, permissionMode? }
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

  const ALLOWED_MODES = ['normal', 'acceptEdits', 'bypass', 'plan'] as const;
  type Mode = (typeof ALLOWED_MODES)[number];
  const permissionMode: Mode = ALLOWED_MODES.includes(body.permissionMode)
    ? body.permissionMode
    : 'normal';
  try {
    const w = await startNew({
      vpsId, cwd,
      name: body.name ? String(body.name) : null,
      projectId: body.projectId ? String(body.projectId) : null,
      permissionMode,
    });
    return NextResponse.json({
      id: w.id, status: w.status, claudeSessionId: w.claudeSessionId,
      vpsId, cwd, name: w.name, permissionMode,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
