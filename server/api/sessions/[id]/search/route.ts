import { eq } from 'drizzle-orm';
import { db, agentSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { searchSessionTranscript } from '@/lib/server/hub/transcriptSearch';
import type { TranscriptView } from '@/lib/transcriptRows';

// GET /api/sessions/[id]/search?q=<text>&view=full|conversation
//
// The session header's magnifier (SessionSearch.tsx): this session's rows
// matching `q`, newest first, among those its transcript view draws
// (SessionTranscriptSearchResponse). The FTS query runs in a worker thread
// (lib/server/hub/transcriptSearch.ts), never on the event loop.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const q = String(url.searchParams.get('q') ?? '').slice(0, 300);
  const view: TranscriptView = url.searchParams.get('view') === 'conversation' ? 'conversation' : 'full';
  const row = db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!row) return Response.json({ error: 'not found' }, { status: 404 });
  const started = performance.now();
  try {
    const res = await searchSessionTranscript(id, q, view);
    const response = Response.json(res);
    response.headers.set('server-timing', `session-search;dur=${(performance.now() - started).toFixed(1)}`);
    return response;
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
