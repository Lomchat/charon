import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { ImportedMessage } from './importJsonl';

// Import an existing Cursor conversation's history.
//
// Unlike Claude and Codex, this does NOT read files over ssh: Cursor's store is
// the SDK's own checkpoint tree, whose layout is explicitly private, and the
// SDK is also the only thing that knows which ids a later `Agent.resume` will
// accept. So the agent asks the SDK (`cursor_agent_messages`) and we take its
// answer — which is exactly the transcript the resumed model will see.
//
// Only user/assistant prose is imported. Tool traffic belongs to the run that
// produced it: replaying it here would leave unresolved tool cards whose ids
// nothing in this transcript ever answers (§14.39).
export async function importCursorAgentMessages(
  vps: Vps,
  agentId: string,
  cwd?: string,
): Promise<{ ok: boolean; messages: ImportedMessage[]; error?: string }> {
  try {
    const client = getAgentClientForVpsId(vps.id);
    const r = await client.call<{
      ok?: boolean; messages?: { role: string; content: string }[]; error?: string;
    }>('cursor_agent_messages', { agent_id: agentId, ...(cwd ? { cwd } : {}) });
    if (!r?.ok) {
      return { ok: false, messages: [], error: r?.error ?? 'could not read the conversation' };
    }
    const messages: ImportedMessage[] = [];
    for (const m of r.messages ?? []) {
      const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
      const content = typeof m?.content === 'string' ? m.content : '';
      // The SDK gives no per-message timestamp, so `ts` stays null and the row
      // is stamped on insert — the same thing an undated Claude import does.
      if (role && content) messages.push({ role, content, ts: null });
    }
    return { ok: true, messages };
  } catch (e: any) {
    const tooOld = e?.code === -32601;
    return {
      ok: false, messages: [],
      error: tooOld ? 'agent too old to read Cursor history — update the agent'
        : String(e?.message ?? e),
    };
  }
}
