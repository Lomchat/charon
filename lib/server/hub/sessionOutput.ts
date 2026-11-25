import 'server-only';
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db, agentSessions, sessionMessages } from '@/lib/db';
import { projectAgentRecord, type AgentActivity, type AgentTranscriptInfo } from '@/lib/subagentActivity';
import type { WorkflowOutputResponse } from '@/lib/types/api';

// A sub-session's own transcript as background-work output (§14.91): what it
// wrote, its tool calls and their results, projected like a native agent's
// (`projectAgentRecord`: no thinking, no opaque tool inputs), paged by row id
// in the shape `useWorkflowOutput` reads.

export const SESSION_OUTPUT_PAGE = 120;
const TEXT_CAP = 16_000;
const MISSION_CAP = 4_000;
const ROLES = ['assistant', 'tool_use', 'tool_result'];

type Row = { id: number; role: string; content: string; tsMs: number | null };

function cap(s: string | undefined): string | undefined {
  return s && s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}\n…` : s;
}

function project(row: Row): AgentActivity[] {
  const at = row.tsMs != null ? new Date(row.tsMs).toISOString() : null;
  if (row.role === 'assistant') {
    const text = row.content.trim();
    return text ? [{ id: `${row.id}:0`, kind: 'text', at, content: cap(text) }] : [];
  }
  let block: unknown;
  try { block = JSON.parse(row.content); } catch { return []; }
  const record = { type: row.role === 'tool_use' ? 'assistant' : 'user', timestamp: at, message: { content: [block] } };
  return projectAgentRecord(record, row.id).map((e) => ({ ...e, content: cap(e.content), detail: cap(e.detail) }));
}

/** Its task: the first thing it was told (a peer request or a typed prompt). */
function mission(sessionId: string): Pick<AgentTranscriptInfo, 'mission' | 'missionTruncated'> {
  const row = db.select({ role: sessionMessages.role, content: sessionMessages.content }).from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), or(eq(sessionMessages.role, 'user'),
      and(eq(sessionMessages.role, 'event'), sql`json_extract(${sessionMessages.content}, '$.type') = 'external_message'`))))
    .orderBy(asc(sessionMessages.id)).limit(1).get();
  if (!row) return {};
  let text = row.content;
  if (row.role === 'event') {
    try { text = String(JSON.parse(row.content)?.text ?? ''); } catch { text = ''; }
  }
  text = text.trim();
  if (!text) return {};
  return text.length > MISSION_CAP ? { mission: text.slice(0, MISSION_CAP), missionTruncated: true } : { mission: text };
}

/** The newest page, the page before `before`, or what came after `after`. */
export function readSessionOutput(sessionId: string, opts: { before?: number; after?: number } = {}): WorkflowOutputResponse | null {
  const s = db.select({ model: agentSessions.model, effectiveModel: agentSessions.effectiveModel, effort: agentSessions.effort })
    .from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
  if (!s) return null;
  const pick = { id: sessionMessages.id, role: sessionMessages.role, content: sessionMessages.content, tsMs: sessionMessages.tsMs };
  const mine = and(eq(sessionMessages.sessionId, sessionId), inArray(sessionMessages.role, ROLES));
  let rows: Row[];
  let nextBefore: number | null = null;
  let nextAfter: number;
  let moreAfter = false;
  if (opts.after != null) {
    rows = db.select(pick).from(sessionMessages).where(and(mine, gt(sessionMessages.id, opts.after)))
      .orderBy(asc(sessionMessages.id)).limit(SESSION_OUTPUT_PAGE + 1).all() as Row[];
    moreAfter = rows.length > SESSION_OUTPUT_PAGE;
    rows = rows.slice(0, SESSION_OUTPUT_PAGE);
    nextAfter = rows.length ? rows[rows.length - 1].id : opts.after;
  } else {
    const where = opts.before != null ? and(mine, lt(sessionMessages.id, opts.before)) : mine;
    rows = db.select(pick).from(sessionMessages).where(where)
      .orderBy(desc(sessionMessages.id)).limit(SESSION_OUTPUT_PAGE + 1).all() as Row[];
    const older = rows.length > SESSION_OUTPUT_PAGE;
    rows = rows.slice(0, SESSION_OUTPUT_PAGE).reverse();
    nextBefore = older && rows.length ? rows[0].id : null;
    nextAfter = rows.length ? rows[rows.length - 1].id : 0;
  }
  const model = s.effectiveModel ?? s.model;
  const info: AgentTranscriptInfo = {
    ...(model ? { model } : {}), ...(s.effort ? { effort: s.effort } : {}),
    // Read once, with the first page.
    ...(opts.after == null && opts.before == null ? mission(sessionId) : {}),
  };
  return {
    ok: true, agentId: sessionId, blocks: [], entries: rows.flatMap(project), info,
    nextBefore, nextAfter, moreAfter, fileId: '', cursor: '', source: 'session_transcript',
  };
}
