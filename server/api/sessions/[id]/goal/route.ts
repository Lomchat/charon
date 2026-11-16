import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getOrCreateStream, resumeSession } from '@/lib/server/agent/sessionOps';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { dismissGoal, readGoal, recordGoal } from '@/lib/server/hub/goalState';
import { markSummaryDirty } from '@/lib/server/sync/syncBus';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';
import { asSessionProvider, supportsSessionCapability } from '@/lib/sessionCapabilities';
import { claudeGoalCommand, goalIsLive, type WireSessionGoal } from '@/lib/sessionGoal';

const RUNNING = new Set(['active', 'thinking', 'starting', 'background', 'failed']);

// POST /api/sessions/[id]/goal (CLAUDE.md §14.119)
// Body: { objective: string | null, tokenBudget?: number | null } — set / clear
//       { dismiss: true } — close a reached / impossible goal's bar
// Claude: the goal IS the `/goal` command, sent as the user's message (it shows
// in the transcript, wakes a sleeping session); the agent reads the outcome
// back from the transcript. Codex: `thread/goal/set|clear` on the live thread.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const stream = getOrCreateStream(id);
  if (!stream) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const kind = asSessionProvider(stream.kind);
  const body = await req.json().catch(() => null) as
    { objective?: unknown; tokenBudget?: unknown; dismiss?: unknown } | null;

  if (body?.dismiss === true) {
    if (dismissGoal(id)) markSummaryDirty(id);
    return NextResponse.json({ ok: true, sync: syncAfter([id]) });
  }
  if (!supportsSessionCapability(kind, 'goal')) {
    return NextResponse.json({ error: 'This backend has no goals.' }, { status: 400 });
  }
  const raw = body?.objective;
  if (raw !== null && (typeof raw !== 'string' || !raw.trim())) {
    return NextResponse.json({ error: 'objective must be a non-empty string or null' }, { status: 400 });
  }
  const objective = typeof raw === 'string' ? raw.trim().slice(0, 4000) : null;
  const budget = typeof body?.tokenBudget === 'number' && Number.isInteger(body.tokenBudget) && body.tokenBudget > 0
    ? body.tokenBudget : null;

  try {
    if (kind === 'claude') {
      // A reached / impossible goal has no hook left to clear: just close it.
      if (objective === null && !goalIsLive(readGoal(id))) {
        if (dismissGoal(id)) markSummaryDirty(id);
        return NextResponse.json({ ok: true, sync: syncAfter([id]) });
      }
      await stream.sendUserMessage(claudeGoalCommand(objective));
      return NextResponse.json({ ok: true, sync: syncAfter([id]) });
    }
    const live = RUNNING.has(stream.status) ? stream : await resumeSession(id);
    const r = await getAgentClientForVpsId(live.vpsId).call<{ ok?: boolean; error?: string; goal?: WireSessionGoal | null }>(
      'set_goal', { session_id: id, objective, token_budget: budget },
    );
    if (r?.ok === false) return NextResponse.json({ error: r.error || 'The goal was refused.' }, { status: 409 });
    if (r && 'goal' in r && recordGoal(id, r.goal ?? null, Date.now())) markSummaryDirty(id);
    return NextResponse.json({ ok: true, sync: syncAfter([id]) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? String(e) }, { status: 500 });
  }
}
