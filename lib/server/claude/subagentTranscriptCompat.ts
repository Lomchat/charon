import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { accountProfileId } from '@/lib/accountProfiles';
import { subagentOutputText } from '@/app/backgroundOutput';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';

/** Old readers looked for content outside the message envelope, returning "null"
 * for every SDK SessionMessage. Read a bounded, identity-checked native tail
 * through the existing file RPCs while busy agents wait for their safe update. */
export async function recoverSubagentTranscript(sessionId: string, agentId: string, result: any) {
  if (!result?.ok || !Array.isArray(result.messages) || !result.messages.length
    || !result.messages.every((m: any) => m.content == null || m.content === 'null')) return result;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row || row.kind !== 'claude' || !row.claudeSessionId || !/^[\w-]+$/.test(agentId)) return result;
  const profile = accountProfileId(row.codexConfig);
  const project = row.cwd?.replace(/[^a-zA-Z0-9]/g, '-');
  const fail = { ok: false, reason: 'unsupported', error: 'The installed agent cannot decode this SDK transcript. Update the agent when the session is idle.' };
  if (!project || project.length > 200 || !/^[a-f0-9-]+$/i.test(row.claudeSessionId)
    || (profile !== 'default' && !/^[a-f0-9]{16}$/.test(profile))) return fail;
  const home = profile === 'default' ? '~/.claude' : `~/.charon/accounts/claude/${profile}`;
  const root = `${home}/projects/${project}/${row.claudeSessionId}/subagents`;
  const client = getAgentClientForVpsId(row.vpsId);
  try {
    const found = await client.call<any>('fs_search', {
      root, query: `agent-${agentId}.jsonl`, mode: 'file', max_results: 2, use_default_excludes: false,
    });
    if (!found.ok || !Array.isArray(found.files)) return fail;
    const paths = found.files.filter((f: any) => typeof f.path === 'string' && f.path.split('/').pop() === `agent-${agentId}.jsonl`);
    if (paths.length !== 1) return fail;
    const range = await client.call<any>('fs_read_range', { root, path: paths[0].path, offset: -262144, length: 262144 });
    if (!range.ok || typeof range.data !== 'string') return fail;
    let raw = Buffer.from(range.data, 'base64').toString('utf8');
    if (range.offset > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    const records = raw.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const uuids = new Set(result.messages.map((m: any) => m.uuid).filter(Boolean));
    // A guessed default/config directory is NEVER trusted without native IDs.
    if (!records.some((record: any) => uuids.has(record.uuid) || (record.sessionId === row.claudeSessionId && record.agentId === agentId))) return fail;
    const messages = records.filter((r: any) => ['user', 'assistant'].includes(r.type) && r.message)
      .slice(-400).map((r: any) => ({ role: r.type, uuid: r.uuid,
        content: subagentOutputText([{ role: 'assistant', content: typeof r.message.content === 'string' ? r.message.content : JSON.stringify(r.message.content ?? []) }]).slice(0, 8000) }));
    return { ok: true, messages, truncated: range.offset > 0, source: 'saved_tail' };
  } catch { return fail; }
}
