import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { stopBackgroundTask } from '@/lib/server/agent/sessionOps';

// POST /api/claude/sessions/[id]/bg-tasks/[taskId]/stop
// Kill ONE background task (the SDK's `stop_task`), leaving the session and
// its current turn running — "kill the sub-agent, not the agent" (§14.91).
// The terminal bg_task event comes back on the session's normal stream, so
// there is nothing to return here but the ack: the bar clears when the CLI
// says the task is actually gone, not when the button was clicked.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id, taskId } = await params;
  if (!taskId) return NextResponse.json({ error: 'taskId required' }, { status: 400 });
  try {
    await stopBackgroundTask(id, taskId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
