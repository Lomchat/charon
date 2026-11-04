import { readWorkflowTranscript } from '@/lib/server/claude/workflowTranscript';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { recoverSubagentTranscript } from '@/lib/server/claude/subagentTranscriptCompat';
import { hideInternalCodexSubagents } from '@/lib/server/claude/sessionInsightCompat';
import { readSessionInsightSnapshot } from '@/lib/server/claude/sessionInsightSnapshot';

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
  const query = new URL(req.url).searchParams;
  const task = query.get('task');
  if (task) {
    const rawBefore = query.get('before');
    const before = rawBefore == null ? undefined : Number(rawBefore);
    if (before != null && (!Number.isSafeInteger(before) || before <= 0))
      return NextResponse.json({ ok: false, error: 'Invalid transcript cursor.' }, { status: 400 });
    return NextResponse.json(await readWorkflowTranscript(id, task, query.get('label') || '', query.get('phase') || '', before, query.get('expectedAgent') || undefined));
  }
  const agent = query.get('agent');
  if (agent) {
    return NextResponse.json(
      await recoverSubagentTranscript(id, agent, await callSessionRpc(id, 'get_subagent_messages', { agent_id: agent })));
  }
  const force = new URL(req.url).searchParams.get('force') === '1';
  return NextResponse.json(readSessionInsightSnapshot(
    id,
    'subagents',
    async () => hideInternalCodexSubagents(await callSessionRpc(id, 'list_subagents')),
    { force, maxAgeMs: 15_000 },
  ));
}
