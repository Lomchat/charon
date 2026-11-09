// THE cross-session fact (CLAUDE.md §14.108): one `session_summary` per
// session = its list row (`annotateSessionRows`) + its pending gates + the
// derived attention. Published on the sync bus as
// `{type:'session_summary', sessionId, summary}` ONLY when `summaryKey`
// changed (volatile fields never publish on their own); `summary: null` =
// deleted OR archived (the builder never builds an archived row).
//
// Wiring: this module registers itself as the bus's summary provider at
// import (`setSummaryProvider`). The bus marks a session dirty whenever a
// SUMMARY_TRIGGERS frame carrying it is published (frameRouting.ts) and
// flushes the dirty set once per tick (microtask), so a status + unread in one
// tick yield ONE frame. `flushSummaryNow(id)` publishes synchronously: every
// push trails it (I17) and every action route reads its `sync` after it.
// A writer that changes a summary fact WITHOUT publishing a trigger owes
// `markSummaryDirty(id)` (I9); the list GET and every resync reconcile ALL
// summaries anyway and publish the diffs (self-heal).
//
// All state is on ONE `globalThis.__charonSummaries` object (§14.106): Next
// evaluates this module in several copies and they must share `lastKey`.
//
// Single-session reads are indexed (pendings by `(session_id, status)`, the
// first user row by the snapshot-lookup prefix, `MAX(ts_ms)` seek): a status
// flip never pays a whole-table GROUP BY. Gate `title`/`preview` are computed
// ONCE per gate id from a bounded prefix (`gateText`), never by re-parsing a
// megabyte Write input on every rebuild.
import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  db, agentSessions, sessionPendingPermissions, sessionPendingQuestions, type AgentSession,
} from '@/lib/db';
import { annotateSessionRows } from '@/lib/server/hub/sessionList';
import { listVpsRuntimeSnapshots } from '@/lib/server/agent/vpsRuntimeSnapshot';
import { deriveAttention } from '@/lib/sessionAttention';
import { isAsyncQuestionDelivering } from '@/lib/server/agent/asyncQuestionDelivery';
import { summaryKey, type SessionSummary, type SummaryGate } from '@/lib/sessionSummary';
import { parseSuggestions, type PermissionSuggestion } from '@/lib/permissionSuggestions';
import type { SyncRev } from '@/lib/sync/rev';
import type { WorkerStatus } from '@/lib/types/api';
import {
  currentRev, flushSummaries, flushSummaryNow, publish, setSummaryProvider, subscribeFrames,
} from './syncBus';

/** A permission's `tool_input` above this many BYTES is previewed from its
 *  raw prefix instead of being parsed and pretty-printed. */
export const GATE_PREVIEW_PARSE_MAX = 8 << 10;
export const GATE_PREVIEW_CHARS = 600;
export const GATE_TITLE_CHARS = 120;
/** A question payload above this is not parsed for its title. */
const QUESTION_PAYLOAD_PARSE_MAX = 64 << 10;
/** SQLite's variable limit is far above this; it keeps statements small. */
const IN_CHUNK = 400;

type GateText = {
  sessionId: string; title: string; preview?: string;
  reason?: string; suggestions?: PermissionSuggestion[];
};

type SummariesState = {
  /** sessionId → summaryKey of the last summary published (or delivered by a
   *  complete snapshot) for it. Absent = nothing published / gone. */
  lastKey: Map<string, string>;
  /** sessionId → first user prompt (raw). Cached once non-null; dropped on
   *  rollback (`forgetFirstUserMessage`). */
  firstUserMsg: Map<string, string>;
  /** gate id → its title/preview, computed once; dropped when the gate is no
   *  longer pending. */
  gateText: Map<string, GateText>;
  /** Bus subscription that forgets the key of a session someone else
   *  published `summary: null` for (deleteSession). */
  subscribed: boolean;
};

function state(): SummariesState {
  const g = globalThis as unknown as { __charonSummaries?: SummariesState };
  return g.__charonSummaries ??= {
    lastKey: new Map(), firstUserMsg: new Map(), gateText: new Map(), subscribed: false,
  };
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** The session's first user prompt, cached once known — only its first
 *  FIRST_MSG_CHARS characters (the summary shows 180 UTF-16 units of it, and a
 *  pasted multi-MB prompt must not be pinned in the heap). The
 *  `snapshot_* IS NULL` terms are neutral (user rows never carry them) and pin
 *  the seek to `idx_…_snapshot_lookup (session_id, role, path, phase, id)`. */
const FIRST_MSG_CHARS = 180;
function readFirstUserMessage(sessionId: string): string | null {
  const S = state();
  const hit = S.firstUserMsg.get(sessionId);
  if (hit !== undefined) return hit;
  const row = db.get(sql`
    SELECT substr(content, 1, ${FIRST_MSG_CHARS}) AS content FROM session_messages
    WHERE session_id = ${sessionId} AND role = 'user'
      AND snapshot_file_path IS NULL AND snapshot_phase IS NULL
    ORDER BY id LIMIT 1
  `) as { content: string | null } | undefined;
  const content = row?.content ?? null;
  if (content != null) S.firstUserMsg.set(sessionId, content);
  return content;
}

/** Drop the cached first prompt (a rewind may have removed it). */
export function forgetFirstUserMessage(sessionId: string): void {
  state().firstUserMsg.delete(sessionId);
}

/** A session left every list (deleted / archived): drop its cached texts —
 *  archived and deleted sessions are never rebuilt, so `loadGates` would
 *  never prune their gate entries. */
function forgetSessionCaches(sessionId: string): void {
  const S = state();
  S.firstUserMsg.delete(sessionId);
  for (const [id, t] of S.gateText) if (t.sessionId === sessionId) S.gateText.delete(id);
}

type PendingCounts = { permissions: number; blockingQuestions: number; asyncQuestions: number };

function permissionText(id: string, sessionId: string, toolName: string): GateText {
  const row = db.get(sql`
    SELECT substr(tool_input, 1, ${GATE_PREVIEW_PARSE_MAX + 1}) AS head,
           length(CAST(tool_input AS BLOB)) AS bytes,
           substr(reason, 1, ${GATE_PREVIEW_CHARS}) AS reason, suggestions
    FROM session_pending_permissions WHERE id = ${id}
  `) as {
    head: string | null; bytes: number | null; reason: string | null; suggestions: string | null;
  } | undefined;
  const head = row?.head ?? '';
  let preview = head.slice(0, GATE_PREVIEW_CHARS);
  if ((row?.bytes ?? 0) <= GATE_PREVIEW_PARSE_MAX) {
    try { preview = JSON.stringify(JSON.parse(head), null, 2).slice(0, GATE_PREVIEW_CHARS); } catch { /* raw prefix */ }
  }
  // Suggestions stay in the agent's order: a cross-session answer picks one
  // by index, exactly like the focused card (lib/permissionSuggestions.ts).
  const suggestions = parseSuggestions(row?.suggestions ?? null);
  return {
    sessionId, title: toolName || 'tool', preview,
    ...(row?.reason ? { reason: row.reason } : {}),
    ...(suggestions.length ? { suggestions: suggestions as PermissionSuggestion[] } : {}),
  };
}

function questionText(id: string, sessionId: string): GateText {
  const row = db.get(sql`
    SELECT CASE WHEN length(CAST(payload AS BLOB)) <= ${QUESTION_PAYLOAD_PARSE_MAX} THEN payload END AS payload
    FROM session_pending_questions WHERE id = ${id}
  `) as { payload: string | null } | undefined;
  let title = 'question';
  try {
    const parsed = row?.payload ? JSON.parse(row.payload) : null;
    const first = Array.isArray(parsed) ? parsed[0] : null;
    const q = first && typeof first === 'object' ? (first as { question?: unknown }).question : null;
    if (typeof q === 'string' && q.trim()) title = q.trim().slice(0, GATE_TITLE_CHARS);
  } catch { /* default title */ }
  return { sessionId, title };
}

/** Pending gates of the given sessions (indexed `(session_id, status)`), as
 *  summary gates (oldest first) and the counts the list row carries. */
function loadGates(sessionIds: string[]): { gates: Map<string, SummaryGate[]>; counts: Map<string, PendingCounts> } {
  const S = state();
  const gates = new Map<string, SummaryGate[]>();
  const counts = new Map<string, PendingCounts>();
  const count = (sid: string) => {
    let c = counts.get(sid);
    if (!c) counts.set(sid, c = { permissions: 0, blockingQuestions: 0, asyncQuestions: 0 });
    return c;
  };
  const push = (sid: string, g: SummaryGate) => {
    const list = gates.get(sid);
    if (list) list.push(g); else gates.set(sid, [g]);
  };
  const seen = new Set<string>();
  for (const ids of chunks(sessionIds)) {
    const perms = db.select({
      id: sessionPendingPermissions.id, sessionId: sessionPendingPermissions.sessionId,
      toolName: sessionPendingPermissions.toolName,
      createdAt: sessionPendingPermissions.createdAt, expiresAt: sessionPendingPermissions.expiresAt,
    }).from(sessionPendingPermissions).where(and(
      inArray(sessionPendingPermissions.sessionId, ids),
      eq(sessionPendingPermissions.status, 'pending'),
    )).orderBy(asc(sessionPendingPermissions.createdAt), asc(sessionPendingPermissions.id)).all();
    for (const p of perms) {
      seen.add(p.id);
      count(p.sessionId).permissions++;
      let text = S.gateText.get(p.id);
      if (!text) S.gateText.set(p.id, text = permissionText(p.id, p.sessionId, p.toolName));
      push(p.sessionId, {
        id: p.id, kind: 'permission', blocking: true,
        createdAt: p.createdAt, expiresAt: p.expiresAt ?? null,
        title: text.title, ...(text.preview != null ? { preview: text.preview } : {}),
        ...(text.reason ? { reason: text.reason } : {}),
        ...(text.suggestions ? { suggestions: text.suggestions } : {}),
      });
    }
    const qs = db.select({
      id: sessionPendingQuestions.id, sessionId: sessionPendingQuestions.sessionId,
      kind: sessionPendingQuestions.kind,
      createdAt: sessionPendingQuestions.createdAt, expiresAt: sessionPendingQuestions.expiresAt,
    }).from(sessionPendingQuestions).where(and(
      inArray(sessionPendingQuestions.sessionId, ids),
      eq(sessionPendingQuestions.status, 'pending'),
    )).orderBy(asc(sessionPendingQuestions.createdAt), asc(sessionPendingQuestions.id)).all();
    for (const q of qs) {
      seen.add(q.id);
      const asynchronous = q.kind === 'async_question';
      if (asynchronous) count(q.sessionId).asyncQuestions++;
      else count(q.sessionId).blockingQuestions++;
      let text = S.gateText.get(q.id);
      if (!text) {
        text = q.kind === 'exit_plan' ? { sessionId: q.sessionId, title: 'plan' } : questionText(q.id, q.sessionId);
        S.gateText.set(q.id, text);
      }
      push(q.sessionId, {
        id: q.id, kind: q.kind === 'exit_plan' ? 'exit_plan' : 'question', blocking: !asynchronous,
        createdAt: q.createdAt, expiresAt: q.expiresAt ?? null, title: text.title,
        ...(asynchronous && isAsyncQuestionDelivering(q.id) ? { delivering: true } : {}),
      });
    }
  }
  // A resolved gate's text is never needed again.
  const scope = new Set(sessionIds);
  for (const [id, t] of S.gateText) {
    if (scope.has(t.sessionId) && !seen.has(id)) S.gateText.delete(id);
  }
  for (const list of gates.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { gates, counts };
}

// ── Builders ────────────────────────────────────────────────────────────────

function buildFrom(rows: AgentSession[]): SessionSummary[] {
  const live = rows.filter((r) => !r.archived);
  if (!live.length) return [];
  const { gates, counts } = loadGates(live.map((r) => r.id));
  const zero: PendingCounts = { permissions: 0, blockingQuestions: 0, asyncQuestions: 0 };
  const items = annotateSessionRows(live, {
    vpsRuntime: listVpsRuntimeSnapshots(),
    firstUserMessage: readFirstUserMessage,
    pendingCounts: (id) => counts.get(id) ?? zero,
  });
  return items.map((item): SessionSummary => {
    const pendingBlocking = item.pendingBlocking ?? item.pendingPermissions;
    const pendingAsync = item.pendingAsync ?? 0;
    return {
      ...item,
      liveStatus: item.liveStatus as WorkerStatus,
      runningBgTasks: item.runningBgTasks ?? 0,
      lastActivityMs: item.lastActivityMs ?? null,
      addressable: item.addressable ?? false,
      pendingBlocking,
      pendingAsync,
      gates: gates.get(item.id) ?? [],
      attention: deriveAttention({
        status: String(item.liveStatus ?? item.status), unreadStop: item.unreadStop,
        pendingBlocking, pendingAsync,
      }),
    };
  });
}

/** Every NON-archived session (or the non-archived ones among `rows`), in the
 *  list order (newest first) — `annotateSessionRows` + gates + attention. */
export function buildSessionSummaries(rows?: AgentSession[]): SessionSummary[] {
  const source = rows ?? db.select().from(agentSessions)
    .where(eq(agentSessions.archived, 0))
    .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id))
    .all();
  return buildFrom(source);
}

/** One session's summary; null if it was deleted OR is archived. */
export function buildSessionSummary(id: string): SessionSummary | null {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  if (!row || row.archived) return null;
  return buildFrom([row])[0] ?? null;
}

// ── Publication ─────────────────────────────────────────────────────────────

function publishIfChanged(s: SessionSummary): void {
  const S = state();
  const key = summaryKey(s);
  if (S.lastKey.get(s.id) === key) return;
  S.lastKey.set(s.id, key);
  publish({ type: 'session_summary', sessionId: s.id, summary: s });
}

function publishGone(id: string): void {
  const S = state();
  forgetSessionCaches(id);
  if (!S.lastKey.has(id)) return;
  S.lastKey.delete(id);
  publish({ type: 'session_summary', sessionId: id, summary: null });
}

/**
 * THE summary provider (registered with the bus at import): rebuild the
 * marked sessions — `ids`, plus every non-archived session of `vpsIds` — and
 * publish each one whose key changed. A marked id with no non-archived row
 * publishes `null` once (only if a summary of it was ever published). An id
 * in `vpsIds` that is not a VPS (a `session_list_changed` carrying a session
 * id, syncBus.ts) matches nothing.
 */
export function publishSummaryDiffs(ids: string[], vpsIds: string[]): void {
  const rows = new Map<string, AgentSession>();
  for (const part of chunks([...new Set(ids)])) {
    for (const r of db.select().from(agentSessions).where(inArray(agentSessions.id, part)).all()) rows.set(r.id, r);
  }
  for (const part of chunks([...new Set(vpsIds)])) {
    for (const r of db.select().from(agentSessions).where(and(
      inArray(agentSessions.vpsId, part), eq(agentSessions.archived, 0),
    )).all()) rows.set(r.id, r);
  }
  const built = buildFrom([...rows.values()]);
  const builtIds = new Set(built.map((s) => s.id));
  for (const s of built) publishIfChanged(s);
  for (const id of ids) if (!builtIds.has(id)) publishGone(id);
}

/**
 * Build EVERY summary, publish each changed key, publish `null` for every
 * session a summary was published for that is now gone or archived, and
 * return the complete list (the list GET, SSR and resync snapshots). Heals any
 * write that bypassed the bus (I9).
 */
export function reconcileAllSummaries(): SessionSummary[] {
  const all = buildSessionSummaries();
  const builtIds = new Set(all.map((s) => s.id));
  for (const s of all) publishIfChanged(s);
  for (const id of [...state().lastKey.keys()]) if (!builtIds.has(id)) publishGone(id);
  return all;
}

/** A FILTERED list (never complete): build the matching summaries and
 *  publish the changed ones — never a removal (an id it lacks may simply be
 *  filtered out). Every summary a client holds is then a known key. */
export function publishMatchingSummaries(rows: AgentSession[]): SessionSummary[] {
  const built = buildFrom(rows);
  for (const s of built) publishIfChanged(s);
  return built;
}

/** Publish these sessions' summaries NOW (or the whole dirty set for
 *  `'dirty'`), then read the bus revision: an action route's `sync` is then
 *  ≥ the summary frame carrying the action, so a client overlay never clears
 *  before its frame (§3.5). */
export function syncAfter(ids: string[] | 'dirty'): SyncRev {
  if (ids === 'dirty') flushSummaries();
  else for (const id of ids) flushSummaryNow(id);
  return currentRev();
}

/** Test hook: forget every published key and cached text. */
export function resetSessionSummariesForTests(): void {
  const S = state();
  S.lastKey.clear();
  S.firstUserMsg.clear();
  S.gateText.clear();
}

setSummaryProvider(publishSummaryDiffs);
{
  const S = state();
  if (!S.subscribed) {
    S.subscribed = true;
    // deleteSession publishes its own `summary: null` (sessionOps cannot
    // import this module): forget the key so the provider does not repeat it.
    subscribeFrames((f, ev) => {
      if (f.type === 'session_summary' && f.sessionId && (ev as { summary?: unknown }).summary === null) {
        state().lastKey.delete(f.sessionId);
        forgetSessionCaches(f.sessionId);
      }
    });
  }
}
