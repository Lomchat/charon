// Pure planning rules of the OFFLINE thinking compaction (CLAUDE.md §14.109,
// sync refonte C04; the runner is scripts/compact-thinking.mjs).
//
// Before C02 the hub persisted a delta provider's reasoning as ONE `event` row
// per streamed token (`{type:'thinking', text}`): millions of rows that the
// client re-joins on every rebuild (app/thinkingMessages.ts). Compaction
// merges such a run into its FIRST row (which keeps id, seq, ts_ms,
// created_at), so the rendered transcript is unchanged while the table
// shrinks. No I/O here — the planner sees rows in rebuild order and answers
// which ones merge.
//
// A run R1..Rk (k ≥ 2) merges iff:
//  - the rows are STRICTLY consecutive in rebuild order
//    `(coalesce(ts_ms, created_at*1000), id)` — no other row of any role in
//    between (a tool call, a turn_usage close, a hub-stamped bg_task…);
//  - every row is mergeable thinking (`isMergeableThinking`);
//  - every row has `seq IS NULL`, or a seq at or below the session's durable
//    cursor (`agent_sessions.last_seen_seq`): rows above it are still
//    replayed by identity after the restart and must keep their own seq
//    (the runner passes NO cursor for a session whose seqs restarted — a
//    recreated agent log, compact-thinking.mjs § seqEpochSuspect);
//  - seq-NULL rows (fork copies, imports) and seq rows never mix, and a seq
//    run needs CONSECUTIVE seqs: a gap reveals a rowless durable event
//    (`status`, `ready`, `permission_request`, `effective_model`, …) that
//    closed the live block and resets the replay cover (C02), so a row merged
//    across it would be inserted again by a replay from below the cursor;
//  - the merged text stays within `maxChars` (else a new run starts there).

/** Session kinds whose reasoning arrives as deltas (PROVIDERS[*].thinkingDelivery
 *  === 'delta', lib/sessionCapabilities.ts — a test pins the equality). Claude
 *  thinking blocks are complete rows: never compacted. */
export const DELTA_KINDS = Object.freeze(['codex', 'cursor']);

/** Upper bound of one merged row (= THINKING_ROW_MAX_CHARS, the hub's live cut). */
export const DEFAULT_MAX_CHARS = 262144;

/**
 * One `session_messages` row as the runner reads it. `content` is only
 * needed for `role='event'` rows; `wnull` is `wire_content IS NULL` (1/0).
 * The rebuild key is `k` when present, else `coalesce(ts_ms, created_at*1000)`.
 * @typedef {{
 *   id: number, role: string, seq: number | null,
 *   content?: string | null,
 *   wnull?: number | boolean, wire_content?: string | null,
 *   ts_ms?: number | null, created_at?: number | null, k?: number | null,
 * }} CompactionRow
 */

/**
 * One merge: R1 (`keepId`) gets `text`, the others (`deleteIds`) go. The extra
 * fields locate the run for `--verify`.
 * @typedef {{
 *   keepId: number, text: string, deleteIds: number[],
 *   keepSeq: number | null, keepKey: number, lastId: number, lastKey: number,
 * }} CompactionOp
 */

/** @param {CompactionRow} row */
function wireIsNull(row) {
  if ('wnull' in row) return row.wnull === 1 || row.wnull === true;
  if ('wire_content' in row) return row.wire_content == null;
  return false;   // unknown: not provably the cheap form
}

/**
 * The reasoning text of a mergeable row, else null: `role='event'`,
 * `wire_content` NULL, content parsing to an object with EXACTLY the keys
 * `type` and `text`, `type==='thinking'`, a non-empty string `text` (the
 * client drops empty fragments, app/thinkingMessages.ts).
 * @param {CompactionRow} row
 * @returns {string | null}
 */
export function mergeableThinkingText(row) {
  if (!row || row.role !== 'event' || !wireIsNull(row)) return null;
  if (typeof row.content !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(row.content); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('text')) return null;
  if (parsed.type !== 'thinking' || typeof parsed.text !== 'string' || parsed.text === '') return null;
  return parsed.text;
}

/** @param {CompactionRow} row */
export function isMergeableThinking(row) {
  return mergeableThinkingText(row) != null;
}

/** @param {CompactionRow} row */
function rebuildKey(row) {
  if (typeof row.k === 'number') return row.k;
  if (typeof row.ts_ms === 'number') return row.ts_ms;
  return (row.created_at ?? 0) * 1000;
}

/**
 * Streaming form of `planRuns` (the runner pages a session 20 000 rows at a
 * time): feed rows in rebuild order; `push` returns the runs it closed,
 * `end` the last one. Throws if the order is not strictly increasing.
 * @param {{ cursor: number | null, maxChars?: number }} opts
 */
export function createRunPlanner({ cursor, maxChars = DEFAULT_MAX_CHARS }) {
  if (!(maxChars > 0)) throw new Error('maxChars must be positive');
  /** @type {null | { seqKind: 'null' | 'seq', ids: number[], texts: string[], length: number,
   *  keepSeq: number | null, keepKey: number, lastSeq: number | null, lastKey: number }} */
  let run = null;
  /** @type {null | { k: number, id: number }} */
  let previous = null;

  /** @returns {CompactionOp[]} */
  function close() {
    const done = run;
    run = null;
    if (!done || done.ids.length < 2) return [];
    return [{
      keepId: done.ids[0],
      text: done.texts.join(''),
      deleteIds: done.ids.slice(1),
      keepSeq: done.keepSeq,
      keepKey: done.keepKey,
      lastId: done.ids[done.ids.length - 1],
      lastKey: done.lastKey,
    }];
  }

  return {
    /** @param {CompactionRow} row @returns {CompactionOp[]} */
    push(row) {
      const k = rebuildKey(row);
      if (previous && (k < previous.k || (k === previous.k && row.id <= previous.id))) {
        throw new Error(`rows out of rebuild order at id ${row.id}`);
      }
      previous = { k, id: row.id };
      const text = mergeableThinkingText(row);
      const seq = typeof row.seq === 'number' ? row.seq : null;
      const eligible = text != null && (seq == null || (cursor != null && seq <= cursor));
      if (!eligible) return close();
      const seqKind = seq == null ? 'null' : 'seq';
      const joins = run != null
        && run.seqKind === seqKind
        && (seqKind === 'null' || seq === /** @type {number} */ (run.lastSeq) + 1)
        && run.length + text.length <= maxChars;
      if (joins && run) {
        run.ids.push(row.id);
        run.texts.push(text);
        run.length += text.length;
        run.lastSeq = seq;
        run.lastKey = k;
        return [];
      }
      const closed = close();
      run = { seqKind, ids: [row.id], texts: [text], length: text.length, keepSeq: seq, keepKey: k, lastSeq: seq, lastKey: k };
      return closed;
    },
    /** @returns {CompactionOp[]} */
    end() {
      return close();
    },
  };
}

/**
 * Plan the merges of one session. `rows` = every row of the session (any
 * role) in rebuild order `(coalesce(ts_ms, created_at*1000), id)`; `cursor` =
 * its `last_seen_seq` (null ⇒ only seq-NULL runs merge).
 * @param {CompactionRow[]} rows
 * @param {{ cursor: number | null, maxChars?: number }} opts
 * @returns {CompactionOp[]}
 */
export function planRuns(rows, { cursor, maxChars = DEFAULT_MAX_CHARS }) {
  const planner = createRunPlanner({ cursor, maxChars });
  /** @type {CompactionOp[]} */
  const ops = [];
  for (const row of rows) ops.push(...planner.push(row));
  ops.push(...planner.end());
  return ops;
}

/** The content a merged row is rewritten to (the hub's own row shape). */
export function mergedThinkingContent(text) {
  return JSON.stringify({ type: 'thinking', text });
}
