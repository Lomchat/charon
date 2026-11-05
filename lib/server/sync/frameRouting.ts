// Frame classification of the sync bus (CLAUDE.md §14.16, §17). Pure, no
// imports at runtime: syncBus.ts (route + summary trigger at publish), the
// SSE router and the proto-2 resume filter read it; lib/transcriptRows.ts
// (snapshot classes) imports `KnownFrameType` as a TYPE only.
//
//   route 'low'      → every connection (cross-session badges, popups, list)
//   route 'focused'  → only the connection whose focus is the frame's sessionId
//   route 'internal' → no browser (in-process subscribers only): frames no
//                      client consumes (`ready`, `session_info`, `rate_limit`)
//   summary          → publishing it marks its session's `session_summary` dirty
//                      (`vps_status` marks every session of that VPS)
//
// ⚠ Classify EVERY new frame type here: the Record is tsc-exhaustive over
// `WorkerEvent['type'] | HubSyntheticType`, so a new union member fails the
// build until it has a route. An unknown type at runtime routes 'focused'
// (today's default: anything not low-volume is focus-filtered).
import type { WorkerEvent } from '@/lib/server/hub/types';

/** Bus frame types published outside the `WorkerEvent` union: other buses
 *  (installs, model notices), the explorer's file activity, and the sync
 *  refonte's new frames until their chunk adds them to `types.ts` (§3.2) —
 *  a type present in both is simply deduplicated by the union. */
export type HubSyntheticType =
  | 'file_activity'
  | 'model_notices'
  | 'install_started' | 'install_finished'
  | 'session_summary'
  | 'pending_snapshot'
  | 'transcript_reset'
  | 'session_resync'
  | 'assistant_flushed' | 'assistant_reopened';

export type KnownFrameType = WorkerEvent['type'] | HubSyntheticType;

export type FrameRoute = 'low' | 'focused' | 'internal';
export type FrameClass = { route: FrameRoute; summary: boolean };

const LOW: FrameClass = { route: 'low', summary: false };
const LOW_SUMMARY: FrameClass = { route: 'low', summary: true };
const FOCUSED: FrameClass = { route: 'focused', summary: false };
const FOCUSED_SUMMARY: FrameClass = { route: 'focused', summary: true };
const INTERNAL: FrameClass = { route: 'internal', summary: false };

export const FRAME_CLASS: Record<KnownFrameType, FrameClass> = {
  // ── LOW: cross-session facts every tab needs regardless of its focus ──────
  // Session lifecycle + the sidebar badges and the cross-session popups.
  status: LOW_SUMMARY,
  mode_changed: LOW_SUMMARY,
  // No browser reads it (status/summary carry the lifecycle): bus only.
  ready: INTERNAL,
  session_id: LOW_SUMMARY,
  permission_request: LOW_SUMMARY,
  user_question: LOW_SUMMARY,
  exit_plan_request: LOW_SUMMARY,
  interaction_resolved: LOW_SUMMARY,
  // The open view's async-question strip only (the summary is marked dirty
  // by the delivery itself).
  question_delivery: FOCUSED,
  error: LOW,
  // Rare-but-cross-tab: the same session open on desktop + phone — every tab's
  // header badge follows them.
  model_changed: LOW_SUMMARY,
  effort_changed: LOW_SUMMARY,
  effective_model: LOW,
  // Shell lifecycle (sessionId = shellId). Shells are never the SSE focus, so
  // every tab colours its shell tabs/dots (sessionOps.ts § emitGlobalShellStatus).
  shell_status: LOW,
  // Its "finished, unread" marker: every tab's header/sidebar (§14.47).
  shell_unread: LOW,
  // Live VPS agent status (sessionId = vpsId): every tab's sidebar badges.
  vps_status: LOW_SUMMARY,
  // "Finished, unread" flips: lights a BACKGROUND session's card the moment it
  // finishes (§14.47).
  session_unread: LOW_SUMMARY,
  // Running background-task count: shown on every session card (§14.91).
  session_bg_tasks: LOW_SUMMARY,
  // A cold registry's warm ACTIVE set (sessionOps § bgRegistryWarmed), sent
  // once after a window GET answered `backgroundTasksPending`. It can be
  // published BEFORE the view's focus POST lands (the GET goes first), and
  // nothing re-sends it: focus-routed, the opening view never got it. Tiny
  // and rare; the hook's subscribeSession filters by session id.
  bg_tasks_snapshot: LOW,
  // The session SET changed (created/imported/deleted/renamed): every tab and
  // device refetches the list (§14.52).
  session_list_changed: LOW_SUMMARY,
  // Workspace layout + settings: shared across devices (§14.78).
  tabs_changed: LOW,
  settings_changed: LOW,
  // Account gauges/profiles: ACCOUNT-scoped (§14.115). A hub account's reading
  // is ONE frame (sessionId `accounts`), a legacy one sessionId = vpsId.
  account_usage: LOW,
  account_profiles_changed: LOW,
  // Who touches which file (sessionId = vpsId): the point is seeing OTHER
  // sessions' activity (§14.88).
  file_activity: LOW,
  // What the running CLI can do: read hub-side (in memory) — no browser
  // consumes the frame.
  session_info: INTERNAL,
  // Typed turn failure (auth/billing): a logged-out session lights up
  // everywhere (§14.65/68).
  turn_error: LOW,
  // Rate-limit state: ACCOUNT-wide; the gauges reach browsers through
  // `account_usage` (§14.72), never this frame.
  rate_limit: INTERNAL,
  // Sync refonte additions: the cross-session summary (§14.108), the legacy
  // pending ids, model notices and the install bus.
  session_summary: LOW,
  pending_snapshot: LOW,
  model_notices: LOW,
  install_started: LOW,
  install_finished: LOW,

  // ── FOCUSED: the transcript of the session a connection is watching ──────
  assistant_text: FOCUSED,
  thinking: FOCUSED,
  thinking_flushed: FOCUSED,
  thinking_reopened: FOCUSED,
  assistant_flushed: FOCUSED,
  assistant_reopened: FOCUSED,
  structured_output: FOCUSED,
  generation_progress: FOCUSED,
  tool_use: FOCUSED,
  tool_result: FOCUSED,
  tool_progress: FOCUSED,
  edit_progress: FOCUSED,
  edit_snapshot: FOCUSED,
  plan_progress: FOCUSED,
  plan_update: FOCUSED,
  tool_activity: FOCUSED,
  prefill_input: FOCUSED,
  reconnecting: FOCUSED,
  bg_task: FOCUSED,
  bg_task_progress: FOCUSED,
  usage: FOCUSED,
  session_token_usage: FOCUSED,
  stop: FOCUSED_SUMMARY,
  compaction: FOCUSED,
  scheduled_fire: FOCUSED,
  external_message: FOCUSED,
  peer_message_status: FOCUSED,
  user_echo: FOCUSED,
  blocking_error: FOCUSED,
  scheduled_resume: FOCUSED,
  history_begin: FOCUSED,
  history_end: FOCUSED,
  transcript_reset: FOCUSED,
  // Ring stub only (never published live): it inherits the route of the
  // oversized frame it replaces (syncBus.ts § publish).
  session_resync: FOCUSED,
};

const CLASS_BY_TYPE: ReadonlyMap<string, FrameClass> = new Map(Object.entries(FRAME_CLASS));

/** Route of a frame type; an unclassified type is focus-filtered. */
export function routeOf(type: string): FrameRoute {
  return CLASS_BY_TYPE.get(type)?.route ?? 'focused';
}

/** Types whose publication marks the session summary dirty (§14.108). */
export const SUMMARY_TRIGGERS: ReadonlySet<string> = new Set(
  Object.entries(FRAME_CLASS).filter(([, c]) => c.summary).map(([t]) => t),
);

/** The per-connection filter (live router AND resume replay): a low frame
 *  reaches every connection, a focused one only the connection focused on
 *  its session, an internal one none. */
export function frameReaches(
  f: { route: FrameRoute; sessionId: string | null },
  focus: string | null,
): boolean {
  if (f.route === 'low') return true;
  return f.route === 'focused' && f.sessionId != null && f.sessionId === focus;
}
