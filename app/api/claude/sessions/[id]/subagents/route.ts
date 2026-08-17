import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { hideInternalCodexSubagents } from '@/lib/server/claude/sessionInsightCompat';

/** GET /api/claude/sessions/[id]/subagents            → the ids
 *  GET /api/claude/sessions/[id]/subagents?agent=<id> → that one's transcript
 *
 *  A Workflow run showed as "Agent: … — 4m12s — done" and everything the
 *  sub-agent read, searched and concluded was discarded. The transcripts were
 *  on the VPS the whole time (`.../subagents/agent-<id>.jsonl`). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const agent = new URL(req.url).searchParams.get('agent');
  if (agent) {
    return NextResponse.json(
      await callSessionRpc(id, 'get_subagent_messages', { agent_id: agent }));
  }
  return NextResponse.json(hideInternalCodexSubagents(
    await callSessionRpc(id, 'list_subagents'),
  ));
}
