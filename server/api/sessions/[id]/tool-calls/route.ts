import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  loadToolCalls, TOOL_CALLS_DEFAULT_LIMIT, TOOL_CALLS_MAX_LIMIT,
} from '@/lib/server/hub/conversationSources';
import { timeSection } from '@/lib/server/perf/loopLag';

// GET /api/sessions/[id]/tool-calls?before=<rowId>&limit=N
//
// The calls tab in conversation view (CLAUDE.md §14.25): the window GET no
// longer carries tool rows, so the tab pages them here — newest page first,
// `before` = the oldest `rowId` held, `limit` ≤ 500 — as `ToolCallSummary`:
// the compacted input and a ≤ 512-char result preview, JSON taken apart in
// SQLite. A tool_result's lossless `content` is never read (megabytes in a
// heavy session); see conversationSources.ts § loadToolCalls.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  return timeSection(`tool-calls GET ${id}`, () => {
    try {
      const exists = db.select({ id: agentSessions.id }).from(agentSessions)
        .where(eq(agentSessions.id, id)).get();
      if (!exists) return NextResponse.json({ error: 'not found' }, { status: 404 });
      const url = new URL(req.url);
      const rawLimit = Number(url.searchParams.get('limit') ?? TOOL_CALLS_DEFAULT_LIMIT);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), TOOL_CALLS_MAX_LIMIT)
        : TOOL_CALLS_DEFAULT_LIMIT;
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
      return NextResponse.json(loadToolCalls(id, before, limit));
    } catch (e: any) {
      // Same contract as the session GET: a transient failure is a clean
      // retryable 503, never an HTML 500.
      // eslint-disable-next-line no-console
      console.error(`[api/sessions/${id}/tool-calls GET] failed:`, e?.stack ?? e);
      return NextResponse.json({ error: e?.message ?? String(e) }, { status: 503 });
    }
  });
}
