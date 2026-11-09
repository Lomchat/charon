// The session transcript's pure reducer (sync refonte C09 + C16, CLAUDE.md
// §14.107).
//
// Browser-safe, no React, no DOM: every client transcript guarantee is proven
// against this module (tests/transcriptReducer.test.ts, transcriptSync.test.ts)
// — there is no DOM test environment (SPEC §11). `useSessionStream` is a
// thin adapter: a state ref + `applyFrame`/`applySnapshot` + an effect runner.
//
// Transcript = snapshot@R + frames>R (I6). Every frame type has a snapshot
// class (`FRAME_SNAPSHOT_CLASS`, lib/transcriptRows.ts): once a window answer
// stamped R is applied, `durable`/`covered` frames with rev ≤ R are already in
// it and are dropped; `live` frames apply whatever their rev; `summary` frames
// belong to the cross-session store.
//
// Hub-owned boundaries (CLAUDE.md §7, sync refonte I7): when the session GET
// advertises `features: ['assistant_flushed', …]` the HUB cuts assistant
// bubbles (`assistant_flushed`), extends a persisted SIGTERM partial
// (`assistant_reopened`) and names every persisted row (`rowId` ⇒ the live
// row is `m<rowId>`, the id the rebuild gives it). The client then never
// invents a boundary; the legacy flush on boundary frames runs only against a
// hub without the feature.

import type {
  Msg, ToolCallEntry, EditSnapshot, PermissionRequest, PendingQuestion, PendingExitPlan,
} from '../sessionTypes';
import type { WorkerEvent, WorkerStatus } from '@/lib/server/hub/types';
import {
  asSessionProvider, defaultSessionMode, isSessionMode, PROVIDERS,
  type SessionMode, type SessionProvider,
} from '@/lib/sessionCapabilities';
import { FRAME_SNAPSHOT_CLASS, isTechnicalFrame, type SnapshotClass, type TranscriptView } from '@/lib/transcriptRows';
import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import type { SessionWindowResponse } from '@/lib/types/api';
import { mergeSessionTokenUsage, type SessionTokenUsage } from '@/lib/sessionTokenUsage';
import { resolveAsyncQuestionMessages } from '@/lib/asyncQuestions';
import { scheduledFireContent } from '@/lib/scheduledTasks';
import {
  appendThinkingMessage, applyThinkingFlushed, applyThinkingReopened, closeThinkingMessage,
  openThinkingCreatedAt, prependMessagePage, thinkingLaneSnapshot, thinkingRowIds, createThinkingLane,
} from '../thinkingMessages';
import { rebuildStateFromMessages } from '../sessionRebuild';
import {
  applyBgTaskEvent, applyBgTaskProgress, bgTasksAfterWindowAnswer, bgTasksToArray, isBgLaunchToolUse,
  markRunningBgTasksStale, reconcileAuthoritativeBgTasks, type BgLaunchCandidate, type BgTask,
} from '../bgTasks';
import type { WindowReason } from './windowSync';
import { reconcileOptimisticBubbles } from './optimistic';
import { reconcileStreamingPreview } from '../streamingPreview';

type Frame<T extends WorkerEvent['type']> = Extract<WorkerEvent, { type: T }>;
export type AssistantFlushed = Frame<'assistant_flushed'>;
export type AssistantReopened = Frame<'assistant_reopened'>;
export type ThinkingFlushed = Frame<'thinking_flushed'>;
export type UserEcho = Frame<'user_echo'>;
export type ToolUseFrame = Frame<'tool_use'>;
export type ToolResultFrame = Frame<'tool_result'>;
export type StopFrame = Frame<'stop'>;

/** Live text not yet a row: `assistant` = the assistant buffer (the hub's open
 *  accumulation as received; with `streamingInto` set, only what follows row
 *  `streamingInto`'s rendered prefix); `thinkingOpen` = a delta provider's
 *  open reasoning block since its last cut. */
export type LiveBuffers = { assistant: string; streamingInto: number | null; thinkingOpen: string };

/** The composer's optimistic sends, by the browser's `clientMessageId`, in send
 *  order (the content FIFO for echoes lacking an id walks it). */
export type OptimisticSends = Map<string /*clientMessageId*/, { content: string; createdAt: number; rowId?: number;
  /** The POST failed without naming a row: the next snapshot lacking it drops
   *  the bubble (optimistic.ts) — never re-appended below later turns. */
  failed?: boolean }>;

export type TranscriptCtx = {
  fromJournal: boolean;
  view: TranscriptView;
  provider: SessionProvider;
  hubBoundaries: boolean;
  nowMs: number;
};

/** `refetch.rowId`: the row the mismatch left wrong. Mid-turn a reload is
 *  dropped by the live-revision guard, so the hook patches THAT row from the
 *  answer anyway (`patchAssistantRows`). */
export type Effect = { kind: 'refetch'; reason: string; rowId?: number } | { kind: 'markFinal'; rowId: number }
  | { kind: 'fsChanged'; paths: string[] } | { kind: 'banner'; msg: string } | { kind: 'killed' } | { kind: 'ackFocus' }
  // C16: a frame asks for a clean window (`transcript_reset`, `session_resync`);
  // the agent's composer prefill; a live frame retiring the error banner.
  | { kind: 'window'; reason: WindowReason } | { kind: 'prefill'; content: string } | { kind: 'clearBanner' }
  // A provider retry's banner ("Reconnecting... n/5"), retired by the next
  // sign of a live stream — never another banner.
  | { kind: 'banner'; msg: string; retrying: true } | { kind: 'clearRetryBanner' };

/** The id of a live row the hub persisted (`rowId`), the rebuild's own id. */
export const rowKey = (rowId: number): string => `m${rowId}`;

/** The optimistic user bubble of a composer send. */
export const optimisticUserId = (clientMessageId: string): string => `u-${clientMessageId}`;

/** A `clientMessageId` the input route accepts (≤64 chars of `[A-Za-z0-9-]`).
 *  `crypto.randomUUID` exists only in secure contexts: a hub served over plain
 *  HTTP on a LAN address falls back to `getRandomValues`, then Math.random. */
export function newClientMessageId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* insecure context */ }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function upsertById(messages: Msg[], row: Msg): Msg[] {
  const idx = messages.findIndex((m) => m.id === row.id);
  if (idx < 0) return [...messages, row];
  const next = messages.slice();
  next[idx] = row;
  return next;
}

// ─── Hub boundaries: assistant_flushed / assistant_reopened / thinking_flushed ─

type FlushEvent = AssistantFlushed | AssistantReopened | ThinkingFlushed;

/** The buffer half of `reduceFlushFrame`: depends only on the buffer and the
 *  frame, so the hook applies it synchronously to its refs while the messages
 *  half runs in its state updater (`applyFlushFrame`). */
export function flushFrameBuffer(buf: LiveBuffers, ev: FlushEvent): { buf: LiveBuffers; effects: Effect[] } {
  switch (ev.type) {
    case 'assistant_flushed': {
      const effects: Effect[] = [];
      // The hub's buffer is `length` chars. Ours is the same text unless a
      // frame was lost; `content` (a replay extend) or `duplicate` make ours
      // irrelevant. Reopened into a row, ours is only the part past its prefix
      // and the hub always sends `content` for THAT row: a content-less cut of
      // ANOTHER row means the reopened row's own flush was lost (or a stale
      // snapshot reopened ours), so our buffer is not this row's text.
      if (!ev.duplicate && typeof ev.content !== 'string') {
        const reason = buf.streamingInto == null
          ? (buf.assistant.length !== ev.length ? `assistant_flushed length ${buf.assistant.length} != ${ev.length}` : null)
          : (ev.rowId !== buf.streamingInto ? `assistant_flushed row ${ev.rowId} over a buffer reopened into ${buf.streamingInto}` : null);
        if (reason) effects.push({ kind: 'refetch', reason, ...(ev.rowId != null ? { rowId: ev.rowId } : {}) });
      }
      return { buf: { ...buf, assistant: '', streamingInto: null }, effects };
    }
    case 'assistant_reopened': {
      // The deltas that follow extend row `rowId`. A buffer reopened into
      // another row is committed into it by the messages half; a plain one
      // cannot exist (every earlier buffer was cut) unless a frame was lost.
      const effects: Effect[] = buf.assistant && buf.streamingInto == null
        ? [{ kind: 'refetch', reason: 'assistant_reopened over an uncut buffer' }] : [];
      return { buf: { ...buf, assistant: '', streamingInto: ev.rowId }, effects };
    }
    case 'thinking_flushed':
      return { buf: { ...buf, thinkingOpen: '' }, effects: [] };
  }
}

/** Replace the content of the live rows `rowIds` with their persisted text
 *  from a session GET's `rows` (rows absent on either side are left alone).
 *  Used when the GET as a whole is too old to apply (live frames moved on)
 *  but a cut it covers was received truncated. */
export function patchAssistantRows(messages: Msg[], rows: ReadonlyArray<{ id: number; role: string; content: string }>,
  rowIds: Iterable<number>): Msg[] {
  let next = messages;
  for (const rowId of rowIds) {
    const fresh = rows.find((r) => r.id === rowId && r.role === 'assistant');
    if (!fresh) continue;
    const idx = next.findIndex((m) => m.id === rowKey(rowId));
    if (idx < 0 || next[idx].content === fresh.content) continue;
    if (next === messages) next = messages.slice();
    next[idx] = { ...next[idx], content: fresh.content };
  }
  return next;
}

/** The messages half of `reduceFlushFrame`, given the buffer BEFORE the frame. */
export function applyFlushFrame(messages: Msg[], before: LiveBuffers, ev: FlushEvent, ctx: Pick<TranscriptCtx, 'nowMs'>): Msg[] {
  switch (ev.type) {
    case 'assistant_flushed': {
      // Replayed text already persisted: the row (when on screen) is it.
      if (ev.duplicate || ev.rowId == null) return messages;
      const id = rowKey(ev.rowId);
      const existing = messages.find((m) => m.id === id);
      const content = typeof ev.content === 'string' ? ev.content
        : before.streamingInto === ev.rowId && existing ? existing.content + before.assistant
        : before.assistant;
      if (!content && !existing) return messages;
      const createdAt = typeof ev.tsMs === 'number' && Number.isFinite(ev.tsMs)
        ? Math.floor(ev.tsMs / 1000)
        : existing?.createdAt ?? Math.floor(ctx.nowMs / 1000);
      return upsertById(messages, {
        ...(existing ?? {}),
        id, role: 'assistant', content, createdAt,
        model: ev.model ?? existing?.model ?? null,
        // A cut is never final by itself: `stop` names the turn's final row.
        assistantFinal: existing?.assistantFinal === 1 ? 1 : 0,
      });
    }
    case 'assistant_reopened': {
      // A buffer still open on another row is committed as that row's text
      // first (no boundary lost); a plain buffer cannot exist here (the hub
      // sends `assistant_reopened` before the remainder of a new buffer).
      if (before.assistant && before.streamingInto != null && before.streamingInto !== ev.rowId) {
        const prev = messages.find((m) => m.id === rowKey(before.streamingInto!));
        if (prev) return upsertById(messages, { ...prev, content: prev.content + before.assistant });
      }
      return messages;
    }
    case 'thinking_flushed':
      return applyThinkingFlushed(messages, ev, before.thinkingOpen);
  }
}

export function reduceFlushFrame(messages: Msg[], buf: LiveBuffers,
  ev: AssistantFlushed | AssistantReopened | ThinkingFlushed, ctx: TranscriptCtx):
  { messages: Msg[]; buf: LiveBuffers; effects: Effect[] } {
  const out = flushFrameBuffer(buf, ev);
  return { messages: applyFlushFrame(messages, buf, ev, ctx), buf: out.buf, effects: out.effects };
}

/** The live assistant bubble: `__streaming` after the history, or — after an
 *  `assistant_reopened` — row `m<streamingInto>` itself, its content followed
 *  by the buffer (no second bubble). Null when there is nothing to show (an
 *  empty buffer reopened into a row renders that row as it is). */
export function liveStreamingMessage(messages: Msg[], buf: LiveBuffers): Msg | null {
  if (!buf.assistant) return null;
  if (buf.streamingInto != null) {
    const row = messages.find((m) => m.id === rowKey(buf.streamingInto!));
    if (row) return { ...row, content: row.content + buf.assistant, assistantFinal: 0 };
  }
  return { id: '__streaming', role: 'assistant', content: buf.assistant, createdAt: 0, assistantFinal: 0 };
}

// ─── user_echo ↔ optimistic sends ───────────────────────────────────────────

/** What an echo means for the transcript (`matchUserEcho`). */
export type EchoMatch =
  | { kind: 'own'; clientMessageId: string; rowId: number | null }   // our bubble: rename it to m<rowId>
  | { kind: 'suppress' }                                              // legacy content match: keep our bubble
  | { kind: 'foreign' };                                              // another tab/device/server send

/** The sends half of `reduceUserEcho` (synchronous, ref-side). An echo with a
 *  `clientMessageId` is matched by IDENTITY only — an unknown id is a foreign
 *  echo, never a content match; only echoes lacking an id (an older hub) walk
 *  the content FIFO. */
export function matchUserEcho(sends: OptimisticSends, ev: UserEcho): { sends: OptimisticSends; match: EchoMatch } {
  const cmid = ev.clientMessageId;
  if (cmid) {
    if (!sends.has(cmid)) return { sends, match: { kind: 'foreign' } };
    const next = new Map(sends);
    next.delete(cmid);
    return { sends: next, match: { kind: 'own', clientMessageId: cmid, rowId: ev.rowId ?? null } };
  }
  for (const [id, s] of sends) {
    if (s.content !== ev.content) continue;
    const next = new Map(sends);
    next.delete(id);
    return { sends: next, match: { kind: 'suppress' } };
  }
  return { sends, match: { kind: 'foreign' } };
}

/** Our optimistic bubble becomes row `rowId` in place (or goes, when the row is
 *  already on screen — a refetch or the other arrival order put it there). */
function renameOwnBubble(messages: Msg[], clientMessageId: string, rowId: number | null): Msg[] {
  if (rowId == null) return messages;
  const from = optimisticUserId(clientMessageId);
  const to = rowKey(rowId);
  const idx = messages.findIndex((m) => m.id === from);
  if (idx < 0) return messages;
  if (messages.some((m) => m.id === to)) return messages.filter((_, i) => i !== idx);
  const next = messages.slice();
  next[idx] = { ...next[idx], id: to };
  return next;
}

export function applyUserEchoMatch(messages: Msg[], match: EchoMatch, ev: UserEcho): Msg[] {
  switch (match.kind) {
    case 'suppress': return messages;
    case 'own': {
      const renamed = renameOwnBubble(messages, match.clientMessageId, match.rowId);
      if (renamed !== messages) return renamed;
      // Neither our bubble nor its row on screen (a refetch replaced the
      // bubble before the row existed): show the row.
      if (match.rowId != null && !messages.some((m) => m.id === rowKey(match.rowId!))
          && !messages.some((m) => m.id === optimisticUserId(match.clientMessageId))) {
        return [...messages, { id: rowKey(match.rowId), role: 'user', content: ev.content, createdAt: ev.createdAt }];
      }
      return messages;
    }
    case 'foreign': {
      if (ev.rowId != null) {
        const id = rowKey(ev.rowId);
        if (messages.some((m) => m.id === id)) return messages;   // a replayed echo
        return [...messages, { id, role: 'user', content: ev.content, createdAt: ev.createdAt }];
      }
      return [...messages, { id: 'u' + ev.createdAt + Math.random(), role: 'user', content: ev.content, createdAt: ev.createdAt }];
    }
  }
}

export function reduceUserEcho(messages: Msg[], sends: OptimisticSends, ev: UserEcho):
  { messages: Msg[]; sends: OptimisticSends } {
  const m = matchUserEcho(sends, ev);
  return { messages: applyUserEchoMatch(messages, m.match, ev), sends: m.sends };
}

/** Bound on remembered sends: an echo that never comes (SSE down) must not
 *  grow the map forever; the oldest go first. */
export const OPTIMISTIC_SENDS_MAX = 64;

/** A composer send: the optimistic bubble `u-<clientMessageId>` and its entry. */
export function addOptimisticSend(messages: Msg[], sends: OptimisticSends,
  clientMessageId: string, content: string, createdAt: number):
  { messages: Msg[]; sends: OptimisticSends } {
  const next = new Map(sends);
  next.set(clientMessageId, { content, createdAt });
  while (next.size > OPTIMISTIC_SENDS_MAX) next.delete(next.keys().next().value!);
  return {
    messages: [...messages, { id: optimisticUserId(clientMessageId), role: 'user', content, createdAt }],
    sends: next,
  };
}

/** The POST answered `{rowId}`: recorded on the entry (the echo may still come,
 *  or never), and the bubble takes the row's id at once — whichever of echo
 *  and response arrives first, the transcript ends with ONE `m<rowId>`. */
export function reduceSendAck(messages: Msg[], sends: OptimisticSends,
  clientMessageId: string, rowId: number | null | undefined):
  { messages: Msg[]; sends: OptimisticSends } {
  if (rowId == null) return { messages, sends };
  const entry = sends.get(clientMessageId);
  let nextSends = sends;
  if (entry) {
    nextSends = new Map(sends);
    nextSends.set(clientMessageId, { ...entry, rowId });
  }
  return { messages: renameOwnBubble(messages, clientMessageId, rowId), sends: nextSends };
}

// ─── Rows the hub named: tool_use / tool_result ─────────────────────────────

/** A live tool frame. With `rowId` the row is `m<rowId>` (inserted once — a
 *  replayed frame replaces it in place); a `tool_result` renames the
 *  `tr-live-<sdkId>` row its `tool_progress` frames built. Without `rowId`
 *  (an older hub) the historical ids are kept. */
export function reduceRowIdRename(messages: Msg[], ev: ToolUseFrame | ToolResultFrame, nowMs = Date.now()): Msg[] {
  const createdAt = Math.floor(nowMs / 1000);
  if (ev.type === 'tool_use') {
    const content = JSON.stringify({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
    if (ev.rowId == null) {
      return [...messages, { id: 'tu' + ev.id + Math.random(), role: 'tool_use', content, createdAt }];
    }
    const id = rowKey(ev.rowId);
    const existing = messages.find((m) => m.id === id);
    return upsertById(messages, { id, role: 'tool_use', content, createdAt: existing?.createdAt ?? createdAt });
  }
  const content = JSON.stringify({ type: 'tool_result', tool_use_id: ev.tool_use_id,
    content: ev.content, is_error: !!ev.is_error });
  const liveId = 'tr-live-' + ev.tool_use_id;
  if (ev.rowId == null) {
    return upsertById(messages, {
      id: liveId, role: 'tool_result', content,
      createdAt: messages.find((m) => m.id === liveId)?.createdAt ?? createdAt,
    });
  }
  const id = rowKey(ev.rowId);
  const liveIdx = messages.findIndex((m) => m.id === liveId);
  const rowIdx = messages.findIndex((m) => m.id === id);
  if (rowIdx >= 0) {
    const next = messages.map((m, i) => i === rowIdx ? { ...m, content } : m);
    return liveIdx >= 0 ? next.filter((_, i) => i !== liveIdx) : next;
  }
  if (liveIdx >= 0) {
    const next = messages.slice();
    next[liveIdx] = { ...next[liveIdx], id, content };
    return next;
  }
  return [...messages, { id, role: 'tool_result', content, createdAt }];
}

// ─── stop ───────────────────────────────────────────────────────────────────

/** `stop` closes an open reasoning bubble and marks the turn's final assistant
 *  row (`finalAssistantId`). The "last optimistic `a…` bubble" fallback is
 *  for a hub without boundaries only: there, the row may still carry the
 *  client's own id; with hub boundaries it is always `m<rowId>`. */
export function reduceStop(messages: Msg[], ev: StopFrame, ctx: Pick<TranscriptCtx, 'hubBoundaries'>): Msg[] {
  let next = closeThinkingMessage(messages);
  if (ev.finalAssistantId == null) return next;
  let index = next.findIndex((m) => m.id === rowKey(ev.finalAssistantId!));
  if (index < 0 && !ctx.hubBoundaries) {
    index = next.findLastIndex((m) => m.role === 'assistant' && m.id.startsWith('a'));
  }
  if (index < 0) return next;
  // The turn's ledger rides on the same frame (lib/promptCache.ts).
  if (next[index].assistantFinal === 1 && !ev.turnUsage) return next;
  next = next.slice();
  next[index] = { ...next[index], assistantFinal: 1, ...(ev.turnUsage ? { turnUsage: ev.turnUsage } : {}) };
  return next;
}

// ═══ C16: the complete transcript state ═════════════════════════════════════

/** A row of the session GET (window or older page). */
export type ApiMessage = SessionWindowResponse['messages'][number];
/** A bus frame delivered to this transcript (`subscribeSession`). */
export type SessionFrame = WorkerEvent & { sessionId?: string };
export type PermissionQ = PermissionRequest;
export type QuestionQ = PendingQuestion;
export type ExitPlanQ = PendingExitPlan;

/** Per-session configuration the header shows (overlays sit on top, hook). */
export type TranscriptMeta = {
  permissionMode: SessionMode;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  /** A config change queued behind a live SDK client (`appliedAtNextStart`):
   *  carried across snapshots (no row holds it), cleared by the next start. */
  modelPendingApply: boolean;
  effortPendingApply: boolean;
  effectiveModel: string | null;
};

export type LiveUsage = {
  output: number; input?: number; final?: boolean; durationMs?: number; costUsd?: number | null;
  /** Tool calls of the current turn so far (hub-counted). */
  tools?: number;
};

export type TranscriptState = {
  sessionId: string;
  /** Raw rows the view was rebuilt from, chronological, older pages included. */
  rows: ApiMessage[];
  messages: Msg[];
  toolCalls: ToolCallEntry[];
  files: Set<string>;
  edits: Map<string, EditSnapshot>;
  bgTasks: Map<string, BgTask>;
  /** Bash `run_in_background` launches waiting for their `bg_task started`. */
  bgLaunches: Map<string, BgLaunchCandidate>;
  queues: { permissions: PermissionQ[]; questions: QuestionQ[]; exitPlans: ExitPlanQ[] };
  status: WorkerStatus | null;
  /** The provider is summarising the conversation (`compacting` frame /
   *  `liveCompacting`): the composer waits. Only meaningful while thinking. */
  compacting: boolean;
  /** Still on the agent code of before an update (`runtime_outdated` frame /
   *  `liveRuntimeOutdated`, §14.117): the header says so. */
  runtimeOutdated: boolean;
  buf: LiveBuffers;
  /** The highest reasoning row id this view knows as persisted
   *  (thinkingMessages.ts § ThinkingLane.known). */
  thinkingKnown: number;
  sends: OptimisticSends;
  /** Row ids this view holds: the snapshot's rows ∪ every `rowId` a frame or
   *  a POST answer carried since (the probe's `newRows` check). */
  knownRowIds: Set<number>;
  /** 'live'-class partial plans (`plan_progress`) carried across snapshots. */
  livePlans: Map<string, Msg>;
  /** Plan ids with a durable `plan_update` row in the last snapshot. */
  durablePlans: Set<string>;
  /** Gates answered here, by id → the answer's `sync` (null: an older hub). A
   *  snapshot older than the answer must not bring them back. */
  localResolved: Map<string, SyncRev | null>;
  snapshotRev: SyncRev | null;
  /** The session's tool_use row count: the last snapshot's `toolCallCount`
   *  (null: none carried one) + the distinct tool_use ids of the frames
   *  applied after it (journal replay included) — `toolCallTotal`. */
  toolCallBase: number | null;
  toolCallIdsSince: Set<string>;
  /** The probe cursor (`maxMessageId` of the last snapshot / clean probe). */
  afterId: number;
  /** The hub cuts bubbles (`features: ['assistant_flushed']`, I7). */
  hubBoundaries: boolean;
  hasMore: boolean;
  oldestChatId: number | null;
  provider: SessionProvider;
  session: SessionWindowResponse['session'] | null;
  meta: TranscriptMeta;
  tokenUsage: SessionTokenUsage | null;
  liveUsage: LiveUsage | null;
  /** A snapshot (cache or network) has been applied. */
  loaded: boolean;
  /** Local id counter (rows the hub did not name). */
  seq: number;
  /** A provider retry's banner is up: the next stream frame retires it. */
  retryBanner: boolean;
};

/** Frames proving a retrying provider got its stream back. */
const STREAM_RESUMED = new Set<string>([
  'assistant_text', 'assistant_flushed', 'thinking', 'thinking_flushed',
  'tool_use', 'tool_result', 'tool_progress', 'stop',
]);

export function createTranscriptState(sessionId: string, provider?: SessionProvider): TranscriptState {
  const p = asSessionProvider(provider);
  return {
    sessionId, rows: [], messages: [], toolCalls: [], files: new Set(), edits: new Map(),
    bgTasks: new Map(), bgLaunches: new Map(),
    queues: { permissions: [], questions: [], exitPlans: [] },
    status: null, compacting: false, runtimeOutdated: false, buf: { assistant: '', streamingInto: null, thinkingOpen: '' }, thinkingKnown: 0,
    sends: new Map(), knownRowIds: new Set(), livePlans: new Map(), durablePlans: new Set(), localResolved: new Map(),
    snapshotRev: null, toolCallBase: null, toolCallIdsSince: new Set(), afterId: 0, hubBoundaries: false, hasMore: false, oldestChatId: null,
    provider: p, session: null,
    meta: {
      permissionMode: defaultSessionMode(p), model: null, fallbackModel: null, effort: null,
      modelPendingApply: false, effortPendingApply: false, effectiveModel: null,
    },
    tokenUsage: null, liveUsage: null, loaded: false, seq: 0, retryBanner: false,
  };
}

/** Conversation view: the cap on live tool calls kept without their rows (the
 *  calls tab pages the rest from `GET …/tool-calls`). */
export const CONVERSATION_TOOL_CALLS_MAX = 200;

export function frameClassOf(type: string): SnapshotClass {
  return (FRAME_SNAPSHOT_CLASS as Record<string, SnapshotClass>)[type] ?? 'live';
}

/** Is this frame's effect already in the applied snapshot? (`durable` /
 *  `covered` with rev ≤ snapshotRev, I6.) A rev-less frame (older hub,
 *  degraded mode) or no stamped snapshot ⇒ never. */
export function isCoveredBySnapshot(s: Pick<TranscriptState, 'snapshotRev'>, type: string, rev: SyncRev | null): boolean {
  if (!rev || !s.snapshotRev) return false;
  const cls = frameClassOf(type);
  if (cls !== 'durable' && cls !== 'covered') return false;
  return cmpRev(rev, s.snapshotRev) <= 0;
}

function nextId(s: TranscriptState, prefix: string, nowMs: number): [string, TranscriptState] {
  const seq = s.seq + 1;
  return [`${prefix}${nowMs}.${seq}`, { ...s, seq }];
}

function withRowIds(s: TranscriptState, ...ids: Array<number | null | undefined>): TranscriptState {
  let next: Set<number> | null = null;
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isFinite(id) || s.knownRowIds.has(id)) continue;
    (next ??= new Set(s.knownRowIds)).add(id);
  }
  return next ? { ...s, knownRowIds: next } : s;
}

/** A client bubble boundary — ONLY against a hub without `assistant_flushed`
 *  (I7); a connect snapshot's replayed gate (`snapshot: true`) never cuts. */
function legacyBoundary(s: TranscriptState, nowMs: number, ev?: { snapshot?: boolean }): TranscriptState {
  if (s.hubBoundaries || ev?.snapshot || !s.buf.assistant) return s;
  const [id, s1] = nextId(s, 'a', nowMs);
  return {
    ...s1,
    messages: [...s1.messages, {
      id, role: 'assistant', content: s1.buf.assistant, createdAt: Math.floor(nowMs / 1000),
      model: s1.meta.effectiveModel, assistantFinal: 0,
    }],
    buf: { ...s1.buf, assistant: '' },
  };
}

function upsertRow(messages: Msg[], row: Msg): Msg[] {
  return upsertById(messages, row);
}

function capToolCalls(calls: ToolCallEntry[], view: TranscriptView): ToolCallEntry[] {
  return view === 'conversation' && calls.length > CONVERSATION_TOOL_CALLS_MAX
    ? calls.slice(calls.length - CONVERSATION_TOOL_CALLS_MAX) : calls;
}

function withBg(s: TranscriptState, mutate: (m: Map<string, BgTask>) => boolean): TranscriptState {
  const copy = new Map<string, BgTask>();
  for (const [k, v] of s.bgTasks) copy.set(k, { ...v });
  return mutate(copy) ? { ...s, bgTasks: copy } : s;
}

function liveToolOutputRow(toolUseId: string, text: string, createdAt: number): Msg {
  return {
    id: 'tr-live-' + toolUseId, role: 'tool_result', createdAt,
    content: JSON.stringify({ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: false }),
  };
}

function coveredToolCallSide(s: TranscriptState, ev: Extract<SessionFrame, { type: 'tool_use' | 'tool_result' }>,
  nowS: number): TranscriptState {
  if (ev.type === 'tool_use') {
    if (s.toolCalls.some((c) => c.id === ev.id)) return s;
    const filePath = ev.input && ev.input.file_path ? String(ev.input.file_path) : null;
    return {
      ...s,
      toolCalls: capToolCalls([...s.toolCalls, { id: ev.id, name: ev.name, input: ev.input, startedAt: nowS }], 'conversation'),
      ...(filePath && !s.files.has(filePath) ? { files: new Set(s.files).add(filePath) } : {}),
    };
  }
  if (!s.toolCalls.some((c) => c.id === ev.tool_use_id)) return s;
  return { ...s, toolCalls: s.toolCalls.map((c) => c.id === ev.tool_use_id
    ? { ...c, result: { content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? ''), isError: !!ev.is_error } } : c) };
}

/** Apply ONE bus frame. `ctx.rev` = its revision (null: a rev-less frame).
 *  Pure; returns the effects for the hook's runner (skipped when
 *  `ctx.fromJournal`: a re-dispatched frame already had its side effects). */
export function applyFrame(s: TranscriptState, ev: SessionFrame, ctx: TranscriptCtx & { rev: SyncRev | null }):
  { state: TranscriptState; effects: Effect[] } {
  const type = (ev as { type: string }).type;
  const nowMs = ctx.nowMs;
  const nowS = Math.floor(nowMs / 1000);
  const conversation = ctx.view === 'conversation';
  const technical = conversation && isTechnicalFrame(type);

  if (isCoveredBySnapshot(s, type, ctx.rev)) {
    // Already in the snapshot. One exception: our own send's echo still names
    // its row (the bubble becomes the snapshot's `m<rowId>`).
    if (ev.type === 'user_echo' && ev.clientMessageId && ev.rowId != null && s.sends.has(ev.clientMessageId)) {
      const acked = reduceSendAck(s.messages, s.sends, ev.clientMessageId, ev.rowId);
      const sends = new Map(acked.sends);
      if (s.knownRowIds.has(ev.rowId)) sends.delete(ev.clientMessageId);
      return { state: withRowIds({ ...s, messages: acked.messages, sends }, ev.rowId), effects: [] };
    }
    // A conversation snapshot carries no tool rows: the calls list keeps its
    // side of a covered tool frame (the count already holds it: no
    // toolCallIdsSince), else that call never reaches the calls tab.
    if (conversation && (ev.type === 'tool_use' || ev.type === 'tool_result')) {
      return { state: coveredToolCallSide(s, ev, nowS), effects: [] };
    }
    return { state: s, effects: [] };
  }
  if (type === 'plan_progress' && ctx.rev && s.snapshotRev && cmpRev(ctx.rev, s.snapshotRev) <= 0
      && s.durablePlans.has(String((ev as { id?: unknown }).id))) {
    return { state: s, effects: [] };
  }

  let st = withRowIds(s, (ev as { rowId?: number }).rowId);
  const effects: Effect[] = [];

  switch (ev.type) {
    case 'status': {
      if (ev.status === 'killed') { effects.push({ kind: 'killed' }); break; }
      st = { ...st, status: ev.status, ...(ev.status !== 'thinking' ? { compacting: false } : {}) };
      // A new SDK client applies the queued config.
      if (ev.status === 'starting' && (st.meta.modelPendingApply || st.meta.effortPendingApply)) {
        st = { ...st, meta: { ...st.meta, modelPendingApply: false, effortPendingApply: false } };
      }
      // The CLI died with the session: its background children cannot notify.
      if (ev.status === 'sleeping' || ev.status === 'error') st = withBg(st, markRunningBgTasksStale);
      break;
    }
    case 'user_echo': {
      const { sends, match } = matchUserEcho(st.sends, ev);
      st = { ...st, sends, liveUsage: null };
      if (match.kind !== 'suppress') st = { ...st, messages: applyUserEchoMatch(st.messages, match, ev) };
      break;
    }
    case 'assistant_text':
      st = { ...st, buf: { ...st.buf, assistant: st.buf.assistant + ev.delta } };
      break;
    case 'assistant_flushed':
    case 'assistant_reopened': {
      const before = st.buf;
      const out = flushFrameBuffer(before, ev);
      st = {
        ...st, hubBoundaries: true, buf: out.buf,
        messages: applyFlushFrame(st.messages, before, ev, { nowMs }),
      };
      for (const e of out.effects) effects.push(e);
      break;
    }
    case 'tool_use': {
      st = legacyBoundary(st, nowMs);
      if (isBgLaunchToolUse(ev.name, ev.input)) {
        const bgLaunches = new Map(st.bgLaunches);
        bgLaunches.set(ev.id, {
          command: typeof ev.input?.command === 'string' ? ev.input.command : null,
          description: typeof ev.input?.description === 'string' ? ev.input.description : null,
        });
        st = { ...st, bgLaunches };
      }
      if (!technical) st = { ...st, messages: reduceRowIdRename(st.messages, ev, nowMs) };
      // The turn's running tool count (thinking bar), whatever the view.
      if (typeof ev.turnTools === 'number') st = { ...st, liveUsage: { ...(st.liveUsage ?? { output: 0 }), tools: ev.turnTools } };
      if (!st.toolCallIdsSince.has(ev.id)) st = { ...st, toolCallIdsSince: new Set(st.toolCallIdsSince).add(ev.id) };
      if (!st.toolCalls.some((c) => c.id === ev.id)) {
        st = { ...st, toolCalls: capToolCalls([...st.toolCalls, { id: ev.id, name: ev.name, input: ev.input, startedAt: nowS }], ctx.view) };
      }
      const filePath = ev.input && ev.input.file_path ? String(ev.input.file_path) : null;
      if (filePath && !st.files.has(filePath)) st = { ...st, files: new Set(st.files).add(filePath) };
      break;
    }
    case 'tool_result':
      if (!technical) st = { ...st, messages: reduceRowIdRename(st.messages, ev, nowMs) };
      st = { ...st, toolCalls: st.toolCalls.map((c) => c.id === ev.tool_use_id
        ? { ...c, result: { content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? ''), isError: !!ev.is_error } } : c) };
      break;
    case 'tool_progress': {
      if (technical) break;
      const id = 'tr-live-' + ev.tool_use_id;
      const idx = st.messages.findIndex((m) => m.id === id);
      let text = ev.delta;
      if (idx >= 0) {
        try { text = String(JSON.parse(st.messages[idx].content).content ?? '') + ev.delta; } catch { /* keep the delta */ }
      }
      // Bound the browser buffer; the final aggregate replaces it.
      const row = liveToolOutputRow(ev.tool_use_id, text.slice(-256 * 1024), idx >= 0 ? st.messages[idx].createdAt : nowS);
      st = { ...st, messages: idx < 0 ? [...st.messages, row] : st.messages.map((m, i) => i === idx ? row : m) };
      break;
    }
    case 'edit_progress': {
      const edits = new Map(st.edits);
      edits.set(ev.file_path, { toolUseId: ev.tool_use_id, filePath: ev.file_path, before: null, after: ev.diff, truncated: !!ev.truncated });
      st = { ...st, edits, files: st.files.has(ev.file_path) ? st.files : new Set(st.files).add(ev.file_path) };
      break;
    }
    case 'plan_progress':
    case 'plan_update': {
      st = legacyBoundary(st, nowMs);
      const id = `plan:${ev.id}`;
      const existing = st.messages.find((m) => m.id === id);
      const row: Msg = {
        id, role: 'plan', createdAt: existing?.createdAt ?? nowS,
        content: JSON.stringify({ ...ev, partial: ev.type === 'plan_progress' }),
      };
      const livePlans = new Map(st.livePlans);
      if (ev.type === 'plan_progress') livePlans.set(id, row);
      else livePlans.delete(id);
      st = { ...st, livePlans };
      if (!technical) st = { ...st, messages: upsertRow(st.messages, row) };
      break;
    }
    case 'tool_activity':
      if (ev.kind === 'filesystem') {
        const paths = (ev.detail as { paths?: unknown } | undefined)?.paths;
        if (Array.isArray(paths)) effects.push({ kind: 'fsChanged', paths: paths.map(String) });
      }
      break;
    case 'compacting':
      st = { ...st, compacting: ev.active === true };
      break;
    case 'runtime_outdated':
      st = { ...st, runtimeOutdated: ev.outdated === true };
      break;
    case 'stop':
      st = legacyBoundary(st, nowMs);
      st = { ...st, compacting: false };
      // Marks `m<finalAssistantId>` final; closes the reasoning bubble. The
      // row is already on screen (its `assistant_flushed` came first): no
      // refetch (I7).
      st = { ...st, messages: reduceStop(st.messages, ev, { hubBoundaries: st.hubBoundaries }) };
      break;
    case 'bg_task': {
      const launches = new Map(st.bgLaunches);
      const at = nowS;
      st = withBg(st, (m) => applyBgTaskEvent(m, ev as never, at, launches));
      st = { ...st, bgLaunches: launches };
      break;
    }
    case 'bg_tasks_snapshot': {
      const next = reconcileAuthoritativeBgTasks(bgTasksToArray(st.bgTasks), ev.tasks as BgTask[]);
      st = { ...st, bgTasks: new Map(next.map((t) => [t.taskId, { ...t }])) };
      break;
    }
    case 'bg_task_progress':
      st = withBg(st, (m) => applyBgTaskProgress(m, ev as never, nowS));
      break;
    case 'error':
      st = { ...st, messages: closeThinkingMessage(st.messages), retryBanner: ev.retrying === true };
      effects.push(ev.retrying === true ? { kind: 'banner', msg: ev.msg, retrying: true } : { kind: 'banner', msg: ev.msg });
      break;
    case 'blocking_error': {
      effects.push({ kind: 'clearBanner' });
      st = withRowIds(st, ev.messageId);
      let id: string;
      if (ev.messageId) id = rowKey(ev.messageId);
      else [id, st] = nextId(st, 'e', nowMs);
      st = { ...st, messages: upsertRow(st.messages, { id, role: 'error', content: JSON.stringify(ev.error), createdAt: ev.createdAt }) };
      break;
    }
    case 'scheduled_resume':
      st = withRowIds(st, ev.messageId);
      st = { ...st, messages: upsertRow(st.messages, { id: rowKey(ev.messageId), role: 'scheduled_resume', content: ev.content, createdAt: ev.createdAt }) };
      break;
    case 'permission_request':
      st = legacyBoundary(st, nowMs);
      if (!st.queues.permissions.some((p) => p.id === ev.id)) {
        st = { ...st, queues: { ...st.queues, permissions: [...st.queues.permissions, {
          id: ev.id, sessionId: st.sessionId, tool: ev.tool, input: ev.input, createdAt: nowS, expiresAt: ev.expiresAt,
          ...(ev.reason ? { reason: ev.reason } : {}),
          ...(ev.suggestions?.length ? { suggestions: ev.suggestions } : {}),
        }] } };
      }
      break;
    case 'user_question': {
      st = legacyBoundary(st, nowMs, ev);
      const createdAt = ev.createdAt ?? nowS;
      if (ev.delivery === 'async' && !ev.snapshot && !st.messages.some((m) => m.id === `question:${ev.id}`)) {
        st = { ...st, messages: [...st.messages, {
          id: `question:${ev.id}`, role: 'async_question', createdAt,
          content: JSON.stringify({ id: ev.id, questions: ev.questions, status: 'pending' }),
        }] };
      }
      if (!st.queues.questions.some((q) => q.id === ev.id)) {
        st = { ...st, queues: { ...st.queues, questions: [...st.queues.questions, {
          id: ev.id, sessionId: st.sessionId, questions: ev.questions as PendingQuestion['questions'],
          createdAt, expiresAt: ev.expiresAt, delivery: ev.delivery,
        }] } };
      }
      break;
    }
    case 'question_delivery': {
      // An async answer's send started/ended (a FAILED one leaves no other
      // trace): the strip's form follows it (W4 review).
      const i = st.queues.questions.findIndex((q) => q.id === ev.id);
      if (i < 0 || !!st.queues.questions[i].delivering === ev.delivering) break;
      const questions = st.queues.questions.slice();
      const { delivering: _d, ...rest } = questions[i];
      questions[i] = ev.delivering ? { ...rest, delivering: true } : rest;
      st = { ...st, queues: { ...st.queues, questions } };
      break;
    }
    case 'exit_plan_request':
      st = legacyBoundary(st, nowMs);
      if (!st.queues.exitPlans.some((p) => p.id === ev.id)) {
        st = { ...st, queues: { ...st.queues, exitPlans: [...st.queues.exitPlans, {
          id: ev.id, sessionId: st.sessionId, plan: ev.plan ?? '', createdAt: nowS, expiresAt: ev.expiresAt,
        }] } };
      }
      break;
    case 'interaction_resolved': {
      if (ev.kind === 'question') {
        st = { ...st, messages: resolveAsyncQuestionMessages(st.messages, ev.id, ev.outcome ?? 'answered', ev.answers) };
      }
      st = { ...st, queues: removeGate(st.queues, ev.kind, ev.id) };
      if (ev.outcome === 'expired') {
        effects.push({ kind: 'banner', msg: ev.kind === 'permission'
          ? 'Approval timed out and was automatically denied.'
          : 'The pending question timed out without an answer.' });
      }
      break;
    }
    case 'prefill_input':
      effects.push({ kind: 'prefill', content: ev.content || 'continue' });
      break;
    case 'reconnecting':
      effects.push({ kind: 'clearBanner' });
      break;
    case 'edit_snapshot': {
      const key = ev.file_path;
      const edits = new Map(st.edits);
      const cur = st.edits.get(key) ?? { toolUseId: ev.tool_use_id, filePath: key, before: null, after: null, truncated: false };
      if (ev.phase === 'before') {
        edits.set(key, { ...cur, before: ev.content, truncated: cur.truncated || !!ev.truncated });
      } else {
        // Codex: phase 'diff', the unified diff in `diff` (§14.59).
        const after = ev.content ?? (ev as { diff?: string | null }).diff ?? null;
        edits.set(key, { ...cur, after, truncated: cur.truncated || !!ev.truncated });
      }
      st = { ...st, edits, files: st.files.has(key) ? st.files : new Set(st.files).add(key) };
      break;
    }
    case 'thinking': {
      st = legacyBoundary(st, nowMs);
      if (PROVIDERS[ctx.provider].thinkingDelivery === 'delta') {
        // A streamed fragment (the hook batches them ≤ 80 ms): joined to the
        // open bubble, and part of the hub's open block.
        st = { ...st, buf: { ...st.buf, thinkingOpen: st.buf.thinkingOpen + ev.text } };
        if (!technical && ev.text) {
          let id: string;
          [id, st] = nextId(st, 'th', nowMs);
          st = { ...st, messages: appendThinkingMessage(st.messages, { id, role: 'thinking', content: ev.text, createdAt: nowS, thinkingDelta: true }) };
        }
        break;
      }
      // A complete block (Claude): its own bubble — `m<rowId>` once.
      if (technical) break;
      if (ev.rowId != null && st.messages.some((m) => m.id === rowKey(ev.rowId!))) break;
      {
        let id: string;
        if (ev.rowId != null) id = rowKey(ev.rowId);
        else [id, st] = nextId(st, 'th', nowMs);
        st = { ...st, messages: appendThinkingMessage(st.messages, { id, role: 'thinking', content: ev.text, createdAt: nowS }) };
      }
      break;
    }
    case 'thinking_flushed': {
      // A content-less re-cut of a row already known is a restart replay
      // passing that anchor again: `open` is a later block's (thinkingMessages.ts).
      if (typeof ev.content !== 'string' && ev.rowId <= st.thinkingKnown) break;
      const openText = st.buf.thinkingOpen;
      st = { ...st, buf: { ...st.buf, thinkingOpen: '' }, thinkingKnown: Math.max(st.thinkingKnown, ev.rowId) };
      if (!technical) st = { ...st, messages: applyThinkingFlushed(st.messages, ev, openText) };
      break;
    }
    case 'thinking_reopened': {
      const openText = st.buf.thinkingOpen;
      st = { ...st, buf: { ...st.buf, thinkingOpen: '' } };
      if (!technical) st = { ...st, messages: applyThinkingReopened(st.messages, openText) };
      break;
    }
    case 'compaction':
      st = legacyBoundary(st, nowMs);
      st = { ...st, compacting: false };
      {
        let id: string;
        if (ev.rowId != null) id = rowKey(ev.rowId);
        else [id, st] = nextId(st, 'cp', nowMs);
        st = { ...st, messages: upsertRow(st.messages, { id, role: 'compaction', content: typeof ev.trigger === 'string' ? ev.trigger : '', createdAt: nowS }) };
      }
      break;
    case 'scheduled_fire': {
      st = legacyBoundary(st, nowMs);
      let id: string;
      if (ev.rowId != null) id = rowKey(ev.rowId);
      else [id, st] = nextId(st, 'sf', nowMs);
      st = { ...st, messages: upsertRow(st.messages, { id, role: 'scheduled_fire', content: scheduledFireContent(ev), createdAt: nowS }) };
      break;
    }
    case 'structured_output': {
      st = legacyBoundary(st, nowMs);
      let id: string;
      if (ev.rowId != null) id = rowKey(ev.rowId);
      else [id, st] = nextId(st, 'so', nowMs);
      const json = JSON.stringify(ev.value, null, 2);
      st = { ...st, messages: upsertRow(st.messages, {
        id, role: 'structured', createdAt: nowS,
        content: `${ev.truncated ? '_Output truncated by the 512 KiB safety limit._\n\n' : ''}\`\`\`json\n${json}\n\`\`\``,
      }) };
      break;
    }
    case 'external_message': {
      st = legacyBoundary(st, nowMs);
      let id: string;
      if (ev.rowId != null) id = rowKey(ev.rowId);
      else [id, st] = nextId(st, 'ex', nowMs);
      const x = ev as typeof ev & { from?: string; fromProvider?: SessionProvider; sourceSessionId?: string;
        messageId?: string; conversationId?: string; replyTo?: string };
      st = { ...st, messages: upsertRow(st.messages, {
        id, role: 'external', content: ev.text, createdAt: nowS,
        from: x.from ?? null, fromProvider: x.fromProvider ?? null, sourceSessionId: x.sourceSessionId ?? null,
        origin: ev.origin, expectsReply: ev.expectsReply ?? null, messageId: x.messageId ?? null,
        conversationId: x.conversationId ?? null, replyTo: x.replyTo ?? null,
      }) };
      break;
    }
    case 'peer_message_status': {
      st = legacyBoundary(st, nowMs);
      const message: Msg = {
        id: `peer:${ev.messageId}`, role: 'peer_status', content: ev.text ?? '', createdAt: nowS,
        messageId: ev.messageId, conversationId: ev.conversationId, peerStatus: ev.status,
        peerTarget: ev.target ?? null, peerTargetSessionId: ev.targetSessionId ?? null,
        peerError: ev.error ?? null, fromProvider: ev.targetProvider ?? null,
      };
      const idx = st.messages.findIndex((m) => m.id === message.id);
      st = { ...st, messages: idx < 0 ? [...st.messages, message]
        : st.messages.map((m, i) => i === idx ? { ...m, ...message, createdAt: m.createdAt } : m) };
      break;
    }
    case 'mode_changed':
      st = { ...st, meta: { ...st.meta, permissionMode: ev.mode } };
      break;
    case 'model_changed':
      st = { ...st, meta: { ...st.meta, model: ev.model ?? null, fallbackModel: ev.fallbackModel ?? null,
        modelPendingApply: !!ev.appliedAtNextStart } };
      break;
    case 'effort_changed':
      st = { ...st, meta: { ...st.meta, effort: (ev.effort as string | null) || null, effortPendingApply: !!ev.appliedAtNextStart } };
      break;
    case 'effective_model':
      if (typeof ev.model === 'string' && ev.model.length > 0) {
        // Text buffered before a mid-turn model switch belongs to the previous
        // model (legacy client cut; the hub cuts it itself otherwise).
        if (st.meta.effectiveModel && st.meta.effectiveModel !== ev.model) st = legacyBoundary(st, nowMs);
        st = { ...st, meta: { ...st.meta, effectiveModel: ev.model } };
      }
      break;
    case 'session_token_usage': {
      const tokenUsage = mergeSessionTokenUsage(st.tokenUsage, ev.usage as SessionTokenUsage);
      if (tokenUsage !== st.tokenUsage) st = { ...st, tokenUsage };
      break;
    }
    case 'usage':
      if (ev.final) st = { ...st, messages: closeThinkingMessage(st.messages) };
      st = { ...st, liveUsage: { output: ev.output_tokens, input: ev.input_tokens, final: ev.final,
        durationMs: ev.duration_ms, costUsd: ev.cost_usd, tools: ev.turn_tools ?? st.liveUsage?.tools } };
      break;
    case 'transcript_reset':
      effects.push({ kind: 'window', reason: 'reset' });
      break;
    default:
      if (type === 'session_resync') effects.push({ kind: 'window', reason: 'resync' });
      break;
  }
  if (st.retryBanner && STREAM_RESUMED.has(type)) {
    st = { ...st, retryBanner: false };
    effects.push({ kind: 'clearRetryBanner' });
  }
  return { state: st, effects };
}

function removeGate(queues: TranscriptState['queues'], kind: string, id: string): TranscriptState['queues'] {
  if (kind === 'permission') return { ...queues, permissions: queues.permissions.filter((p) => p.id !== id) };
  if (kind === 'question') return { ...queues, questions: queues.questions.filter((q) => q.id !== id) };
  if (kind === 'exit_plan') return { ...queues, exitPlans: queues.exitPlans.filter((e) => e.id !== id) };
  return queues;
}

/** Merge a rebuilt edits Map into the current one WITHOUT losing loaded diff
 *  content (the GET strips edit_snapshot content, §14.41): a file whose
 *  content is already loaded keeps it; files outside the window are kept. */
export function mergeEdits(prev: Map<string, EditSnapshot>, rebuilt: Map<string, EditSnapshot>): Map<string, EditSnapshot> {
  const next = new Map<string, EditSnapshot>();
  for (const [k, v] of rebuilt) {
    const old = prev.get(k);
    next.set(k, old && (old.before != null || old.after != null) ? { ...old, truncated: old.truncated || v.truncated } : v);
  }
  for (const [k, v] of prev) if (!next.has(k)) next.set(k, v);
  return next;
}

/** Chronological order key of a row (lib/server/hub/messageOrder.ts:
 *  `ts_ms`, ties by id). */
function chronoKey(m: ApiMessage): [number, number] {
  const ts = (m as { tsMs?: number | null }).tsMs;
  return [typeof ts === 'number' && Number.isFinite(ts) ? ts : m.createdAt * 1000, m.id];
}
function olderThan(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function planIdOfRow(m: ApiMessage): string | null {
  if (m.role !== 'event' || !m.content.includes('plan_update')) return null;
  try {
    const ev = JSON.parse(m.content);
    return ev?.type === 'plan_update' ? String(ev.id ?? m.id) : null;
  } catch { return null; }
}

/**
 * Apply a window answer (I6). `tail` keeps the loaded older rows strictly
 * older than the answer's oldest chronological key (older rows are immutable
 * except through rollback — `transcript_reset` — and offline compaction — a
 * new epoch —, both `replace`); `replace` drops older pages. Then rebuild;
 * live buffers EXACT (`streamingText`/`streamingExtends`/`streamingThinking`/
 * `streamingToolOutput`); queues and bg registry replaced; status from
 * `liveStatus`; `live` state carried over (partial plans, usage, pending
 * config flags). The caller then re-dispatches the journaled frames > R.
 */
export function applySnapshot(s: TranscriptState, r: SessionWindowResponse,
  ctx: TranscriptCtx & { mode: 'replace' | 'tail' }): TranscriptState {
  const provider = asSessionProvider(r.session?.kind ?? s.provider);
  const view = ctx.view;
  const fresh = (r.messages ?? []) as ApiMessage[];
  let kept: ApiMessage[] = [];
  if (ctx.mode === 'tail' && s.rows.length && fresh.length) {
    const first = chronoKey(fresh[0]);
    const freshIds = new Set(fresh.map((m) => m.id));
    // Older rows are kept only if they JOIN the answer: the windows overlap
    // (a shared row, or a held row at/after the answer's first) or the answer
    // reaches the start. A window landing past a gap wider than itself would
    // leave a hole that paging (from the old oldest row) never fills: it
    // replaces instead, taking the answer's hasMore/oldestChatId.
    const joins = r.hasMore !== true
      || s.rows.some((m) => freshIds.has(m.id) || !olderThan(chronoKey(m), first));
    if (joins) kept = s.rows.filter((m) => !freshIds.has(m.id) && olderThan(chronoKey(m), first));
  }
  const rows = kept.length ? [...kept, ...fresh] : fresh;
  const hubBoundaries = Array.isArray(r.features) ? r.features.includes('assistant_flushed') : s.hubBoundaries;
  const liveStatus = (r.liveStatus ?? r.session?.status ?? 'sleeping') as WorkerStatus;
  const rebuilt = rebuildStateFromMessages(rows, liveStatus, provider);
  let messages = rebuilt.messages;
  // A stamped answer is EXACT: its live buffers are the hub's at R, and the
  // journal replays every delta > R on top. An unstamped one (an older hub)
  // has no journal behind it: its buffers may lag what this browser already
  // received, so they are reconciled, never rewound (streamingPreview.ts,
  // legacy-only).
  const exact = r.sync != null;
  const streamingInto = hubBoundaries ? (r.streamingExtends?.rowId ?? null) : null;
  const serverText = String(r.streamingText ?? '');
  const assistant = exact || streamingInto !== s.buf.streamingInto ? serverText : reconcileStreamingPreview({
    serverText, localText: s.buf.assistant, status: liveStatus,
    lastAssistant: streamingInto != null ? null
      : [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? null,
  });

  // The hub's open reasoning block (delta providers; not a row yet).
  let thinkingOpen = '';
  let thinkingKnown = Math.max(typeof r.maxMessageId === 'number' ? r.maxMessageId : 0, ...thinkingRowIds(rows));
  if (PROVIDERS[provider].thinkingDelivery === 'delta' && view === 'full') {
    const lane = createThinkingLane();
    if (!exact) lane.open = s.buf.thinkingOpen;
    messages = thinkingLaneSnapshot(lane, messages, String(r.streamingThinking ?? ''),
      openThinkingCreatedAt(r.streamingThinkingTsMs), thinkingKnown);
    thinkingOpen = lane.open;
    thinkingKnown = lane.known;
  }

  // Output of the tools still running (`tool_progress` so far).
  if (view === 'full' && Array.isArray(r.streamingToolOutput)) {
    for (const t of r.streamingToolOutput) {
      const resolved = messages.some((m) => m.role === 'tool_result' && m.content.includes(t.toolUseId) && (() => {
        try { return JSON.parse(m.content)?.tool_use_id === t.toolUseId; } catch { return false; }
      })());
      if (!resolved) messages = upsertRow(messages, liveToolOutputRow(t.toolUseId, t.text, Math.floor(ctx.nowMs / 1000)));
    }
  }

  // Partial plans (live class) without a durable row in this snapshot.
  const durablePlans = new Set<string>();
  for (const m of rows) { const id = planIdOfRow(m); if (id) durablePlans.add(id); }
  const livePlans = new Map<string, Msg>();
  for (const [id, row] of s.livePlans) {
    if (durablePlans.has(id.slice('plan:'.length))) continue;
    livePlans.set(id, row);
    if (view === 'full') messages = upsertRow(messages, row);
  }

  const knownRowIds = new Set<number>(rows.map((m) => m.id));
  const snapshotRev = r.sync ?? null;

  // Gates answered here after this snapshot was read stay answered.
  const localResolved = new Map<string, SyncRev | null>();
  const dropped = new Set<string>();
  for (const [id, rev] of s.localResolved) {
    if (rev == null || !snapshotRev || cmpRev(snapshotRev, rev) < 0) {
      dropped.add(id);
      if (rev != null && snapshotRev) localResolved.set(id, rev);
    }
  }
  const sid = r.session?.id ?? s.sessionId;
  const queues = {
    permissions: ((r.pendingPermissions ?? []) as Omit<PermissionQ, 'sessionId'>[])
      .filter((p) => !dropped.has(p.id)).map((p) => ({ ...p, sessionId: sid })),
    questions: ((r.pendingQuestions ?? []) as Omit<QuestionQ, 'sessionId'>[])
      .filter((q) => !dropped.has(q.id)).map((q) => ({ ...q, sessionId: sid })),
    exitPlans: ((r.pendingExitPlans ?? []) as Omit<ExitPlanQ, 'sessionId'>[])
      .filter((e) => !dropped.has(e.id)).map((e) => ({ ...e, sessionId: sid })),
  };

  // Composer sends: unmaterialised bubbles come back; materialised ones go.
  const reconciled = reconcileOptimisticBubbles(messages, s.sends, knownRowIds);
  messages = reconciled.messages;

  const bg = bgTasksAfterWindowAnswer(rebuilt.bgTasks, r, s.bgTasks.values());
  const sess = r.session as (SessionWindowResponse['session'] & { model?: string | null; fallbackModel?: string | null; effort?: string | null }) | undefined;
  const pm = sess?.permissionMode as SessionMode | undefined;
  const tailKeepsPaging = kept.length > 0;
  return {
    ...s,
    rows, messages,
    toolCalls: view === 'full' ? rebuilt.toolCalls : s.toolCalls,
    files: view === 'full' ? rebuilt.files : new Set([...s.files, ...rebuilt.files]),
    edits: mergeEdits(s.edits, rebuilt.edits),
    bgTasks: new Map(bg.map((t) => [t.taskId, { ...t }])),
    queues,
    status: liveStatus,
    compacting: r.liveCompacting === true,
    runtimeOutdated: r.liveRuntimeOutdated === true,
    buf: { assistant, streamingInto, thinkingOpen },
    thinkingKnown,
    sends: reconciled.sends,
    knownRowIds, livePlans, durablePlans, localResolved,
    snapshotRev,
    // A snapshot without a count (an older hub, a `?since=` delta) keeps the
    // running one.
    ...(typeof r.toolCallCount === 'number' ? { toolCallBase: r.toolCallCount, toolCallIdsSince: new Set<string>() } : {}),
    afterId: typeof r.maxMessageId === 'number' ? r.maxMessageId : rows.reduce((a, m) => Math.max(a, m.id), 0),
    hubBoundaries,
    hasMore: tailKeepsPaging ? s.hasMore : !!r.hasMore,
    oldestChatId: tailKeepsPaging ? s.oldestChatId : (r.oldestChatId ?? null),
    provider,
    session: r.session ?? s.session,
    meta: {
      ...s.meta,
      permissionMode: sess && isSessionMode(provider, pm) ? pm! : defaultSessionMode(provider),
      model: sess?.model ?? null,
      fallbackModel: sess?.fallbackModel ?? null,
      effort: sess?.effort || null,
      effectiveModel: r.effectiveModel ?? null,
      // The hub's known flags win (a `starting` lost in a resync gap must not
      // leave a stale "apply now"); unknown ones keep the view's value.
      ...(typeof r.pendingApply?.model === 'boolean' ? { modelPendingApply: r.pendingApply.model } : {}),
      ...(typeof r.pendingApply?.effort === 'boolean' ? { effortPendingApply: r.pendingApply.effort } : {}),
    },
    tokenUsage: mergeSessionTokenUsage(s.tokenUsage, r.tokenUsage),
    loaded: true,
  };
}

/** A page of older rows (`?before=`), prepended. Ignored when the window
 *  moved meanwhile (`cursor` is no longer the oldest row: a replace apply). */
export function applyOlderPage(s: TranscriptState,
  page: { messages: ApiMessage[]; hasMore: boolean; oldestChatId: number | null },
  cursor: number, ctx: Pick<TranscriptCtx, 'view' | 'provider'>): TranscriptState {
  if (s.oldestChatId !== cursor) return s;
  const have = new Set(s.rows.map((m) => m.id));
  const older = (page.messages ?? []).filter((m) => !have.has(m.id));
  const next: TranscriptState = { ...s, hasMore: !!page.hasMore, oldestChatId: page.oldestChatId ?? cursor };
  if (!older.length) return next;
  const rebuilt = rebuildStateFromMessages(older, (s.status ?? 'sleeping') as WorkerStatus, ctx.provider);
  const edits = new Map(s.edits);
  for (const [k, v] of rebuilt.edits) if (!edits.has(k)) edits.set(k, v);
  const knownRowIds = new Set(s.knownRowIds);
  for (const m of older) knownRowIds.add(m.id);
  return {
    ...next,
    rows: [...older, ...s.rows],
    messages: prependMessagePage(rebuilt.messages, s.messages),
    toolCalls: ctx.view === 'full' ? [...rebuilt.toolCalls, ...s.toolCalls] : s.toolCalls,
    files: new Set([...s.files, ...rebuilt.files]),
    edits, knownRowIds,
  };
}

/** The session's tool-call total (null until a snapshot carried a count):
 *  live tool_use frames grow it between window answers. */
export function toolCallTotal(s: TranscriptState): number | null {
  return s.toolCallBase == null ? null : s.toolCallBase + s.toolCallIdsSince.size;
}

/** The composer's optimistic bubble (`u-<clientMessageId>`). */
export function applyLocalSend(s: TranscriptState, clientMessageId: string, content: string, nowMs: number): TranscriptState {
  const added = addOptimisticSend(s.messages, s.sends, clientMessageId, content, Math.floor(nowMs / 1000));
  return { ...s, messages: added.messages, sends: added.sends, liveUsage: null };
}

/** The input POST answered `{rowId}`. */
export function applyLocalSendAck(s: TranscriptState, clientMessageId: string, rowId: number | null | undefined): TranscriptState {
  if (rowId == null) return s;
  const acked = reduceSendAck(s.messages, s.sends, clientMessageId, rowId);
  return withRowIds({ ...s, messages: acked.messages, sends: acked.sends }, rowId);
}

/** The input POST failed with no `rowId`. The bubble stays until the next
 *  snapshot: one holding the row (persisted before the failure, e.g. the
 *  agent RPC threw) materialises it; one lacking it drops it (a late echo
 *  still shows the row). */
export function applyLocalSendFailed(s: TranscriptState, clientMessageId: string): TranscriptState {
  const entry = s.sends.get(clientMessageId);
  if (!entry || entry.rowId != null || entry.failed) return s;
  const sends = new Map(s.sends);
  sends.set(clientMessageId, { ...entry, failed: true });
  return { ...s, sends };
}

/** A gate answered here (pessimistic: after the POST succeeded). `rev` = the
 *  answer's `sync`: a snapshot older than it does not bring the gate back. */
export function applyLocalResolution(s: TranscriptState, kind: 'permission' | 'question' | 'exit_plan', id: string,
  rev: SyncRev | null | undefined, answers?: Record<string, string> | null): TranscriptState {
  const localResolved = new Map(s.localResolved);
  localResolved.set(id, rev ?? null);
  let messages = s.messages;
  if (kind === 'question' && answers !== undefined) {
    messages = resolveAsyncQuestionMessages(messages, id, answers ? 'answered' : 'cancelled', answers);
  }
  return { ...s, messages, localResolved, queues: removeGate(s.queues, kind, id) };
}

/** Every pending gate id this view holds (the probe's `pendingIds`). */
export function pendingGateIds(s: Pick<TranscriptState, 'queues'>): Set<string> {
  const ids = new Set<string>();
  for (const p of s.queues.permissions) ids.add(p.id);
  for (const q of s.queues.questions) ids.add(q.id);
  for (const e of s.queues.exitPlans) ids.add(e.id);
  return ids;
}
