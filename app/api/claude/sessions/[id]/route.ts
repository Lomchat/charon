import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionMessages, claudeSessionLogs } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { killSession, getStream } from '@/lib/server/agent/sessionOps';

// GET /api/claude/sessions/[id]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);
  const messages = db.select().from(claudeSessionMessages)
    .where(eq(claudeSessionMessages.sessionId, id))
    .orderBy(asc(claudeSessionMessages.id))
    .all()
    .slice(-limit);
  const stream = getStream(id);
  return NextResponse.json({
    session: row,
    liveStatus: stream ? stream.status : row.status,
    subscribers: stream ? stream.subscribersCount() : 0,
    messages,
  });
}

// PATCH /api/claude/sessions/[id]
const ALLOWED_PATCH = ['name'] as const;
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const update: Record<string, unknown> = {};
  for (const k of ALLOWED_PATCH) {
    if (!(k in body)) continue;
    const v = body[k];
    update[k] = v == null || v === '' ? null : String(v).trim();
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
    return NextResponse.json(row ?? null);
  }
  db.update(claudeSessions).set(update).where(eq(claudeSessions.id, id)).run();
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  return NextResponse.json(row);
}

// DELETE /api/claude/sessions/[id]
//   par défaut : kill (status='killed') — le row reste en DB pour l'historique
//   ?hard=1   : suppression complète (cascade messages/permissions/logs)
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const hard = url.searchParams.get('hard') === '1';
  try {
    await killSession(id);
    if (hard) {
      db.delete(claudeSessionLogs).where(eq(claudeSessionLogs.sessionId, id)).run();
      db.delete(claudeSessions).where(eq(claudeSessions.id, id)).run();
    }
    return NextResponse.json({ ok: true, hard });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
