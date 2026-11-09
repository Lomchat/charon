import { accountProfileId, accountProfileNumber } from '@/lib/accountProfiles';
import { publicConnection } from '@/lib/server/customEndpoints';
import { sessionTokenUsage } from '@/lib/server/agent/sessionTokenUsage';
import { NextResponse } from 'next/server';
import { and, asc, desc, eq, gt, gte, lt, lte, notInArray, sql } from 'drizzle-orm';
import {
  db, agentSessions, sessionMessages, sessionLogs, vps as vpsTable,
  sessionPendingPermissions, sessionPendingQuestions,
  type AgentSessionMessage,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import {
  deleteSession, peekStream, emitGlobalSessionListChanged, sweepExpiredInteractions,
  setSessionStatusLocal,
} from '@/lib/server/agent/sessionOps';
import { focusCountFor, setConnectionFocus } from '@/lib/server/agent/eventConnections';
import { markLeftRead } from '@/lib/server/agent/shellNotify';
import { currentRev } from '@/lib/server/sync/syncBus';
import { isAsyncQuestionDelivering } from '@/lib/server/agent/asyncQuestionDelivery';
import { buildSessionSummary, syncAfter } from '@/lib/server/sync/sessionSummaries';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { sshExec, shQuote } from '@/lib/server/hub/sshExec';
import { orderChronologically } from '@/lib/server/hub/messageOrder';
import { loadMessageWindow, publicMessageColumns } from '@/lib/server/hub/messageWindow';
import { countToolCalls, exitPlanFallback, withBgTaskLaunchers } from '@/lib/server/hub/conversationSources';
import type { TranscriptView } from '@/lib/transcriptRows';
import { normalizeSessionHandle } from '@/lib/server/agent/sessionHandles';
import { runningBgTaskDetailsIfWarm } from '@/lib/server/hub/bgTaskState';
import { attachPeerAssistantReplies } from '@/lib/server/hub/peerReplyContext';
import { attachAsyncQuestionState } from '@/lib/server/agent/asyncQuestions';
import { timeSection } from '@/lib/server/perf/loopLag';
import type { AgentSessionMessageWindow } from '@/lib/types/api';
import { HUB_TRANSCRIPT_FEATURES } from '@/lib/assistantBoundaries';
import { parseSuggestions, type PermissionSuggestion } from '@/lib/permissionSuggestions';

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
  nativeSessionId: string,
  oldCwd: string,
  newCwd: string,
): Promise<{ ok: boolean; detail: string }> {
  const slugify = (p: string) => p.replace(/\//g, '-');
  const oldSlug = slugify(oldCwd);
  const newSlug = slugify(newCwd);
  if (oldSlug === newSlug) return { ok: true, detail: 'same slug' };
  // oldCwd comes from the DB but the original value is user-controlled (the
  // user chooses their cwd at new-session). nativeSessionId comes from the
  // SDK (uuid) but we quote it for safety anyway. shQuote isolates all
  // shell-meta.
  const oldQ = shQuote(oldSlug);
  const newQ = shQuote(newSlug);
  const sidQ = shQuote(nativeSessionId);
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
// NOT count in the window — they ride as attachments of the page owning
// their CHRONOLOGICAL position (half-open partition, messageWindow.ts).
// Otherwise a session with many Edit/Write floods the 200 messages with
// snapshots (cf. gotcha §14 in CLAUDE.md).
//
// 'event' contains either `bg_task` (no chat display — folded into the
// BgTasks registry), or `thinking` (displayable but sparse). Both cases are
// handled correctly with range loading.
// NON_PAGINATED_ROLES + the chronological window live in messageWindow.ts
// (extracted for testability + the Codex-18 chronological pagination).

// Strips the heavy `content` (full file before/after, capped at 256KB EACH by
// the agent) out of edit_snapshot rows before they go over the wire.
//
// This endpoint is re-fetched in a LOOP — the 5s delta poll's clean reload,
// every SSE reconnect, every tab-foreground return, every notification focus
// (cf. CLAUDE.md §14 gotcha 24). A large session accumulates thousands of
// snapshots (one Edit = a before + an after row, ~hundreds of KB), so a single
// full GET could weigh tens of MB, and the loop multiplied that into ~16.5 GB
// of egress in a day — enough to get the VPS suspended for excessive outbound
// traffic. 99%+ of those bytes are redundant historical snapshots of the same
// handful of files.
//
// The chat NEVER renders edit_snapshot content (it's a side channel); only the
// ToolPanel diffs tab does, and that content is now served lazily by
// GET /api/sessions/[id]/edits (latest-per-file, once per session view).
// Here we keep the lightweight metadata (file_path, phase, tool_use_id, size,
// truncated) so the client can still rebuild the edits-Map skeleton and know
// which files changed; only `content` is nulled. cf. CLAUDE.md §14 gotcha 41.
function stripEditSnapshotContent(rows: AgentSessionMessage[]): AgentSessionMessage[] {
  return rows.map((m) => {
    if (m.role !== 'edit_snapshot') return m;
    let parsed: { content?: unknown; diff?: unknown } | null = null;
    try { parsed = JSON.parse(m.content); } catch { return m; }
    if (!parsed) return m;
    // Null BOTH the Claude `content` (before/after file bodies) AND the Codex
    // `diff` (unified diff) — both are heavy and re-fetched in the 5s poll
    // loop (§14.41 egress). Diff content comes lazily from GET .../edits.
    if (parsed.content == null && parsed.diff == null) return m;
    return { ...m, content: JSON.stringify({ ...parsed, content: null, diff: null, contentStripped: true }) };
  });
}

// loadMessageWindow moved to lib/server/hub/messageWindow.ts: pages are
// consecutive slices of ONE chronological order (seq-keyed), so crash-
// repaired rows land in the RIGHT page and client-side prepend stays exact.

/** The open reasoning block as the row an old bundle expects (see GET). */
function legacyOpenThinkingRow(sessionId: string, text: string, tsMs: number | null): AgentSessionMessage {
  const at = tsMs ?? Date.now();
  return {
    id: -1, sessionId, role: 'event', content: JSON.stringify({ type: 'thinking', text }),
    model: null, assistantFinal: null, seq: null, tsMs: at, cliUuid: null,
    createdAt: Math.floor(at / 1000),
  } as AgentSessionMessage;
}

// GET /api/sessions/[id]
//
// Query params:
//   ?limit=N   (default 200, max 1000) — chat window size
//   ?before=K  — pagination cursor for the "load older history" scroll-up.
//                K is the `oldestChatId` of the page the client already
//                holds; it is resolved POSITIONALLY in the session's global
//                CHRONOLOGICAL order (seq-keyed — NOT `id < K`: crash-
//                repaired rows have high ids but old seqs, see
//                messageWindow.ts) and the previous slice is returned.
//                Consecutive pages tile exactly — client prepend is safe.
//                LEAN: the response is only {messages, hasMore,
//                oldestChatId} (AgentSessionMessageWindow) — no token
//                fold, pendings, live state, max id or bg registry.
//   ?since=K   — DELTA mode: returns ONLY messages with id > K (chat AND
//                edit_snapshot/event in the range), in chronological order
//                (orderChronologically — id order except repaired rows).
//                `hasMore`/`oldestChatId` are not meaningful and set to
//                false/null. Kept for LEGACY bundles' polling safety net
//                (the current client uses the rev-gated probe + one window
//                GET instead, §14.24). Cheap: the vast majority of calls
//                return an empty messages array.
//                When provided, ?before and ?limit are ignored.
//   ?open=1    — this client reads the open reasoning block from
//                `streamingThinking`. Without it (an old bundle), the window
//                and delta modes append it as ONE synthetic row, id -1.
//   ?view=conversation — window and `before` modes (CLAUDE.md §14.25): only
//                conversation rows take slots and ride along (no tool,
//                thinking or plan rows; messageWindow.ts). The window then
//                omits `streamingThinking`, and what tool rows fed comes from
//                compact sources in BOTH views (conversationSources.ts):
//                `toolCallCount`, running tasks' launcher `command`/
//                `description`, an empty ExitPlan's plan file. Default `full`.
//   ?conn=<uuid>&focusSeq=N — window mode only (sync refonte C12): apply
//                this SSE connection's focus INSIDE the GET (routing only,
//                latest-wins by focusSeq) → `focus:{applied, focused,
//                focusSeq}`. Window and `before` answers carry `sync`
//                ({epoch, rev}: the bus revision they reflect, read last in
//                the same tick); the window adds `streamingToolOutput`.
//
// Note: edit_snapshot and event DO NOT COUNT toward the limit (chat-window
// mode). They ride as attachments of the page owning their chronological
// position — pages PARTITION the whole history with half-open bounds, so
// every attachment belongs to exactly one page (cf. messageWindow.ts).
// In ?since mode they are returned unconditionally so the poll detects new
// edits. In BOTH modes the edit_snapshot `content` is STRIPPED before
// sending (see stripEditSnapshotContent) — the poll only needs the row to
// exist (it triggers a clean reload), and diff content is fetched lazily via
// GET /api/sessions/[id]/edits. cf. CLAUDE.md §14 gotcha 41.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  // Past 250 ms: `[perf] session GET <id> <delta|window> <ms>ms` (journal greps rely on this text).
  return timeSection(`session GET ${id} ${/^\d+$/.test(new URL(req.url).searchParams.get('since') ?? '') ? 'delta' : 'window'}`, () => {
  const perfStarted = performance.now();
  try {
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
  // Atomic focus (window mode only, sync refonte G5): the SSE connection
  // `conn` routes this session's frames from NOW on, so a frame published
  // after this response reaches it and one published before is in the
  // snapshot below (stamped `sync`, same synchronous tick, I1/I2). Routing
  // only: a GET carries no presence report; what the move left is read now
  // if this conn is already proven attended, else by the focus POST (§14.47).
  const focusConn = url.searchParams.get('conn');
  const focusSeqRaw = Number(url.searchParams.get('focusSeq'));
  let focus: { applied: boolean; focused: boolean; focusSeq: number } | undefined;
  if (since == null && url.searchParams.get('before') == null && focusConn
    && focusConn.length >= 8 && focusConn.length <= 64 && Number.isSafeInteger(focusSeqRaw) && focusSeqRaw >= 0) {
    const f = setConnectionFocus(focusConn, id, focusSeqRaw, true, { routingOnly: true });
    markLeftRead(f.read);
    focus = { applied: f.applied, focused: f.ok && f.focus === id, focusSeq: focusSeqRaw };
  }
  // Text the lane coalescer still holds goes out as its frame BEFORE anything
  // is read: a snapshot holding text whose frame was still pending made the
  // browser show it twice (snapshot, then frame), and that frame's rev must
  // be ≤ this snapshot's `sync`. Delta mode too: it serves `streamingText`.
  peekStream(id)?.flushLiveBroadcasts();
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Delta mode is legacy-only and always full (§3.5 of the sync refonte).
  const view: TranscriptView = since == null && url.searchParams.get('view') === 'conversation'
    ? 'conversation' : 'full';

  let messages: AgentSessionMessage[];
  let hasMore: boolean;
  let oldestChatId: number | null;
  let includeBackgroundSnapshot = false;
  let lean = false;
  const windowStarted = performance.now();
  if (since != null) {
    // Delta mode: every row with id > since. Cap at 1000 just in case
    // (a very long gap could otherwise return thousands of rows; in
    // practice we poll every 5s so the gap is small).
    messages = orderChronologically(db.select(publicMessageColumns).from(sessionMessages)
      .where(and(
        eq(sessionMessages.sessionId, id),
        gt(sessionMessages.id, since),
      ))
      .orderBy(asc(sessionMessages.id))
      .limit(1000)
      .all());
    hasMore = false;
    oldestChatId = null;
    // `bg=1`: a view whose window answer said `backgroundTasksPending` asks
    // again on its delta poll — the `bg_tasks_snapshot` frame is one-shot
    // and lost when it outruns the view's SSE (§14.24 poll backstop).
    includeBackgroundSnapshot = url.searchParams.get('bg') === '1';
  } else {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 1000);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
    includeBackgroundSnapshot = before == null;
    lean = before != null;
    const win = loadMessageWindow(id, limit, before, view);
    messages = win.messages;
    hasMore = win.hasMore;
    oldestChatId = win.oldestChatId;
  }
  // Drop the heavy edit_snapshot file content from EVERY path (window, delta,
  // before-cursor) — this is the looping endpoint and the bandwidth fix. The
  // client refills diff content lazily via the dedicated /edits endpoint.
  // cf. CLAUDE.md §14 gotcha 41.
  messages = attachAsyncQuestionState(id, attachPeerAssistantReplies(id, stripEditSnapshotContent(messages)));
  const windowMs = performance.now() - windowStarted;
  if (lean) {
    // `?before=` (scroll-up history) is LEAN: the client reads only the page
    // (lib/api.ts § loadOlderMessages). The session-wide envelope —
    // token fold, expiry sweep, pendings, max(id), bg registry — belongs to
    // the window and the delta poll.
    const page: AgentSessionMessageWindow = { messages, hasMore, oldestChatId, sync: currentRev() };
    const response = NextResponse.json(page);
    response.headers.set('server-timing', `message-window;dur=${windowMs.toFixed(1)}, session-total;dur=${(performance.now() - perfStarted).toFixed(1)}`);
    return response;
  }
  const stream = peekStream(id);
  // The conversation view shows no reasoning: the open block is omitted.
  const streamingThinking = view === 'conversation' ? '' : stream?.getStreamingThinking() ?? '';
  // A replayed buffer extending a SIGTERM partial row (sessionOps § assistantReopen).
  const streamingExtends = stream?.getStreamingExtends() ?? null;
  const streamingThinkingTsMs = streamingThinking ? stream?.getStreamingThinkingTsMs() ?? null : null;
  // Legacy branch (G11): a tab still running a bundle from before the hub
  // coalesced delta reasoning (CLAUDE.md §14.17) ignores `streamingThinking`
  // and saw the open block as rows. It gets it as ONE synthetic row, last,
  // with an id no cursor ever takes (`m.id > maxId`, `oldestChatId` come from
  // real rows). Current clients ask `open=1` and read the field instead.
  if (streamingThinking && url.searchParams.get('open') !== '1') {
    messages = [...messages, legacyOpenThinkingRow(id, streamingThinking, streamingThinkingTsMs)];
  }

  // True max message id for this session (ALL roles, including
  // edit_snapshot/event that fall outside the chat window). The client
  // uses THIS as the polling cursor — NOT the max id of the returned
  // window, which can be lower when the newest rows are non-chat
  // attachments. Using the window max caused the delta poll to return the
  // same trailing rows forever (cursor never advanced). cf. CLAUDE.md §14
  // gotcha 24.
  const maxRow = db.select({ m: sql<number>`max(${sessionMessages.id})` })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, id))
    .get();
  const maxMessageId = maxRow?.m ?? 0;
  // The chat is paginated, task liveness is not. A compact full-history
  // projection prevents a task older than the latest 200 chat rows from
  // keeping the session violet while disappearing from the composer bar.
  // Delta and load-older calls omit it: live SSE patches task state, and any
  // missed delta triggers a clean root-window refetch — except a delta poll
  // with `bg=1`, the backstop of a pending answer. A cold registry warms
  // in background slices (bgTaskState.ts): the answer then says so
  // (`backgroundTasksPending`, the client keeps the running tasks it holds
  // that the window cannot see) and the warm set follows as a
  // `bg_tasks_snapshot` frame (sessionOps § bgRegistryWarmed).
  // Running tasks carry their launcher's command/description: the tool row the
  // browser used to read it from is not in a conversation window (§14.25).
  const runningTasks = includeBackgroundSnapshot ? runningBgTaskDetailsIfWarm(id) : null;
  const backgroundTasks = runningTasks ? withBgTaskLaunchers(id, runningTasks) : undefined;
  const backgroundTasksPending = includeBackgroundSnapshot && backgroundTasks === undefined;

  // Provider deadlines continue while the browser/hub is disconnected; the
  // sweep publishes each expiry (C07).
  sweepExpiredInteractions();
  // Pendings (permission/question/exit_plan) — returned so the client can
  // display them immediately on refetch without having to wait for the SSE
  // to replay them (which we will specifically skip to avoid the scroll).
  const pendingPerms = db.select().from(sessionPendingPermissions).where(and(
    eq(sessionPendingPermissions.sessionId, id),
    eq(sessionPendingPermissions.status, 'pending'),
  )).all();
  const pendingQs = db.select().from(sessionPendingQuestions).where(and(
    eq(sessionPendingQuestions.sessionId, id),
    eq(sessionPendingQuestions.status, 'pending'),
  )).all();

  // An ExitPlan without its plan text: the plan file's latest Write/Edit,
  // read server-side (the browser no longer holds the tool rows), once.
  let planFallback: string | null = null;
  const planOf = (plan: unknown): string => {
    if (typeof plan === 'string' && plan) return plan;
    planFallback ??= exitPlanFallback(id);
    return planFallback;
  };

  const response = NextResponse.json({
    // Window mode only: the legacy delta poll's envelope stays as it was.
    ...(since == null ? { view, toolCallCount: countToolCalls(id) } : {}),
    // The session's cross-session fact as the list/SSE carry it (§14.108);
    // null when archived. Window mode only.
    ...(since == null ? { summary: buildSessionSummary(id) } : {}),
    session: { ...row, providerConfig: undefined, accountProfile: accountProfileId(row.providerConfig), accountProfileNumber: accountProfileNumber(row.providerConfig), endpoint: publicConnection(row.providerConfig) },
    liveStatus: stream ? stream.status : row.status,
    liveCompacting: stream?.compacting === true,
    // Known "applies at next start" flags (window mode; unknown ones omitted).
    ...(since == null && stream ? pendingApplyOf(stream) : {}),
    subscribers: focusCountFor(id),
    messages,
    hasMore,
    oldestChatId,
    maxMessageId,
    backgroundTasks,
    ...(backgroundTasksPending ? { backgroundTasksPending: true } : {}),
    // Incremental fold; null while a cold one warms (its completion
    // broadcasts `session_token_usage`; clients keep their last value).
    tokenUsage: sessionTokenUsage(id),
    // Assistant text currently being accumulated (not yet persisted). Empty
    // if no active streaming. The client injects it into its assistantBuf
    // to show "where we are" without replaying the deltas. While a replay
    // EXTENDS a persisted partial row (`streamingExtends`), only the text past
    // that row's `length` chars: the row in `messages` holds the rest.
    streamingText: streamingExtends
      ? (stream?.getStreamingText() ?? '').slice(streamingExtends.length)
      : stream?.getStreamingText() ?? '',
    streamingExtends,
    // What this hub does for the transcript (lib/assistantBoundaries.ts): a
    // client keeps its legacy boundaries until it reads `assistant_flushed`.
    features: [...HUB_TRANSCRIPT_FEATURES],
    // A delta provider's reasoning block not yet in a row (CLAUDE.md §14.17):
    // without it, a refetch mid-block erased the reasoning on screen. Its
    // first delta's time dates the open bubble, like its row will. Omitted in
    // the conversation view.
    ...(view === 'conversation' ? {} : { streamingThinking, streamingThinkingTsMs }),
    // Output of the tools still running (I6 `covered`): a refetch mid-command
    // keeps what was printed so far; frames > `sync` extend it.
    ...(since == null ? { streamingToolOutput: stream?.getStreamingToolOutput() ?? [] } : {}),
    // Model Anthropic actually used on the last AssistantMessage (agent >= 0.6.0).
    // In-memory stream value first, then the DURABLE agent_sessions.effective_model
    // (stamped by the effective_model handler) — the GET must not lose the value
    // just because the stream isn't hydrated (peekStream is hydrate-free, §14.45).
    // Null when no turn ever happened or the agent never reported one.
    effectiveModel: stream?.effectiveModel ?? row.effectiveModel ?? null,
    pendingPermissions: pendingPerms.map((p) => {
      let input: any = {};
      try { input = JSON.parse(p.toolInput); } catch {}
      // Suggestions keep the agent's order: the answer picks one by index.
      const suggestions = parseSuggestions(p.suggestions);
      return {
        id: p.id, tool: p.toolName, input,
        createdAt: p.createdAt, expiresAt: p.expiresAt ?? undefined,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(suggestions.length ? { suggestions: suggestions as PermissionSuggestion[] } : {}),
      };
    }),
    pendingQuestions: pendingQs.filter((q) => q.kind === 'question' || q.kind === 'async_question').map((q) => {
      let payload: any = [];
      try { payload = JSON.parse(q.payload); } catch {}
      return {
        id: q.id, questions: payload,
        createdAt: q.createdAt, expiresAt: q.expiresAt ?? undefined,
        delivery: q.kind === 'async_question' ? 'async' : undefined,
        // A send in flight NOW (`_respondAsyncQuestion`): a reload shows
        // "sending…". Never the stored reservation, which outlives a failed
        // send and would lock the only form for good.
        delivering: q.kind === 'async_question' && isAsyncQuestionDelivering(q.id),
      };
    }),
    pendingExitPlans: pendingQs.filter((q) => q.kind === 'exit_plan').map((q) => {
      let payload: any = {};
      try { payload = JSON.parse(q.payload); } catch {}
      return {
        id: q.id, plan: planOf(payload?.plan),
        createdAt: q.createdAt, expiresAt: q.expiresAt ?? undefined,
      };
    }),
    // Window mode: the atomic focus outcome, then the bus revision this
    // snapshot reflects — read LAST, after every read above, same tick (I2).
    ...(since == null ? { ...(focus ? { focus } : {}), sync: currentRev() } : {}),
  });
  const totalMs = performance.now() - perfStarted;
  response.headers.set('server-timing', `message-window;dur=${windowMs.toFixed(1)}, session-total;dur=${totalMs.toFixed(1)}`);
  return response;
  } catch (e: any) {
    // Same rationale as the list route: a transient failure must not
    // become an unhandled 500 (HTML error page → client JSON parse
    // failure → cascading "stuck" UI). Log + clean retryable 503; the
    // 5s poll retries on its own.
    // eslint-disable-next-line no-console
    console.error(`[api/sessions/${id} GET] failed:`, e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 503 });
  }
  });
}

// PATCH /api/sessions/[id]
//
// Allowed fields: name, handle, color, cwd.
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
  if ('handle' in body) {
    const handle = normalizeSessionHandle(body.handle);
    if (!handle) {
      return NextResponse.json({ error: 'a valid session handle is required' }, { status: 400 });
    }
    update.handle = handle;
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, id)).all();
    return NextResponse.json(row ?? null);
  }

  const [before] = db.select().from(agentSessions).where(eq(agentSessions.id, id)).all();
  if (!before) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const cwdChanged = 'cwd' in update && update.cwd !== before.cwd;
  if (typeof update.handle === 'string' && update.handle !== before.handle) {
    const conflict = db.select({ id: agentSessions.id }).from(agentSessions).where(and(
      eq(agentSessions.vpsId, before.vpsId),
      eq(agentSessions.handle, update.handle),
    )).get();
    if (conflict && conflict.id !== id) {
      return NextResponse.json({ error: `@${update.handle} is already used on this VPS` }, { status: 409 });
    }
  }

  let relocateNote: string | undefined;
  // If cwd changes: kill on the agent side + reset DB status to 'sleeping' +
  // relocate the JSONL on the VPS side so the SDK finds the conversation
  if (cwdChanged) {
    update.status = 'sleeping';
    // The agent echoes our kill as `status:killed` — the transient DELETION
    // signal. The stream turns that ONE echo into `sleeping` (S7). The flag
    // outlives this call: a subscribe replay in progress HOLDS the echo while
    // the RPC answer overtakes it (the stream clears it, sessionOps §
    // armKilledEcho).
    const live = peekStream(id);
    if (live) live.armKilledEcho();
    try {
      const client = getAgentClientForVpsId(before.vpsId);
      await client.call('kill_session', { session_id: id }).catch(() => {});
    } catch {
      // No agent client — we continue, it will restart on resume
    }
    // Relocate JSONL (best-effort)
    if (before.nativeSessionId) {
      const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, before.vpsId)).all();
      if (v) {
        const r = await relocateJsonl(v, before.nativeSessionId, before.cwd, String(update.cwd));
        relocateNote = (r.ok ? '✓ ' : '⚠ ') + r.detail;
        db.insert(sessionLogs).values({
          sessionId: id, level: r.ok ? 'info' : 'warn',
          event: 'cwd_change',
          detail: JSON.stringify({ from: before.cwd, to: update.cwd, relocate: r }),
        }).run();
      }
    }
  }

  try {
    db.update(agentSessions).set(update).where(eq(agentSessions.id, id)).run();
  } catch (e) {
    if (typeof update.handle === 'string' && /unique/i.test(String(e))) {
      return NextResponse.json({ error: `@${update.handle} is already used on this VPS` }, { status: 409 });
    }
    throw e;
  }
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, id)).all();
  // A hydrated stream labels pushes/Telegram with its own copies (A3).
  const stream = peekStream(id);
  if (stream) {
    if ('name' in update) stream.name = (update.name as string | null) ?? null;
    if ('cwd' in update && typeof update.cwd === 'string') stream.cwd = update.cwd;
  }
  // The DB says `sleeping` for a cwd change: memory and every tab too (the
  // DB was written above, with the cwd).
  if (cwdChanged) setSessionStatusLocal(id, 'sleeping', { persist: false });

  // Mirror the name into the CLI's own transcript (agent >= 0.38.0). Until
  // now Charon's name lived only in the dashboard: a session called
  // "frontend" here was an unnamed uuid to the provider's resume picker.
  // The peer address is intentionally independent (`handle`).
  // Fire-and-forget on purpose — a rename must not fail because a VPS is
  // unreachable, and the agent retries the write at the next turn end.
  if ('name' in update && typeof update.name === 'string' && update.name) {
    const name = update.name;
    void (async () => {
      try {
        const client = getAgentClientForVpsId(before.vpsId);
        await client.call('set_session_name', { session_id: id, name });
      } catch {}
    })();
  }

  if ('handle' in update && typeof update.handle === 'string') {
    const handle = update.handle;
    void (async () => {
      try {
        const client = getAgentClientForVpsId(before.vpsId);
        await client.call('set_session_handle', { session_id: id, handle });
      } catch {
        // The DB is authoritative; every start/resume reasserts it after a
        // reconnect or automatic daemon update.
      }
    })();
  }

  // Every field is a list fact (color and cwd included, A3): the frame marks
  // the summary dirty and makes legacy tabs refetch the list.
  emitGlobalSessionListChanged(id);

  const publicRow = { ...row, providerConfig: undefined, accountProfile: accountProfileId(row.providerConfig), accountProfileNumber: accountProfileNumber(row.providerConfig), endpoint: publicConnection(row.providerConfig) };
  const sync = syncAfter([id]);
  return NextResponse.json(relocateNote ? { ...publicRow, _relocateNote: relocateNote, sync } : { ...publicRow, sync });
}

// DELETE /api/sessions/[id]
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
    // deleteSession published `session_summary{null}` synchronously.
    return NextResponse.json({ ok: true, sync: syncAfter([id]) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

/** The stream's known pending-apply flags (null = unknown: omitted). */
function pendingApplyOf(stream: { pendingApply?: { model: boolean | null; effort: boolean | null } }):
  { pendingApply?: { model?: boolean; effort?: boolean } } {
  const p = stream.pendingApply;
  if (!p) return {};
  const out: { model?: boolean; effort?: boolean } = {};
  if (p.model != null) out.model = p.model;
  if (p.effort != null) out.effort = p.effort;
  return Object.keys(out).length ? { pendingApply: out } : {};
}
