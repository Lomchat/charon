import { NextResponse } from 'next/server';
import { like, desc, eq } from 'drizzle-orm';
import { db, claudeSessionMessages, claudeSessions, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// GET /api/claude/search?q=...
// LIKE %q% on claude_session_messages.content + aggregates by session.
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const url = new URL(req.url);
  const q = String(url.searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ results: [] });
  const rows = db.select({
    id: claudeSessionMessages.id,
    sessionId: claudeSessionMessages.sessionId,
    role: claudeSessionMessages.role,
    content: claudeSessionMessages.content,
    createdAt: claudeSessionMessages.createdAt,
  })
    .from(claudeSessionMessages)
    .where(like(claudeSessionMessages.content, `%${q}%`))
    .orderBy(desc(claudeSessionMessages.id))
    .limit(80)
    .all();
  const sessionIds = Array.from(new Set(rows.map((r) => r.sessionId)));
  const sessionMap = new Map<string, any>();
  const vpsCache = new Map<string, string>();
  for (const sid of sessionIds) {
    const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sid)).all();
    if (!row) continue;
    let vpsName: string | null = null;
    if (row.vpsId) {
      vpsName = vpsCache.get(row.vpsId) ?? null;
      if (!vpsName) {
        const [v] = db.select({ name: vpsTable.name }).from(vpsTable).where(eq(vpsTable.id, row.vpsId)).all();
        if (v?.name) { vpsName = v.name; vpsCache.set(row.vpsId, v.name); }
      }
    }
    sessionMap.set(sid, { ...row, vpsName });
  }
  // Snippet around q
  const lower = q.toLowerCase();
  const results = rows.map((r) => {
    const idx = r.content.toLowerCase().indexOf(lower);
    const start = Math.max(0, idx - 60);
    const end = Math.min(r.content.length, idx + q.length + 60);
    const snippet = (start > 0 ? '…' : '') + r.content.slice(start, end) + (end < r.content.length ? '…' : '');
    return {
      messageId: r.id, sessionId: r.sessionId, role: r.role,
      snippet, createdAt: r.createdAt,
      session: sessionMap.get(r.sessionId),
    };
  });
  return NextResponse.json({ results });
}
