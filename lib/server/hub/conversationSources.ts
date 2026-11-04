import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db, sessionMessages } from '@/lib/db';
import { bgTaskLaunchAnchorsIfWarm } from '@/lib/server/hub/bgTaskState';
import { compactToolInputForWire } from '@/lib/server/hub/messageWire';
import { isBgLaunchToolUse, type BgTask } from '@/app/bgTasks';
import type { AgentSessionToolCallsResponse, ToolCallSummary } from '@/lib/types/api';

/**
 * Compact sources for what tool rows used to feed (CLAUDE.md §14.25).
 *
 * The conversation view (`?view=conversation`, tools hidden) never ships
 * tool/thinking rows, so whatever the browser derived from them comes from
 * bounded server reads instead: the tool-call counter, the ExitPlan card's
 * fallback text, a running background task's command, and the lazy calls tab.
 *
 * Every read seeks `idx_…_snapshot_lookup` = (session_id, role,
 * snapshot_file_path, snapshot_phase, id). tool_use/tool_result rows never
 * carry snapshot columns (messageWire.ts § deriveMessageStorage), so `IS NULL`
 * on both pins the index's equality prefix and `id` orders the seek; without it
 * SQLite sorts every tool row of the session, or walks (session_id, id) through
 * every role. Payloads are read as `coalesce(wire_content, content)` — the
 * bounded preview the window GET serves too — never the lossless `content` of
 * a tool_result (megabytes in a heavy session); JSON is taken apart in SQLite.
 */

const TOOL_ROWS = (sessionId: string, role: 'tool_use' | 'tool_result') => sql`
  session_id = ${sessionId} AND role = ${role}
  AND snapshot_file_path IS NULL AND snapshot_phase IS NULL`;

/** `tool_use` rows of the session (a covering-index count). */
export function countToolCalls(sessionId: string): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, 'tool_use')))
    .get();
  return Number(row?.n ?? 0);
}

// ── ExitPlan fallback ───────────────────────────────────────────────────────

/** tool_use rows looked at, newest first, for the plan file an ExitPlan names. */
export const EXIT_PLAN_LOOKBACK = 200;

/**
 * The plan text of a pending ExitPlan that arrived without one: the newest
 * `Write`/`Edit` (≤ EXIT_PLAN_LOOKBACK tool_use rows back) of a file under
 * `/.claude/plans/`. `Write` ⇒ its `input.content`; otherwise the latest
 * `edit_snapshot` 'after' body of that path — stripped from the window GET
 * (§14.41) but read here. '' when nothing qualifies. Replaces the browser's
 * scan of the tool rows the conversation view no longer loads.
 */
export function exitPlanFallback(sessionId: string): string {
  const candidates = db.all<{ id: number; name: string; fp: string }>(sql`
    SELECT id, name, fp FROM (
      SELECT id,
        CASE WHEN json_valid(wc) THEN json_extract(wc, '$.name') END AS name,
        CASE WHEN json_valid(wc) THEN json_extract(wc, '$.input.file_path') END AS fp
      FROM (
        SELECT id, coalesce(wire_content, content) AS wc FROM session_messages
        WHERE ${TOOL_ROWS(sessionId, 'tool_use')}
        ORDER BY id DESC LIMIT ${EXIT_PLAN_LOOKBACK}
      )
    )
    WHERE name IN ('Write', 'Edit') AND typeof(fp) = 'text' AND instr(fp, '/.claude/plans/') > 0
    ORDER BY id DESC`);
  for (const c of candidates) {
    if (c.name === 'Write') {
      // The lossless row: a long plan is truncated in its wire preview.
      const w = db.get<{ t: string | null; v: unknown }>(sql`
        SELECT CASE WHEN json_valid(content) THEN json_type(content, '$.input.content') END AS t,
               CASE WHEN json_valid(content) THEN json_extract(content, '$.input.content') END AS v
        FROM session_messages WHERE id = ${c.id}`);
      if (w?.t === 'text' && typeof w.v === 'string' && w.v) return w.v;
    }
    const snap = db.get<{ t: string | null; v: unknown }>(sql`
      SELECT CASE WHEN json_valid(content) THEN json_type(content, '$.content') END AS t,
             CASE WHEN json_valid(content) THEN json_extract(content, '$.content') END AS v
      FROM session_messages
      WHERE session_id = ${sessionId} AND role = 'edit_snapshot'
        AND snapshot_file_path = ${c.fp} AND snapshot_phase = 'after'
      ORDER BY id DESC LIMIT 1`);
    if (snap?.t === 'text' && typeof snap.v === 'string' && snap.v) return snap.v;
  }
  return '';
}

// ── Background-task launchers ───────────────────────────────────────────────

/** tool_use rows looked at, backward from a task's `started` row. */
export const BG_LAUNCHER_LOOKBACK = 50;

/**
 * Running tasks get the `command`/`description` of their launcher tool_use —
 * what the browser's rebuild takes from a `Bash run_in_background` row
 * (`app/bgTasks.ts § applyBgTaskEvent` launch candidates), which the server
 * registry deliberately never scans for. Bounded by the RUNNING count: from
 * each task's latest `started` row naming that launcher (its row id, kept by
 * the bg registry fold — bgTaskState.ts § launch), a backward seek over
 * ≤ BG_LAUNCHER_LOOKBACK tool_use rows for `id === toolUseId`. A task without
 * a launcher or with a non-Bash launcher keeps what it had.
 */
export function withBgTaskLaunchers(sessionId: string, tasks: BgTask[]): BgTask[] {
  const wanted = new Map<string, string>();               // taskId → launcher tool_use id
  for (const t of tasks) {
    if (t.status === 'running' && t.toolUseId && (t.command == null || t.description == null)) {
      wanted.set(t.taskId, t.toolUseId);
    }
  }
  if (wanted.size === 0) return tasks;
  // The latest `started` row naming that launcher (O(running), no row read).
  const anchors = bgTaskLaunchAnchorsIfWarm(sessionId, wanted.keys()) ?? new Map();
  const launchers = new Map<string, { command: string | null; description: string | null }>();
  for (const [taskId, toolUseId] of wanted) {
    const anchor = anchors.get(taskId);
    if (!anchor || anchor.toolUseId !== toolUseId) continue;
    const hit = db.get<{ wc: string }>(sql`
      SELECT id, wc FROM (
        SELECT id, coalesce(wire_content, content) AS wc FROM session_messages
        WHERE ${TOOL_ROWS(sessionId, 'tool_use')} AND id < ${anchor.rowId}
        ORDER BY id DESC LIMIT ${BG_LAUNCHER_LOOKBACK}
      )
      WHERE CASE WHEN json_valid(wc) THEN json_extract(wc, '$.id') END = ${toolUseId}
      ORDER BY id DESC LIMIT 1`);
    if (!hit) continue;
    try {
      const parsed = JSON.parse(hit.wc);
      if (!isBgLaunchToolUse(parsed?.name, parsed?.input)) continue;
      launchers.set(taskId, {
        command: typeof parsed.input.command === 'string' ? parsed.input.command : null,
        description: typeof parsed.input.description === 'string' ? parsed.input.description : null,
      });
    } catch { /* unparsable launcher: nothing to add */ }
  }
  if (launchers.size === 0) return tasks;
  return tasks.map((t) => {
    const l = launchers.get(t.taskId);
    // Same precedence as the rebuild: the launcher's command, the task's own
    // description first.
    if (!l) return t;
    return { ...t, command: t.command ?? l.command, description: !t.description && l.description ? l.description : t.description };
  });
}

// ── The calls tab (GET …/tool-calls) ────────────────────────────────────────

export const TOOL_CALLS_DEFAULT_LIMIT = 200;
export const TOOL_CALLS_MAX_LIMIT = 500;
export const TOOL_RESULT_PREVIEW_CHARS = 512;
/** tool_result rows read per pairing query. */
const RESULT_CHUNK = 256;
/** tool_result rows read past `before` for results of calls straddling the
 *  page boundary (parallel calls answered after the newer page's first call). */
export const TOOL_RESULT_SPILL_ROWS = 200;
/** …and, while a SUB-AGENT launcher of the page is still unanswered, up to
 *  this many: the agent forwards every tool row of a sub-agent to the parent
 *  session BEFORE the launcher's own result, so parallel sub-agents put
 *  hundreds of result rows between a `Task` call and its answer. */
export const TOOL_RESULT_SUBAGENT_SPILL_ROWS = 5_000;
/** Tool names that launch a sub-agent (`Task`, later renamed `Agent`). */
const SUBAGENT_LAUNCHERS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/**
 * One page of tool calls, newest page first (`before` = the oldest `rowId`
 * the caller holds), returned in chronological order. Results are paired by
 * `tool_use_id` from the tool_result rows after the page's first call: up to
 * `before`, then ≤ TOOL_RESULT_SPILL_ROWS more (≤ TOOL_RESULT_SUBAGENT_SPILL_ROWS
 * while a sub-agent launcher is unanswered). A call still unpaired when a
 * bound stopped the scan says so (`resultUnknown`): `result: null` alone means
 * no result exists yet (running).
 */
export function loadToolCalls(sessionId: string, before: number | null, limit: number): AgentSessionToolCallsResponse {
  const total = countToolCalls(sessionId);
  const page = db.all<{ id: number; createdAt: number; wc: string; compacted: number }>(sql`
    SELECT id, created_at AS createdAt, coalesce(wire_content, content) AS wc,
           wire_content IS NOT NULL AS compacted
    FROM session_messages
    WHERE ${TOOL_ROWS(sessionId, 'tool_use')} ${before != null ? sql`AND id < ${before}` : sql``}
    ORDER BY id DESC LIMIT ${limit + 1}`);
  const hasMore = page.length > limit;
  if (hasMore) page.pop();
  page.reverse();
  const calls: ToolCallSummary[] = [];
  // The rebuild's rule (sessionRebuild.ts § usedCallIds, R4 F7): the first
  // row carrying an SDK id keeps it, a later duplicate gets 'h'+rowId — React
  // keys and the live merge need unique ids.
  const usedIds = new Set<string>();
  const keys: PairKey[] = [];
  const sdkIdByRow = new Map<number, string>();
  const subagentIds = new Set<string>();
  for (const row of page) {
    let parsed: { id?: unknown; name?: unknown; input?: unknown } | null = null;
    try { parsed = JSON.parse(row.wc); } catch { /* the rebuild skips it too */ }
    if (!parsed || typeof parsed !== 'object') continue;
    const sdkId = typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    if (sdkId) {
      keys.push({ rowId: row.id, sdkId });
      sdkIdByRow.set(row.id, sdkId);
      if (SUBAGENT_LAUNCHERS.has(name)) subagentIds.add(sdkId);
    }
    const callId = sdkId && !usedIds.has(sdkId) ? sdkId : `h${row.id}`;
    usedIds.add(callId);
    calls.push({
      id: callId,
      rowId: row.id,
      name,
      // A wire_content row is compacted already (re-compacting would rewrite
      // its `_bytes` with the preview's length).
      input: row.compacted ? parsed.input : compactToolInputForWire(parsed.input),
      startedAt: row.createdAt,
      result: null,
    });
  }
  if (page.length > 0 && keys.length > 0) {
    const { results, bounded } = pairToolResults(sessionId, page[0].id, before, keys, subagentIds);
    for (const call of calls) {
      call.result = results.get(call.rowId) ?? null;
      if (call.result == null && bounded && sdkIdByRow.has(call.rowId)) call.resultUnknown = true;
    }
  }
  return { calls, hasMore, total };
}

type PairKey = { rowId: number; sdkId: string };

/** Results keyed by the CALL's row id. A result row pairs with the nearest
 *  EARLIER call carrying its `tool_use_id` (the rebuild's rule: a duplicated
 *  SDK id's later call never shows the earlier call's result). `bounded`: a
 *  spill bound stopped the scan before every call was paired (an unpaired
 *  call may still have a result further on). */
function pairToolResults(
  sessionId: string, afterId: number, before: number | null,
  keys: readonly PairKey[], subagents: ReadonlySet<string>,
): { results: Map<number, { isError: boolean; preview: string }>; bounded: boolean } {
  const out = new Map<number, { isError: boolean; preview: string }>();
  // Call rows per SDK id, ascending (the page is chronological).
  const rowsById = new Map<string, number[]>();
  for (const k of keys) {
    const list = rowsById.get(k.sdkId);
    if (list) list.push(k.rowId); else rowsById.set(k.sdkId, [k.rowId]);
  }
  const lastCallRow = keys.reduce((m, k) => Math.max(m, k.rowId), 0);
  // Past the page's last call only each id's LATEST call can still pair.
  const latestOpen = new Set(rowsById.keys());
  const subagentOpen = (): boolean => {
    for (const id of subagents) if (latestOpen.has(id)) return true;
    return false;
  };
  let cursor = afterId;
  let spilled = 0;
  for (;;) {
    const rows = db.all<{ id: number; tid: unknown; err: unknown; preview: unknown }>(sql`
      SELECT id,
        json_extract(wc, '$.tool_use_id') AS tid,
        json_extract(wc, '$.is_error') AS err,
        substr(json_extract(wc, '$.content'), 1, ${TOOL_RESULT_PREVIEW_CHARS}) AS preview
      FROM (
        SELECT id, CASE WHEN json_valid(coalesce(wire_content, content))
          THEN coalesce(wire_content, content) END AS wc
        FROM session_messages
        WHERE ${TOOL_ROWS(sessionId, 'tool_result')} AND id > ${cursor}
        ORDER BY id LIMIT ${RESULT_CHUNK}
      )`);
    for (const r of rows) {
      cursor = r.id;
      if (before != null && r.id > before) {
        spilled++;
        // Past the common bound only an unanswered sub-agent launcher keeps
        // the scan going (any result met on the way still pairs).
        if (spilled > TOOL_RESULT_SUBAGENT_SPILL_ROWS
          || (spilled > TOOL_RESULT_SPILL_ROWS && !subagentOpen())) return { results: out, bounded: true };
      }
      const callRows = typeof r.tid === 'string' ? rowsById.get(r.tid) : undefined;
      if (!callRows) continue;
      let callRow: number | null = null;
      for (const c of callRows) { if (c < r.id) callRow = c; else break; }
      if (callRow == null) continue;
      out.set(callRow, {
        isError: !!r.err,
        preview: typeof r.preview === 'string' ? r.preview : r.preview == null ? '' : String(r.preview),
      });
      if (callRow === callRows[callRows.length - 1]) latestOpen.delete(r.tid as string);
      if (latestOpen.size === 0 && r.id > lastCallRow) return { results: out, bounded: false };
    }
    if (rows.length < RESULT_CHUNK) return { results: out, bounded: false };
  }
}
