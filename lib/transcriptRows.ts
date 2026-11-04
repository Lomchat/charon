// Which persisted rows a transcript VIEW renders, and how every bus frame
// relates to the session GET's snapshot (CLAUDE.md §14.25, sync refonte I6,
// I14, I15). Shared and browser-safe: no runtime import (`KnownFrameType` is
// a type, erased).
//
// ⚠ Classify every new row role / `event` row type here (and in
// `app/sessionRebuild.ts`), and every new frame type in FRAME_SNAPSHOT_CLASS
// (tsc-exhaustive) — tests/transcriptRows.test.ts checks every rebuild branch.
//
// "Tools hidden" in the browser (`app/chatVisibility.ts`) asks the session GET
// for `view=conversation`, whose window counts and returns conversation rows
// only (lib/server/hub/messageWindow.ts builds its SQL from these lists).
import type { KnownFrameType } from '@/lib/server/sync/frameRouting';

export type TranscriptView = 'full' | 'conversation';

/** Rows the conversation view never fetches (rendered only with tools shown). */
export const TECHNICAL_ROLES = ['tool_use', 'tool_result', 'thinking'] as const;

/** Rows that render nothing in either view (their state rides on gate queues). */
export const RENDER_NULL_ROLES = ['user_question', 'exit_plan_request'] as const;

/** `event` rows that ride along with their page in conversation view: they
 *  render a message (compaction, structured output, fork point, peer traffic)
 *  or carry state the conversation still needs (bg tasks, async-question
 *  resolutions). */
export const CONVERSATION_EVENT_TYPES = ['compaction', 'scheduled_fire', 'structured_output', 'fork_point', 'external_message',
  'peer_message_status', 'bg_task', 'interaction_resolved'] as const;

/** `event` row types that produce a Msg in `rebuildStateFromMessages`. */
export const RENDERED_EVENT_TYPES = ['thinking', 'compaction', 'scheduled_fire', 'structured_output', 'fork_point', 'external_message',
  'plan_update', 'peer_message_status'] as const;

/** `event` row types the rebuild reads WITHOUT rendering a message of their
 *  own (registries, resolutions, turn boundaries) or ignores on purpose. */
export const STATE_EVENT_TYPES = ['bg_task', 'interaction_resolved', 'turn_usage', 'endpoint_usage',
  'tool_activity'] as const;

const NON_SLOT_ROLES: ReadonlySet<string> = new Set<string>([
  'edit_snapshot', 'event', ...TECHNICAL_ROLES, ...RENDER_NULL_ROLES,
]);
const TECHNICAL: ReadonlySet<string> = new Set<string>(TECHNICAL_ROLES);
const RENDER_NULL: ReadonlySet<string> = new Set<string>(RENDER_NULL_ROLES);
const RENDERED_EVENTS: ReadonlySet<string> = new Set<string>(RENDERED_EVENT_TYPES);
const CONVERSATION_EVENTS: ReadonlySet<string> = new Set<string>(CONVERSATION_EVENT_TYPES);

/** A row that takes one of the conversation window's `limit` slots: not a
 *  side channel (edit_snapshot/event), not technical, not render-null. */
export function isConversationSlotRole(role: string): boolean {
  return !NON_SLOT_ROLES.has(role);
}

/**
 * Does this persisted row produce a rendered message in `view`? (`eventType`
 * = `json_extract(content,'$.type')` for `role='event'`, else null.) The
 * probe's `newRows` and the rowId rule (I15) read it: a frame whose handler
 * persisted a RENDERED row (`'full'`) carries that row's id as `rowId`.
 */
export function isRenderedRow(role: string, eventType: string | null, view: TranscriptView): boolean {
  if (role === 'edit_snapshot' || RENDER_NULL.has(role)) return false;
  if (role === 'event') {
    if (eventType == null || !RENDERED_EVENTS.has(eventType)) return false;
    return view === 'full' || CONVERSATION_EVENTS.has(eventType);
  }
  if (view === 'conversation' && TECHNICAL.has(role)) return false;
  return true;
}

/**
 * How a frame relates to a snapshot stamped R (the window GET's `sync`):
 *   durable — the hub handler writes the DB (row or column) BEFORE publishing,
 *             so its effect is in every snapshot stamped ≥ its rev;
 *   covered — live-only but mirrored by the window GET (`streamingText`/
 *             `streamingExtends`, `streamingThinking`, `streamingToolOutput`);
 *   live    — latest-value state never in a snapshot (applied whatever its rev,
 *             global dup guard only);
 *   summary — a cross-session store fact (list, badges, VPS, workspace), not
 *             transcript state.
 * After a snapshot @R: durable/covered frames ≤ R are dropped, > R replayed.
 */
export type SnapshotClass = 'durable' | 'covered' | 'live' | 'summary';

export const FRAME_SNAPSHOT_CLASS: Record<KnownFrameType, SnapshotClass> = {
  // ── durable: rows (and session columns) written before the publish ───────
  user_echo: 'durable',
  assistant_flushed: 'durable',
  tool_use: 'durable',
  tool_result: 'durable',
  structured_output: 'durable',
  compaction: 'durable',
  scheduled_fire: 'durable',
  external_message: 'durable',
  peer_message_status: 'durable',
  plan_update: 'durable',
  bg_task: 'durable',
  edit_snapshot: 'durable',
  thinking_flushed: 'durable',
  blocking_error: 'durable',
  scheduled_resume: 'durable',
  permission_request: 'durable',
  user_question: 'durable',
  exit_plan_request: 'durable',
  interaction_resolved: 'durable',
  question_delivery: 'durable',      // the in-memory delivering mark, set before the publish
  stop: 'durable',
  status: 'durable',                 // `liveStatus` (stream memory, set before the publish)
  mode_changed: 'durable',
  model_changed: 'durable',
  effort_changed: 'durable',
  effective_model: 'durable',
  session_id: 'durable',
  transcript_reset: 'durable',       // the rollback deleted the rows first
  bg_tasks_snapshot: 'durable',      // the warm registry the next window GET returns
  // A ring stub for an oversized frame: the snapshot it asks for supersedes it.
  session_resync: 'durable',
  // ── covered: mirrored by the window GET ─────────────────────────────────
  assistant_text: 'covered',         // streamingText
  assistant_reopened: 'covered',     // streamingExtends
  thinking: 'covered',               // delta: streamingThinking; block: its row (durable too)
  thinking_reopened: 'covered',      // streamingThinking
  tool_progress: 'covered',          // streamingToolOutput
  // ── live: latest-value, never in a snapshot ─────────────────────────────
  plan_progress: 'live',
  edit_progress: 'live',
  bg_task_progress: 'live',
  usage: 'live',
  generation_progress: 'live',
  rate_limit: 'live',
  tool_activity: 'live',
  session_token_usage: 'live',
  session_info: 'live',
  turn_error: 'live',
  error: 'live',
  ready: 'live',
  reconnecting: 'live',
  prefill_input: 'live',
  history_begin: 'live',
  history_end: 'live',
  // ── summary: cross-session stores ───────────────────────────────────────
  session_summary: 'summary',
  session_unread: 'summary',
  session_bg_tasks: 'summary',
  session_list_changed: 'summary',
  pending_snapshot: 'summary',
  vps_status: 'summary',
  shell_status: 'summary',
  shell_unread: 'summary',
  tabs_changed: 'summary',
  settings_changed: 'summary',
  account_usage: 'summary',
  account_profiles_changed: 'summary',
  file_activity: 'summary',
  model_notices: 'summary',
  install_started: 'summary',
  install_finished: 'summary',
};

const TECHNICAL_FRAMES: ReadonlySet<string> = new Set([
  'tool_use', 'tool_result', 'tool_progress', 'thinking', 'thinking_flushed', 'thinking_reopened',
]);

/** A frame the conversation view keeps out of the transcript (it still
 *  drives live state: thinking bar, running tool, plan strip). */
export function isTechnicalFrame(type: string): boolean {
  return TECHNICAL_FRAMES.has(type) || type.startsWith('plan_');
}
