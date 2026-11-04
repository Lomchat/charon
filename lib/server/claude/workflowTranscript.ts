import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionMessages } from '@/lib/db';
import { accountProfileId } from '@/lib/accountProfiles';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { SessionBackgroundTaskAgent } from '@/lib/types/api';
import { projectAgentRecord, type AgentActivity, type AgentTranscriptInfo } from '@/lib/subagentActivity';
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

export type TranscriptCursor = { after?: number; fileId?: string; cursor?: string; nativeAgent?: string };
class TranscriptReset extends Error { readonly reason = 'reset'; }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 24);

/** Stable byte boundaries for older pages AND append-only updates. An incomplete
 * final record stays behind the cursor until its newline arrives. The inode and
 * the bytes preceding the cursor detect replacement/truncation; never merge epochs. */
export async function readWorkflowTranscriptPage(read: Reader, root: string, path: string,
  sessionId: string, agentId: string, before?: number, options: TranscriptCursor = {}) {
  let length = PAGE;
  const after = options.after;
  const prefix = after == null ? 0 : Math.min(64, after);
  for (;;) {
    const offset = after != null ? after - prefix : before == null ? -length : Math.max(0, before - length);
    const range = await read({ root, path, offset, length: after != null ? length : before == null ? length : Math.min(length, before) });
    if (!range.ok || typeof range.data !== 'string') throw new Error(range.error || 'Transcript unavailable.');
    const fileId = typeof range.version === 'string' ? range.version.split(':').slice(0, 2).join(':') : '';
    if ((options.fileId && options.fileId !== fileId) || (before != null && range.size < before) || (after != null && range.size < after))
      throw new TranscriptReset('The transcript changed. Reloading its latest activity.');
    const bytes = Buffer.from(range.data, 'base64');
    if (after != null && options.cursor && digest(bytes.subarray(0, prefix)) !== options.cursor)
      throw new TranscriptReset('The transcript changed. Reloading its latest activity.');
    const start = after != null ? prefix : range.offset > 0 ? bytes.indexOf(10) + 1 : 0;
    const lastNewline = bytes.lastIndexOf(10);
    const end = lastNewline >= start ? lastNewline + 1 : start;
    // Grow only to include a complete record, not to transfer the whole file.
    const noRecord = after != null ? end <= prefix && bytes.length >= length : range.offset > 0 && (start === 0 || start === bytes.length);
    if (noRecord) {
      if (length >= MAX_RECORD) throw new Error('A transcript record exceeds the readable page size (1 MiB).');
      length = Math.min(length * 2, MAX_RECORD); continue;
    }
    const entries: AgentActivity[] = [];
    const blocks: string[] = [];
    let position = start;
    while (position < end) {
      const next = bytes.indexOf(10, position);
      const line = bytes.subarray(position, next).toString('utf8');
      const recordOffset = range.offset + position;
      position = next + 1;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (!['assistant', 'user'].includes(r.type)) continue;
      if (r.sessionId !== sessionId || r.agentId !== agentId) throw new Error('Transcript identity mismatch.');
      entries.push(...projectAgentRecord(r, recordOffset));
      if (r.type === 'assistant') blocks.push(...visibleSubagentBlocks(r.message?.content));
    }
    const nextBefore = range.offset + start;
    const nextAfter = range.offset + end;
    return { ok: true as const, agentId, blocks, entries, nextBefore: nextBefore > 0 ? nextBefore : null,
      nextAfter, moreAfter: range.offset + bytes.length < range.size, fileId,
      cursor: digest(bytes.subarray(Math.max(0, end - Math.min(64, nextAfter)), end)), source: 'workflow_transcript' as const };
  }
}

// Binding and metadata caches are bounded and scoped by native session/account.
// No transcript contents are retained server-side. Failed resolutions aren't cached.
const memo = new Map<string, { until: number; value: any }>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await load();
  if (value != null) {
    memo.delete(key); memo.set(key, { until: Date.now() + ttl, value });
    while (memo.size > 128) memo.delete(memo.keys().next().value!);
  }
  return value;
}
async function transcriptInfo(read: Reader, root: string, path: string, sessionId: string, agentId: string, scope: string): Promise<AgentTranscriptInfo> {
  return cached(`info:${scope}:${root}/${path}`, 300_000, async () => {
    const info: AgentTranscriptInfo = {};
    try {
      const meta = await read({ root, path: path.replace(/\.jsonl$/, '.meta.json'), offset: 0, length: 16384 });
      if (meta.ok && meta.size <= 16384) {
        const m = JSON.parse(Buffer.from(meta.data, 'base64').toString('utf8'));
        info.model = typeof m.pickedEffortModel === 'string' ? m.pickedEffortModel : typeof m.model === 'string' ? m.model : undefined;
        info.phase = typeof m.workflowPhase === 'string' ? m.workflowPhase : undefined;
      }
      const head = await read({ root, path, offset: 0, length: 65536 });
      if (head.ok) {
        for (const line of Buffer.from(head.data, 'base64').toString('utf8').split('\n')) {
          let r: any; try { r = JSON.parse(line); } catch { continue; }
          if (r.sessionId !== sessionId || r.agentId !== agentId || r.type !== 'user') continue;
          const content = r.message?.content;
          const prompt = typeof content === 'string' ? content : Array.isArray(content)
            ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
          if (!prompt) continue;
          const clean = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          info.mission = clean.slice(0, 8000); info.missionTruncated = clean.length > 8000;
          if (typeof r.timestamp === 'string') info.startedAt = r.timestamp;
          break;
        }
      }
    } catch { /* metadata is optional; the identity-checked transcript still works */ }
    return info;
  });
}

export async function readWorkflowTranscript(sessionId: string, taskId: string, label: string, phase: string,
  before?: number, expectedAgent?: string, options: TranscriptCursor = {}) {
  const unavailable = { ok: false, reason: 'unavailable', error: 'This workflow node could not be linked to a saved transcript. Preview only.' };
  if ((!options.nativeAgent && !safeId.test(taskId)) || (options.nativeAgent && !safeId.test(options.nativeAgent)) || label.length > 500 || phase.length > 500) return unavailable;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row || row.kind !== 'claude' || !row.claudeSessionId || !/^[a-f0-9-]+$/i.test(row.claudeSessionId)) return unavailable;
  const profile = accountProfileId(row.codexConfig);
  const project = row.cwd?.replace(/[^a-zA-Z0-9]/g, '-');
  if (!project || project.length > 200 || (profile !== 'default' && !/^[a-f0-9]{16}$/.test(profile))) return unavailable;
  const home = profile === 'default' ? '~/.claude' : `~/.charon/accounts/claude/${profile}`;
  const sessionRoot = `${home}/projects/${project}/${row.claudeSessionId}/subagents`;
  const client = getAgentClientForVpsId(row.vpsId);
  const read: Reader = (params) => client.call('fs_read_range', params);
  const scope = `${row.vpsId}:${sessionRoot}`;
  try {
    let root = sessionRoot, path: string, agentId: string;
    if (options.nativeAgent) {
      agentId = options.nativeAgent;
      const foundPath = await cached(`${scope}:native:${agentId}`, 30_000, async () => {
        const found = await client.call<any>('fs_search', { root, query: `agent-${agentId}.jsonl`, mode: 'file', max_results: 2, use_default_excludes: false });
        if (!found.ok || !Array.isArray(found.files)) return null;
        const paths = found.files.filter((f: any) => typeof f.path === 'string' && f.path.split('/').pop() === `agent-${agentId}.jsonl`);
        return paths.length === 1 ? paths[0].path as string : null;
      });
      if (!foundPath) return unavailable;
      path = foundPath;
    } else {
      const run = await cached(`${scope}:run:${taskId}`, 300_000, async () => {
        const receipts = db.select({ content: claudeSessionMessages.content }).from(claudeSessionMessages).where(and(
          eq(claudeSessionMessages.sessionId, sessionId), eq(claudeSessionMessages.role, 'tool_result'),
          sql`instr(${claudeSessionMessages.content}, ${taskId}) > 0`,
        )).limit(100).all();
        const runs = new Set(receipts.map(r => workflowRunFromReceipt(r.content, taskId)).filter(Boolean));
        return runs.size === 1 ? [...runs][0] : null;
      });
      if (!run) return unavailable;
      root += `/workflows/${run}`;
      const rawJournal = await cached(`${scope}:journal:${run}`, 10_000, async () => {
        const journal = await read({ root, path: 'journal.jsonl', offset: 0, length: MAX_RECORD });
        if (!journal.ok || typeof journal.data !== 'string' || journal.size > MAX_RECORD) return null;
        // Keep identities/states, not the potentially huge structured results.
        return Buffer.from(journal.data, 'base64').toString('utf8').split('\n').flatMap(line => {
          try {
            const r = JSON.parse(line);
            return ['started', 'result'].includes(r.type)
              ? [JSON.stringify({ type: r.type, agentId: r.agentId, label: r.label, phase: r.phase })] : [];
          } catch { return []; }
        }).join('\n');
      });
      if (rawJournal == null) return unavailable;
      if (!label) return { ok: true, agents: workflowAgentsFromJournal(rawJournal) };
      const resolved = workflowAgentFromJournal(rawJournal, label, phase);
      if (!resolved) return unavailable;
      agentId = resolved; path = `agent-${agentId}.jsonl`;
    }
    if (expectedAgent && expectedAgent !== agentId) throw new TranscriptReset('The node now points to a different agent. Reloading activity.');
    const page = await readWorkflowTranscriptPage(read, root, path, row.claudeSessionId, agentId, before, options);
    const info = before == null && options.after == null ? await transcriptInfo(read, root, path, row.claudeSessionId, agentId, scope) : undefined;
    return { ...page, info };
  } catch (err) {
    return { ok: false, reason: err instanceof TranscriptReset ? 'reset' : 'unavailable', error: err instanceof Error ? err.message : unavailable.error };
  }
}
