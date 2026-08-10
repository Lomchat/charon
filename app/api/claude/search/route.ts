import { NextResponse } from 'next/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

function toFtsQuery(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
  if (terms.length === 0) return null;
  // ANDed prefixes are forgiving for partially typed words while quoting
  // makes all FTS operators in user input inert.
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
}

// GET /api/claude/search?q=...
// FTS5 replaces the unindexed LIKE %q% scan over the full (400MB+) message
// table. Results and session/VPS metadata are each fetched in one query.
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const q = String(new URL(req.url).searchParams.get('q') ?? '').trim();
  const ftsQuery = toFtsQuery(q);
  if (!ftsQuery) return NextResponse.json({ results: [] });
  const perfStarted = performance.now();

  const rows = db.all(sql`
    SELECT CAST(f.message_id AS INTEGER) AS id,
           f.session_id AS sessionId,
           f.role AS role,
           snippet(claude_session_messages_fts, 3, '', '', '…', 22) AS snippet,
           m.created_at AS createdAt
    FROM claude_session_messages_fts f
    JOIN claude_session_messages m ON m.id = f.rowid
    WHERE claude_session_messages_fts MATCH ${ftsQuery}
    ORDER BY bm25(claude_session_messages_fts), m.id DESC
    LIMIT 80
  `) as Array<{
    id: number;
    sessionId: string;
    role: string;
    snippet: string;
    createdAt: number;
  }>;

  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  const sessionMap = new Map<string, Record<string, unknown>>();
  if (sessionIds.length > 0) {
    const sessions = db.select({ session: claudeSessions, vpsName: vpsTable.name })
      .from(claudeSessions)
      .leftJoin(vpsTable, eq(vpsTable.id, claudeSessions.vpsId))
      .where(inArray(claudeSessions.id, sessionIds))
      .all();
    for (const row of sessions) {
      sessionMap.set(row.session.id, { ...row.session, vpsName: row.vpsName });
    }
  }

  const response = NextResponse.json({
    results: rows.map((r) => ({
      messageId: r.id,
      sessionId: r.sessionId,
      role: r.role,
      snippet: r.snippet,
      createdAt: r.createdAt,
      session: sessionMap.get(r.sessionId),
    })),
  });
  const totalMs = performance.now() - perfStarted;
  response.headers.set('server-timing', `search-fts;dur=${totalMs.toFixed(1)}`);
  if (totalMs > 150) {
    // eslint-disable-next-line no-console
    console.warn(`[perf] search GET ${totalMs.toFixed(1)}ms (${rows.length} hits)`);
  }
  return response;
}
