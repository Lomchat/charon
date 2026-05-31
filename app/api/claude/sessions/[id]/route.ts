import { NextResponse } from 'next/server';
import { and, asc, desc, eq, gt, gte, lt, lte, notInArray, sql } from 'drizzle-orm';
import {
  db, claudeSessions, claudeSessionMessages, claudeSessionLogs, vps as vpsTable,
  claudePendingPermissions, claudePendingQuestions,
  type ClaudeSessionMessage,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { deleteSession, peekStream } from '@/lib/server/agent/sessionOps';
import { focusCountFor } from '@/lib/server/agent/eventConnections';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { sshExec, shQuote } from '@/lib/server/claude/sshExec';

/**
 * The Claude SDK stores each session in
 *   ~/.claude/projects/<slug>/<uuid>.jsonl
 * where <slug> is derived from the cwd by replacing '/' with '-'. To resume
 * a session after a cwd change, we must move the .jsonl to the new slug.
 * Best-effort: if it fails, the SDK won't find the conversation and the
 * session will be "fresh" (loses Claude's memory but our DB history
 * remains displayable).
 */
async function relocateJsonl(
  vpsRow: typeof vpsTable.$inferSelect,
  claudeSessionId: string,
  oldCwd: string,
  newCwd: string,
): Promise<{ ok: boolean; detail: string }> {
  const slugify = (p: string) => p.replace(/\//g, '-');
  const oldSlug = slugify(oldCwd);
  const newSlug = slugify(newCwd);
  if (oldSlug === newSlug) return { ok: true, detail: 'same slug' };
  // oldCwd comes from the DB but the original value is user-controlled (the
  // user chooses their cwd at new-session). claudeSessionId comes from the
  // SDK (uuid) but we quote it for safety anyway. shQuote isolates all
  // shell-meta.
  const oldQ = shQuote(oldSlug);
  const newQ = shQuote(newSlug);
  const sidQ = shQuote(claudeSessionId);
  // We copy instead of mv so we don't break the original history.
  // If the new file already exists, skip (don't overwrite).
  const cmd =
    `OLD=~/.claude/projects/${oldQ}/${sidQ}.jsonl && ` +
    `NEW_DIR=~/.claude/projects/${newQ} && ` +
    `NEW=$NEW_DIR/${sidQ}.jsonl && ` +
    `if [ ! -f "$OLD" ]; then echo "JSONL_NOT_FOUND_AT_OLD"; exit 1; fi && ` +
    `mkdir -p "$NEW_DIR" && ` +
    `if [ ! -f "$NEW" ]; then cp "$OLD" "$NEW"; fi && ` +
    `echo OK`;
  const r = await sshExec(vpsRow, cmd, { timeoutMs: 10_000 });
  if (r.ok && r.stdout.includes('OK')) {
    return { ok: true, detail: `copied ${oldSlug} -> ${newSlug}` };
  }
  return { ok: false, detail: r.stderr.slice(-200) || r.stdout.slice(-200) || `exit ${r.code}` };
}

// Roles considered as "chat" for pagination. edit_snapshot and event do
// NOT count in the window — they are loaded as attachments by ID range
// (they are temporally close to their tool_use). Otherwise a session with
// many Edit/Write floods the 200 messages with snapshots
// (cf. gotcha §14 in CLAUDE.md).
//
// 'event' contains either `todo_update` (no chat display — only the last
// one counts), or `thinking` (displayable but sparse). Both cases are
// handled correctly with range loading.
const NON_PAGINATED_ROLES: string[] = ['edit_snapshot', 'event'];

/**
 * Loads a window of chat messages (role != edit_snapshot/event) with
 * cursor-based pagination, then adds the edit_snapshot/event that fall in
 * the same ID range (they are emitted temporally close to their parent
 * tool_use).
 *
 * @param before  If provided, window of the `limit` messages with id < before.
 *                Otherwise (initial load), window of the `limit` latest messages.
 * @returns       messages (asc by id, chat + snapshots/events merged),
 *                hasMore (true if there are even older chat messages),
 *                oldestChatId (id of the oldest CHAT message returned — used
 *                as cursor for the next loadMore).
 */
function loadMessageWindow(
  sessionId: string,
  limit: number,
  before: number | null,
): { messages: ClaudeSessionMessage[]; hasMore: boolean; oldestChatId: number | null } {
  // Fetch chat messages DESC, limit+1 to detect hasMore
  const chatRows = db.select().from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      notInArray(claudeSessionMessages.role, NON_PAGINATED_ROLES),
      before != null ? lt(claudeSessionMessages.id, before) : undefined,
    ))
    .orderBy(desc(claudeSessionMessages.id))
    .limit(limit + 1)
    .all();
  const hasMore = chatRows.length > limit;
  const window = chatRows.slice(0, limit).reverse(); // asc by id
  if (window.length === 0) {
    return { messages: [], hasMore: false, oldestChatId: null };
  }
  const minId = window[0].id;
  const maxId = window[window.length - 1].id;
  // Fetch edit_snapshot + event within the chat window range. They are
  // emitted temporally close to their tool_use (the agent sends tool_use ->
  // edit_snapshot before/after -> tool_result), so their ids fall BETWEEN
  // the chat messages of the same conversation.
  const attachments = db.select().from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      gte(claudeSessionMessages.id, minId),
      lte(claudeSessionMessages.id, maxId),
      // Filter in code (drizzle inArray on tuple -> ok but we already have the range)
    ))
    .all()
    .filter((m) => NON_PAGINATED_ROLES.includes(m.role));
  // Merge + sort by id asc
  const merged = [...window, ...attachments].sort((a, b) => a.id - b.id);
  return { messages: merged, hasMore, oldestChatId: minId };
}

// GET /api/claude/sessions/[id]
//
// Query params:
//   ?limit=N   (default 200, max 1000) — chat window size
//   ?before=K  — pagination cursor: only returns chat messages whose
//                id < K. Allows the "load older history" scroll-up.
//                When this param is passed, the response contains the
//                paginated window but the heavy fields (pendings, liveStatus,
//                streamingText) remain populated to stay compatible with
//                the type shape.
//   ?since=K   — DELTA mode: returns ONLY messages with id > K (chat AND
//                edit_snapshot/event in the range), sorted ASC.
//                `hasMore`/`oldestChatId` are not meaningful and set to
//                false/null. Used by the client's polling safety net
//                (cf. useClaudeSessionStream pollDelta) to catch any
//                messages missed because the SSE was down or its
//                listeners were torn down by a React error. Cheap: the
//                vast majority of calls return an empty messages array.
//                When provided, ?before and ?limit are ignored.
//
// Note: edit_snapshot and event DO NOT COUNT toward the limit (chat-window
// mode). They are loaded as attachments by ID range (cf. loadMessageWindow).
// In ?since mode they are returned unconditionally — the client needs them
// for ToolPanel diffs / todos.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;

  let messages: ClaudeSessionMessage[];
  let hasMore: boolean;
  let oldestChatId: number | null;
  if (since != null) {
    // Delta mode: every row with id > since. Cap at 1000 just in case
    // (a very long gap could otherwise return thousands of rows; in
    // practice we poll every 5s so the gap is small).
    messages = db.select().from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, id),
        gt(claudeSessionMessages.id, since),
      ))
      .orderBy(asc(claudeSessionMessages.id))
      .limit(1000)
      .all();
    hasMore = false;
    oldestChatId = null;
  } else {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 1000);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
    const win = loadMessageWindow(id, limit, before);
    messages = win.messages;
    hasMore = win.hasMore;
    oldestChatId = win.oldestChatId;
  }
  const stream = peekStream(id);

  // True max message id for this session (ALL roles, including
  // edit_snapshot/event that fall outside the chat window). The client
  // uses THIS as the polling cursor — NOT the max id of the returned
  // window, which can be lower when the newest rows are non-chat
  // attachments. Using the window max caused the delta poll to return the
  // same trailing rows forever (cursor never advanced). cf. CLAUDE.md §14
  // gotcha 24.
  const maxRow = db.select({ m: sql<number>`max(${claudeSessionMessages.id})` })
    .from(claudeSessionMessages)
    .where(eq(claudeSessionMessages.sessionId, id))
    .get();
  const maxMessageId = maxRow?.m ?? 0;

  // Pendings (permission/question/exit_plan) — returned so the client can
  // display them immediately on refetch without having to wait for the SSE
  // to replay them (which we will specifically skip to avoid the scroll).
  const pendingPerms = db.select().from(claudePendingPermissions).where(and(
    eq(claudePendingPermissions.sessionId, id),
    eq(claudePendingPermissions.status, 'pending'),
  )).all();
  const pendingQs = db.select().from(claudePendingQuestions).where(and(
    eq(claudePendingQuestions.sessionId, id),
    eq(claudePendingQuestions.status, 'pending'),
  )).all();

  return NextResponse.json({
    session: row,
    liveStatus: stream ? stream.status : row.status,
    subscribers: focusCountFor(id),
    messages,
    hasMore,
    oldestChatId,
    maxMessageId,
    // Assistant text currently being accumulated (not yet persisted). Empty
    // if no active streaming. The client injects it into its assistantBuf
    // to show "where we are" without replaying the deltas.
    streamingText: stream?.getStreamingText() ?? '',
    // Model Anthropic actually used on the last AssistantMessage (agent >= 0.6.0).
    // Null when (a) no turn has happened yet since last attach, or (b) the
    // agent on this VPS is < 0.6.0 (doesn't emit `effective_model`). The
    // session detail GET is what the UI calls on mount/reconnect — surfacing
    // this here means the ModelEffortBadges can show "effective: claude-opus-4-8"
    // even right after a tab reload (without waiting for the next turn).
    effectiveModel: stream?.effectiveModel ?? null,
    pendingPermissions: pendingPerms.map((p) => {
      let input: any = {};
      try { input = JSON.parse(p.toolInput); } catch {}
      return { id: p.id, tool: p.toolName, input, createdAt: p.createdAt };
    }),
    pendingQuestions: pendingQs.filter((q) => q.kind === 'question').map((q) => {
      let payload: any = [];
      try { payload = JSON.parse(q.payload); } catch {}
      return { id: q.id, questions: payload, createdAt: q.createdAt };
    }),
    pendingExitPlans: pendingQs.filter((q) => q.kind === 'exit_plan').map((q) => {
      let payload: any = {};
      try { payload = JSON.parse(q.payload); } catch {}
      return { id: q.id, plan: payload?.plan ?? '', createdAt: q.createdAt };
    }),
  });
  } catch (e: any) {
    // Same rationale as the list route: a transient failure must not
    // become an unhandled 500 (HTML error page → client JSON parse
    // failure → cascading "stuck" UI). Log + clean retryable 503; the
    // 5s poll retries on its own.
    // eslint-disable-next-line no-console
    console.error(`[api/claude/sessions/${id} GET] failed:`, e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 503 });
  }
}

// PATCH /api/claude/sessions/[id]
//
// Allowed fields: name, color, cwd.
//
// Special case cwd: the cwd is used at the moment of start_session on the
// agent side — updating the value in DB is not enough if the agent already
// has an in-memory instance (which keeps its old cwd). So:
//   - we update the DB
//   - we kill the agent instance (silent if it doesn't exist)
//   - we reset DB status to 'sleeping' so the UI offers a resume
//     (which will cleanly recreate the session with the new cwd)
const ALLOWED_PATCH = ['name', 'color', 'cwd'] as const;
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const update: Record<string, unknown> = {};
  for (const k of ALLOWED_PATCH) {
    if (!(k in body)) continue;
    const v = body[k];
    update[k] = v == null || v === '' ? null : String(v).trim();
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
    return NextResponse.json(row ?? null);
  }

  const [before] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!before) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const cwdChanged = 'cwd' in update && update.cwd !== before.cwd;

  let relocateNote: string | undefined;
  // If cwd changes: kill on the agent side + reset DB status to 'sleeping' +
  // relocate the JSONL on the VPS side so the SDK finds the conversation
  if (cwdChanged) {
    update.status = 'sleeping';
    try {
      const client = getAgentClientForVpsId(before.vpsId);
      await client.call('kill_session', { session_id: id }).catch(() => {});
    } catch {
      // No agent client — we continue, it will restart on resume
    }
    // Relocate JSONL (best-effort)
    if (before.claudeSessionId) {
      const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, before.vpsId)).all();
      if (v) {
        const r = await relocateJsonl(v, before.claudeSessionId, before.cwd, String(update.cwd));
        relocateNote = (r.ok ? '✓ ' : '⚠ ') + r.detail;
        db.insert(claudeSessionLogs).values({
          sessionId: id, level: r.ok ? 'info' : 'warn',
          event: 'cwd_change',
          detail: JSON.stringify({ from: before.cwd, to: update.cwd, relocate: r }),
        }).run();
      }
    }
  }

  db.update(claudeSessions).set(update).where(eq(claudeSessions.id, id)).run();
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  return NextResponse.json(relocateNote ? { ...row, _relocateNote: relocateNote } : row);
}

// DELETE /api/claude/sessions/[id]
//   permanent deletion: kill on the agent side + DB cascade (messages /
//   permissions / questions / logs / session row). No more soft-delete
//   `?hard=1`: the kill->delete merge eliminated the intermediate state
//   `'killed'` (cf. CLAUDE.md §10 and migration 0008). The only way to
//   "pause" a session is now `POST .../sleep`.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    await deleteSession(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
