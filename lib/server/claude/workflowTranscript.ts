import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionMessages } from '@/lib/db';
import { accountProfileId } from '@/lib/accountProfiles';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { SessionBackgroundTaskAgent } from '@/lib/types/api';
import { visibleSubagentBlocks } from '@/app/backgroundOutput';

const PAGE = 256 * 1024;
const MAX_RECORD = 1024 * 1024;
const safeId = /^[a-zA-Z0-9_-]+$/;
type Reader = (params: { root: string; path: string; offset: number; length: number }) => Promise<any>;

/** Only the persisted launcher receipt binds a task to a run. Labels alone
 * cannot distinguish repeated workflows. Never accept a file path from HTTP. */
export function workflowRunFromReceipt(raw: string, taskId: string): string | null {
  try {
    const receipt = JSON.parse(raw);
    if (receipt.type !== 'tool_result' || receipt.is_error || typeof receipt.content !== 'string') return null;
    const task = /^Workflow launched in background\. Task ID: ([\w-]+)\r?$/m.exec(receipt.content)?.[1];
    const run = /^Run ID: (wf_[\w-]+)\r?$/m.exec(receipt.content)?.[1];
    return task === taskId && run ? run : null;
  } catch { return null; }
}

export function workflowAgentFromJournal(raw: string, label: string, phase: string): string | null {
  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r.type === 'started' && r.label === label && (!phase || r.phase === phase)
        && typeof r.agentId === 'string' && safeId.test(r.agentId)) ids.add(r.agentId);
    } catch { /* unfinished journal record */ }
  }
  // Retries with the same label are ambiguous: never pick an arbitrary child.
  return ids.size === 1 ? [...ids][0] : null;
}

/** Journal identities restore the graph after transient progress is lost.
 * Only an actual result proves completion; absence of a result means unknown. */
export function workflowAgentsFromJournal(raw: string): SessionBackgroundTaskAgent[] {
  const rows = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const finished = new Set(rows.filter(r => r.type === 'result').map(r => r.agentId));
  const seen = new Set<string>();
  return rows.flatMap(r => {
    if (r.type !== 'started' || typeof r.agentId !== 'string' || !safeId.test(r.agentId)
      || typeof r.label !== 'string' || seen.has(r.agentId)) return [];
    seen.add(r.agentId);
    return [{ index: seen.size - 1, label: r.label, phaseTitle: typeof r.phase === 'string' ? r.phase : null,
      state: finished.has(r.agentId) ? 'done' : null, model: null, tokens: null, toolCalls: null,
      durationMs: null, resultPreview: null }];
  }).slice(0, 200);
}

/** Byte cursors end on record boundaries, so prepending pages loses neither
 * long messages nor UTF-8 characters. No per-message 8k clipping. */
export async function readWorkflowTranscriptPage(read: Reader, root: string, path: string,
  sessionId: string, agentId: string, before?: number) {
  let length = PAGE;
  for (;;) {
    const offset = before == null ? -length : Math.max(0, before - length);
    const range = await read({ root, path, offset, length: before == null ? length : Math.min(length, before) });
    if (!range.ok || typeof range.data !== 'string') throw new Error(range.error || 'Transcript unavailable.');
    if (before != null && range.size < before) throw new Error('The transcript changed. Return to latest output.');
    const bytes = Buffer.from(range.data, 'base64');
    const start = range.offset > 0 ? bytes.indexOf(10) + 1 : 0;
    // The record spanning a page edge is fetched intact on the next page.
    // If the entire window is one record, enlarge it rather than lose text.
    if (range.offset > 0 && (start === 0 || start === bytes.length)) {
      if (length >= MAX_RECORD) throw new Error('A transcript record exceeds the readable page size (1 MiB).');
      length = Math.min(length * 2, MAX_RECORD); continue;
    }
    const blocks: string[] = [];
    for (const line of bytes.subarray(start).toString('utf8').split('\n')) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'assistant') continue;
      if (r.sessionId !== sessionId || r.agentId !== agentId) throw new Error('Transcript identity mismatch.');
      blocks.push(...visibleSubagentBlocks(r.message?.content));
    }
    const nextBefore = range.offset + start;
    return { ok: true, agentId, blocks, nextBefore: nextBefore > 0 ? nextBefore : null, source: 'workflow_transcript' };
  }
}

export async function readWorkflowTranscript(sessionId: string, taskId: string, label: string, phase: string,
  before?: number, expectedAgent?: string) {
  const unavailable = { ok: false, reason: 'unavailable', error: 'This workflow node could not be linked to a saved transcript. Preview only.' };
  if (!safeId.test(taskId) || label.length > 500 || phase.length > 500) return unavailable;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row || row.kind !== 'claude' || !row.claudeSessionId || !/^[a-f0-9-]+$/i.test(row.claudeSessionId)) return unavailable;
  const profile = accountProfileId(row.codexConfig);
  const project = row.cwd?.replace(/[^a-zA-Z0-9]/g, '-');
  if (!project || project.length > 200 || (profile !== 'default' && !/^[a-f0-9]{16}$/.test(profile))) return unavailable;
  const receipts = db.select({ content: claudeSessionMessages.content }).from(claudeSessionMessages).where(and(
    eq(claudeSessionMessages.sessionId, sessionId), eq(claudeSessionMessages.role, 'tool_result'),
    sql`instr(${claudeSessionMessages.content}, ${taskId}) > 0`,
  )).limit(100).all();
  const runs = new Set(receipts.map(r => workflowRunFromReceipt(r.content, taskId)).filter(Boolean));
  if (runs.size !== 1) return unavailable;
  const home = profile === 'default' ? '~/.claude' : `~/.charon/accounts/claude/${profile}`;
  const root = `${home}/projects/${project}/${row.claudeSessionId}/subagents/workflows/${[...runs][0]}`;
  const client = getAgentClientForVpsId(row.vpsId);
  const read: Reader = (params) => client.call('fs_read_range', params);
  try {
    const journal = await read({ root, path: 'journal.jsonl', offset: 0, length: MAX_RECORD });
    if (!journal.ok || typeof journal.data !== 'string' || journal.size > MAX_RECORD) return unavailable;
    const rawJournal = Buffer.from(journal.data, 'base64').toString('utf8');
    if (!label) return { ok: true, agents: workflowAgentsFromJournal(rawJournal) };
    const agentId = workflowAgentFromJournal(rawJournal, label, phase);
    if (!agentId || (expectedAgent && expectedAgent !== agentId)) return unavailable;
    return await readWorkflowTranscriptPage(read, root, `agent-${agentId}.jsonl`, row.claudeSessionId, agentId, before);
  } catch (err) { return { ok: false, reason: 'unavailable', error: err instanceof Error ? err.message : unavailable.error }; }
}
