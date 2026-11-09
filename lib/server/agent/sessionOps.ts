import { runtimeConnection, connectionConfig } from '@/lib/server/customEndpoints';
import { isModelParamSet } from '@/lib/modelParams';
import { sessionTokenUsage } from './sessionTokenUsage';
import { invalidateSessionRowCaches } from './sessionRowCache';
import type { SessionTokenUsage } from '@/lib/sessionTokenUsage';
import { adaptCursorEffortForVps } from '@/lib/server/hub/cursorModels';
import 'server-only';
import { accountProfileId } from '@/lib/accountProfiles';
import { cacheStateFromUsage, ledgerFromUsage, parsePromptCache, type TurnLedger } from '@/lib/promptCache';
import type { NotificationEvent } from '@/lib/notificationPreferences';
import crypto from 'node:crypto';
import { asyncQuestionReply } from '@/lib/asyncQuestions';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  db, agentSessions, sessionMessages,
  sessionPendingPermissions, sessionPendingQuestions, sessionLogs,
  vps as vpsTable,
} from '@/lib/db';
import type { PermissionMode } from '@/lib/server/hub/types';
import type { WorkerEvent, WorkerStatus, AccountUsage } from '@/lib/server/hub/types';
import { getAgentClientForVpsId } from './AgentClientPool';
import { handlePeerSpawnRequest } from '@/lib/server/hub/subSessions';
import type { AgentSessionInfo } from './types';
import { sendPushToAll } from '@/lib/server/hub/webPush';
import {
  sendPermissionToTelegram, sendQuestionToTelegram, markInteractionResolvedInTelegram,
  sendPlainToTelegram,
} from '@/lib/server/hub/telegram';
import { getSetting, getSettingBool, type SettingKey } from '@/lib/server/hub/settings';
import type { AgentEvent, EffortLevel, AgentKind, AnyEffort, SessionMode } from './types';
import type {
  ClaudeSessionConfig, CodexSessionConfig, CursorSessionConfig, ProviderSessionConfig,
} from '@/lib/types/api';
import { resolveSettingSources, safeParseSettingSources } from '@/lib/settingSources';
import { AgentRpcError } from './types';
import type { AgentClient, EventListener as AgentEventListener } from './AgentClient';
import { setVpsStatusEmitter } from './AgentClient';
import { hubHooks, type HubHooks } from './hubHooks';
import { isClaudeAuthExpired } from '@/lib/authExpired';
import {
  classifyTerminalClaudeError, type TerminalClaudeErrorKind,
} from '@/lib/terminalClaudeError';
import { classifySessionError, type SessionErrorPayload } from '@/lib/sessionError';
import { pickVpsRuntimeFields } from '@/lib/vpsRuntimeFields';
import { normalizeResetAtMs, resolveResetAtMs } from '@/lib/rateLimitReset';
import { purgeSessionBlobs } from '@/lib/server/hub/attachments';
import { noteSessionRuntime } from '@/lib/server/hub/sessionRuntimes';
import { dropTabsForRef } from '@/lib/server/hub/tabs';
import {
  clearSessionActivity, fileFromToolUse, noteActivity, type FileActivity,
} from '@/lib/server/hub/fileActivity';
import {
  compactToolInputForWire, compactToolResultForWire, deriveMessageStorage,
} from '@/lib/server/hub/messageWire';
import {
  bgTaskIdsBeforeEventFromDb, bgTaskRunningInDb, bgTasksHiddenFromStopHook, bgWorkCount, isBgTaskDone, pruneStaleBgTasks,
  runningBgTasksFromDb, runningBgTasksIfWarm, runningBgTaskDetailsIfWarm,
} from '@/lib/server/hub/bgTaskState';
import { withBgTaskLaunchers } from '@/lib/server/hub/conversationSources';
import { readScheduledTasks, recordScheduledTasks } from '@/lib/server/hub/scheduledTaskState';
import { dueScheduledTask, fireKey, matchFiredTask, type ScheduledTask } from '@/lib/scheduledTasks';
import { readCodexBgState } from '@/lib/server/hub/codexBgState';
import { codexTerminalProcessId, type BgTask } from '@/app/bgTasks';
import { allocateSessionHandle } from './sessionHandles';
import {
  assistantRowAtSeq, eventRowAtSeq, loadLegacyReplaySets, rowAtSeq, sessionHasLegacyToolRows,
  sessionHasStampedRows, type LegacyReplaySets,
} from './replayIdentity';
import {
  PersistedSpans, THINKING_ROW_MAX_CHARS, closesThinking, thinkingText,
} from './thinkingBoundaries';
import { timeSection } from '@/lib/server/perf/loopLag';
import {
  cancelBlockingGateRows, cancelPendingGateRow, deleteSessionGates, expireStalePendingInteractions,
  gateOutcome, type GateKind, type GateOutcome, type GateRef,
} from './pendingInteractions';
import { flushSummaryNow, markSummaryDirty, publish, subscribeFrames } from '@/lib/server/sync/syncBus';
import { markAsyncQuestionDelivering } from '@/lib/server/agent/asyncQuestionDelivery';
import { providerText, providerName } from '@/lib/providerText';
import {
  allowRulesOf, offeredSuggestions, parseSuggestions, type PermissionSuggestion,
} from '@/lib/permissionSuggestions';
import { sidebarOrderAfterDelete } from '@/app/sidebarPathGroups';
import {
  PROVIDERS, asSessionProvider, defaultSessionMode, isEffortValue, isSessionEffort, isSessionMode,
  providerBackendState, providerLabel as providerDisplayName, providerLoginPatch,
  providerSettingKey, supportsSessionCapability, unhandledProvider,
} from '@/lib/sessionCapabilities';

// How long after the last background task finishes before the session is
// declared done. Long enough for the model's automatic follow-up turn (§14.54)
// to claim the session, short enough to feel immediate. cf. §14.91.
const BG_FINISH_GRACE_MS = 5_000;

// Trailing window of the live `session_token_usage` broadcast: a burst of
// usage rows publishes ONE frame (clients merge by `revision`, so a skipped
// intermediate is never visible).
const TOKEN_USAGE_BROADCAST_MS = 300;

// Resolve the effective (model, fallback_model, effort) for a new session:
// per-session opts win, otherwise fall back to the global defaults in
// appSettings, otherwise null (= let the agent pass nothing → SDK default).
// Empty string in settings is treated as "unset" so an admin can erase a
// default from the SettingsModal without nuking the row.
//
// Kind-aware (multi-agent): a Codex session reads codex.default_model /
// codex.default_effort and has NO fallback-model concept; a Claude session
// keeps the existing claude.default_* keys. cf. CLAUDE.md §14.59.
function _resolveSessionConfig(
  kind: AgentKind,
  opts: {
    model?: string | null;
    fallbackModel?: string | null;
    effort?: string | null;
  },
): { model: string | null; fallbackModel: string | null; effort: string | null } {
  const pick = (perSession: string | null | undefined, settingKey: SettingKey): string | null => {
    if (perSession && perSession.length > 0) return perSession;
    const v = getSetting(settingKey);
    return v && v.length > 0 ? v : null;
  };
  // Provider-derived keys keep defaults exhaustive (§14.102).
  return {
    model: pick(opts.model, providerSettingKey(kind, 'default_model')),
    // Fallback settings exist only for providers declaring that capability.
    fallbackModel: supportsSessionCapability(kind, 'fallbackModel')
      ? pick(opts.fallbackModel, `${kind}.default_fallback_model` as SettingKey)
      : null,
    effort: pick(opts.effort, providerSettingKey(kind, 'default_effort')),
  };
}

/** Resolve the mode copied into a newly-created/imported session. Settings are
 * installation policy; the shared fallback remains safe for source checkouts
 * and for a corrupt/unknown stored value. */
export function resolveConfiguredSessionMode(kind: AgentKind): SessionMode {
  const configured = getSetting(providerSettingKey(kind, 'default_permission_mode'));
  return (isSessionMode(kind, configured)
    ? configured
    : defaultSessionMode(kind, 'create')) as SessionMode;
}

export function parseProviderConfig(value: string | null | undefined): ProviderSessionConfig | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ProviderSessionConfig : null;
  } catch {
    return null;
  }
}

/** What a permission card carries beyond the tool call itself. */
export type PermissionGateExtras = { reason?: string; suggestions?: PermissionSuggestion[] };

/** Sanitize the agent's optional card fields. Suggestions are forwarded in
 *  the agent's order (answers pick by index), capped, never re-shaped. */
export function permissionGateExtras(reason: unknown, suggestions: unknown): PermissionGateExtras {
  const out: PermissionGateExtras = {};
  if (typeof reason === 'string' && reason.trim()) out.reason = reason.trim().slice(0, 2000);
  if (Array.isArray(suggestions) && suggestions.length) {
    out.suggestions = suggestions.slice(0, 16) as PermissionSuggestion[];
  }
  return out;
}

/** Cap on a session's remembered "don't ask again" rules (newest kept). */
const MAX_REMEMBERED_RULES = 256;

/** The session's remembered rules (`agentSessions.alwaysAllowTools`): CLI
 *  rule strings, or bare tool names from before the CLI's own suggestions —
 *  the same spelling for "the whole tool". Garbage reads as none. */
export function rememberedRules(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === 'string' && r.trim() !== '').slice(-MAX_REMEMBERED_RULES)
      : [];
  } catch {
    return [];
  }
}

/** Claude's remembered rules ride every start/resume as `allowedTools` (the
 *  CLI's `--allowedTools`): its `session` rules die with the process and
 *  Charon loads `local` settings only on opt-in (§14.100). Codex grants are
 *  native and request-scoped; its historical rows must never be replayed. */
export function withRememberedRules<T extends object | null>(
  kind: AgentKind, config: T, raw: string | null | undefined,
): T | (NonNullable<T> & { allowedTools: string[] }) {
  if (!supportsSessionCapability(kind, 'permissionSuggestions')) return config;
  const rules = rememberedRules(raw);
  if (!rules.length) return config;
  return { ...(config ?? {}), allowedTools: rules } as NonNullable<T> & { allowedTools: string[] };
}

/** Resolve the safety reviewer once, when a Codex session is created.
 * Changing the fleet default must not silently alter existing sessions;
 * explicit API config still wins. The dashboard exposes this only in global
 * Settings, not as a noisy per-composer switch. */
function resolveCodexConfig(value: CodexSessionConfig | null | undefined): CodexSessionConfig {
  const configured = value?.approvalsReviewer;
  const reviewer = configured === 'auto_review' || configured === 'user'
    ? configured
    : getSetting('codex.default_approvals_reviewer') === 'auto_review'
      ? 'auto_review'
      : 'user';
  return { ...(value ?? {}), approvalsReviewer: reviewer };
}

/** Persist Cursor overrides without freezing values derived from the mode. */
function resolveCursorConfig(
  value: CursorSessionConfig | null | undefined,
): CursorSessionConfig {
  const { autoReview, settingSources, ...rest } = value ?? {};
  return {
    ...rest,
    ...(typeof autoReview === 'boolean' ? { autoReview } : {}),
    settingSources: settingSources ?? ['project', 'user'],
  };
}

/**
 * Fill in the Claude construction options a session inherits rather than
 * chooses (§14.100). Today that is only the settings scope, resolved OUTSIDE-IN
 * — session → VPS → hub → built-in ['project'] — and PERSISTED, for the same
 * reason model/effort are: a fleet default that changed retroactively would
 * rewrite the permission rules of sessions already running under the old one.
 */
function resolveClaudeConfig(
  value: ClaudeSessionConfig | null | undefined,
  vpsRow: { claudeSettingSources?: string | null } | null,
): ClaudeSessionConfig {
  return {
    ...(value ?? {}),
    settingSources: resolveSettingSources(
      value?.settingSources,
      safeParseSettingSources(vpsRow?.claudeSettingSources),
      safeParseSettingSources(getSetting('claude.setting_sources')),
    ),
  };
}

/** Resolve provider construction config exhaustively. */
function resolveProviderConfig(
  kind: AgentKind,
  requested: ProviderSessionConfig | null,
  vpsRow: { claudeSettingSources?: string | null } | null,
): ProviderSessionConfig | null {
  switch (kind) {
    case 'codex':
      return resolveCodexConfig(requested as CodexSessionConfig | null);
    case 'claude':
      return resolveClaudeConfig(requested as ClaudeSessionConfig | null, vpsRow);
    case 'cursor':
      return resolveCursorConfig(requested as CursorSessionConfig | null);
    default:
      return unhandledProvider(kind);
  }
}

export function isValidEffort(v: string | null | undefined): v is EffortLevel {
  return isSessionEffort('claude', v);
}
// Kind-aware effort validity. A Codex session's effort is validated against the
// Codex set (so 'ultra'/'none'/'minimal' aren't dropped); a Claude session uses
// the Claude set; a provider whose ladder is per model (Cursor) stores a
// parameter set, validated by SHAPE since no hub-side vocabulary exists.
// Invalid values are dropped (persisted as null → default).
function isValidEffortForKind(v: string | null | undefined, kind: AgentKind, customEndpoint = false): boolean {
  return isEffortValue(kind, v) || (customEndpoint && typeof v === 'string' && isModelParamSet(v));
}

const newId = () => crypto.randomBytes(8).toString('hex');

/** A coalesced reasoning row is dated by its FIRST delta (like the live
 *  bubble, and like a compacted legacy row), not by the boundary that closed
 *  it. Undefined without a ts: the column default (now). */
function thinkingCreatedAt(tsMs: number | null): number | undefined {
  return tsMs != null ? Math.floor(tsMs / 1000) : undefined;
}

/** The frame of a handler that persisted a row carries that row's id as
 *  `rowId` (sync refonte I15) — only when the write succeeded. Never
 *  `messageId`: that is a PEER message id on `external_message` and
 *  `peer_message_status`. */
function withRowId<T extends object>(frame: T, rowId: number | false | null | undefined): T & { rowId?: number } {
  return typeof rowId === 'number' ? { ...frame, rowId } : frame;
}

/** Bound of `SessionStream.recentClientMessages`. */
const RECENT_CLIENT_MESSAGES_MAX = 200;
// `SessionStream.liveToolOutput` bounds (the session GET's `streamingToolOutput`).
const LIVE_TOOL_OUTPUT_MAX = 64 * 1024;
const LIVE_TOOL_OUTPUT_TOOLS = 8;

// ── Per-session dispatcher pool ─────────────────────────────────────────────
// Each active session has a SessionStream (= a dispatcher between the agent
// and the SSE consumers). The SessionStream:
//   - Is created lazily on the 1st SSE subscribe or at boot (autoResume)
//   - Subscribes to the agent and persists all events in DB (msgs/permissions/etc.)
//   - Broadcasts to attached SSE sinks (live only — no replay on Charon
//     side, the DB is the source of truth, the client GETs on mount)
const g = globalThis as unknown as { _sessionStreams?: Map<string, SessionStream> };
if (!g._sessionStreams) g._sessionStreams = new Map();
const streams: Map<string, SessionStream> = g._sessionStreams;

// No per-session ring: the DB is the source of truth for persisted events.
// The ONE ring is the sync bus's (CLAUDE.md §14.14): bounded, once-encoded
// frames for SSE resume; a client that cannot resume refetches via GET.

// ── Global session-tagged event bus ────────────────────────────────────────
// ALL events broadcast by the SessionStreams pass through this bus, tagged
// with their sessionId. It is the sync bus (lib/server/sync/syncBus.ts,
// CLAUDE.md §14.14): `publish` stamps `id: <epoch>.<rev>`, encodes once, keeps
// a bounded ring and fans out — the multiplexed SSE `/api/events`
// routes each frame by connection focus (`eventConnections.ts`,
// `frameRouting.ts`). Persist then publish in the same synchronous tick.
export type GlobalSessionEvent = WorkerEvent & { sessionId: string };

/** In-process subscribers (tests, legacy consumers): session-tagged frames only. */
export function subscribeGlobalSessionEvents(cb: (ev: GlobalSessionEvent) => void): () => void {
  return subscribeFrames((f, ev) => {
    if (f.sessionId != null) cb(ev as unknown as GlobalSessionEvent);
  });
}

function emitGlobalSession(ev: GlobalSessionEvent): void {
  publish(ev as GlobalSessionEvent & Record<string, unknown>);
}

/**
 * Fan a persistent SHELL's live lifecycle status onto the global SSE bus so
 * every browser tab can color the shell's tab/dot — blue "thinking" while it
 * streams output (status='busy'), neutral when idle/at-prompt ('active'),
 * gray when bash ended ('exited'). `sessionId` is the shell id (shells are
 * 16-hex, sessions 32-hex → no collision in the shared bus keyspace).
 *
 * Source: the persistent AgentClient's output-free `shell_watch` → shellNotify.
 * Routed LOW (frameRouting.ts § FRAME_CLASS) so it reaches ALL connections
 * regardless of focus (shells are not the SSE's "focused session"). This is
 * intentionally NOT on the per-WS shell output path (that would re-egress
 * bytes; cf. §14 gotcha 41) — it's a tiny lifecycle ping.
 */
/** A shell's "finished, unread" marker flipped (shellNotify § markShell*). */
export function emitGlobalShellUnread(shellId: string, unread: boolean): void {
  emitGlobalSession({ type: 'shell_unread', unread, sessionId: shellId });
}

export function emitGlobalShellStatus(
  shellId: string, status: 'active' | 'busy' | 'exited', lastActivityMs?: number,
): void {
  emitGlobalSession({
    type: 'shell_status', status, sessionId: shellId,
    ...(lastActivityMs != null ? { lastActivityMs } : {}),
  });
}

/**
 * Live agentStatus push (sessionId = vpsId): the sidebar badge / action
 * buttons follow `vps.agentStatus` flips without waiting for the next SSR.
 * AgentClient owns the DB persists but cannot import this bus (import cycle
 * AgentClient ← AgentClientPool ← here), so it exposes an injection point —
 * wired once at module load. Same gating as the persist: transient SSH drops
 * never reach the browser (cf. ERROR_PERSIST_AFTER_ATTEMPTS in AgentClient).
 */
export function emitGlobalVpsStatus(
  vpsId: string,
  agentStatus: 'ok' | 'missing' | 'error',
  extra?: {
    agentVersion?: string | null; agentPyzSha?: string | null; sdkVersion?: string | null;
    agentLastError?: string | null; codexAvailable?: number | null; codexSdkVersion?: string | null; codexCliVersion?: string | null;
    codexLoggedIn?: number | null; claudeLoggedIn?: number | null;
    cursorAvailable?: number | null; cursorSdkVersion?: string | null;
    cursorLoggedIn?: number | null;
  },
): void {
  emitGlobalSession({
    type: 'vps_status',
    agentStatus,
    // Forward all declared runtime fields while preserving absent keys
    // (`undefined`) for the no-clobber contract (§14.52-53).
    ...pickVpsRuntimeFields(extra),
    sessionId: vpsId,
  });
}
setVpsStatusEmitter(emitGlobalVpsStatus);

// ── "Finished, unread" marker (CLAUDE.md §14.47) ────────────────────────────
// Every new finish lights it, watched or not: it stays lit while the session
// is on screen, and is read when an attended view LEAVES it or the user sends.

/**
 * Clear a session's durable "finished, unread" marker
 * (agentSessions.unreadStop → 0) and mirror it live to every tab via the
 * `session_unread` bus event. Called when an attended view leaves the session
 * (POST /api/focus, the window GET's focus move), on a user send and on a new
 * turn. Idempotent + cheap: only writes/emits when the row was actually
 * unread, so switching between already-read sessions never spams the bus.
 */
export function markSessionRead(sessionId: string): void {
  try {
    const res = db.update(agentSessions).set({ unreadStop: 0 })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.unreadStop, 1)))
      .run();
    if (((res as { changes?: number }).changes ?? 0) > 0) {
      emitGlobalSession({ type: 'session_unread', unread: false, sessionId });
    }
  } catch {}
}

/**
 * THE helper for a HUB-originated status write (C13; R1 §3 S1–S6/S9): DB
 * (unless `persist:false` — the caller already wrote it), the hydrated
 * stream's memory, and the `status` frame — so memory, DB and every tab never
 * diverge. Persist then publish (I1); the frame marks the session summary
 * dirty (§14.108). DB rules mirror the agent status case: `sleeping` clears
 * the sleep intent, `active`/`thinking` the post-update resume intent.
 */
export function setSessionStatusLocal(
  sessionId: string, status: WorkerStatus, o: { persist?: boolean } = {},
): void {
  if (o.persist !== false) {
    try {
      const upd: { status: string; sleepRequested?: number; resumePending?: number } =
        status === 'sleeping' ? { status, sleepRequested: 0 } : { status };
      if (status === 'active' || status === 'thinking') upd.resumePending = 0;
      db.update(agentSessions).set(upd).where(eq(agentSessions.id, sessionId)).run();
    } catch (e) {
      console.error(`[sessionOps] ${sessionId} local status '${status}' write failed:`, (e as Error)?.message ?? e);
    }
  }
  const stream = streams.get(sessionId);
  if (stream) stream.applyLocalStatus(status);
  else emitGlobalSession({ type: 'status', status, sessionId });
}

/**
 * Re-publish a VPS's runtime columns as stored (§14.52): for writers that
 * changed one of them without an emit (V1 codex login, V2 claude login
 * sweep, V6 profile login). Real `agentStatus`, every runtime key present.
 */
export function emitGlobalVpsRuntimeFromDb(vpsId: string): void {
  let row: typeof vpsTable.$inferSelect | undefined;
  try { row = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).get(); } catch { return; }
  if (!row) return;
  // `pickVpsRuntimeFields(row)` carries the stored agentStatus, which wins
  // over this positional argument.
  emitGlobalVpsStatus(vpsId, row.agentStatus as 'ok' | 'missing' | 'error', row);
}

/**
 * Announce that the SET of Claude sessions changed (created / imported /
 * deleted) so every connected browser refetches GET /api/sessions and
 * updates its sidebar + tab bar live — across tabs AND devices (a session
 * started on a phone shows up on the desktop without the 15s poll or an F5).
 * Charon-internal synthetic event, routed LOW (frameRouting.ts § FRAME_CLASS) so it
 * reaches every connection regardless of SSE focus. cf. CLAUDE.md §14.52.
 */
export function emitGlobalSessionListChanged(sessionId: string): void {
  emitGlobalSession({ type: 'session_list_changed', sessionId });
}

/** A rewind deleted a suffix of this session's rows: every view of it
 *  re-windows (focused frame; C13). */
export function emitGlobalTranscriptReset(sessionId: string, reason: 'rollback'): void {
  emitGlobalSession({ type: 'transcript_reset', reason, sessionId });
}

/**
 * Tell every connection the workspace layout moved (§14.78). Tabs are shared
 * across devices, so this is LOW_VOLUME and carries no payload — the client
 * refetches the (small) list rather than us trying to diff it over the wire.
 */
export function emitGlobalTabsChanged(): void {
  emitGlobalSession({ type: 'tabs_changed', sessionId: 'tabs' } as GlobalSessionEvent);
}

export function emitGlobalSettingsChanged(): void {
  emitGlobalSession({ type: 'settings_changed', sessionId: 'settings' });
}


/**
 * Fan "an agent is touching this file" onto the global bus (sessionId = vpsId).
 *
 * LOW_VOLUME because the explorer that renders it is frequently NOT the
 * focused session's — with several agents on one machine, seeing what the
 * others are doing is the entire point. §14.88
 */
export function emitGlobalFileActivity(a: FileActivity): void {
  emitGlobalSession({
    type: 'file_activity', sessionId: a.vpsId,
    path: a.path, kind: a.kind, activitySessionId: a.sessionId,
    sessionName: a.sessionName, at: a.at,
  } as unknown as GlobalSessionEvent);
}

/**
 * Fan a VPS's account-usage gauges onto the global bus (sessionId = vpsId).
 * Source: usagePoll.ts (the `get_usage` RPC poll). Routed LOW (frameRouting.ts
 * § FRAME_CLASS) so every tab's header widget updates regardless of SSE focus
 * (usage is account-global, not focus-scoped). cf. CLAUDE.md §14.58.
 */
export function emitGlobalAccountUsage(vpsId: string, usage: AccountUsage): void {
  emitGlobalSession({ type: 'account_usage', sessionId: vpsId, ...usage } as GlobalSessionEvent);
}

/** A hub account's reading (`scope:'account'`, accounts engine): ONE frame,
 *  whatever the number of VPSes — the browser keys it by account. §14.115. */
export function emitGlobalHubAccountUsage(usage: AccountUsage & { scope: 'account' }): void {
  emitGlobalSession({ type: 'account_usage', sessionId: 'accounts', ...usage } as GlobalSessionEvent);
}

export function emitGlobalAccountProfiles(vpsId: string): void {
  emitGlobalSession({ type: 'account_profiles_changed', sessionId: vpsId });
}

// Post-stop usage-refresh trigger, injected by usagePoll.ts at its import time
// (one-directional to dodge the import cycle: this module owns the bus + the
// `stop` handler; usagePoll owns the poll). Unset until usagePoll is loaded
// (autoConnect imports it at boot) → the `stop` handler no-ops safely. §14.58.
// Every slot below lives in `hubHooks()`, shared by all module copies (§14.106).
export function setUsagePollTrigger(fn: NonNullable<HubHooks['usagePollTrigger']>): void {
  hubHooks().usagePollTrigger = fn;
}

// Parallel trigger for the Codex account-usage poll (a Codex session's `stop`
// moved the Codex quota, not the Claude one). Same injection pattern; wired by
// usagePoll.ts. Unset until loaded → the `stop` handler no-ops safely. §14.58.
export function setCodexUsagePollTrigger(fn: NonNullable<HubHooks['codexUsagePollTrigger']>): void {
  hubHooks().codexUsagePollTrigger = fn;
}

// App-server also PUSHES AccountRateLimitsUpdated on the global SDK FIFO.
// usagePoll owns normalization/cache state, while this module owns agent-event
// dispatch, so inject the consumer just like the post-stop poll trigger above.
export function setCodexUsagePushHandler(fn: NonNullable<HubHooks['codexUsagePushHandler']>): void {
  hubHooks().codexUsagePushHandler = fn;
}

// A Claude `rate_limit` event's live 5h/7d windows (agent >= 0.98.0) feed the
// same account gauges the poll does. Same injection pattern. §14.72.
export function setUsageWindowsHandler(fn: NonNullable<HubHooks['usageWindowsHandler']>): void {
  hubHooks().usageWindowsHandler = fn;
}

export function setUsageResetResolver(fn: NonNullable<HubHooks['usageResetResolver']>): void {
  hubHooks().usageResetResolver = fn;
}

function resetFromCodexLimits(detail: unknown): number | null {
  const exhausted: number[] = [];
  const future: number[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const reset = normalizeResetAtMs(item.resets_at ?? item.resetsAt);
    if (reset && reset > Date.now() - 60_000) {
      const used = Number(item.used_percent ?? item.usedPercent ?? NaN);
      (Number.isFinite(used) && used >= 100 ? exhausted : future).push(reset);
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(detail);
  // If multiple windows are exhausted, the account remains blocked until the
  // last of them resets. Without utilization evidence, use the next reset.
  return exhausted.length ? Math.max(...exhausted) : future.length ? Math.min(...future) : null;
}

/** How long a PATCH-cwd kill waits for its `killed` echo (a held one arrives
 *  after the subscribe replay that held it). */
const KILLED_ECHO_GRACE_MS = 5 * 60_000;

// ONE in-flight lazy import of endpointOps (it imports this module back): two
// concurrent first `import()`s of a cyclic module can hand the second caller a
// partly evaluated copy under vite-node (TDZ on its `inflight`). A failed load
// is retried by the next caller.
let endpointOpsLoad: Promise<typeof import('./endpointOps')> | null = null;
function loadEndpointOps(): Promise<typeof import('./endpointOps')> {
  if (!endpointOpsLoad) {
    endpointOpsLoad = import('./endpointOps');
    endpointOpsLoad.catch(() => { endpointOpsLoad = null; });
  }
  return endpointOpsLoad;
}

export class SessionStream {
  readonly id: string;
  readonly vpsId: string;
  readonly accountProfile: string;
  // Agent-type discriminator: 'claude' (default) | 'codex'. Determines config
  // resolution (which default_* keys), effort validity, sandbox-mode semantics
  // and which start_session kind the agent gets. Persisted in agentSessions.kind.
  readonly kind: AgentKind = 'claude';
  status: WorkerStatus = 'starting';
  // The provider is summarising the conversation (agent `compacting`). Memory
  // only, like `status`: the window GET's `liveCompacting`. Never outlives
  // the turn (`_setCompacting`).
  compacting = false;
  // For a Codex session this holds a sandbox mode ('read-only' |
  // 'workspace-write' | 'accept-all'); for Claude a permission mode. Typed as
  // the Claude subset for the existing broadcast plumbing (BridgeEvent is
  // locked to PermissionMode) — codex values pass through at runtime.
  permissionMode: PermissionMode = 'normal';
  nativeSessionId: string | null = null;
  name: string | null = null;
  // Read at use: a stream outlives a rename of its VPS.
  get vpsName(): string { return _vpsName(this.vpsId); }
  cwd: string | null = null;
  // Set by PATCH cwd right before its `kill_session`: the status case turns
  // ONE following `killed` echo into `sleeping` (S7, C13). NOT cleared when the
  // RPC settles: during a subscribe replay the agent HOLDS the session's live
  // events (the echo) while the answer, which carries no session id, overtakes
  // them. Cleared by the echo, by a live `starting` (a new instance: anything
  // held was delivered before it, in order) or past KILLED_ECHO_GRACE_MS.
  expectKilledEcho = false;
  private expectKilledEchoUntil = 0;
  armKilledEcho(now = Date.now()): void {
    this.expectKilledEcho = true;
    this.expectKilledEchoUntil = now + KILLED_ECHO_GRACE_MS;
  }
  // Per-session model / fallback / effort. NULL = fall back to the global
  // default (claude.default_* or codex.default_*) → agent/SDK default. Source
  // of truth is the DB column; SessionStream caches it in memory for fast access
  // and because resume needs to read it before any DB roundtrip. `effort` is the
  // AnyEffort superset (Claude or Codex level, per `kind`). `fallbackModel` is
  // unused for Codex.
  model: string | null = null;
  fallbackModel: string | null = null;
  effort: AnyEffort | null = null;
  customEndpoint = false;
  // The model Anthropic actually used on the last AssistantMessage. Captured
  // from the `effective_model` event (agent >= 0.6.0), persisted in
  // agent_sessions.effective_model (the agent only re-emits on CHANGE, so a
  // Charon restart would otherwise lose it until the next model switch) and
  // hydrated back in getOrCreateStream. Stamped onto every flushed assistant
  // message row (session_messages.model) so each bubble can display
  // the true speaking model. Distinct from the configured `model` above:
  // aliases resolve, fallback_model can kick in, SDK may pick a default.
  effectiveModel: string | null = null;

  /**
   * What the CLI said about itself in its init frame (agent >= 0.36.0).
   *
   * In memory only, on purpose: it describes the CURRENTLY RUNNING CLI
   * process, so a persisted copy would outlive the thing it describes and
   * claim capabilities the restarted process may not have. Null until the
   * first init frame of the current process — treat absence as "unknown",
   * never as "unsupported".
   */
  sessionInfo: {
    capabilities?: string[]; slashCommands?: string[]; tools?: string[];
    plugins?: string[]; modelEfforts?: Record<string, string[]>;
    models?: Array<{
      id: string; resolved?: string; label?: string; hint?: string;
      efforts?: string[]; supports_effort?: boolean;
      supports_adaptive_thinking?: boolean;
    }>;
  } | null = null;

  private currentAssistant = '';
  // Agent deltas may arrive one token at a time. Forwarding each one through
  // the global bus/SSE made Node serialize tens of events per second and made
  // every browser wake up just as often. Keep the live feel while coalescing
  // adjacent text for one short frame-sized interval, in ONE lane at a time:
  // assistant text, or a delta provider's reasoning (Claude's complete
  // thinking blocks never coalesce — two in one frame would merge bubbles).
  // A lane switch, a replay-flag switch and any other broadcast flush first,
  // so tool/status ordering stays exact.
  private pendingBroadcast: { lane: 'assistant' | 'thinking'; text: string; replay: boolean } | null = null;
  private liveBroadcastTimer: NodeJS.Timeout | null = null;
  // ── Delta-provider reasoning (CLAUDE.md §14.17/§14.31) ─────────────────
  // Codex/Cursor stream reasoning one token per `thinking` event. They are
  // coalesced into ONE `event` row per block, stamped with the FIRST delta's
  // seq and ts, and closed by every non-transparent event
  // (thinkingBoundaries.ts) BEFORE its identity gate. No other row is
  // persisted while a block is open (I8: `_persist` and `persistExternal`
  // flush it first). Claude (complete blocks) and seq-less agents keep one
  // row per event.
  private readonly coalesceThinking: boolean;
  private currentThinking = '';
  private pendingThinkingSince: number | null = null;
  private pendingThinkingTsMs: number | null = null;
  // Last seq in the open block: a replayed delta at or below it is already in
  // it (double replay). Replay windows only, like pendingAssistantLastSeq.
  private pendingThinkingLastSeq: number | null = null;
  // …and its ts: the block's persisted span is ts-bounded (`deltaSpans`).
  private pendingThinkingLastTsMs: number | null = null;
  // The block was opened inside a replay window: its flush looks for a row
  // at its first seq (a sealed retry may have written it meanwhile).
  private pendingThinkingFromReplay = false;
  // Blocks whose row insert FAILED ("sealed"). Never blocks the boundary
  // (rows sort by first-delta ts_ms, §14.71); retried oldest first before
  // the next block opens / a replay lookup / inside the next flush. Each
  // holds the durable cursor back until it persists. Past 50 entries the
  // OLDEST is dropped from memory and KEEPS its holdback: the persisted
  // cursor stays below it, so the next restart replays and rebuilds it once
  // (identity dedupes the rest). It is never re-delivered live: a DB failing
  // that long would fail that write too.
  private thinkingRetry: Array<{
    text: string; since: number; tsMs: number | null; lastSeq?: number | null; lastTsMs?: number | null;
  }> = [];
  // Inside a replay: the not-yet-replayed rest of a persisted coalesced row.
  // Replayed deltas consume it positionally (prefix cover, seqs moving
  // forward from `replayThinkingCoverSeq`, the last replayed event it was
  // carried through); reset at every boundary, and at a `replay_begin`
  // that does not resume right after that seq. Never free-text matching.
  private replayThinkingCover: string | null = null;
  private replayThinkingCoverSeq: number | null = null;
  // The covered row's anchor (seq, ts): consuming the cover through seq Q
  // records the span [anchor, Q] as persisted (`deltaSpans`).
  private replayThinkingCoverSince: number | null = null;
  private replayThinkingCoverTsMs: number | null = null;
  // Coalesced rows (reasoning blocks, assistant flush rows) this process
  // persisted or proved persisted: seq spans [first delta, last delta]. A
  // replay window starting INSIDE one (an overlapping resubscribe: its cursor
  // was taken while the row still streamed) re-delivers deltas with no row of
  // their own and no cover — the span drops them (G2). Both lanes share it:
  // each delta belongs to one row. Bounded (thinkingBoundaries.ts).
  private deltaSpans = new PersistedSpans();
  private agentListener: AgentEventListener | null = null;
  private attached = false;
  // The AgentClient instance this stream is currently subscribed to. The pool
  // RECREATES the client (a fresh instance with an EMPTY subscribers map) on
  // agent update/refresh/creds-change (dropAgentClient → getAgentClient). A
  // plain `attached` boolean can't distinguish a live registration from one
  // stranded on the dead old client — so we ALSO pin the client identity and
  // re-subscribe whenever it changes. Without this, every running session on a
  // VPS goes silent after an agent update: the agent processes turns but its
  // events are dropped by the new client (no subscriber), the UI freezes and
  // the DB status sticks. cf. CLAUDE.md §14.51.
  private attachedClient: AgentClient | null = null;
  // True while we're processing events replayed by the agent (between
  // replay_begin and replay_end). During this window, we dedupe each event
  // against the DB to avoid re-persisting content already known. The goal:
  // after a Charon restart (where the VPS agent kept streaming events we
  // didn't see), pick up ONLY the missing events without duplicating what's
  // already in the DB.
  private isReplaying = false;
  // Content fallback for seq-less events / seq-NULL rows (replayIdentity.ts),
  // loaded LAZILY by `_legacy()` on the first event that needs it, dropped at
  // replay_begin/replay_end. Stamped events need it only for tool ids, and
  // only when the session has seq-NULL tool rows (`legacyToolRows`, asked
  // once per window).
  private legacyReplay: LegacyReplaySets | null = null;
  private legacyToolRows: boolean | null = null;
  // Pending interaction ids (tiny tables), loaded at replay_begin.
  private replayKnownPendingIds: Set<string> = new Set();
  // First and last seq the current replay window dispatched (reset at
  // replay_begin). A window cut by a disconnect (AgentClient's synthetic
  // `replay_end`) while it re-delivered events OLDER than the frontier (an
  // overlapping resubscribe) is resumed where it stopped: `replayCutSeq` is
  // then the reconnect cursor (`_onReplayWindowCut`), and its open
  // buffer/block continues instead of absorbing the frontier's deltas.
  // Cleared once a window passes the frontier (`_trackSeq`) or ends for real.
  private replayWindowFirstSeq: number | null = null;
  private replayWindowLastSeq: number | null = null;
  private replayCutSeq: number | null = null;
  // A seq-epoch reset asked the new log's replay from 0 and it has not run to
  // a real `replay_end` yet: the reconnect cursor and the durable one stay
  // PINNED at 0. Live new-epoch events (released behind the reset's answer
  // while the replay waits its turn in the reconnect chain) must not move
  // them past 1..current_seq, or that range is never asked for (G2).
  private epochReplayPinned = false;
  // The fatal `error` whose blocking-error row failed to persist: the stop's
  // fallback row takes ITS seq/ts, so a replay of that error finds it.
  private pendingBlockingErrorAt: { seq: number; tsMs: number | null } | null = null;
  // Identity answer for the seq of the event being dispatched. Memoises the
  // repeated lookups of ONE dispatch only (reset at the top of every
  // _onAgentEvent and at replay_begin/end): kept across dispatches, it would
  // call a row inserted by the first of two identical replays a miss on the
  // second (§14.31).
  private replayIdentityMemo: { seq: number; hit: boolean } | null = null;

  // Durable event-log checkpoint (agent >= 0.4.0). `lastSeenSeq` is the
  // highest seq we've successfully observed; `lastPersistedSeq` is what
  // we've written back to the DB. We keep them split so we can throttle
  // the DB write without losing the in-memory state. Persist happens:
  //   - On landmark events (`status`, `stop`) — small in count, capture
  //     turn boundaries that matter for recovery.
  //   - On a 2s debounce timer for high-frequency events (assistant_text
  //     deltas, etc.) — a Charon crash within 2s of the last event
  //     would replay at most 2s of work via durable replay, which the
  //     existing replay-dedup absorbs.
  private lastSeenSeq: number | null = null;
  private lastPersistedSeq: number | null = null;
  private persistSeqTimer: NodeJS.Timeout | null = null;
  // Highest `stop` seq we've already pushed a "finished" notification for.
  // Replayed stops (Charon reboot / SSH reconnect) carry seq <= this →
  // skipped. Persisted to DB so the dedup survives a Charon restart.
  private lastStopNotifiedSeq: number | null = null;
  // Set by a seq-epoch reset: the newest row ts_ms at that moment. A REPLAYED
  // stop at or before it is no new finish (the recreated log's seqs restart
  // below `lastStopNotifiedSeq`'s old epoch). Cleared when the reset replay
  // ends. Not a column: a stream loaded with a durable cursor of 0 (the reset
  // persists 0 and pins it there until its replay ends) rebuilds it from the
  // rows (`stopFloorFromLoad`), so a hub restart mid-replay does not re-mark
  // handled finishes unread.
  private stopNotifyFloorTsMs: number | null = null;
  private stopFloorFromLoad = false;
  /** "Applies at next start" for model/effort, as this hub saw it (null =
   *  unknown since boot). Set by `*_changed`, cleared by a live `starting`;
   *  the window GET serves the known ones, so a view whose SSE missed the
   *  `starting` frame (a resync gap) drops a stale "apply now" badge. */
  readonly pendingApply: { model: boolean | null; effort: boolean | null } = { model: null, effort: null };

  // ── Replay exactness (P0.2/P0.3) ──────────────────────────────────────
  // `currentEventSeq`: seq of the event being dispatched RIGHT NOW (null
  // outside dispatch). Stamped onto every message row _persist writes —
  // the per-row identity that replaces content-based dedup.
  private currentEventSeq: number | null = null;
  // `currentEventTs`: WHEN the event being dispatched happened, unix ms (the
  // agent's `ts`, emitted next to `seq`). Stamped onto every row _persist
  // writes and used as THE chronological sort key (§14.71) — `seq` cannot be
  // one, it restarts at 1 whenever the agent's event log is recreated.
  private currentEventTs: number | null = null;
  // Scheduled-task fires already named by a `scheduled_fire` row (`fireKey`).
  private firedScheduledTasks = new Set<string>();
  // First seq of the still-unflushed assistant accumulation. The DURABLE
  // cursor is held back to (pendingAssistantSince - 1): after a hard crash
  // the whole unflushed text is re-delivered and rebuilt instead of losing
  // the first seconds of a turn (the old cursor advanced past deltas whose
  // text only lived in this process's memory).
  private pendingAssistantSince: number | null = null;
  // …and the ts of that same first delta. A flush row must be dated when the
  // assistant STARTED speaking, not when the boundary event closed the
  // buffer, or a long turn's text sorts after the tools it preceded.
  private pendingAssistantTsMs: number | null = null;
  // The CLI transcript's uuid for the message being accumulated (agent >=
  // 0.39.0). Stamped on the flush row so "fork from here" can name the exact
  // transcript entry to branch at — the SDK identifies it by ITS uuid, not by
  // anything Charon assigns. First delta wins, like the seq and ts above.
  private pendingAssistantUuid: string | null = null;
  // Seq of the LAST delta in the buffer. Inside a replay window a delta at or
  // below it is already in the buffer (the same range replayed twice: attach +
  // resubscribe) and is dropped. Never a live guard: one AgentClient never
  // re-sends a live delta, and a recreated log restarts seq at 1 (§14.71).
  private pendingAssistantLastSeq: number | null = null;
  // …and its ts: the flush row's span ends at the buffer's last delta, not at
  // the boundary that flushes it (an older replayed boundary can flush a kept
  // buffer whose deltas are newer than itself).
  private pendingAssistantLastTsMs: number | null = null;
  // The buffer was opened inside a replay window. Its flush then goes through
  // identity even when the closing boundary arrives LIVE: the replayed deltas
  // may extend a row persisted before the hub went down (SIGTERM partial).
  private pendingAssistantFromReplay = false;
  // The row a replayed buffer was KEPT for at a boundary (it was longer: the
  // live flush failed there and the buffer ran on). The buffer runs on only
  // while it still spells that row (`case 'assistant_text'`).
  private pendingAssistantRowGuide: string | null = null;
  // The buffer length at which the guide relation was last VERIFIED (-1 =
  // unknown): the next delta then compares only ITSELF against the guide,
  // never the whole buffer (a long replayed answer was O(n²), G1).
  private pendingAssistantGuideLen = -1;
  // A replayed buffer whose FIRST delta found a persisted assistant row at its
  // own seq (a SIGTERM partial, `flushPendingAssistant`): the browser already
  // renders `prefix`. Deltas inside it are not re-broadcast; the first one
  // past it announces `assistant_reopened` and sends only the remainder
  // (`case 'assistant_text'`). Reset with the buffer, kept with a kept buffer.
  // `matched`: the buffer length known to spell `prefix` so far (-1 =
  // unknown): each delta is compared alone at that offset (G1, no O(n²)).
  private assistantReopen: { rowId: number; prefix: string; announced: boolean; matched: number } | null = null;
  // Browser `clientMessageId` → the user row it created (insertion order,
  // ≤ RECENT_CLIENT_MESSAGES_MAX): a retried POST re-sends `send_input` only
  // (the agent dedups the id) — never a second row or echo.
  private recentClientMessages = new Map<string, number>();
  // Live command/MCP output of RUNNING tools (`tool_progress`, sync refonte
  // I6 `covered`): the session GET returns it as `streamingToolOutput`, so a
  // refetch mid-command keeps what was printed so far. Tail-bounded
  // (LIVE_TOOL_OUTPUT_MAX chars per tool, ≤ LIVE_TOOL_OUTPUT_TOOLS tools,
  // least-recently-updated evicted); the tool's `tool_result` (the durable
  // aggregate), `stop`, `detach` and a non-live status clear it.
  private liveToolOutput = new Map<string, { text: string; truncated: boolean }>();
  // Some Claude CLI failures are delivered as a synthetic assistant bubble
  // followed by a perfectly ordinary stop→active sequence. Remember the
  // classified final bubble until `stop`, then latch the session in `failed`;
  // while latched, the agent's idle `active` frame must not overwrite it.
  private pendingTerminalAssistantError: { text: string; kind: TerminalClaudeErrorKind } | null = null;
  // Raw SDK/provider error held until `stop` tells us whether it actually
  // blocked the turn. Non-blocking diagnostics keep their live banner only;
  // a failed stop promotes this into one durable role='error' chat row.
  private fatalErrorNotified = false;
  private pendingAgentError: { msg: string; fatal: boolean } | null = null;
  private pendingTurnErrorKind: string | null = null;
  // The turn's prompt-cache ledger (lib/promptCache.ts), held from its
  // `usage final:true` until `stop` names the final assistant row it lands
  // on; or that row, held a few seconds for a usage arriving after `stop`.
  private pendingTurnLedger: TurnLedger | null = null;
  private awaitingTurnLedger: { rowId: number; at: number } | null = null;
  // Tool calls of the current turn (`_turnToolCount`), re-counted from the
  // rows at each tool_use; null = not counted yet this turn (reset at stop).
  private turnTools: number | null = null;
  private pendingBlockingErrorRecorded = false;
  // Evidence that the current/replayed turn actually carried assistant output.
  // Needed to clear an older `failed` latch on a later successful replay
  // without treating an isolated duplicate stop as a recovery.
  private pendingTurnAssistantSeen = false;
  private terminalErrorLatched = false;
  private terminalErrorText: string | null = null;
  private terminalErrorKind: SessionErrorPayload['kind'] | null = null;
  // Latest structured quota reset seen on this provider stream. Always UTC
  // epoch ms; never a server-local/browser-local wall clock.
  private latestLimitResetAtMs: number | null = null;
  // Failed persists, PER SOURCE (key → first seq whose effect is missing).
  // Each holds the durable cursor back to (seq - 1) so the next restart
  // replays it and the row gets a second chance — identity makes the
  // re-delivery of everything else idempotent. `assistant:<since>` /
  // `thinking:<since>` are DELETED when that buffer/sealed block persists
  // later in this process (the cursor advances again); a block the retry
  // cap dropped from memory keeps its key until a replay rebuilds it (the
  // restart's, in practice). ONE `event` key holds the lowest of the pins
  // never released in-process (a boundary's own row, a pending insert, an
  // event DROPPED because the assistant flush before it failed): only its
  // minimum matters, so the map stays bounded by the releasable sources.
  private holdbacks = new Map<string, number>();
  // (Replay identity — "is there a row stamped with this event's seq?" — is
  // an indexed lookup per event, replayIdentity.ts. Never MAX(seq): a failed
  // persist at N followed by a successful N+1 must still be repaired.)
  // Background tasks still running (taskId → startedAt), lazily rebuilt from
  // the persisted bg_task rows and then maintained live. `null` = not loaded
  // yet. This is what makes a session `background` instead of green-and-done
  // (§14.91), so it must survive a hub restart — hence derived from the rows,
  // not from the events this process happened to witness.
  private bgRunning: Map<string, number> | null = null;
  // Last `session_bg_tasks` count sent, so the sidebar hears only CHANGES.
  private bgRunningAnnounced: number | null = null;
  // Pending "the background work is now really finished" notification. Delayed,
  // because a finishing task usually re-invokes the model (§14.54) — firing
  // "done" a beat before a new turn starts would be a lie.
  private bgFinishTimer: ReturnType<typeof setTimeout> | null = null;
  private peerDrivenFinish: boolean | null = null;
  private codexBgChecks = new Map<string, { revision: number; since: number }>();
  private codexBgTimer: ReturnType<typeof setTimeout> | null = null;
  private codexBgChecking = false;
  // attach() found the bg registry cold: seed the checks once it is warm.
  private codexBgSeedPending = false;
  // Debounced `session_token_usage` (sessionTokenUsage.ts is an incremental
  // fold): usage rows persisted during a replay only mark it dirty (ONE frame
  // at replay_end, synthetic ones included); live ones arm one trailing timer.
  private tokenUsageDirty = false;
  private tokenUsageTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    id: string; vpsId: string; name: string | null;
    status: WorkerStatus; permissionMode: SessionMode;
    nativeSessionId: string | null;
    kind?: AgentKind;
    accountProfile?: string;
    cwd?: string | null;
    lastSeenSeq?: number | null;
    lastStopNotifiedSeq?: number | null;
    model?: string | null;
    fallbackModel?: string | null;
    effort?: string | null;
    effectiveModel?: string | null;
    customEndpoint?: boolean;
  }) {
    this.id = opts.id;
    this.vpsId = opts.vpsId;
    this.name = opts.name;
    this.cwd = opts.cwd ?? null;
    this.kind = opts.kind ?? 'claude';
    this.accountProfile = opts.accountProfile ?? 'default';
    this.status = opts.status;
    this.permissionMode = opts.permissionMode as PermissionMode;
    this.nativeSessionId = opts.nativeSessionId;
    this.lastSeenSeq = opts.lastSeenSeq ?? null;
    this.lastPersistedSeq = this.lastSeenSeq;
    this.lastStopNotifiedSeq = opts.lastStopNotifiedSeq ?? null;
    if (opts.lastSeenSeq === 0) {
      const maxTs = this._maxRowTsMs();
      if (maxTs != null) { this.stopNotifyFloorTsMs = maxTs; this.stopFloorFromLoad = true; }
    }
    this.model = opts.model ?? null;
    this.fallbackModel = opts.fallbackModel ?? null;
    this.customEndpoint = !!opts.customEndpoint;
    this.effort = isValidEffortForKind(opts.effort, this.kind, this.customEndpoint) ? (opts.effort as AnyEffort) : null;
    this.effectiveModel = opts.effectiveModel ?? null;
    // Delta providers' reasoning coalesces hub-side (one row per block).
    this.coalesceThinking = PROVIDERS[this.kind]?.thinkingDelivery === 'delta';
    // Preserve a durable failed-turn marker across a Charon reconnect. The
    // daemon is still idle/active; only a new turn or explicit lifecycle
    // recovery clears this display state.
    this.terminalErrorLatched = opts.status === 'failed';
  }

  /** Wires the listener to the agent (idempotent).
   *  Passes `afterSeq` to the agent so it can replay missed events from
   *  its durable log (agent >= 0.4.0). For older agents this is a no-op:
   *  the client falls back to ring replay.
   *  Returns TRUE iff it subscribed in this call: a caller that would force a
   *  second subscribe (resumeSession) must not, or the agent replays the
   *  same range twice (§14.31). */
  attach(): boolean {
    const client = getAgentClientForVpsId(this.vpsId);
    // Already correctly subscribed to the CURRENT client → nothing to do.
    if (this.attached && this.attachedClient === client) return false;
    // Either never attached, or attached to a now-dead client (the pool
    // recreated it on agent update/refresh — its subscribers map is empty and
    // our old listener went down with it). (Re)subscribe to the live client.
    // Reuse the SAME listener reference so re-subscribing to the same client is
    // deduped by the AgentClient's Set; a fresh closure would double-fire.
    // cf. CLAUDE.md §14.51.
    if (!this.agentListener) this.agentListener = (ev) => this._onAgentEvent(ev);
    this.attached = true;
    this.attachedClient = client;
    // A window the previous client's close cut resumes where it stopped.
    const afterSeq = this.replayCutSeq ?? (this.epochReplayPinned ? 0 : this.lastSeenSeq);
    client.subscribe(this.id, this.agentListener,
      afterSeq != null ? { afterSeq } : undefined,
    );
    if (this.kind === 'codex') this._seedCodexBgChecks();
    return true;
  }

  /** A codex stream reconciles the sub-agent/collab tasks its persisted
   *  registry still calls running. A cold registry (first read, or evicted)
   *  is not folded here, inside the (re)connect handler: it warms in slices
   *  and `bgRegistryWarmed` seeds the checks once complete. */
  private _seedCodexBgChecks(): void {
    const tasks = runningBgTaskDetailsIfWarm(this.id);
    this.codexBgSeedPending = tasks == null;
    if (tasks == null) return;
    for (const task of tasks) {
      if (task.taskType === 'codex_subagent' || task.taskType === 'codex_collab') {
        this.codexBgChecks.set(task.taskId, { revision: 0, since: task.startedAt });
      }
    }
    this._scheduleCodexBgCheck();
  }

  /** bgTaskState: this session's cold bg registry finished warming. */
  onBgRegistryWarm(): void {
    if (this.codexBgSeedPending && this.attached) this._seedCodexBgChecks();
  }

  /** Advance the durable-replay cursor. Called from _onAgentEvent
   *  AFTER the event has been processed (persisted in DB), so we never
   *  advance past an event we haven't actually saved. */
  private _trackSeq(ev: AgentEvent): void {
    const seq = (ev as { seq?: unknown }).seq;
    if (typeof seq !== 'number') return; // old agent or replay marker
    if (this.lastSeenSeq != null && seq <= this.lastSeenSeq) return;
    this.lastSeenSeq = seq;
    // Past the frontier: whatever a cut window left was dispatched before.
    this.replayCutSeq = null;
    // A pending reset replay keeps the client's cursor at 0 (see the field).
    if (this.epochReplayPinned) return;
    // Notify the AgentClient so a future reconnect uses the new cursor. The
    // RAW frontier, never `_durableCursor()`: its `event` pins are never
    // released in-process, so every reconnect would replay an ever-growing
    // range until it overflows the agent's send queue and loops (the restart
    // cursor alone is held back).
    try {
      getAgentClientForVpsId(this.vpsId).setAfterSeq(this.id, this.lastSeenSeq);
    } catch {}
    // Decide when to write to DB. Landmark events flush immediately;
    // high-frequency events debounce.
    const landmark = ev.event === 'status' || ev.event === 'stop';
    if (landmark) {
      this._persistSeqNow();
    } else if (!this.persistSeqTimer) {
      this.persistSeqTimer = setTimeout(() => this._persistSeqNow(), 2000);
    }
  }

  private _persistSeqNow(): void {
    if (this.persistSeqTimer) {
      clearTimeout(this.persistSeqTimer);
      this.persistSeqTimer = null;
    }
    // After the shutdown flush the cursor stays where it was: the restart
    // resumes at the flushed rows' anchors and covers/extends them (§14.31).
    if (globalThis.__charon_shuttingDown) return;
    // Persist the HELD-BACK cursor, not the raw lastSeenSeq: everything
    // beyond _durableCursor() has effects (unflushed assistant text, a
    // failed row insert) that only live in this process's memory — a crash
    // must replay those events, and the seq-gate absorbs the overlap.
    const cursor = this._durableCursor();
    if (cursor == null) return;
    if (cursor === this.lastPersistedSeq) return;
    try {
      db.update(agentSessions)
        .set({ lastSeenSeq: cursor })
        .where(eq(agentSessions.id, this.id))
        .run();
      this.lastPersistedSeq = cursor;
    } catch {
      // Best-effort: next event triggers another attempt. Worst case
      // we replay a few extra events on next reconnect (idempotent
      // via the seq-gate / replay-dedup path).
    }
  }

  /** Detach the listener (used on permanent kill). */
  detach(): void {
    this._clearCodexBgChecks();
    if (this.tokenUsageTimer) { clearTimeout(this.tokenUsageTimer); this.tokenUsageTimer = null; }
    if (!this.attached) return;
    this.attached = false;
    try {
      // Unsubscribe from the client we ACTUALLY registered with, not just the
      // current pool entry (they differ if the client was recreated).
      const client = this.attachedClient ?? getAgentClientForVpsId(this.vpsId);
      if (this.agentListener) client.unsubscribe(this.id, this.agentListener);
    } catch {}
    this.attachedClient = null;
    this.agentListener = null;
    this.liveToolOutput.clear();
    // Emit what the lane coalescer still holds (assistant or reasoning).
    this._flushLiveBroadcast();
    // Cancel the pending seq-persist timer — no more events are coming.
    // We don't bother flushing one last time: the seq will be irrelevant
    // after the session is deleted (agent will tear down its log too).
    if (this.persistSeqTimer) {
      clearTimeout(this.persistSeqTimer);
      this.persistSeqTimer = null;
    }
  }

  /** Set + publish on a CHANGE only (the bus frame before any later one). */
  private _setCompacting(on: boolean): void {
    if (this.compacting === on) return;
    this.compacting = on;
    this._broadcast({ type: 'compacting', active: on });
  }

  /** Assistant text currently being accumulated (since the last flush).
   *  Exposed so the GET API can pass it to the client → lets the UI
   *  resume an "in-progress" streaming without having to re-listen
   *  to deltas that have already passed (and already perceived as "scrolling"). */
  getStreamingText(): string {
    return this.currentAssistant;
  }

  /** A replayed buffer EXTENDING persisted row `rowId` (a SIGTERM partial,
   *  see `assistantReopen`), whose first `length` chars the browser renders
   *  from that row: the session GET's `streamingExtends`. Only the text past
   *  `length` is still to come (`getStreamingText().slice(length)`). */
  getStreamingExtends(): { rowId: number; length: number } | null {
    const reopen = this.assistantReopen;
    return reopen ? { rowId: reopen.rowId, length: reopen.prefix.length } : null;
  }

  /** A delta provider's reasoning block still open (not yet a row), for the
   *  session GET. Sealed blocks are excluded: they are no longer open, and
   *  their text already reached the browser live. */
  getStreamingThinking(): string {
    return this.currentThinking;
  }

  /** When the open reasoning block started (its first delta's ts, unix ms),
   *  or null: the GET dates the open bubble with it. */
  getStreamingThinkingTsMs(): number | null {
    return this.currentThinking ? this.pendingThinkingTsMs : null;
  }

  /** Emit what the 25 ms lane coalescer still holds, NOW. A snapshot (the
   *  session GET) reads the streaming text after this: text it returns must
   *  never have its frame still pending, or the browser shows that text
   *  twice (the snapshot's copy, then the late frame's). */
  flushLiveBroadcasts(): void {
    this._flushLiveBroadcast();
  }

  /** Output of the tools still running (`tool_progress` so far, tail-bounded),
   *  oldest-updated first: the session GET's `streamingToolOutput`. */
  getStreamingToolOutput(): Array<{ toolUseId: string; text: string; truncated: boolean }> {
    return [...this.liveToolOutput].map(([toolUseId, o]) => ({ toolUseId, text: o.text, truncated: o.truncated }));
  }

  private _noteToolOutput(toolUseId: string, delta: string): void {
    if (!toolUseId || typeof delta !== 'string' || !delta) return;
    const prev = this.liveToolOutput.get(toolUseId);
    let text = (prev?.text ?? '') + delta;
    let truncated = prev?.truncated ?? false;
    if (text.length > LIVE_TOOL_OUTPUT_MAX) {
      text = text.slice(text.length - LIVE_TOOL_OUTPUT_MAX);
      truncated = true;
    }
    // Re-insert: Map order = least-recently-updated first.
    this.liveToolOutput.delete(toolUseId);
    this.liveToolOutput.set(toolUseId, { text, truncated });
    while (this.liveToolOutput.size > LIVE_TOOL_OUTPUT_TOOLS) {
      this.liveToolOutput.delete(this.liveToolOutput.keys().next().value as string);
    }
  }

  /** Idempotent — attach to the agent listener. Called lazily from the
   * calling code that creates the SessionStream (autoConnect,
   * startNewSession, resumeSession). No longer tied to an HTTP
   * subscriber: the SSE listens to the global bus. */
  ensureAttached(): void {
    // Call attach() UNCONDITIONALLY: it is idempotent for the current client
    // and re-subscribes if the pool swapped the client out from under us (agent
    // update/refresh). The old `if (!this.attached)` guard would skip a stream
    // stranded on the dead old client — exactly the post-update freeze. §14.51.
    this.attach();
  }

  /**
   * Dispatch an agent event: DB persistence + SSE broadcast.
   * Preserves the semantics of SessionWorker.handleBridgeEvent.
   */
  private _onAgentEvent(ev: AgentEvent): void {
    // Flushed for the exit (gracefulShutdown): the restart replays it.
    if (globalThis.__charon_shuttingDown) return;
    if ((ev.event === "status" && ev.status === "active") || ev.event === "stop" || ev.event === "turn_end" || ev.event === "bg_task") {
      setTimeout(() => { loadEndpointOps().then((m) => m.applyPendingEndpoint(this.id)).catch(() => {}); }, 0);
    }
    const seq = (ev as { seq?: unknown }).seq;
    // A LIVE event below the cursor: the agent's log was recreated and the
    // subscribe saw it EMPTY (`current_seq: 0` is no reset for AgentClient —
    // a kill_session deletes the log and the restarted worker writes its
    // first event after the subscribe answered). Live events are in seq order
    // on one FIFO (replays are inside their window), so this is the new
    // epoch's first event: reset now, or every new-epoch stop would be <=
    // `lastStopNotifiedSeq` (no push, no unread) until the next reconnect.
    if (typeof seq === 'number' && !this.isReplaying && !this.epochReplayPinned && this.attached
        && this.lastSeenSeq != null && seq < this.lastSeenSeq && ev.event !== 'seq_epoch_reset') {
      console.warn(`[sessionOps] ${this.id}: live seq ${seq} below the cursor ${this.lastSeenSeq} — event log recreated`);
      this._dispatchEvent({
        event: 'seq_epoch_reset', session_id: this.id,
        after_seq: this.lastSeenSeq, current_seq: Math.max(0, seq - 1),
      } as AgentEvent);
    }
    // Identity answers are valid for ONE dispatch (see replayIdentityMemo).
    this.replayIdentityMemo = null;
    this.currentEventSeq = typeof seq === 'number' ? seq : null;
    // The agent sends `ts` as unix SECONDS (float, from the durable log).
    const ts = (ev as { ts?: unknown }).ts;
    this.currentEventTs = typeof ts === 'number' && Number.isFinite(ts) ? Math.round(ts * 1000) : null;
    if (this.isReplaying && this.currentEventSeq != null) {
      this.replayWindowFirstSeq ??= this.currentEventSeq;
      this.replayWindowLastSeq = this.currentEventSeq;
    }
    try {
      // Every handler runs on the event loop: a slow one is named in the
      // `[perf]`/`[eventloop]` journal lines.
      timeSection('agent:' + ev.event, () => this._dispatchEvent(ev));
    } finally {
      this.currentEventSeq = null;
      this.currentEventTs = null;
      // Advance the in-memory cursor AFTER the dispatch ran. The `finally`
      // is safe since the seq-gate (P0.2/P0.3): the DURABLE cursor persisted
      // to DB is held back below both the unflushed-assistant boundary and
      // any failed _persist (see _durableCursor), and re-delivered events
      // are deduped by IDENTITY (row seq stamps), so replaying past events
      // is idempotent by construction. `_trackSeq` is a no-op for events
      // without a seq (replay markers, old agents).
      this._trackSeq(ev);
    }
  }

  /** The seq value safe to persist as the durable replay checkpoint:
   *  everything <= it has ALL its DB effects flushed. */
  private _durableCursor(): number | null {
    let cursor = this.lastSeenSeq;
    if (cursor == null) return null;
    if (this.epochReplayPinned) return 0;
    if (this.pendingAssistantSince != null) {
      cursor = Math.min(cursor, this.pendingAssistantSince - 1);
    }
    // The open reasoning block lives only in memory, like the assistant one.
    if (this.pendingThinkingSince != null) {
      cursor = Math.min(cursor, this.pendingThinkingSince - 1);
    }
    // A replay consuming a persisted row's cover (no block open) is strictly
    // inside that row until the cover runs out or a boundary resets it: a
    // restart from there would replay the tail with no row, cover or span of
    // its own and write it again (G2). Held at the row's anchor − 1.
    if (this.replayThinkingCover != null && this.replayThinkingCoverSince != null) {
      cursor = Math.min(cursor, this.replayThinkingCoverSince - 1);
    }
    for (const seq of this.holdbacks.values()) {
      cursor = Math.min(cursor, seq - 1);
    }
    return cursor;
  }

  /** Hold the durable cursor back below `seq` for `key` (keeps the LOWEST
   *  seq per key). See `holdbacks`. */
  private _holdBack(key: string, seq: number | null | undefined): void {
    if (seq == null) return;
    const held = this.holdbacks.get(key);
    if (held == null || seq < held) this.holdbacks.set(key, seq);
  }

  /** During replay: TRUE if a row stamped with THIS event's seq (and ts)
   *  already exists. Dedup by IDENTITY — one indexed lookup per event
   *  (replayIdentity.ts); the content Sets remain as fallback for events
   *  without seq / rows without seq. Row-writing events are atomic per event
   *  (see the interaction transactions), so "a row with my seq exists" ⟹
   *  "my persistence completed". */
  private _replayAlreadyPersisted(ev: AgentEvent): boolean {
    if (!this.isReplaying) return false;
    const seq = (ev as { seq?: unknown }).seq;
    return typeof seq === 'number' && this._replaySeqPersisted(seq);
  }

  /** Identity of the event being dispatched, memoised for this dispatch. */
  private _replaySeqPersisted(seq: number): boolean {
    const memo = this.replayIdentityMemo;
    if (memo && memo.seq === seq) return memo.hit;
    const hit = !!rowAtSeq(this.id, seq, this.currentEventTs);
    this.replayIdentityMemo = { seq, hit };
    return hit;
  }

  /** Forget the assistant accumulation (flushed, or proven persisted). */
  private _resetAssistantBuffer(): void {
    this.currentAssistant = '';
    this.pendingAssistantSince = null;
    this.pendingAssistantTsMs = null;
    this.pendingAssistantUuid = null;
    this.pendingAssistantLastSeq = null;
    this.pendingAssistantLastTsMs = null;
    this.pendingAssistantFromReplay = false;
    this.pendingAssistantRowGuide = null;
    this.pendingAssistantGuideLen = -1;
    this.assistantReopen = null;
  }

  /** A replay window cut by a disconnect or a pool drop (AgentClient's
   *  synthetic `replay_end`). One that was re-delivering events OLDER than
   *  the frontier (an overlapping resubscribe) left the rest of them unseen
   *  and maybe an old buffer/block open: the reconnect must resume right
   *  after its last event, not at the frontier — there the missing tail was
   *  lost and the open buffer absorbed new deltas (G2). The cursor goes to
   *  the client this stream is attached to (never the pool: a dropped client
   *  must not be recreated from here) and to `attach()` for its replacement.
   *  Bounded: that range was already queued whole by the agent once. */
  private _onReplayWindowCut(): void {
    const last = this.replayWindowLastSeq;
    if (last != null) {
      const previous = this.replayCutSeq;
      this.replayCutSeq = this.lastSeenSeq != null && last < this.lastSeenSeq ? last : null;
      // A resumed cut window cut again AT the frontier ends that cut: the
      // client still holds the old cut point, which nothing else moves
      // (replayed seqs never reach `_trackSeq`'s cursor write) — put it back
      // on the frontier, as a real end would (`_endReplayCut`).
      const cursor = this.replayCutSeq ?? (previous != null ? this.lastSeenSeq : null);
      if (cursor != null) {
        try { this.attachedClient?.setAfterSeq(this.id, cursor); } catch {}
      }
    }
  }

  /** Newest row ts_ms of this session (the epoch-reset finish floor). */
  private _maxRowTsMs(): number | null {
    try {
      const row = db.select({ maxTs: sql<number | null>`max(${sessionMessages.tsMs})` })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, this.id)).get();
      return typeof row?.maxTs === 'number' ? row.maxTs : null;
    } catch { return null; }
  }

  /** The reset's replay from 0 (or a cut of it, resumed) ran to a real end:
   *  the new log is covered, both cursors follow the frontier again. */
  private _endEpochReplayPin(): void {
    this.epochReplayPinned = false;
    this.replayCutSeq = null;
    // The new epoch's own cursors (`lastStopNotifiedSeq`, the replay cursor)
    // own the finish dedup from here: the reset's ts floor compares clocks of
    // different origins (hub, old agent, new agent) and must not outlive it.
    this.stopNotifyFloorTsMs = null;
    this.stopFloorFromLoad = false;
    if (this.lastSeenSeq == null) return;
    try { (this.attachedClient ?? getAgentClientForVpsId(this.vpsId)).setAfterSeq(this.id, this.lastSeenSeq); } catch {}
    this._persistSeqNow();
  }

  /** A window ran to its end: a cut it resumed is over, the reconnect
   *  cursor is the frontier again. */
  private _endReplayCut(): void {
    if (this.replayCutSeq == null) return;
    this.replayCutSeq = null;
    if (this.lastSeenSeq == null) return;
    try { this.attachedClient?.setAfterSeq(this.id, this.lastSeenSeq); } catch {}
  }

  /** When a replayed FLUSH-BOUNDARY event is identity-gated, the deltas
   *  replayed just before it may already live in their flush row — but
   *  ONLY discard the buffer if that flush row actually exists. Flush rows
   *  are stamped with the FIRST DELTA's seq and ts (pendingAssistantSince/
   *  TsMs), so the check is exact: row present → text persisted → drop; row
   *  absent (the flush failed pre-crash) → KEEP the buffer, a later ungated
   *  boundary will flush it (slightly late in chronology, never lost).
   *  A row LONGER than the buffer and starting with it is the
   *  `_flushAssistantBuffer` rule: the live run did not flush here (its flush
   *  failed and the buffer ran on past this boundary, whose own row a later
   *  pass repaired — hence gated now), so the buffer is KEPT, bounded by that
   *  row (`pendingAssistantRowGuide`). Dropping it left the row's next deltas
   *  a rowless buffer: a duplicate tail.
   *  `exact`: for a replayed event that was a boundary only IF the live run
   *  flushed there (an unchanged `effective_model`). Drop only when the flush
   *  row holds exactly this buffer. */
  private _dropReplayedAssistantBuffer(opts?: { exact?: boolean }): void {
    const since = this.pendingAssistantSince;
    if (since == null) return;
    const row = assistantRowAtSeq(this.id, since, this.pendingAssistantTsMs);
    if (row && row.content.length > this.currentAssistant.length && row.content.startsWith(this.currentAssistant)) {
      this.pendingAssistantRowGuide = row.content;
      this.pendingAssistantGuideLen = this.currentAssistant.length;
      return;
    }
    const persistedRow = opts?.exact
      ? (row?.content === this.currentAssistant ? row : undefined)
      : row ?? rowAtSeq(this.id, since, this.pendingAssistantTsMs);
    if (!persistedRow) return;
    // The browser discards what it holds of this buffer (I7).
    const announced = {
      type: 'assistant_flushed' as const, rowId: persistedRow.id, length: this.currentAssistant.length,
      tsMs: this.pendingAssistantTsMs, model: this.effectiveModel, duplicate: true as const,
    };
    this._endPersistedAssistantBuffer();
    this._broadcast(announced);
  }

  /** The buffer is in its row: forget it, and remember that the row holds
   *  its deltas (a later window starting inside it skips them). The span ends
   *  at the buffer's LAST delta (its ts), never at the event closing it. */
  private _endPersistedAssistantBuffer(): void {
    const since = this.pendingAssistantSince;
    if (since != null && this.pendingAssistantLastSeq != null) {
      this.deltaSpans.record(since, this.pendingAssistantLastSeq, this.pendingAssistantTsMs, this.pendingAssistantLastTsMs);
    }
    this._resetAssistantBuffer();
  }

  /** The legacy content Sets, loaded on first need. Every caller runs inside
   *  a replay window; the Sets live until its end. */
  private _legacy(): LegacyReplaySets {
    if (this.legacyReplay) return this.legacyReplay;
    const sets = loadLegacyReplaySets(this.id);
    if (this.isReplaying) this.legacyReplay = sets;
    return sets;
  }

  /** The legacy Sets a replayed tool row that MISSED identity must consult:
   *  always for a seq-less event (no identity at all); for a stamped one only
   *  when the session has seq-NULL tool rows (fork copies, imports, pre-seq
   *  history), the one case where its tool id can still be a duplicate. A
   *  natively stamped session never loads them for a tool row. */
  private _legacyForToolRow(): LegacyReplaySets | null {
    if (!this.isReplaying) return null;
    if (this.legacyReplay) return this.legacyReplay;
    if (this.currentEventSeq != null) {
      this.legacyToolRows ??= sessionHasLegacyToolRows(this.id);
      if (!this.legacyToolRows) return null;
    }
    return this._legacy();
  }

  private _dispatchEvent(ev: AgentEvent): void {
    // A delta provider's reasoning block ends at every non-transparent event,
    // BEFORE that event's identity gate: unlike an assistant buffer at a
    // gated boundary, a block must never survive one (it would merge
    // reasoning across a tool call). Flushing ahead of an already-persisted
    // boundary is order-safe: rows sort by first-delta ts_ms (§14.71).
    if (this.coalesceThinking) {
      if (closesThinking(ev as { event: string; final?: unknown })) {
        this._resetThinkingCover();
        this._flushThinking();
      } else if (ev.event === 'replay_begin') {
        this._onThinkingReplayBegin();
      } else if (this.replayThinkingCover != null && this.isReplaying
        && ev.event !== 'thinking' && this.currentEventSeq != null) {
        // A transparent event inside the covered row carries the cover: a
        // window cut right after it still resumes where the cover stopped.
        this.replayThinkingCoverSeq = Math.max(this.replayThinkingCoverSeq ?? this.currentEventSeq, this.currentEventSeq);
      }
    }
    switch (ev.event) {
      case 'replay_begin':
        // We enter the replay window: the events that follow may be
        // duplicates (already persisted) OR missed events (e.g. after
        // a Charon restart, the VPS agent kept streaming while we were
        // down). Primary dedup = the identity gate (_replayAlreadyPersisted,
        // one indexed lookup per event); the content Sets are the lazy
        // legacy fallback for seq-less events / seq-NULL rows. Nothing
        // session-wide is read here (§14.31). An open reasoning block stays
        // open (thinkingBoundaries.ts): its re-delivered deltas are dropped
        // by the replay-only seq guard in `_onThinkingDelta`.
        this.isReplaying = true;
        this.replayIdentityMemo = null;
        this.replayWindowFirstSeq = null;
        this.replayWindowLastSeq = null;
        this._beginReplayIdentity();
        return;
      case 'replay_end': {
        // Idempotent: AgentClient also synthesizes one when a connection
        // drops mid-replay; outside a window it only clears.
        const wasReplaying = this.isReplaying;
        this.isReplaying = false;
        this.replayIdentityMemo = null;
        this.legacyReplay = null;
        this.legacyToolRows = null;
        this.replayKnownPendingIds.clear();
        if (wasReplaying) {
          this._scheduleCodexBgCheck();
          // A synthetic end is a CUT: the reconnect resumes the window where
          // it stopped (`_onReplayWindowCut`).
          if ((ev as { synthetic?: unknown }).synthetic === true) this._onReplayWindowCut();
          else if (this.epochReplayPinned) this._endEpochReplayPin();
          else {
            this._endReplayCut();
            // The restarted process's replay from 0 covered the new log.
            if (this.stopFloorFromLoad) { this.stopFloorFromLoad = false; this.stopNotifyFloorTsMs = null; }
          }
        }
        if (this.tokenUsageDirty) this._broadcastTokenUsage();
        return;
      }
      case 'seq_epoch_reset': {
        // AgentClient: a READABLE durable log answered `current_seq <
        // after_seq` — recreated, its seqs restarted at 1 (§14.71). (1) The
        // open buffers belong to the old epoch: persist them as live rows
        // (a failure seals/holds back as usual).
        this._flushAssistant();
        this._flushThinking();
        this._log('warn', 'seq_epoch_reset', { afterSeq: ev.after_seq, currentSeq: ev.current_seq });
        // (2) Old-epoch seqs mean nothing to the new log: drop every seq
        // guard, cover, span and holdback (sealed blocks keep retrying).
        this.pendingAssistantLastSeq = null;
        this.pendingThinkingLastSeq = null;
        this._resetThinkingCover();
        this.deltaSpans = new PersistedSpans();
        this.replayIdentityMemo = null;
        this.holdbacks.clear();
        this.replayCutSeq = null;
        this.replayWindowFirstSeq = null;
        this.replayWindowLastSeq = null;
        // (3) Cursors restart; the finish floor keeps the reset replay from
        // re-finishing stops already handled (`isNewFinish`).
        this.lastSeenSeq = 0;
        this.lastPersistedSeq = null;
        this.lastStopNotifiedSeq = null;
        {
          const maxTs = this._maxRowTsMs();
          if (maxTs != null) {
            this.stopNotifyFloorTsMs = Math.max(this.stopNotifyFloorTsMs ?? maxTs, maxTs);
          }
        }
        // (4) Persist them.
        if (this.persistSeqTimer) { clearTimeout(this.persistSeqTimer); this.persistSeqTimer = null; }
        try {
          db.update(agentSessions).set({ lastSeenSeq: 0, lastStopNotifiedSeq: null })
            .where(eq(agentSessions.id, this.id)).run();
          this.lastPersistedSeq = 0;
        } catch {}
        // (5) Replay the new log whole (ts-matched identity dedupes, §14.31).
        // An agent < 0.103.0 queues a whole burst at once in its capped send
        // queue: a big new log from 0 would drop the connection before a line
        // is written, on every reconnect (the cursor never moves). There the
        // cursor jumps to the new log's end instead, and the skipped range is
        // an explicit `replay_gap` (never a silent loss).
        let client: ReturnType<typeof getAgentClientForVpsId> | null = null;
        try { client = this.attachedClient ?? getAgentClientForVpsId(this.vpsId); } catch {}
        const currentSeq = typeof ev.current_seq === 'number' ? ev.current_seq : 0;
        if (client && !client.backpressuresReplay() && currentSeq > 0) {
          this.lastSeenSeq = currentSeq;
          try {
            db.update(agentSessions).set({ lastSeenSeq: currentSeq })
              .where(eq(agentSessions.id, this.id)).run();
            this.lastPersistedSeq = currentSeq;
          } catch {}
          try { client.setAfterSeq(this.id, currentSeq); } catch {}
          this._dispatchEvent({
            event: 'replay_gap', session_id: this.id, after_seq: 0, earliest_seq: currentSeq + 1,
          } as AgentEvent);
          return;
        }
        this.epochReplayPinned = true;
        try {
          client?.setAfterSeq(this.id, 0);
          client?.resubscribe(this.id, { afterSeq: 0 });
        } catch {}
        return;
      }
      case 'replay_gap': {
        // Synthesized by AgentClient from the subscribe RPC result (agent
        // >= 0.18.0): the durable log rotated past our cursor — events
        // (after_seq, earliest_seq) are gone for good. Make the hole
        // EXPLICIT instead of silently presenting a truncated transcript:
        // durable log line, a persisted event row (survives refetch), and
        // a non-fatal error banner in the live UI.
        const missedFrom = ev.after_seq + 1;
        const missedTo = ev.earliest_seq - 1;
        this._log('warn', 'replay_gap', { from: missedFrom, to: missedTo });
        this._persist('event', { type: 'replay_gap', from: missedFrom, to: missedTo });
        this._broadcast({
          type: 'error',
          msg: `history gap: events ${missedFrom}–${missedTo} were lost while Charon was disconnected (agent log rotated). The transcript may be missing messages in that window.`,
          fatal: false,
        });
        break;
      }
      case 'status':
        // Skip replayed status events: the agent's ring buffer contains the
        // historical status chronology (e.g. active→thinking→active→sleeping
        // before the session was paused). Applying them as if live causes UI
        // flicker on every resubscribe (sidebar stuck on the last replayed
        // status, chat view recovering only via the next GET → desync).
        // The agent always sends its CURRENT status as a final event AFTER
        // `replay_end` (cf. agent/server.py § subscribe), so we just trust
        // that one to be the source of truth.
        if (this.isReplaying) {
          break;
        }
        // Compaction lives inside a turn: the post-replay frame says whether
        // one runs (agent >= 0.125.0), any non-turn status ends it.
        if (typeof ev.compacting === 'boolean') this._setCompacting(ev.compacting && ev.status === 'thinking');
        else if (ev.status !== 'thinking') this._setCompacting(false);
        // A new SDK client applies the queued config (the reducer's rule).
        if (ev.status === 'starting') { this.pendingApply.model = false; this.pendingApply.effort = false; }
        if (this.expectKilledEcho && (ev.status === 'starting' || Date.now() > this.expectKilledEchoUntil)) {
          this.expectKilledEcho = false;
        }
        // S7 (PATCH cwd): the hub killed the agent-side instance itself to
        // re-create it with the new cwd. ONE `killed` echo of that kill means
        // "sleeping" — never the transient deletion signal (a browser would
        // drop the session), never a bg-task burial. Only that echo consumes
        // the flag: a turn-end `active` already on the wire ahead of it must
        // not.
        if (this.expectKilledEcho && ev.status === 'killed') {
          this.expectKilledEcho = false;
          // The killed instance's running tools are gone, as on any
          // sleeping status (C12's liveToolOutput rule).
          this.liveToolOutput.clear();
          this._cancelBlockingGates();
          this.status = 'sleeping';
          this._broadcast({ type: 'status', status: 'sleeping' });
          try {
            db.update(agentSessions).set({ status: 'sleeping' })
              .where(eq(agentSessions.id, this.id)).run();
          } catch {}
          break;
        }
        // The Claude daemon returns to idle after ResultMessage even when the
        // final assistant bubble was an API/auth failure. Keep the durable
        // failed-turn marker visible until a new turn really starts.
        if (ev.status === 'active' && this.terminalErrorLatched) {
          break;
        }
        // Same shape for background work: the daemon goes idle the moment the
        // turn ends and knows nothing about the tasks it left running, so its
        // `active` would repaint the session green a few ms after `stop` set it
        // to `background` (§14.91). Only the last task finishing clears it —
        // see _trackBgTask.
        if (ev.status === 'active' && this.status === 'background' && this.hasRunningBgTasks()) {
          break;
        }
        if (ev.status === 'thinking' || ev.status === 'starting') {
          this.clearTerminalErrorLatch();
          // A new turn owns the session now: whatever "background work is
          // done" notice was queued belongs to this turn's stop instead.
          this._cancelBgFinish();
        }
        if (ev.status === 'sleeping' || ev.status === 'error' || ev.status === 'killed') {
          this.liveToolOutput.clear();
          this._expireBgTasks();
          // The worker is gone: its blocking gates can never be answered.
          // Published, not silent (G7); async questions survive (C07).
          this._cancelBlockingGates();
        }
        this.status = ev.status as WorkerStatus;
        this._broadcast({ type: 'status', status: this.status });
        // A new turn beginning (status → thinking) means the session is being
        // actively worked again, so it is no longer "finished, unread": clear
        // the green marker authoritatively (DB + session_unread bus). This is
        // the cross-device counterpart of the client display guard that hides
        // green while a session is working. markSessionRead is a no-op when the
        // row wasn't unread, so the extra write is free on a normal turn start.
        // cf. CLAUDE.md §14.47.
        if (ev.status === 'thinking') {
          markSessionRead(this.id);
        }
        try {
          // A confirmed 'sleeping' from the agent fulfills any pending sleep
          // intent (sleepRequested) — clear it so a later legitimate 'active'
          // isn't suppressed by reconcileVpsAgentState. cf. CLAUDE.md §14.46.
          // `killed` is a transient deletion signal, never a row status (§10):
          // a real deletion detaches this stream before its kill, so a
          // `killed` reaching a hydrated stream leaves a row that still
          // exists — durably `sleeping` (resumable), never stuck `killed`.
          const upd: { status: string; sleepRequested?: number; resumePending?: number } =
            ev.status === 'sleeping' ? { status: ev.status, sleepRequested: 0 }
              : ev.status === 'killed' ? { status: 'sleeping' } : { status: ev.status };
          if (ev.status === 'active' || ev.status === 'thinking') upd.resumePending = 0;
          db.update(agentSessions).set(upd)
            .where(eq(agentSessions.id, this.id)).run();
        } catch (e) {
          // P7 (CLAUDE.md §14.45): surface instead of swallowing. _trackSeq
          // still advances the durable cursor, but the agent's post-replay
          // status frame + reconcileVpsAgentState re-assert the truth on the
          // next (re)connect, so one failed write is recovered, not lost.
          console.error(`[sessionOps] ${this.id} status db.update('${ev.status}') failed:`, (e as Error)?.message ?? e);
        }
        break;
      case 'ready': {
        // The agent emits `ready` exactly once per ClaudeSDKClient
        // construction (`session.py`): a BRAND-NEW CLI process owns the
        // session now. Everything the previous one was running died with it —
        // including its background children, whose `finished` can never arrive
        // (§14.91). Bury them here exactly as sleep/error does: left alone the
        // ghost pins the session `background` and keeps sdkWatch's quiet gate
        // believing the VPS is busy until the 24h age cap, so that VPS is
        // never auto-updated.
        // NOT live-only: the restart that matters is usually the one that also
        // dropped the SSH connection, so this `ready` arrives inside the
        // reconnect replay. Hydration already includes newer DB tasks: the
        // temporal guard preserves them even when this ready originally had
        // nothing to bury (hence no identity receipt). Existing receipts are
        // still deduped by the READY's seq. Seq-less agents → live only.
        const readySeq = typeof ev.seq === 'number' ? ev.seq : null;
        if (readySeq == null ? !this.isReplaying : !this._replayAlreadyPersisted(ev)) {
          this._expireBgTasks(readySeq, this._bgTasksBeforeCurrentEvent());
        }
        this._broadcast({ type: 'ready' });
        break;
      }
      case 'session_id':
        this.nativeSessionId = ev.claude_session_id;
        try {
          db.update(agentSessions).set({ nativeSessionId: ev.claude_session_id })
            .where(eq(agentSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'session_id', id: ev.claude_session_id });
        break;
      case 'assistant_text': {
        // One open buffer at a time ⇒ row id order matches chronology.
        if (this.coalesceThinking) this._flushThinking();
        // No identity gate here: deltas never write their own row (their
        // text lands in the flush row stamped with the FIRST delta's seq).
        // Deltas replayed under an already-persisted flush are discarded
        // when the gated boundary arrives (_dropReplayedAssistantBuffer).
        const deltaSeq = typeof ev.seq === 'number' ? ev.seq : null;
        // Replay windows only: a delta at or below the buffer's last seq is
        // already in it — the same range replayed twice (attach +
        // resubscribe) doubled the text of a whole answer. Live deltas are
        // never re-sent, and a recreated log restarts seq at 1 (§14.71).
        if (this.isReplaying && deltaSeq != null && this.currentAssistant
          && this.pendingAssistantLastSeq != null && deltaSeq <= this.pendingAssistantLastSeq) {
          break;
        }
        // …and with no buffer open, a window starting INSIDE a flush row this
        // process persisted (an overlapping resubscribe): the delta has no
        // row of its own, its text is in that row (`deltaSpans`).
        if (this.isReplaying && deltaSeq != null && !this.currentAssistant
          && this.deltaSpans.covers(deltaSeq, this.currentEventTs)) {
          this.pendingTurnAssistantSeen = true;
          break;
        }
        // A buffer kept for a longer row runs on only while it still spells
        // it (or extends it: a SIGTERM partial). A delta leaving it is new
        // text — a hole in the replayed log — and starts its own buffer; the
        // kept text is in that row.
        const guide = this.pendingAssistantRowGuide;
        if (guide != null && this.currentAssistant) {
          const { guideHasNext, nextHasGuide } = this._guideRelation(guide, ev.delta);
          if (guideHasNext || nextHasGuide) this.pendingAssistantGuideLen = this.currentAssistant.length + ev.delta.length;
          if (!guideHasNext) {
            if (!nextHasGuide) this._resetAssistantBuffer();
            // Past the row's end, a replayed delta that has a row of its own
            // starts ANOTHER persisted row: that row was complete, not a
            // SIGTERM partial. The buffer ends before it (its row extended
            // with what it holds past it, if anything — a failure leaves the
            // pins to the restart), and the delta opens its own buffer, which
            // that row's identity settles.
            else if (this.isReplaying && deltaSeq != null
              && assistantRowAtSeq(this.id, deltaSeq, this.currentEventTs)) {
              this._flushAssistant();
              this._resetAssistantBuffer();
            }
          }
        } else if (this.isReplaying && deltaSeq != null && this.currentAssistant
          && deltaSeq !== this.pendingAssistantSince
          && assistantRowAtSeq(this.id, deltaSeq, this.currentEventTs)) {
          // The same rule for a hub-only cut the replay cannot reproduce:
          // `plan_progress` cuts the live bubble (lib/assistantBoundaries.ts)
          // but is TRANSIENT agent-side (never logged, never replayed), so the
          // replay re-delivers the deltas on both sides of it as one run. A
          // replayed delta with a flush row of its OWN started another
          // persisted row (a delta belongs to exactly one): the buffer ends
          // before it — identity settles its row (`duplicate`, or extended
          // with what it holds past it; a failure leaves the pins to the
          // restart) — and the delta opens its own buffer, reopening that
          // row. Without the cut the first row was extended over the second
          // row's text: written twice, for good.
          this._flushAssistant();
          this._resetAssistantBuffer();
        }
        if (!this.currentAssistant) {
          this.pendingAssistantFromReplay ||= this.isReplaying;
          // A replayed buffer whose first delta already has its flush row: a
          // SIGTERM partial (`flushPendingAssistant`) the browser renders.
          // The deltas re-delivered inside it are not shown twice (below).
          if (this.isReplaying && deltaSeq != null) {
            const row = assistantRowAtSeq(this.id, deltaSeq, this.currentEventTs);
            if (row) this.assistantReopen = { rowId: row.id, prefix: row.content, announced: false, matched: 0 };
          }
        }
        if (deltaSeq != null) {
          this.pendingAssistantLastSeq = deltaSeq;
          this.pendingAssistantLastTsMs = this.currentEventTs;
        }
        // Crash protection: remember where the unflushed accumulation
        // starts — the durable cursor never advances past it (P0.2).
        if (this.pendingAssistantSince == null && deltaSeq != null) {
          this.pendingAssistantSince = deltaSeq;
        }
        if (this.pendingAssistantUuid == null && typeof ev.uuid === 'string' && ev.uuid) {
          this.pendingAssistantUuid = ev.uuid;
        }
        // …and WHEN it starts, so the flush row is dated from the first
        // delta rather than from the boundary that closes it (§14.71).
        // Guarded on the ts, not on pendingAssistantSince: a seq-less agent
        // still gives us a usable date.
        if (this.pendingAssistantTsMs == null && this.currentEventTs != null) {
          this.pendingAssistantTsMs = this.currentEventTs;
        }
        const preLen = this.currentAssistant.length;
        this.currentAssistant += ev.delta;
        this.pendingTurnAssistantSeen = true;
        const reopen = this.assistantReopen;
        if (reopen && !reopen.announced) {
          const rel = this._reopenRelation(reopen, preLen, ev.delta);
          // Still inside the persisted prefix: already rendered.
          if (rel === 'inside') { reopen.matched = this.currentAssistant.length; break; }
          if (rel === 'past') {
            // Past it: the browser extends that row with what follows.
            reopen.announced = true;
            this._broadcast({ type: 'assistant_reopened', rowId: reopen.rowId, length: reopen.prefix.length });
            this._broadcast({ type: 'assistant_text', delta: this.currentAssistant.slice(reopen.prefix.length), replay: true });
            break;
          }
          // Diverged from the row: the whole buffer is new to the browser
          // (the flush's identity block decides at the boundary).
          this.assistantReopen = null;
          this._broadcast({ type: 'assistant_text', delta: this.currentAssistant, ...(this.isReplaying ? { replay: true } : {}) });
          break;
        }
        this._broadcast({ type: 'assistant_text', delta: ev.delta, ...(this.isReplaying ? { replay: true } : {}) });
        break;
      }
      case 'compacting':
        // Transient on the agent (never replayed); `isReplaying` guards a
        // future durable copy.
        if (!this.isReplaying) this._setCompacting(ev.active === true && this.status === 'thinking');
        break;
      case 'session_runtime':
        // Transient (never replayed): the runtime process now running it
        // (§14.117). Hub memory, re-stated by every hello.
        if (!this.isReplaying) noteSessionRuntime(this.vpsId, this.id, ev.outdated === true);
        break;
      case 'generation_progress':
        if (!this.isReplaying && Number.isFinite(ev.characters) && ev.characters >= 0) {
          this._broadcast({ type: 'generation_progress', characters: ev.characters });
        }
        break;
      case 'structured_output': {
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        if (!this._flushAssistant()) break;
        const payload = {
          type: 'structured_output' as const,
          value: ev.value,
          ...(ev.truncated ? { truncated: true } : {}),
        };
        this._broadcast(withRowId(payload, this._persist('event', payload)));
        break;
      }
      case 'thinking': {
        if (this.coalesceThinking && typeof ev.seq === 'number') {
          this._onThinkingDelta(ev.text, ev.seq);
          break;
        }
        // One row per event: Claude's complete blocks, seq-less agents.
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        // Flush failed → STOP: persisting this boundary's row now would put
        // it BEFORE the assistant text that preceded it (Codex 16.3). The
        // dropped event stays pinned (the `event` key, even once a later flush
        // releases `assistant:<since>`); the restart replay redoes it.
        if (!this._flushAssistant()) break;
        // Streamed tokens repeat legitimately (spaces, punctuation, words).
        // With seq, identity is the indexed per-event lookup or the positional
        // cover of a coalesced row (§14.31) — never free-text matching.
        const legacyThinking = this.isReplaying && this.currentEventSeq == null;
        if (legacyThinking && this._legacy().thinkingContents.has(ev.text)) break;
        const saved = this._persist('event', { type: 'thinking', text: ev.text });
        this._broadcast(withRowId({ type: 'thinking', text: ev.text, ...(this.isReplaying ? { replay: true } : {}) }, saved));
        if (saved !== false && legacyThinking) this._legacy().thinkingContents.add(ev.text);
        break;
      }
      case 'tool_use':
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        if (this._legacyForToolRow()?.toolUseIds.has(String(ev.id))) break;
        const toolUseRow = this._persist('tool_use', { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        // Live "who is touching what" for the explorer. Never during replay:
        // a reconnect would relight files an agent read an hour ago. §14.88
        if (!this.isReplaying) {
          const touched = fileFromToolUse(String(ev.name ?? ''), ev.input, this.cwd ?? '');
          if (touched) {
            const fresh = noteActivity({
              vpsId: this.vpsId, path: touched.path, kind: touched.kind,
              sessionId: this.id, sessionName: this.name, at: Date.now(),
            });
            if (fresh) emitGlobalFileActivity(fresh);
          }
        }
        if (!this.isReplaying) this.turnTools = this._turnToolCount();
        this._broadcast(withRowId({
          type: 'tool_use', id: ev.id, name: ev.name,
          input: compactToolInputForWire(ev.input),
          ...(this.turnTools != null ? { turnTools: this.turnTools } : {}),
        } as WorkerEvent, toolUseRow));
        // Only a LOADED Set needs the id; a later load reads the DB itself.
        if (this.isReplaying) this.legacyReplay?.toolUseIds.add(String(ev.id));
        break;
      case 'tool_result':
        this.liveToolOutput.delete(String(ev.tool_use_id));
        if (this._replayAlreadyPersisted(ev)) break;
        if (this._legacyForToolRow()?.toolResultIds.has(String(ev.tool_use_id))) break;
        const toolResultRow = this._persist('tool_result', { type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        this._broadcast(withRowId({
          type: 'tool_result', tool_use_id: ev.tool_use_id,
          ...compactToolResultForWire(ev.content), is_error: ev.is_error,
        } as WorkerEvent, toolResultRow));
        if (this.isReplaying) this.legacyReplay?.toolResultIds.add(String(ev.tool_use_id));
        break;
      case 'tool_progress':
        // High-frequency command/MCP output. Live-only: the completed item
        // persists the authoritative aggregate as a normal tool_result.
        this._noteToolOutput(String(ev.tool_use_id), ev.delta);
        this._broadcast({ type: 'tool_progress', tool_use_id: ev.tool_use_id, delta: ev.delta });
        break;
      case 'edit_progress':
        // Live cumulative patch. The completed FileChangeThreadItem persists
        // the final edit_snapshot; writing every delta would drown pagination.
        this._broadcast({
          type: 'edit_progress', tool_use_id: ev.tool_use_id,
          file_path: ev.file_path, diff: ev.diff,
          size: ev.size, truncated: ev.truncated,
        });
        break;
      case 'plan_progress':
        // A bubble boundary (lib/assistantBoundaries.ts) that writes no row:
        // the text before it is persisted first, as the live view shows it.
        if (!this._flushAssistant()) break;
        this._broadcast({ type: 'plan_progress', id: ev.id, text: ev.text });
        break;
      case 'plan_update': {
        const payload = {
          type: 'plan_update' as const, id: ev.id,
          ...(ev.explanation !== undefined ? { explanation: ev.explanation } : {}),
          steps: ev.steps,
        };
        let planRow: number | false | undefined;
        if (this._replayAlreadyPersisted(ev)) {
          this._dropReplayedAssistantBuffer();
          // Re-published as before; it names the row it already has.
          planRow = this.currentEventSeq == null ? undefined : rowAtSeq(this.id, this.currentEventSeq, this.currentEventTs)?.id;
        } else {
          if (!this._flushAssistant()) break; // order-preserving stop (16.3)
          planRow = this._persist('event', payload);
        }
        this._broadcast(withRowId(payload, planRow));
        break;
      }
      case 'tool_activity': {
        const id = `codex-${ev.kind}-${ev.id}`;
        const payload = {
          type: 'tool_activity' as const, kind: ev.kind, id,
          status: ev.status, detail: ev.detail,
        };
        // Hooks/progress/status are live control-plane state. Persisting them
        // created raw JSON cards on replay and grew the transcript for no user
        // value; consumers that need a signal still receive the broadcast.
        this._broadcast(payload);
        break;
      }
      case 'codex_signal': {
        if (ev.kind === 'account_limits') {
          // This signal is account state, not transcript/tool activity. Feed
          // the existing Codex usage cache + LOW_VOLUME global gauge event.
          // An agent that did not stamp the reading (every emit path before
          // 0.103.3) still ran under THIS stream's profile: never guess the
          // VPS default, which files account 2's limits under account 1.
          hubHooks().codexUsagePushHandler?.(this.vpsId, ev.detail, ev.account_profile ?? this.accountProfile, ev.account_key);
          this.latestLimitResetAtMs = resetFromCodexLimits(ev.detail) ?? this.latestLimitResetAtMs;
          break;
        }
        // Global app-server FIFO signals are live state, not transcript rows.
        // Reuse the existing activity-card wire shape without persisting every
        // active/idle or fs invalidation transition into SQLite.
        this._broadcast({
          type: 'tool_activity', kind: ev.kind,
          id: `codex-${ev.kind}-${ev.id}`,
          status: ev.status, detail: ev.detail,
        });
        break;
      }
      case 'permission_request':
        // NO identity gate-break here (Codex 13.2.C): a permission writes
        // NO message row — but its preceding FLUSH does, stamped with THIS
        // event's seq. Breaking on that row would skip the pending insert
        // when it's the piece that failed. Discard the replayed buffer if
        // the flush row exists, then let the pendingIds dedup decide.
        if (this._replayAlreadyPersisted(ev)) this._dropReplayedAssistantBuffer();
        const expiresAt = ev.expires_at
          ?? Math.floor(Date.now() / 1000) + PROVIDERS[this.kind].interactionTimeoutS.permission;
        this._scheduleInteractionExpiry('permission', ev.id, expiresAt);
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        // `replayKnownPendingIds` names every gate of the session WHATEVER its
        // status: a restart replay must never resurface one (a ghost card +
        // push + Telegram AFTER its own resolution; add-only feeds keep it).
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
        // Remembered "don't ask again" rules never reach the hub: the CLI
        // applies them itself (they ride every start as `allowedTools`). What
        // arrives here is a real question, with the provider's reason and —
        // Claude — its own options, picked by index (lib/permissionSuggestions.ts).
        const gate = permissionGateExtras(ev.reason, ev.suggestions);
        try {
          db.insert(sessionPendingPermissions).values({
            id: ev.id,
            sessionId: this.id,
            toolName: ev.tool,
            toolInput: JSON.stringify(ev.input ?? {}),
            status: 'pending',
            expiresAt,
            reason: gate.reason ?? null,
            suggestions: gate.suggestions ? JSON.stringify(gate.suggestions) : null,
          }).onConflictDoNothing().run();
        } catch (e) {
          // A REAL insert failure (not a dup — onConflictDoNothing absorbs
          // those): hold the cursor back and STOP — the replay after
          // restart redoes this event whole (broadcasting a card that
          // wouldn't survive a refetch would just mislead the user).
          this._pinEvent(this.currentEventSeq);
          this._log('warn', 'sdk_error', { msg: 'pending perm insert failed', err: (e as Error)?.message });
          break;
        }
        this._surfacePermissionRequest(ev.id, ev.tool, ev.input, expiresAt, gate);
        break;
      case 'user_question': {
        // Identity gate on the event's OWN row: it is inserted AFTER the
        // pending (break-on-failure order below), so its presence proves
        // the pending write completed too — no transaction needed.
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        const asynchronous = ev.delivery === 'async';
        const expiresAt = asynchronous ? undefined : ev.expires_at
          ?? Math.floor(Date.now() / 1000) + PROVIDERS[this.kind].interactionTimeoutS.question;
        if (expiresAt != null) this._scheduleInteractionExpiry('question', ev.id, expiresAt);
        // Codex 16.2: "pending exists" must NOT short-circuit the message
        // row — the pending may have survived a crash whose row insert
        // failed. Skip only the effects that provably happened (pending +
        // its notifications); REPAIR the missing row silently.
        const pendingKnown = this.isReplaying && this.replayKnownPendingIds.has(ev.id);
        if (!pendingKnown) {
          try {
            db.insert(sessionPendingQuestions).values({
              id: ev.id, sessionId: this.id, kind: asynchronous ? 'async_question' : 'question',
              payload: JSON.stringify(ev.questions ?? []), status: 'pending',
              createdAt: Math.floor((this.currentEventTs ?? Date.now()) / 1000),
              expiresAt,
            }).onConflictDoNothing().run();
          } catch (e) {
            // Real failure → holdback + stop; replay redoes pending AND row.
            this._pinEvent(this.currentEventSeq);
            this._log('warn', 'sdk_error', { msg: 'pending question insert failed', err: (e as Error)?.message });
            break;
          }
        }
        const questionRow = this._persist(asynchronous ? 'async_question' : 'user_question', {
          type: 'user_question', id: ev.id, questions: ev.questions, delivery: ev.delivery,
        });
        if (!pendingKnown) {
          this._broadcast(withRowId({
            type: 'user_question' as const, id: ev.id, questions: ev.questions,
            expiresAt,
            delivery: ev.delivery,
            createdAt: this.currentEventTs == null ? Math.floor(Date.now() / 1000) : Math.floor(this.currentEventTs / 1000),
          }, questionRow));
          this._maybePush({
            event: 'question',
            title: `❓ ${this.vpsName} · ${this._label()} : question`,
            body: `${ev.questions[0]?.question ?? 'user question'}`,
            tag: `q-${this.id}`,
          });
          // Telegram's question callback answers a blocking gate. Async forms
          // instead link to their durable transcript bubble.
          if (asynchronous) sendPlainToTelegram(`❓ ${this.vpsName} · ${this._label()}\n${ev.questions[0]?.question ?? 'Question'}`, `/?session=${this.id}`, 'question').catch(() => {});
          else sendQuestionToTelegram(this.id, ev.id, ev.questions ?? []).catch(() => {});
        }
        break;
      }
      case 'exit_plan_request': {
        // Same structure as user_question: pending→row break-on-failure
        // order + pending-survived-row-missing repair (Codex 16.2).
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        const pendingKnown = this.isReplaying && this.replayKnownPendingIds.has(ev.id);
        if (!pendingKnown) {
          try {
            db.insert(sessionPendingQuestions).values({
              id: ev.id, sessionId: this.id, kind: 'exit_plan',
              payload: JSON.stringify({ plan: ev.plan ?? '' }), status: 'pending',
              expiresAt: ev.expires_at ?? null,
            }).onConflictDoNothing().run();
          } catch (e) {
            this._pinEvent(this.currentEventSeq);
            this._log('warn', 'sdk_error', { msg: 'pending exit_plan insert failed', err: (e as Error)?.message });
            break;
          }
        }
        const planRequestRow = this._persist('exit_plan_request', { type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        if (!pendingKnown) {
          this._broadcast(withRowId({
            type: 'exit_plan_request' as const, id: ev.id, plan: ev.plan,
            expiresAt: ev.expires_at,
          }, planRequestRow));
          this._maybePush({
            event: 'plan',
            title: `📋 ${this.vpsName} · ${this._label()} : plan ready`,
            body: providerText.finishedPlanning(this.kind),
            tag: `plan-${this.id}`,
          });
          sendPlainToTelegram(`📋 ${this.vpsName} · ${this._label()}\nPlan ready — open Charon to approve`, `/?session=${this.id}`, 'plan').catch(() => {});
        }
        break;
      }
      case 'interaction_resolved': {
        // Provider-side expiry/cancellation is authoritative. This event is
        // durable in the agent log, so replay after a hub outage removes the
        // stale card just like the live path.
        const resolvedAt = Math.floor(Date.now() / 1000);
        try {
          if (ev.kind === 'permission') {
            db.update(sessionPendingPermissions)
              .set({ status: ev.outcome, respondedAt: resolvedAt })
              .where(and(
                eq(sessionPendingPermissions.id, ev.id),
                eq(sessionPendingPermissions.sessionId, this.id),
                eq(sessionPendingPermissions.status, 'pending'),
              )).run();
          } else {
            db.update(sessionPendingQuestions)
              .set({ status: ev.outcome, respondedAt: resolvedAt })
              .where(and(
                eq(sessionPendingQuestions.id, ev.id),
                eq(sessionPendingQuestions.sessionId, this.id),
                eq(sessionPendingQuestions.status, 'pending'),
              )).run();
          }
        } catch {}
        this._broadcast({
          type: 'interaction_resolved', kind: ev.kind, id: ev.id,
          outcome: ev.outcome,
        });
        markInteractionResolvedInTelegram(ev.kind, ev.id);
        break;
      }
      case 'bg_task': {
        if (this._replayAlreadyPersisted(ev)) break;
        // Background-task lifecycle (agent >= 0.13.0): started / updated /
        // finished, from the SDK's Task*Message stream. Persist as an 'event'
        // row so rebuildStateFromMessages reconstructs the BgTasks registry
        // after any refetch, and broadcast for the live path. Not rendered as
        // a chat bubble (the assistant's own follow-up text tells the story);
        // high-volume routing (focused conn) like the rest of the turn stream.
        const payload = {
          type: 'bg_task' as const,
          kind: ev.kind,
          taskId: ev.task_id,
          ...(ev.description !== undefined ? { description: ev.description } : {}),
          ...(ev.tool_use_id !== undefined ? { toolUseId: ev.tool_use_id } : {}),
          ...(ev.task_type !== undefined ? { taskType: ev.task_type } : {}),
          ...(ev.status !== undefined ? { status: ev.status } : {}),
          ...(ev.output_file !== undefined ? { outputFile: ev.output_file } : {}),
          ...(ev.summary !== undefined ? { summary: ev.summary } : {}),
          ...(ev.workflow_name !== undefined ? { workflowName: ev.workflow_name } : {}),
          ...(ev.owned_by_subagent === true ? { ownedBySubagent: true } : {}),
          // The SDK's own terminal verdict (agent >= 0.36.0). Persisted with
          // the row so a rebuild-from-history gets the same answer the live
          // path did — the whole point of §14.91's "one oracle".
          ...(ev.terminal !== undefined ? { terminal: ev.terminal } : {}),
        };
        this._broadcast(withRowId(payload, this._persist('event', payload)));
        // …and keep the running-task registry current: it decides whether the
        // NEXT stop means "finished" or "still has background work" (§14.91),
        // and whether an already-stopped session is done now.
        this._trackBgTask(payload.taskId, payload);
        if (this.kind === 'codex'
          && (ev.task_type === 'codex_subagent' || ev.task_type === 'codex_collab')) {
          const previous = this.codexBgChecks.get(ev.task_id);
          this.codexBgChecks.set(ev.task_id, {
            revision: (previous?.revision ?? 0) + 1,
            since: ev.kind === 'started' ? (ev.ts ?? Date.now() / 1000) : (previous?.since ?? 0),
          });
          this._scheduleCodexBgCheck();
        }
        break;
      }
      case 'bg_task_progress': {
        // Transient per-task progress (§14.54): a running task's live usage +,
        // for a Workflow run, the per-sub-agent fan-out. NO DB write (would
        // bloat history like the old edit_snapshot egress incident, §14.41) —
        // broadcast-only to the focused SSE conn (high-volume), mirroring
        // `usage`. Never replayed; the client patches the live registry.
        this._broadcast({
          type: 'bg_task_progress',
          taskId: ev.task_id,
          ...(ev.description !== undefined ? { description: ev.description } : {}),
          ...(ev.last_tool_name !== undefined ? { lastToolName: ev.last_tool_name } : {}),
          ...(ev.workflow_name !== undefined ? { workflowName: ev.workflow_name } : {}),
          ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
          ...(ev.agents !== undefined ? { agents: ev.agents } : {}),
          ...(ev.phases !== undefined ? { phases: ev.phases } : {}),
        });
        break;
      }
      case 'edit_snapshot': {
        if (this._replayAlreadyPersisted(ev)) break;
        // phase 'before'/'after' (Claude, content-based) OR 'diff' (Codex:
        // `diff` holds a unified diff, content is null — see codex_session.py).
        // Persist the `diff` when present so the lazy /edits route can serve it
        // (the main GET strips both content AND diff for egress, §14.41). The
        // outgoing WorkerEvent type (BridgeEvent, locked) doesn't model
        // phase='diff'/`diff`, so we cast on broadcast — the client handles it.
        const snap: Record<string, unknown> = {
          type: 'edit_snapshot', phase: ev.phase, tool_use_id: ev.tool_use_id,
          file_path: ev.file_path, content: ev.content, size: ev.size, truncated: ev.truncated,
        };
        if (ev.diff !== undefined) snap.diff = ev.diff;
        const snapRow = this._persist('edit_snapshot', snap);
        this._broadcast(withRowId(snap, snapRow) as unknown as WorkerEvent);
        break;
      }
      case 'mode_changed':
        this.permissionMode = ev.mode as PermissionMode;
        try {
          db.update(agentSessions).set({ permissionMode: ev.mode })
            .where(eq(agentSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'mode_changed', mode: this.permissionMode });
        break;
      case 'model_changed':
        // Agent confirmed: store + persist + broadcast. The actual SDK
        // change happens at the next start (sleep+resume) — applied_at_next_start
        // in the payload tells the UI whether to label this as deferred.
        this.model = ev.model ?? null;
        this.fallbackModel = ev.fallback_model ?? null;
        try {
          db.update(agentSessions).set({
            model: this.model, fallbackModel: this.fallbackModel,
          }).where(eq(agentSessions.id, this.id)).run();
        } catch {}
        this.pendingApply.model = !!ev.applied_at_next_start;
        this._broadcast({
          type: 'model_changed',
          model: this.model,
          fallbackModel: this.fallbackModel,
          appliedAtNextStart: !!ev.applied_at_next_start,
        });
        break;
      case 'effort_changed':
        this.effort = isValidEffortForKind(ev.effort, this.kind, this.customEndpoint) ? (ev.effort as AnyEffort) : null;
        try {
          db.update(agentSessions).set({ effort: this.effort })
            .where(eq(agentSessions.id, this.id)).run();
        } catch {}
        this.pendingApply.effort = !!ev.applied_at_next_start;
        this._broadcast({
          type: 'effort_changed',
          // BridgeEvent.effort_changed (locked) types effort as EffortLevel|null;
          // a Codex effort passes through at runtime.
          effort: this.effort as EffortLevel | null,
          appliedAtNextStart: !!ev.applied_at_next_start,
        });
        break;
      case 'effective_model':
        // Agent emits this on change only. Cache + persist + broadcast. The
        // DB write makes it survive Charon restarts (getOrCreateStream
        // hydrates it back), which matters because every flushed assistant
        // row is stamped with this value (per-message model attribution) and
        // the agent will NOT re-emit after a hub restart unless the model
        // actually changes. Replayed occurrences are fine: they arrive in
        // order, so the last one wins — same end state as live.
        if (typeof ev.model === 'string' && ev.model.length > 0
            && ev.model !== this.effectiveModel) {
          // Stamp any text buffered BEFORE the switch with the OLD model: a
          // mid-turn model change (fallback kicking in) must not retroactively
          // relabel text the previous model produced. Flush failed → do NOT
          // switch (the restored buffer would be mislabeled with the NEW
          // model at its retry); the replay redoes flush-then-switch.
          if (!this._flushAssistant()) break;
          this.effectiveModel = ev.model;
          try {
            db.update(agentSessions).set({ effectiveModel: ev.model })
              .where(eq(agentSessions.id, this.id)).run();
          } catch {}
          this._broadcast({ type: 'effective_model', model: ev.model });
        } else if (this.isReplaying && typeof ev.model === 'string' && ev.model.length > 0) {
          // Replayed switch the hub already applied (cursor lagged behind it):
          // the live run flushed here, so the text before it must not merge
          // into the text after it (and get relabelled with the new model).
          this._dropReplayedAssistantBuffer({ exact: true });
        }
        break;
      case 'endpoint_usage':
        if (!this._replayAlreadyPersisted(ev)) {
          this._persist('event', {
            type: 'endpoint_usage', requestId: ev.request_id,
            inputTokens: ev.input_tokens, outputTokens: ev.output_tokens,
            totalTokens: ev.total_tokens, partial: !!ev.partial,
          });
        }
        // Debounced: a replay of N requests used to fold the session N times.
        this._scheduleTokenUsageBroadcast();
        break;
      case 'usage':
        // Intermediate counters stay transient/high-volume. The one final
        // frame is different: persist one provider-neutral turn_usage row so
        // Claude and Codex accounting survives a browser/hub restart and can
        // be compared from the same DB representation. It remains invisible
        // in the transcript; sessionRebuild intentionally ignores it.
        if (ev.final && !this._replayAlreadyPersisted(ev)) {
          const turnUsageRow = this._persist('event', {
            type: 'turn_usage', provider: this.kind,
            outputTokens: ev.output_tokens,
            inputTokens: ev.input_tokens ?? 0,
            cacheReadTokens: ev.cache_read_tokens ?? 0,
            cacheWriteTokens: ev.cache_write_tokens ?? 0,
            durationMs: ev.duration_ms ?? 0,
            ...(ev.duration_api_ms != null ? { durationApiMs: ev.duration_api_ms } : {}),
            costUsd: ev.cost_usd ?? null,
            ...(ev.endpoint_accounted ? { endpointAccounted: true } : {}),
            ...(ev.tree ? { tree: ev.tree } : {}),
            ...(ev.turn_cache ? { cache: ev.turn_cache } : {}),
          });
          // turn_usage rows count in the session totals too (legacy turns).
          if (turnUsageRow !== false) this._scheduleTokenUsageBroadcast();
          this._recordPromptCache(ev);
        }
        // Fan every frame to the focused SSE connection so ThinkingBar can
        // show the growing output counter. Intermediate frames never touch DB.
        this._broadcast({
          type: 'usage',
          output_tokens: ev.output_tokens,
          input_tokens: ev.input_tokens,
          cache_read_tokens: ev.cache_read_tokens,
          cache_write_tokens: ev.cache_write_tokens,
          final: ev.final,
          duration_ms: ev.duration_ms,
          cost_usd: ev.cost_usd,
          sdk_throughput: ev.sdk_throughput,
          // Whole-tree totals (agent >= 0.36.0): the flat fields above are the
          // main thread only, so a Workflow session's real spend was invisible.
          tree: ev.tree,
          ...(!this.isReplaying ? { turn_tools: this.turnTools ??= this._turnToolCount() } : {}),
        });
        break;
      case 'compaction': {
        if (!this.isReplaying) this._setCompacting(false);
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        // A bubble boundary (lib/assistantBoundaries.ts): the text before the
        // marker persists first, so the marker sorts after it.
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        // The CLI just summarised the conversation away. Our transcript keeps
        // every message, so this is not a loss — but from here the model no
        // longer remembers what is above, and without a marker that reads as
        // "the session went stupid". Durable (role='event', already listed in
        // NON_PAGINATED_ROLES) so it keeps its place after a refetch.
        const payload = {
          type: 'compaction' as const,
          ...(ev.trigger !== undefined ? { trigger: ev.trigger } : {}),
          ...(ev.pre_tokens !== undefined ? { preTokens: ev.pre_tokens } : {}),
          ...(ev.post_tokens !== undefined ? { postTokens: ev.post_tokens } : {}),
        };
        this._broadcast(withRowId(payload, this._persist('event', payload)));
        break;
      }
      case 'session_info':
        // The CLI's init frame. Kept in memory only: it describes the CURRENT
        // CLI process, so persisting it would let a stale snapshot outlive the
        // process it described. `capabilities` is the sanctioned way to ask
        // "does this CLI support X" (CLI >= 2.1.205) instead of comparing
        // version strings.
        this.sessionInfo = {
          ...(this.sessionInfo ?? {}),
          // Merge, don't replace: the init frame and the model catalog arrive
          // as two separate emissions of the same event.
          ...(ev.capabilities !== undefined ? { capabilities: ev.capabilities } : {}),
          ...(ev.slash_commands !== undefined ? { slashCommands: ev.slash_commands } : {}),
          ...(ev.tools !== undefined ? { tools: ev.tools } : {}),
          ...(ev.plugins !== undefined ? { plugins: ev.plugins } : {}),
          ...(ev.model_efforts !== undefined ? { modelEfforts: ev.model_efforts } : {}),
          ...(ev.models !== undefined ? { models: ev.models } : {}),
        };
        this._broadcast({ type: 'session_info', ...this.sessionInfo });
        break;
      case 'external_message': {
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        // A message relayed from ANOTHER agent (§14.x cross-session). It is a
        // real turn driver — the session acts on it — so it belongs in the
        // transcript, but it must not look like something the user typed:
        // `origin` is carried through and the bubble is rendered distinctly.
        const payload = {
          type: 'external_message' as const,
          origin: ev.origin,
          text: ev.text,
          // Who sent it. The transcript's first question about a message
          // nobody in this session typed is "who asked me this".
          ...(ev.from ? { from: ev.from } : {}),
          ...(ev.from_provider ? { fromProvider: ev.from_provider } : {}),
          ...(ev.source_session_id ? { sourceSessionId: ev.source_session_id } : {}),
          ...(ev.message_id ? { messageId: ev.message_id } : {}),
          ...(ev.conversation_id ? { conversationId: ev.conversation_id } : {}),
          ...(ev.reply_to ? { replyTo: ev.reply_to } : {}),
          ...(ev.expects_reply !== undefined ? { expectsReply: ev.expects_reply } : {}),
        };
        this._broadcast(withRowId(payload, this._persist('event', payload)));
        break;
      }
      case 'peer_spawn_request': {
        // Hub-internal and transient: no row, no frame, no replay identity.
        void handlePeerSpawnRequest(this.id, ev).catch((e) => {
          console.warn(`[sub-sessions] spawn request failed: ${(e as Error)?.message ?? e}`);
        });
        break;
      }
      case 'peer_message_status': {
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        const payload = {
          type: 'peer_message_status' as const,
          messageId: ev.message_id,
          conversationId: ev.conversation_id,
          ...(ev.target_session_id ? { targetSessionId: ev.target_session_id } : {}),
          ...(ev.target ? { target: ev.target } : {}),
          ...(ev.target_provider ? { targetProvider: ev.target_provider } : {}),
          ...(ev.text ? { text: ev.text } : {}),
          status: ev.status,
          ...(ev.error ? { error: ev.error } : {}),
          ...(ev.reply_id ? { replyId: ev.reply_id } : {}),
        };
        this._broadcast(withRowId(payload, this._persist('event', payload)));
        break;
      }
      case 'turn_end': {
        if (this._replayAlreadyPersisted(ev)) break;
        // The Stop hook's verdict on what is STILL RUNNING (agent >= 0.37.0).
        // §14.91's registry is a RECONSTRUCTION — burial rows, three triggers,
        // a 24h age cap, two terminal-word lists — of a fact the process that
        // owns those tasks can simply state. Treat it as authoritative and
        // reconcile: anything we still believe is running but the CLI did not
        // list has ended without us seeing its terminal event, which is exactly
        // the case that pinned sessions violet forever.
        if (Array.isArray(ev.background_tasks)) {
          this.hasRunningBgTasks();                    // ensure loaded
          const alive = new Set(ev.background_tasks);
          const running = this.bgRunning!;
          const eligible = running.size ? this._bgTasksBeforeCurrentEvent() : null;
          let hidden: Set<string> | null = null;      // read only if needed
          let changed = false;
          for (const taskId of [...running.keys()]) {
            if (!alive.has(taskId) && (eligible == null || eligible.has(taskId))) {
              // A sub-agent's own command is outside the hook's view: its
              // absence is not an ending while its owner may still run.
              hidden ??= bgTasksHiddenFromStopHook(this.id, alive, running.keys());
              if (hidden.has(taskId)) continue;
              const payload = { type: 'bg_task' as const, kind: 'finished' as const,
                taskId, status: 'completed', terminal: true };
              // Persist the receipt and send it to the bar too. An in-memory
              // deletion resurrected this task at the next GET/hub restart.
              const receiptRow = this._persist('event', payload);
              if (receiptRow !== false) {
                this._broadcast(withRowId(payload, receiptRow));
                running.delete(taskId);
                changed = true;
              }
            }
          }
          // Order between the hook and the ResultMessage is not guaranteed. If
          // `stop` already ran and parked us in `background`, correct it now;
          // if it has not, it will simply read a registry that is already right.
          if (changed) this._announceBgCount();
          if (changed && running.size === 0) this._onLastBgTaskEnded();
        }
        // The CLI's scheduled tasks, same authority (lib/scheduledTasks.ts).
        if (Array.isArray(ev.scheduled_tasks)) {
          try {
            if (recordScheduledTasks(this.id, ev.scheduled_tasks, ev.schedule_tz, this.currentEventTs ?? Date.now())) {
              markSummaryDirty(this.id);
            }
          } catch (e) {
            console.warn(`[session ${this.id}] scheduled tasks not recorded:`, e);
          }
        }
        break;
      }
      case 'unprompted_turn': {
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        // A turn the CLI opened by itself, not a background wake-up: a
        // scheduled task fired. Its prompt is in no stream message, so without
        // this row the answer comes from nowhere. The task is the one this
        // prompt opens, else the one that was due (lib/scheduledTasks.ts);
        // none ⇒ something else opened it, and nothing is written.
        const at = this.currentEventTs ?? Date.now();
        let task: ScheduledTask | null = null;
        let opened = false;   // the opener's own text IS this task's prompt
        try {
          const tasks = readScheduledTasks(this.id)?.tasks ?? [];
          task = ev.prompt ? matchFiredTask(tasks, ev.prompt) : null;
          opened = !!task;
          task ??= dueScheduledTask(tasks, at, this.firedScheduledTasks);
        } catch {}
        if (!task) break;
        if (!this._flushAssistant()) break; // order-preserving stop (16.3)
        // A failed turn sends no turn_end, so the list keeps this fire's
        // nextFireAt: never name it twice.
        this.firedScheduledTasks.add(fireKey(task));
        const payload = {
          type: 'scheduled_fire' as const,
          source: 'schedule',
          prompt: opened && ev.prompt ? ev.prompt : task.prompt,
          taskId: task.id, schedule: task.schedule, recurring: task.recurring,
        };
        this._broadcast(withRowId(payload, this._persist('event', payload)));
        break;
      }
      case 'rate_limit':
        // Free rate-limit state off the stream (agent >= 0.37.0): "am I limited
        // right now, and when does the window reset". The top-level
        // `utilization` is null on a subscription account; `windows` (agent >=
        // 0.98.0) carries the 5h/7d percentages and goes straight to the
        // account gauges — replayed events included, the ingest drops any
        // reading older than what it shows. §14.72.
        this.latestLimitResetAtMs = normalizeResetAtMs(ev.resets_at) ?? this.latestLimitResetAtMs;
        if (ev.windows && this.kind === 'claude') {
          // Unstamped (agent <0.103.3) ⇒ the stream's own profile, never the VPS
          // default: one account's windows must not repaint another's (§14.58).
          try { hubHooks().usageWindowsHandler?.(this.vpsId, ev.windows, this.currentEventTs ?? Date.now(), ev.account_profile ?? this.accountProfile, ev.account_key); } catch {}
        }
        this._broadcast({
          type: 'rate_limit',
          status: ev.status, window: ev.window,
          resets_at: ev.resets_at, utilization: ev.utilization,
          overage_status: ev.overage_status,
        });
        break;
      case 'turn_error':
        // Typed failure (agent >= 0.36.0), the same fact §14.65 infers from
        // prose. Layered, not substituted: the regex path still runs for older
        // agents, and both converge on the idempotent flag write.
        this.pendingTurnErrorKind = ev.kind;
        if (/auth/i.test(ev.kind)) this._flagProviderLoggedOut();
        this._broadcast({ type: 'turn_error', kind: ev.kind });
        break;
      case 'stop': {
        // A re-delivered stop older than the open buffer ended an EARLIER
        // turn, handled already: it neither finalizes nor resets the live
        // turn, and no `stop` frame cuts the answer streaming now.
        if (this._replayPrecedesOpenAssistant()) break;
        this.liveToolOutput.clear();
        if (!this.isReplaying) this._setCompacting(false);
        this.peerDrivenFinish = ev.peer_request_id !== undefined
          ? !!ev.peer_request_id : this._peerTurnFromHistory();
        const assistantFlushed = this._flushAssistant();
        // A replayed stop whose live flush had failed keeps the buffer going
        // (its row is longer): nothing to finalize here, as live.
        const finalAssistantId = assistantFlushed && !this.currentAssistant ? this._finalizeAssistantTurn() : null;
        const turnUsage = this._attachTurnLedger(finalAssistantId);
        // The typed outcome (agent >= 0.36.0) OUTRANKS the prose classifier.
        // Measured on the fleet: a failed turn still reports
        // subtype='success' while is_error is true and terminal_reason is
        // 'api_error' — so `subtype`, the only non-prose signal the hub used
        // to have, actively lies. When the CLI says the turn errored, that is
        // the answer, whether or not the model happened to phrase it in a way
        // §14.65's regex recognises. The prose path stays for older agents and
        // supplies the human-readable text when it did match.
        // Codex reports SDK/app-server turn failures as subtype='error'. It
        // does not have Claude's ResultMessage.is_error/terminal_reason
        // fields, so ignoring subtype here turned a real Codex failure into a
        // successful finish notification followed by an idle session.
        const typedFailure = ev.is_error === true
          || ev.terminal_reason === 'api_error'
          || ev.subtype === 'error'
          || this.pendingAgentError?.fatal === true;
        const assistantTerminalError = this.pendingTerminalAssistantError;
        const typedErrorText = this.pendingAgentError?.msg ?? this.terminalErrorText
          ?? `The turn ended with an API error${ev.api_error_status ? ` (${ev.api_error_status})` : ''}.`;
        const typedErrorKind = typedFailure
          ? classifySessionError({
              provider: this.kind,
              message: typedErrorText,
              turnFailure: true,
              hint: this.pendingTurnErrorKind,
              apiStatus: ev.api_error_status,
            }).kind
          : null;
        const terminalError = assistantTerminalError
          ?? (typedFailure && typedErrorKind
            ? { text: typedErrorText, kind: typedErrorKind }
            : null);
        const turnSawAssistant = this.pendingTurnAssistantSeen;
        // The finish dedup (below): a stop at or below the last one handled
        // was processed already — by this process or a previous one.
        const stopSeq = typeof ev.seq === 'number' ? ev.seq : null;
        // After a seq-epoch reset the recreated log's seqs restart below the
        // old cursor: the floor (newest row ts at the reset) keeps the reset
        // replay from re-finishing stops this hub already handled. A LIVE
        // stop is new by construction: the floor only filters replayed ones.
        const isNewFinish = (stopSeq == null
          ? !this.isReplaying
          : (this.lastStopNotifiedSeq == null || stopSeq > this.lastStopNotifiedSeq))
          && (!this.isReplaying || this.stopNotifyFloorTsMs == null
            || (this.currentEventTs ?? 0) > this.stopNotifyFloorTsMs);
        // A REPLAYED stop already handled is status-neutral: its turn-end
        // status was applied when it was processed, and later events
        // superseded it. Re-applied, an old failed turn re-latched 'failed'
        // (DB + broadcast) on a session that had recovered, and the agent's
        // post-subscribe `active` could not clear it; an old stop with bg
        // tasks live painted a running session `background`. A stop the hub
        // never handled (it was down) still applies, replay or not.
        const alreadyFinished = this.isReplaying && stopSeq != null && !isNewFinish;
        const recoveredFromFailed =
          !alreadyFinished && !terminalError && turnSawAssistant && this.status === 'failed';
        // Claude's synthetic failure is already a durable assistant bubble.
        // Every other failed stop needs its own durable provider-neutral error
        // row; this is the path Codex previously lacked entirely.
        if (typedFailure && (!assistantTerminalError || assistantTerminalError.kind === 'rate_limit') && !this.pendingBlockingErrorRecorded) {
          this._recordBlockingError(
            terminalError?.text,
            {
              turnFailure: true,
              hint: this.pendingTurnErrorKind,
              apiStatus: ev.api_error_status,
            },
          );
        }
        this.pendingTerminalAssistantError = null;
        this.pendingAgentError = null;
        this.pendingTurnErrorKind = null;
        this.pendingBlockingErrorRecorded = false;
        this.pendingBlockingErrorAt = null;
        this.pendingTurnAssistantSeen = false;
        // The turn ended, but background work it launched may outlive it: that
        // session is neither working nor finished, and calling it finished is
        // what put a green "done" on sessions that were still busy (§14.91). A
        // failed turn still wins — it is the more urgent thing to report.
        const bgPending = !alreadyFinished && !terminalError && this.hasRunningBgTasks();
        if (terminalError && !alreadyFinished) {
          this.terminalErrorLatched = true;
          this.terminalErrorText = terminalError.text;
          this.terminalErrorKind = terminalError.kind;
          this.status = 'failed';
        } else if (!alreadyFinished) {
          if (recoveredFromFailed) {
            // During replay, historical status frames (including `thinking`) are
            // intentionally ignored. A later genuine assistant answer + stop is
            // therefore the durable proof that the old failed turn recovered.
            this.clearTerminalErrorLatch();
          }
          if (bgPending) this.status = 'background';
          else if (recoveredFromFailed) this.status = 'active';
        }
        const stopStatus: WorkerStatus | null = alreadyFinished ? null
          : terminalError ? 'failed'
          : bgPending ? 'background'
          : recoveredFromFailed ? 'active' : null;
        // The normal live finish: the hub says `active` itself, right after
        // `stop`, so in-app green never trails a push (G6). The agent's own
        // `active` (<100 ms later) is an idempotent repeat.
        const synthActive = !this.isReplaying && stopStatus == null
          && (this.status === 'thinking' || this.status === 'starting');
        if (synthActive) this.status = 'active';
        const writtenStatus: WorkerStatus | null = stopStatus ?? (synthActive ? 'active' : null);
        try {
          db.update(agentSessions).set({
            lastUsedAt: Math.floor(Date.now() / 1000),
            ...(writtenStatus ? { status: writtenStatus } : {}),
            ...(synthActive ? { resumePending: 0 } : {}),
          })
            .where(eq(agentSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'stop', subtype: ev.subtype, finalAssistantId, ...(turnUsage ? { turnUsage } : {}) });
        if (writtenStatus) {
          this._broadcast({ type: 'status', status: writtenStatus });
        }
        // Order (§14.47): stop → status → unread (DB + `session_unread`) →
        // finish cursor → usage poll → push → Telegram. The in-app marker
        // must never trail a push.
        //
        // Passive in-app "finished, unread" marker (CLAUDE.md §14.47). Light
        // it on every genuinely-new finish, on screen or not: it stays lit
        // until the user leaves it. Unlike the push below we do NOT require
        // !isReplaying:
        // a finish first learned about via replay (Charon was down when the
        // agent finished) is a real unread finish, and a silent DB flag has
        // no notification-storm concern. The seq dedup in `isNewFinish` + the
        // advance below keep later reconnect-replays from re-marking it.
        // The green unread marker and final background-work notice still
        // wait for the last task (§14.91).
        if (isNewFinish && !bgPending && (terminalError || !this.peerDrivenFinish)) {
          try {
            db.update(agentSessions).set({ unreadStop: 1 })
              .where(eq(agentSessions.id, this.id)).run();
          } catch {}
          this._broadcast({ type: 'session_unread', unread: true });
        }
        // Dedup the "finished" push. Without this, every agent re-subscribe
        // (Charon reboot / SSH reconnect) replays past `stop` events and
        // re-notifies the user for sessions that finished long ago.
        // Rule: never push during replay; otherwise only push a stop whose
        // seq is strictly greater than the last we notified, then advance
        // the marker (persisted to DB so it survives restarts). We advance
        // the marker even for replayed stops so a later replay can't
        // re-notify them. Agents without seq (< 0.4.0) fall back to the
        // isReplaying guard alone.
        if (stopSeq != null && (this.lastStopNotifiedSeq == null || stopSeq > this.lastStopNotifiedSeq)) {
          this.lastStopNotifiedSeq = stopSeq;
          try {
            db.update(agentSessions).set({ lastStopNotifiedSeq: stopSeq })
              .where(eq(agentSessions.id, this.id)).run();
          } catch {}
        }
        // A turn finished → the account quota just moved; refresh the usage
        // gauges (debounced + endpoint-rate-limit-aware in usagePoll). Live
        // stops only — a reconnect replay of old stops must not spam the
        // /usage endpoint. cf. CLAUDE.md §14.58.
        if (!this.isReplaying) {
          try {
            if (this.kind === 'codex') hubHooks().codexUsagePollTrigger?.(this.vpsId, this.accountProfile);
            else hubHooks().usagePollTrigger?.(this.vpsId, this.accountProfile);
          } catch {}
        }
        // Announce the response even while tasks remain, with their count.
        if (!this.isReplaying && isNewFinish && !this.fatalErrorNotified
          && (terminalError || !this.peerDrivenFinish)) {
          const terminalError = this.terminalErrorLatched;
          const providerLabel = providerDisplayName(this.kind);
          const bgCount = bgPending ? bgWorkCount(this.id, this.bgRunning!) : 0;
          const finishedBody = `${providerLabel} finished its response${bgCount > 0
            ? ` — ${bgCount} background task${bgCount === 1 ? '' : 's'} still running`
            : ''}`;
          const terminalErrorLabel = this.terminalErrorKind === 'authentication'
            ? 'an authentication error'
            : this.terminalErrorKind === 'rate_limit'
              ? 'a rate-limit error'
              : 'an API error';
          const event: NotificationEvent = terminalError ? 'session_error'
            : bgPending ? 'session_background' : 'session_finished';
          this._maybePush(terminalError ? {
            event,
            title: `⚠ ${this.vpsName} · ${this._label()}`,
            body: `${providerLabel} ended with ${terminalErrorLabel}`,
            tag: `stop-${this.id}`,
          } : {
            event,
            title: `✓ ${this.vpsName} · ${this._label()}`,
            body: finishedBody,
            tag: `stop-${this.id}`,
          });
          sendPlainToTelegram(
            terminalError
              ? `⚠ ${this.vpsName} · ${this._label()}\n${providerLabel} ended with ${terminalErrorLabel}\n${(this.terminalErrorText ?? '').trim().split('\n')[0].slice(0, 300)}`
              : `✓ ${this.vpsName} · ${this._label()}\n${finishedBody}`,
            `/?session=${this.id}`, event,
          ).catch(() => {});
        }
        break;
      }
      case 'interrupted':
        this._broadcast({ type: 'mode_changed', mode: this.permissionMode }); // free-form
        break;
      case 'error':
        this._log('error', 'sdk_error', { msg: ev.msg, fatal: !!ev.fatal });
        // A provider retry is not the turn's error: if the retries run out, a
        // non-retrying error follows and names the failure.
        if (ev.retrying !== true) this.pendingAgentError = { msg: ev.msg, fatal: ev.fatal === true };
        this._broadcast({ type: 'error', msg: ev.msg, fatal: ev.fatal, ...(ev.retrying === true ? { retrying: true } : {}) });
        // Fatal means the SDK/session itself cannot continue and there may be
        // no following stop event. Persist now; a later stop is deduped by the
        // per-turn flag and replay identity.
        if (ev.fatal === true && !this.pendingBlockingErrorRecorded) {
          const recorded = this._recordBlockingError(ev.msg, {
            fatal: true,
            turnFailure: false,
            hint: this.pendingTurnErrorKind,
          });
          // A crash is a finish too: the durable marker turns it red until
          // read (lib/sessionAttention.ts `error`, §14.47). `recorded` is
          // its replay dedup (a NEW error row), so like a failed stop, a crash
          // first learned via replay still counts. Before the push (G6).
          if (recorded) {
            try {
              db.update(agentSessions).set({ unreadStop: 1 })
                .where(eq(agentSessions.id, this.id)).run();
            } catch {}
            this._broadcast({ type: 'session_unread', unread: true });
          }
          if (recorded && !this.isReplaying && !this.fatalErrorNotified) {
            this.fatalErrorNotified = true;
            const title = `⚠ ${this.vpsName} · ${this._label()}`;
            this._maybePush({ event: 'session_error', title, body: ev.msg.slice(0, 300), tag: `stop-${this.id}` });
            sendPlainToTelegram(`${title}\n${ev.msg.slice(0, 300)}`, `/?session=${this.id}`, 'session_error').catch(() => {});
          }
        }
        break;
    }
  }

  // ── Actions (forwarded to the agent) ─────────────────────────────────────
  /** Persist + echo + send one user input. `clientMessageId` (the browser's
   *  UUID for a composer send, else a fresh one) is the agent's idempotency
   *  key AND rides the `user_echo`, so the browser reconciles its optimistic
   *  bubble by identity. A repeated id (a POST retried after an ambiguous
   *  failure) only re-sends `send_input` — the agent dedups it — and returns
   *  the row the first call wrote. `rowId`: a user row the caller persisted
   *  itself (scheduled resume), named on the echo. Returns the user row id
   *  (null when none was written). */
  async sendUserMessage(
    content: string,
    codexInputs?: Array<Record<string, unknown>>,
    opts?: { persist?: boolean; broadcastUser?: boolean; clientMessageId?: string; rowId?: number },
  ): Promise<{ rowId: number | null }> {
    await (await loadEndpointOps()).applyPendingEndpoint(this.id);

    const client = getAgentClientForVpsId(this.vpsId);
    const clientMessageId = opts?.clientMessageId ?? crypto.randomUUID();
    const known = this.recentClientMessages.get(clientMessageId);
    let rowId: number | null = known ?? opts?.rowId ?? null;
    // The optimistic `thinking` below is memory + bus only (the agent's echo
    // writes the DB). A send that fails for good reverts it (S4, C13): left
    // alone it stuck the session `thinking` everywhere until the agent spoke.
    let optimisticFrom: WorkerStatus | null = null;
    const revertOptimistic = () => {
      if (optimisticFrom != null && optimisticFrom !== 'thinking' && this.status === 'thinking') {
        setSessionStatusLocal(this.id, optimisticFrom, { persist: false });
      }
    };
    if (known == null) {
      this.clearTerminalErrorLatch();
      if (opts?.persist !== false) {
        const persisted = this._persist('user', content);
        if (persisted !== false) {
          rowId = persisted;
          this.recentClientMessages.set(clientMessageId, persisted);
          if (this.recentClientMessages.size > RECENT_CLIENT_MESSAGES_MAX) {
            this.recentClientMessages.delete(this.recentClientMessages.keys().next().value!);
          }
        }
      }
      const now = Math.floor(Date.now() / 1000);
      if (opts?.broadcastUser !== false) {
        this._broadcast(withRowId({ type: 'user_echo' as const, content, createdAt: now, clientMessageId }, rowId));
      }
      optimisticFrom = this.status;
      this.status = 'thinking';
      this._broadcast({ type: 'status', status: 'thinking' });
      // The user is engaged with this session: whatever finish it showed is read.
      markSessionRead(this.id);
    }
    // Idempotency key (P1.1): the agent (>= 0.19.0) records the id once the
    // input was ACCEPTED and answers {duplicate:true} on a re-send — so the
    // ambiguous-timeout case ("did my prompt land?") can be retried without
    // ever executing the prompt twice. Older agents ignore the extra param
    // (retry then risks a duplicate, same as before — strictly no worse).
    const params = {
      session_id: this.id, content,
      client_message_id: clientMessageId,
      ...(codexInputs?.length ? { codex_inputs: codexInputs } : {}),
    };
    try {
      await client.call('send_input', params);
    } catch (e) {
      const msg = String((e as { message?: unknown })?.message ?? e);
      // AMBIGUOUS timeout: the RPC may or may not have been delivered.
      // Retry once with the SAME id — the agent-side dedup makes this safe.
      if (/timeout on send_input/i.test(msg)) {
        try {
          await client.call('send_input', params);
        } catch (retryErr) {
          revertOptimistic();
          throw retryErr;
        }
        return { rowId };
      }
      // Auto-recover from a status DESYNC: the agent refuses input on a
      // non-running session — session.py raises "not running (status=sleeping)"
      // (or session dead / not found, -32000/-32001) when the session slept
      // behind the UI's back (other tab/device, idle, post-restart desync)
      // while it still looked usable here. Rather than 500-ing, RESUME and
      // retry ONCE so the message just lands. A genuine failure (cwd gone,
      // agent unreachable) still throws → the UI flips to the "resume" CTA.
      // cf. CLAUDE.md §14.49. (Same client_message_id: if the first attempt
      // somehow landed before the session slept, the retry dedups.)
      if (!/not running|not found|dead|-3200[01]/i.test(msg)) {
        revertOptimistic();
        throw e;
      }
      try {
        await resumeSession(this.id);   // starts/resumes the SDK session (re-reads model/effort, §14.35)
      } catch (resumeErr) {
        // The agent said the worker is not running and it could not be
        // brought back: its blocking gates can never be answered (D-13).
        cancelSessionBlockingGates(this.id);
        // Memory, DB and bus agree (S4): the list GET / SSE snapshot no
        // longer revert every tab to a stale live status.
        setSessionStatusLocal(this.id, 'sleeping');
        throw resumeErr;
      }
      // The resume SUCCEEDED: a failure of the retried send alone leaves the
      // status resumeSession established (the agent runs the session; a
      // timed-out input may even have landed) — never a durable 'sleeping'.
      await client.call('send_input', params);
    }
    return { rowId };
  }

  async sendInterrupt(): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('interrupt', { session_id: this.id });
  }

  /** A hub-originated status (setSessionStatusLocal): memory + this
   *  stream's broadcast (lane coalescer flushed first, frame order kept). */
  applyLocalStatus(status: WorkerStatus): void {
    // A non-live status ends the worker's tools, as the agent's own status
    // event does: no stale partial output served as `streamingToolOutput`.
    if (status === 'sleeping' || status === 'error' || status === 'killed') this.liveToolOutput.clear();
    this.status = status;
    this._broadcast({ type: 'status', status });
  }

  /** Publish an already-persisted scheduler card onto this session's SSE. */
  publishScheduledResume(messageId: number, content: string, createdAt: number): void {
    this._broadcast({ type: 'scheduled_resume', messageId, content, createdAt });
  }

  async forceStop(): Promise<void> {
    // Force the SDK to let go: the session switches to 'sleeping'
    // immediately on the agent side, we can resume just after. Used when
    // `interrupt` (soft) does nothing because a tool is stuck.
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('force_stop', { session_id: this.id });
    this.status = 'sleeping';
    this._broadcast({ type: 'status', status: 'sleeping' });
  }

  // mode is a Claude PermissionMode OR (for a codex session) a Codex sandbox
  // mode (read-only / workspace-write / accept-all). Passed straight to the
  // agent, which interprets it per kind.
  async setPermissionMode(mode: SessionMode): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('set_permission_mode', { session_id: this.id, mode });
    // The mode_changed event will come back and do the DB sync
  }

  /**
   * Change the model (and optionally the fallback) for this session.
   *
   * Takes effect at the NEXT SDK start (sleep + resume, or auto-resume after
   * Charon restart). The underlying claude-agent-sdk binds the model at
   * ClaudeSDKClient construction — there is no runtime swap. Pass null to
   * clear back to the global default.
   *
   * The agent persists the new value to its state.json and emits
   * `model_changed` (with `applied_at_next_start: true` when a live client
   * exists). Charon's _dispatchEvent handler does the DB write + broadcast.
   */
  async setModel(model: string | null, fallbackModel: string | null = null): Promise<void> {
    const row = db.select({ config: agentSessions.providerConfig }).from(agentSessions).where(eq(agentSessions.id, this.id)).get();
    const endpoint = connectionConfig(row?.config).customEndpoint;
    if (endpoint) {
      if (!model || model.length > 256) throw new Error('Enter a valid endpoint model ID.');
      await (await loadEndpointOps()).queueEndpoint(this.id, { ...endpoint, model });
      return;
    }
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('set_model', {
      session_id: this.id,
      model: model ?? null,
      fallback_model: fallbackModel ?? null,
    });
  }

  /**
   * Change the effort level for this session. Same deferred-apply semantics
   * as setModel — effort is also part of ClaudeAgentOptions. Pass null to
   * clear back to the global default. Invalid values are dropped agent-side.
   */
  async setEffort(effort: AnyEffort | null): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('set_effort', { session_id: this.id, effort: effort ?? null });
  }

  /**
   * Answer a permission card. `always` is Codex's native session grant;
   * Claude remembers through `suggestion`, the index of one of the CLI's own
   * "don't ask again" options on the card. A Claude answer that only says
   * `always` (Telegram) takes the first option offered, as the CLI's dialog
   * lists its best one first.
   */
  async respondPermission(
    permId: string, allow: boolean, always = false, suggestion?: number,
  ): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    const [row] = db.select().from(sessionPendingPermissions)
      .where(and(
        eq(sessionPendingPermissions.id, permId),
        eq(sessionPendingPermissions.sessionId, this.id),
      )).all();
    if (!row) throw new Error('permission request not found for this session');
    if (row.status !== 'pending') {
      // The asker still shows a gate some other path resolved (another
      // device, a frame it missed): publish the REAL outcome so every
      // surface drops the ghost, then refuse.
      this.publishResolution('permission', permId, gateOutcome(row.status));
      throw new Error('This approval has already expired or been resolved.');
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (row.expiresAt != null && row.expiresAt <= nowSeconds) {
      try {
        db.update(sessionPendingPermissions)
          .set({ status: 'expired', respondedAt: nowSeconds })
          .where(and(
            eq(sessionPendingPermissions.id, permId),
            eq(sessionPendingPermissions.sessionId, this.id),
            eq(sessionPendingPermissions.status, 'pending'),
          )).run();
      } catch {}
      this.publishResolution('permission', permId, 'expired');
      throw new Error('This approval has already expired and was automatically denied.');
    }

    let pick: number | undefined;
    if (allow && supportsSessionCapability(this.kind, 'permissionSuggestions')) {
      const offered = offeredSuggestions(row.suggestions);
      if (suggestion != null) {
        if (!offered.some((o) => o.index === suggestion)) {
          throw new Error('This option is not offered for this approval.');
        }
        pick = suggestion;
      } else if (always) {
        pick = offered[0]?.index;
      }
    }

    // The provider is authoritative. Keep the card pending until its RPC has
    // accepted the answer; otherwise an offline/timeout path leaves the SDK
    // blocked while every browser believes the interaction was resolved.
    const response = await client.call('respond_permission', {
      session_id: this.id, perm_id: permId, allow, always,
      ...(pick != null ? { suggestion: pick } : {}),
    });
    if ((response as { resolved?: boolean } | undefined)?.resolved === false) {
      this._retireRefusedGate('permission', permId);
      throw new Error('This approval has already expired or been cancelled.');
    }
    try {
      if (pick != null) {
        this._rememberAllowRules(allowRulesOf(parseSuggestions(row.suggestions)[pick]));
      }
      db.update(sessionPendingPermissions)
        .set({ status: allow ? 'allowed' : 'denied', respondedAt: Math.floor(Date.now() / 1000) })
        .where(and(
          eq(sessionPendingPermissions.id, permId),
          eq(sessionPendingPermissions.sessionId, this.id),
        )).run();
    } catch {}
    this.publishResolution('permission', permId, allow ? 'answered' : 'denied');
  }

  async respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void> {
    const row = db.select().from(sessionPendingQuestions).where(and(
      eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id),
    )).get();
    if (!row) throw new Error('Question not found in this session.');
    if (row.kind === 'async_question') {
      return this._respondAsyncQuestion(qid, answers);
    }
    if (row.status !== 'pending') {
      this.publishResolution('question', qid, gateOutcome(row.status));   // ghost card, cf. respondPermission
      throw new Error('This question has already been resolved.');
    }
    const client = getAgentClientForVpsId(this.vpsId);
    const response = await client.call('respond_question', { session_id: this.id, q_id: qid, answers });
    if ((response as { resolved?: boolean } | undefined)?.resolved === false) {
      this._retireRefusedGate('question', qid);
      throw new Error('This question has already expired or been cancelled.');
    }
    db.update(sessionPendingQuestions).set({
      status: answers ? 'answered' : 'cancelled',
      answers: answers ? JSON.stringify(answers) : null,
      respondedAt: Math.floor(Date.now() / 1000),
    }).where(and(eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id))).run();
    this._broadcast({
      type: 'interaction_resolved', kind: 'question', id: qid,
      outcome: answers ? 'answered' : 'cancelled',
    });
    markInteractionResolvedInTelegram('question', qid);
  }

  private asyncQuestionResponses = new Map<string, { answers: string; task: Promise<void> }>();

  private _respondAsyncQuestion(qid: string, answers: Record<string, string> | null): Promise<void> {
    const encodedAnswers = JSON.stringify(answers);
    const inflight = this.asyncQuestionResponses.get(qid);
    if (inflight) return inflight.answers === encodedAnswers ? inflight.task
      : Promise.reject(new Error('A response is already being delivered. Retry the same answers.'));
    const respond = async () => {
      const row = db.select().from(sessionPendingQuestions).where(and(
        eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id),
      )).get();
      if (!row || row.kind !== 'async_question') throw new Error('Question not found.');
      if (row.status !== 'pending') {
        if (row.answers === encodedAnswers) return; // response-lost POST retry
        throw new Error('This question has already been resolved.');
      }
      const content = asyncQuestionReply(JSON.parse(row.payload), answers);
      // Reserve the answer before transport. Retries after an ambiguous
      // timeout reuse both the same content and the agent's input dedup id.
      if (row.answers != null && row.answers !== encodedAnswers) {
        throw new Error('A response is already being delivered. Retry the same answers.');
      }
      db.update(sessionPendingQuestions).set({ answers: encodedAnswers })
        .where(and(eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id))).run();
      const clientMessageId = `async-question:${qid}`;
      const existing = db.select({ id: sessionMessages.id }).from(sessionMessages).where(and(
        eq(sessionMessages.sessionId, this.id), eq(sessionMessages.cliUuid, clientMessageId),
        eq(sessionMessages.role, 'user'),
      )).get();
      if (!existing) {
        const answerRow = this._persist('user', content, { cliUuid: clientMessageId });
        if (answerRow === false) throw new Error('Could not save the answers.');
        this._broadcast({ type: 'user_echo', content, createdAt: Math.floor(Date.now() / 1000), rowId: answerRow, clientMessageId });
      }
      await this.sendUserMessage(content, undefined, { persist: false, broadcastUser: false, clientMessageId });
      const outcome = answers ? 'answered' as const : 'cancelled' as const;
      const event = { type: 'interaction_resolved' as const, kind: 'question' as const, id: qid, outcome, answers };
      // A durable resolution advances the delta cursor even if SSE is lost.
      // Written outside the stream AFTER the send: a new Codex turn may
      // already be streaming reasoning into an open block — persist it first
      // so its row precedes this one (I8).
      this.persistExternal(() => db.transaction(() => {
        db.update(sessionPendingQuestions).set({ status: outcome, respondedAt: Math.floor(Date.now() / 1000) })
          .where(and(eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id))).run();
        db.insert(sessionMessages).values({ sessionId: this.id, role: 'event',
          content: JSON.stringify(event), tsMs: Date.now() }).run();
      }));
      this._broadcast(event);
    };
    // `delivering` (GET + summary) follows the in-flight send only: a failed
    // one leaves the form answerable (the reservation keeps retries identical).
    // Open views follow it live (`question_delivery`): a failed send leaves
    // no other frame, and a tab that loaded the window mid-send must see its
    // form answerable again.
    markAsyncQuestionDelivering(qid, true);
    markSummaryDirty(this.id);
    this._broadcast({ type: 'question_delivery', id: qid, delivering: true });
    const task = respond().finally(() => {
      this.asyncQuestionResponses.delete(qid);
      markAsyncQuestionDelivering(qid, false);
      markSummaryDirty(this.id);
      this._broadcast({ type: 'question_delivery', id: qid, delivering: false });
    });
    this.asyncQuestionResponses.set(qid, { answers: encodedAnswers, task });
    return task;
  }

  async respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback = ''): Promise<void> {
    const row = db.select({ status: sessionPendingQuestions.status }).from(sessionPendingQuestions).where(and(
      eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id),
      eq(sessionPendingQuestions.kind, 'exit_plan'),
    )).get();
    if (!row) throw new Error('Plan review not found in this session.');
    if (row.status !== 'pending') {
      this.publishResolution('exit_plan', qid, gateOutcome(row.status));   // ghost card, cf. respondPermission
      throw new Error('This plan review has already been resolved.');
    }
    // Pessimistic (§14.18): the provider accepts first; a failed RPC leaves
    // the row pending and publishes nothing. A REFUSAL (`resolved:false`) is
    // the provider's own "no such gate": retired as `cancelled`, published.
    const client = getAgentClientForVpsId(this.vpsId);
    const response = await client.call('respond_exit_plan', { session_id: this.id, q_id: qid, decision, feedback });
    if ((response as { resolved?: boolean } | undefined)?.resolved === false) {
      this._retireRefusedGate('exit_plan', qid);
      throw new Error('This plan review has already expired or been cancelled.');
    }
    try {
      db.update(sessionPendingQuestions).set({
        status: 'answered',
        answers: JSON.stringify({ decision, feedback }),
        respondedAt: Math.floor(Date.now() / 1000),
      }).where(and(eq(sessionPendingQuestions.id, qid), eq(sessionPendingQuestions.sessionId, this.id))).run();
    } catch {}
    this.publishResolution('exit_plan', qid, 'answered');
  }

  /** Publish a gate's resolution through this stream (lane coalescer flushed
   *  first) and retire its Telegram card. sessionOps § publishInteractionResolved
   *  routes a session id here when its stream is hydrated. */
  publishResolution(
    kind: GateKind, id: string, outcome: GateOutcome,
    extra?: { answers?: Record<string, string> | null },
  ): void {
    this._broadcast({ type: 'interaction_resolved', kind, id, outcome, ...(extra ?? {}) });
    try { markInteractionResolvedInTelegram(kind, id); } catch {}
  }

  /** The provider answered `resolved:false`: it holds no live future for this
   *  gate (the worker died without an event — kill -9, OOM, reboot — or the
   *  resolution was lost to a gap), so no answer can ever reach it. That
   *  refusal is authoritative, unlike a transport failure (which stays
   *  pessimistic, §14.18): retire the row as `cancelled` and publish — only
   *  if THIS update changed it (another device may have just answered). */
  private _retireRefusedGate(kind: GateKind, id: string): void {
    let changed = false;
    try {
      changed = cancelPendingGateRow(kind, id, this.id);
    } catch (e) {
      console.warn(`[sessionOps] ${this.id} refused gate ${id} cancel failed:`, (e as Error)?.message ?? e);
    }
    if (changed) this.publishResolution(kind, id, 'cancelled');
  }

  /** A LIVE agent status left the live states: cancel this session's
   *  blocking gates, published through this stream (cancelSessionBlockingGates). */
  private _cancelBlockingGates(): void {
    cancelSessionBlockingGates(this.id, (gate) => this.publishResolution(gate.kind, gate.id, 'cancelled'));
  }

  // ── Privates ─────────────────────────────────────────────────────────────
  private _broadcast(ev: WorkerEvent): void {
    if (this.isReplaying) ev = { ...ev, replay: true };
    const lane = ev.type === 'assistant_text' ? 'assistant' as const
      : ev.type === 'thinking' && this.coalesceThinking ? 'thinking' as const
      : null;
    if (lane) {
      // Keep replay metadata across coalescing, including a replay→live
      // transition inside the same frame. Catch-up is never live throughput.
      const replay = ev.replay === true;
      const text = ev.type === 'assistant_text' ? ev.delta : ev.type === 'thinking' ? ev.text : '';
      const pending = this.pendingBroadcast;
      if (pending && (pending.lane !== lane || pending.replay !== replay)) this._flushLiveBroadcast();
      if (this.pendingBroadcast) this.pendingBroadcast.text += text;
      else this.pendingBroadcast = { lane, text, replay };
      if (!this.liveBroadcastTimer) {
        this.liveBroadcastTimer = setTimeout(() => {
          this.liveBroadcastTimer = null;
          this._flushLiveBroadcast();
        }, 25);
      }
      return;
    }
    this._flushLiveBroadcast();
    this._emitBroadcast(ev);
  }

  /** Emit the lane coalescer's pending text (one frame) now. */
  private _flushLiveBroadcast(): void {
    if (this.liveBroadcastTimer) {
      clearTimeout(this.liveBroadcastTimer);
      this.liveBroadcastTimer = null;
    }
    const pending = this.pendingBroadcast;
    this.pendingBroadcast = null;
    if (!pending?.text) return;
    const replay = pending.replay ? { replay: true } : {};
    this._emitBroadcast(pending.lane === 'assistant'
      ? { type: 'assistant_text', delta: pending.text, ...replay }
      : { type: 'thinking', text: pending.text, ...replay });
  }

  /** Former name of `_flushLiveBroadcast` (tests call it). */
  private _flushAssistantBroadcast(): void {
    this._flushLiveBroadcast();
  }

  private _emitBroadcast(ev: WorkerEvent): void {
    // Push all events on the global bus — the multiplexed /events SSE
    // handles the fan-out + filter by connection focus. Tag with sessionId
    // so consumers know which session it came from.
    emitGlobalSession({ ...ev, sessionId: this.id } as GlobalSessionEvent);
  }

  /** A usage row was persisted: publish the session totals, debounced.
   *  Replaying ⇒ only dirty (one frame at `replay_end`); live ⇒ ONE trailing
   *  `unref` timer per stream (cleared in `detach`) — the frame reads the
   *  latest fold, so dropped intermediates are never missed (clients merge by
   *  `revision`). */
  private _scheduleTokenUsageBroadcast(): void {
    if (this.isReplaying) { this.tokenUsageDirty = true; return; }
    if (this.tokenUsageTimer) return;
    this.tokenUsageTimer = setTimeout(() => {
      this.tokenUsageTimer = null;
      if (this.isReplaying) { this.tokenUsageDirty = true; return; }
      this._broadcastTokenUsage();
    }, TOKEN_USAGE_BROADCAST_MS);
    this.tokenUsageTimer.unref?.();
  }

  private _broadcastTokenUsage(): void {
    this.tokenUsageDirty = false;
    let usage: SessionTokenUsage | null;
    try { usage = sessionTokenUsage(this.id); } catch { return; }
    // null = a cold fold still warming: its completion publishes the totals.
    if (usage) this._broadcast({ type: 'session_token_usage', usage });
  }

  /** Publish totals computed elsewhere (a fold that finished warming). */
  broadcastTokenUsage(usage: SessionTokenUsage): void {
    this._broadcast({ type: 'session_token_usage', usage });
  }

  /** Publish the bg registry's ACTIVE set once a cold fold is warm. */
  broadcastBgTasksSnapshot(tasks: BgTask[]): void {
    this._broadcast({ type: 'bg_tasks_snapshot', tasks });
  }

  /**
   * Flush the assistant text currently being accumulated (currentAssistant):
   * persist an 'assistant' message in DB and reset the buffer. To be called
   * before any event that interrupts the assistant text (tool_use, thinking,
   * permission_request, etc.) — otherwise the text written BEFORE the tool
   * would be concatenated with the text AFTER and inserted as a single block
   * at the end (on `stop`), breaking chronological order on reload.
   *
   * For a buffer replayed (or opened during a replay), we're more careful:
   *  - If its row (first delta's seq + ts) already exists → skip, or extend
   *    it when it holds a strict prefix (a partial flushed by SIGTERM) —
   *    otherwise we'd have a partial + a complete in DB.
   *  - Seq-less buffers / unstamped sessions: the legacy content checks.
   *  - Otherwise → normal insert.
   */
  /** Returns FALSE when the flush row insert/extend failed (buffer restored,
   *  cursor pinned) — boundary handlers must then STOP before persisting
   *  their own row, or the transcript order breaks: the boundary row would
   *  land BEFORE the assistant text that preceded it (Codex 16.3). TRUE =
   *  flushed or nothing to flush. */
  private _flushAssistant(): boolean {
    // An overlapping replay re-delivering an event OLDER than the open
    // buffer's first delta: that event was handled before this accumulation
    // began. It never closes the newer buffer (a partial row mid-answer, the
    // cursor hold released until the replayed anchor reopens it).
    if (this._replayPrecedesOpenAssistant()) return true;
    const since = this.pendingAssistantSince;
    const lastSeq = this.currentAssistant ? this.pendingAssistantLastSeq : null;
    const tsMs = this.pendingAssistantTsMs;
    const lastTsMs = this.pendingAssistantLastTsMs;
    const ok = this._flushAssistantBuffer();
    if (ok) {
      // The accumulation persisted (or proved persisted): a holdback a failed
      // flush of it left behind is void, the durable cursor may advance again.
      if (since != null) this.holdbacks.delete(`assistant:${since}`);
      // Its deltas are in that row. The span ends at the LAST delta's ts: the
      // boundary flushing it can be an OLDER replayed event (a kept buffer
      // whose dropped boundary is re-delivered), earlier than those deltas.
      if (since != null && lastSeq != null) this.deltaSpans.record(since, lastSeq, tsMs, lastTsMs);
    } else {
      // The caller STOPS and drops the event being dispatched (16.3 order
      // rule). Releasing `assistant:<since>` at a later successful flush
      // must not let the cursor pass that event: pin it under the `event`
      // key, never released in-process, so a restart replays it. Conservative
      // for a caller that goes on (`stop`): identity makes a replay
      // idempotent. The pin goes to the restored buffer's ANCHOR: its later
      // deltas join it, so the row that finally lands spans this boundary,
      // and a restart resuming inside it would write that tail again.
      this._pinEvent(this.currentEventSeq);
    }
    return ok;
  }

  /** TRUE while a replay dispatches an event of the open assistant buffer's
   *  epoch whose seq is BELOW that buffer's first delta. Seqs reach a stream
   *  in order within a window, so such an event is a re-delivery (an
   *  overlapping resubscribe) of one handled before the buffer opened. Same
   *  epoch = not dated after the buffer's first delta (a recreated log
   *  restarts seq at 1 with later ts, §14.71). */
  private _replayPrecedesOpenAssistant(): boolean {
    if (!this.isReplaying || !this.currentAssistant) return false;
    const seq = this.currentEventSeq;
    const since = this.pendingAssistantSince;
    if (seq == null || since == null || seq >= since) return false;
    const ts = this.currentEventTs;
    const bufferTs = this.pendingAssistantTsMs;
    return ts == null || bufferTs == null || ts <= bufferTs;
  }

  /** The never-released `event` pin for a write or an event lost at `seq`.
   *  With an assistant buffer open, at its first delta too: its deltas past
   *  `seq` will join the same row (anchored before `seq`), so the restart
   *  replay must start at that anchor, never strictly inside the row — it
   *  would rebuild the tail as a second row (no span survives a restart). */
  private _pinEvent(seq: number | null): void {
    if (seq == null) return;
    this._holdBack('event', seq);
    if (this.currentAssistant) this._holdBack('event', this.pendingAssistantSince);
  }

  /** A RELEASABLE holdback (`thinking:<since>`, a flush's own key) for a
   *  write lost while an assistant buffer is open — only a replay-KEPT
   *  buffer coexists with one: its later deltas join the same row, so the
   *  key is held at that buffer's anchor too (the lower seq). Releasing the
   *  key once the write lands releases the anchor with it. */
  private _holdBackAnchored(key: string, seq: number): void {
    const since = this.currentAssistant ? this.pendingAssistantSince : null;
    this._holdBack(key, since != null ? Math.min(seq, since) : seq);
  }

  private _flushAssistantBuffer(): boolean {
    if (!this.currentAssistant) return true;
    const finalContent = this.currentAssistant;
    if (this.kind === 'claude') {
      const terminalKind = classifyTerminalClaudeError(finalContent, this.effectiveModel);
      this.pendingTerminalAssistantError = terminalKind
        ? { text: finalContent, kind: terminalKind }
        : null;
    }
    // The flush row is stamped with the FIRST delta's seq — the row's
    // identity is the accumulation start (unique: a delta belongs to
    // exactly one accumulation, and deltas write no other row). Captured
    // BEFORE clearing so a failed insert can restore both buffer and
    // holdback (Codex 13.2.B: the old code forgot the buffer start before
    // knowing whether the insert succeeded — a failed flush lost the
    // whole turn text).
    const flushSeq = this.pendingAssistantSince;
    // Same reasoning for the date: the row belongs to the moment the
    // assistant STARTED speaking. Stamping it with the boundary event's ts
    // would sort a long answer after the tool calls it actually preceded.
    const flushTsMs = this.pendingAssistantTsMs;
    // The transcript entry this row corresponds to — the fork anchor.
    const flushUuid = this.pendingAssistantUuid;
    const flushLastSeq = this.pendingAssistantLastSeq;
    const flushLastTsMs = this.pendingAssistantLastTsMs;
    const flushGuide = this.pendingAssistantRowGuide;
    // Identity applies to a buffer OPENED in a replay window even when the
    // boundary closing it arrives live: its replayed deltas may extend a row
    // persisted before the hub went down (a SIGTERM partial). Checking only
    // `isReplaying` at flush time inserted a duplicate row with the same seq.
    // The legacy content path stays window-only (see below).
    const fromReplay = this.pendingAssistantFromReplay;
    // A kept or restored buffer keeps its reopened row (`assistantReopen`).
    const flushReopen = this.assistantReopen;
    this._resetAssistantBuffer();
    // The hub's bubble cut (I7, lib/assistantBoundaries.ts), through
    // `_broadcast`: after the buffer's last coalesced delta, before the
    // boundary's own frame. A failed write announces nothing.
    const announce = (rowId: number | null, extra?: { content?: string; duplicate?: true }) => this._broadcast({
      type: 'assistant_flushed', rowId, length: finalContent.length, tsMs: flushTsMs,
      model: this.effectiveModel, ...extra,
    });

    if (this.isReplaying || fromReplay) {
      if (flushSeq != null && sessionHasStampedRows(this.id)) {
        // IDENTITY path (rows are seq-stamped): the flush row's identity is
        // the FIRST delta's seq (and ts). Row present → this exact
        // accumulation is already persisted (possibly as a SIGTERM partial →
        // prefix-extend below). Row absent → genuinely new: identical TEXT
        // from another turn must NOT suppress it — the original P0.3 "Done."
        // bug lived in the content check of the else-branch, still reachable
        // through the ungated stop/effective_model flushes until this fix.
        // (Transition caveat: rows persisted pre-0023 are unstamped, so a
        // replay straddling the deploy boundary can fall through to insert;
        // one-shot window, accepted.)
        const row = assistantRowAtSeq(this.id, flushSeq, flushTsMs);
        if (row) {
          if (finalContent.startsWith(row.content) && finalContent.length > row.content.length) {
            // SIGTERM partial: the persisted row holds a strict prefix of
            // the re-accumulated text — extend it in place.
            try {
              db.update(sessionMessages)
                .set({ content: finalContent, ...(this.effectiveModel ? { model: this.effectiveModel } : {}) })
                .where(eq(sessionMessages.id, row.id))
                .run();
            } catch (e: any) {
              // A failed extend is a failed persist (§14.31): the buffer was
              // already cleared, so swallowing it lost the rest of the answer
              // for good once the cursor moved past the block.
              this._log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
              this._restoreAssistantBuffer(finalContent, flushSeq, flushTsMs, flushUuid, flushLastSeq, flushLastTsMs, fromReplay, flushGuide);
              this.assistantReopen = this._unverifiedReopen(flushReopen);
              return false;
            }
            // The row's text replaces what the browser holds of it.
            announce(row.id, { content: finalContent });
          } else if (row.content.length > finalContent.length && row.content.startsWith(finalContent)) {
            // The row is LONGER: the live run did not flush here (this
            // boundary's flush failed and its buffer ran on past it, §14.31).
            // The boundary goes on; the buffer keeps accumulating toward that
            // row, and a later boundary proves it persisted. Dropping it here
            // left the next deltas a rowless buffer: a duplicate tail.
            this._keepAssistantBuffer(finalContent, flushSeq, flushTsMs, flushUuid, flushLastSeq, flushLastTsMs, fromReplay, row.content);
            this.assistantReopen = this._unverifiedReopen(flushReopen);
          } else {
            announce(row.id, { duplicate: true });  // already persisted
          }
          return true;
        }
        // fall through → INSERT below (identity says: not persisted)
      } else if (this.isReplaying) {
        // LEGACY path (agents without seq / pre-0023 rows): content dedup +
        // prefix-extend — the historical behavior, imperfect on identical
        // answers but the only signal available. INSIDE a window only: a
        // buffer flushed live after it (`fromReplay`) has no identity to find
        // here, and the content heuristics would drop a new answer equal to a
        // copied one or rewrite an unrelated earlier row → plain INSERT.
        const legacy = this._legacy();
        if (legacy.assistantContents.has(finalContent)) {
          announce(null, { duplicate: true });
          return true;
        }
        try {
          const lastRows = db.select({
            id: sessionMessages.id,
            content: sessionMessages.content,
          }).from(sessionMessages)
            .where(and(
              eq(sessionMessages.sessionId, this.id),
              eq(sessionMessages.role, 'assistant'),
            ))
            .orderBy(desc(sessionMessages.id))
            .limit(1).all();
          if (lastRows.length > 0 &&
              finalContent.startsWith(lastRows[0].content) &&
              finalContent.length > lastRows[0].content.length) {
            db.update(sessionMessages)
              // Re-stamp the model too: the partial may predate the model column
              // (or a SIGTERM flush that raced the effective_model event).
              .set({ content: finalContent, ...(this.effectiveModel ? { model: this.effectiveModel } : {}) })
              .where(eq(sessionMessages.id, lastRows[0].id))
              .run();
            legacy.assistantContents.delete(lastRows[0].content);
            legacy.assistantContents.add(finalContent);
            announce(lastRows[0].id, { content: finalContent });
            return true;
          }
        } catch {}
      }
    }

    // Stamp the row with the model that actually produced this text (per-
    // message attribution — the effective_model handler flushes BEFORE
    // switching, so buffered text never gets relabeled by a newer model).
    const ok = this._persist('assistant', finalContent, {
      model: this.effectiveModel, seq: flushSeq, tsMs: flushTsMs, cliUuid: flushUuid,
      holdbackKey: `assistant:${flushSeq}`,
    });
    if (!ok) {
      this._restoreAssistantBuffer(finalContent, flushSeq, flushTsMs, flushUuid, flushLastSeq, flushLastTsMs, fromReplay, flushGuide);
      this.assistantReopen = this._unverifiedReopen(flushReopen);
      return false;
    }
    announce(ok);
    // Keep a LOADED legacy Set coherent; a later load reads the DB itself.
    if (this.isReplaying) this.legacyReplay?.assistantContents.add(finalContent);
    // LIVE only: a replay re-walking an old auth failure must not re-flag a
    // VPS that has been signed in again since.
    else this._noteAuthExpired(finalContent);
    return true;
  }

  /** RESTORE after a failed flush write (Codex 13.2.B): keep the text in the
   *  buffer — the next boundary retries the flush with possibly more text
   *  (chronology slightly late, never lost) — and pin the durable cursor at
   *  the FIRST delta so a crash replays the whole accumulation. The whole
   *  buffer identity comes back: the fork anchor, the replay guard's last seq
   *  and the replay origin of the accumulation. */
  private _restoreAssistantBuffer(
    content: string, since: number | null, tsMs: number | null, uuid: string | null,
    lastSeq: number | null, lastTsMs: number | null, fromReplay: boolean, guide: string | null,
  ): void {
    this._keepAssistantBuffer(content, since, tsMs, uuid, lastSeq, lastTsMs, fromReplay, guide);
    this._holdBack(`assistant:${since}`, since);
  }

  /** Put a whole buffer identity back (the open buffer pins the durable
   *  cursor at its first delta by itself), with the row bounding it if any. */
  private _keepAssistantBuffer(
    content: string, since: number | null, tsMs: number | null, uuid: string | null,
    lastSeq: number | null, lastTsMs: number | null, fromReplay: boolean, guide: string | null,
  ): void {
    this.currentAssistant = content;
    this.pendingAssistantSince = since;
    this.pendingAssistantTsMs = tsMs;
    this.pendingAssistantUuid = uuid;
    this.pendingAssistantLastSeq = lastSeq;
    this.pendingAssistantLastTsMs = lastTsMs;
    this.pendingAssistantFromReplay = fromReplay;
    this.pendingAssistantRowGuide = guide;
    this.pendingAssistantGuideLen = -1;
  }

  /** A reopen carried over a kept/restored buffer: its match is re-verified
   *  once on the next delta (the buffer may differ from what was matched). */
  private _unverifiedReopen<T extends { matched: number } | null>(reopen: T): T {
    if (reopen) reopen.matched = -1;
    return reopen;
  }

  /** How the buffer, `delta` now appended at `preLen`, relates to the
   *  reopened row's prefix: still `inside` it, `past` its end (the buffer
   *  starts with it), or `diverged`. When `reopen.matched === preLen` the
   *  buffer so far is known to spell the prefix, so only the delta is
   *  compared (O(delta)); otherwise one full check (O(buffer)). */
  private _reopenRelation(
    reopen: { prefix: string; matched: number }, preLen: number, delta: string,
  ): 'inside' | 'past' | 'diverged' {
    const prefix = reopen.prefix;
    if (reopen.matched === preLen && preLen <= prefix.length) {
      const room = prefix.length - preLen;
      if (delta.length <= room) return prefix.startsWith(delta, preLen) ? 'inside' : 'diverged';
      return prefix.startsWith(delta.slice(0, room), preLen) ? 'past' : 'diverged';
    }
    const buf = this.currentAssistant;
    if (prefix.startsWith(buf)) return 'inside';
    return buf.startsWith(prefix) ? 'past' : 'diverged';
  }

  /** `guide.startsWith(buffer + delta)` / `(buffer + delta).startsWith(guide)`
   *  for a kept buffer, comparing only `delta` when the relation is known at
   *  the current buffer length (`pendingAssistantGuideLen`). */
  private _guideRelation(guide: string, delta: string): { guideHasNext: boolean; nextHasGuide: boolean } {
    const cur = this.currentAssistant;
    const curLen = cur.length;
    const gl = guide.length;
    const nl = curLen + delta.length;
    if (this.pendingAssistantGuideLen === curLen) {
      // Known: guide.startsWith(cur) when curLen <= gl, else cur.startsWith(guide).
      return {
        guideHasNext: nl <= gl && guide.startsWith(delta, curLen),
        nextHasGuide: nl >= gl && (curLen >= gl || guide.startsWith(delta.slice(0, gl - curLen), curLen)),
      };
    }
    const next = cur + delta;
    return { guideHasNext: guide.startsWith(next), nextHasGuide: next.startsWith(guide) };
  }

  /**
   * The CLI answered the turn with "your OAuth token expired" instead of doing
   * the work (§14.65). That message is the ONLY signal — no protocol `error`
   * event is emitted — so we treat it as an authoritative logout: flip
   * `vps.claudeLoggedIn` to 0 and broadcast it, which lights the "claude
   * login" affordances (sidebar bar, health chips) everywhere at once. The
   * chat bubble itself grows a "sign in again" button client-side.
   *
   * Cheap + idempotent: no write unless the DB still believes we're signed in.
   */
  private _noteAuthExpired(text: string): void {
    if (!isClaudeAuthExpired(text)) return;
    this._flagProviderLoggedOut();
  }

  /**
   * The DB half of the above, callable without the prose detector.
   *
   * agent >= 0.36.0 also delivers this as a TYPED field
   * (AssistantMessage.error.type === 'authentication_failed' → `turn_error`),
   * which is the same fact stated rather than inferred. Both paths land here;
   * the regex stays for older agents on the fleet, so this must remain
   * idempotent — it is called from whichever arrives first.
   */
  /** Add accepted "don't ask again" rules to the session's durable set, which
   *  every later start/resume passes back (`withRememberedRules`). Best-effort:
   *  losing the write costs one re-asked permission after a resume, never
   *  correctness — the live CLI already applied the rule. */
  private _rememberAllowRules(rules: string[]): void {
    if (!rules.length) return;
    try {
      const row = db.select({ raw: agentSessions.alwaysAllowTools }).from(agentSessions)
        .where(eq(agentSessions.id, this.id)).get();
      const current = rememberedRules(row?.raw);
      const next = [...current, ...rules.filter((r) => !current.includes(r))];
      if (next.length === current.length) return;
      db.update(agentSessions)
        .set({ alwaysAllowTools: JSON.stringify(next.slice(-MAX_REMEMBERED_RULES)) })
        .where(eq(agentSessions.id, this.id)).run();
    } catch {}
  }

  private _flagProviderLoggedOut(): void {
    try {
      const row = db.select({ config: agentSessions.providerConfig }).from(agentSessions).where(eq(agentSessions.id, this.id)).get();
      if (connectionConfig(row?.config).customEndpoint) return;
      // §14.115: a hub-owned account is the hub's to repair (re-push, refresh);
      // no VPS column moves, there is no local login behind it.
      void import('@/lib/server/accounts/store').then(async (store) => {
        if (store.isGlobalAccountId(this.accountProfile)) {
          (await import('@/lib/server/accounts/engine')).repairAfterAuthError(this.accountProfile, this.vpsId);
        }
      }).catch(() => {});
      // The VPS login columns mirror the hub's accounts (accounts engine):
      // a session never writes them.
    } catch {}
  }

  /** Persist and immediately surface one blocking failure as a chat message. */
  private _recordBlockingError(
    message: string | null | undefined,
    opts: {
      turnFailure: boolean;
      fatal?: boolean;
      hint?: string | null;
      apiStatus?: string | number | null;
      resetAt?: number | null;
    },
  ): SessionErrorPayload | null {
    const seq = this.currentEventSeq;
    if (this.isReplaying && seq != null && this._replaySeqPersisted(seq)) {
      this.pendingBlockingErrorRecorded = true;
      return null;
    }
    const payload = classifySessionError({
      provider: this.kind,
      message,
      turnFailure: opts.turnFailure,
      fatal: opts.fatal,
      hint: opts.hint,
      apiStatus: opts.apiStatus,
      resetAt: opts.resetAt ?? resolveResetAtMs(
        (this.latestLimitResetAtMs != null && this.latestLimitResetAtMs >= Date.now() - 60_000
          ? this.latestLimitResetAtMs : null)
          ?? hubHooks().usageResetResolver?.(this.vpsId, this.kind, this.accountProfile),
        String(message ?? ''),
      ),
    });
    if (payload.kind === 'authentication') this._flagProviderLoggedOut();
    // A first attempt of this turn (the fatal `error`) failed to persist: the
    // fallback (the `stop`) is that error's row, stamped with ITS seq/ts —
    // under the stop's own seq a replay of the error found no row and
    // recorded the card a second time.
    const at = this.pendingBlockingErrorAt;
    const messageId = this._persist('error', payload, at ? { seq: at.seq, tsMs: at.tsMs } : undefined);
    if (!messageId) {
      if (!at && this.currentEventSeq != null) {
        this.pendingBlockingErrorAt = { seq: this.currentEventSeq, tsMs: this.currentEventTs };
      }
      return null;
    }
    this.pendingBlockingErrorRecorded = true;
    this.pendingBlockingErrorAt = null;
    this._broadcast({
      type: 'blocking_error', error: payload,
      createdAt: Math.floor((at?.tsMs ?? this.currentEventTs ?? Date.now()) / 1000), messageId,
    });
    return payload;
  }

  /** Public variant for graceful shutdown: persists the open reasoning block
   *  and the assistant text (a later replay covers/extends both rows). */
  flushPendingAssistant(): void {
    this._flushThinking();
    this._flushAssistant();
  }

  /** Persist the open reasoning block now (public: writers outside the
   *  stream, shutdown). See `_flushThinking`. */
  flushThinking(): void {
    this._flushThinking();
  }

  /** Run a DB write made OUTSIDE the agent stream (scheduled-resume cards,
   *  the async-question resolution) after persisting the open reasoning
   *  block, so no row lands while a block is open (I8): the block's row
   *  would otherwise get a LOWER id than text it precedes. */
  persistExternal<T>(fn: () => T): T {
    this._flushThinking();
    return fn();
  }

  /** One coalescable reasoning delta (delta provider, numeric seq). Inside a
   *  replay, identity first: a delta covered by a persisted row (its own
   *  per-delta row, positionally inside a coalesced row anchored at an
   *  earlier seq of the same block, or inside the span of a row this process
   *  persisted) writes nothing and re-sends no text (a persisted block's
   *  anchor is re-cut, positionally). Covers legacy per-delta rows,
   *  merged/compacted rows, SIGTERM partials (the cover runs out, the
   *  remainder becomes an adjacent row), a double replay (replay-only seq
   *  guard) and a window starting mid-row (`deltaSpans`, or a sealed block
   *  still waiting for its retry). A replayed delta
   *  outside the open block (before it, or at a persisted row) closes that
   *  block first. */
  private _onThinkingDelta(text: string, seq: number): void {
    if (this.isReplaying) {
      // Sealed rows become visible to the lookup below.
      if (!this.currentThinking) this._retryThinking();
      // Positional: the cover's next text, at a seq past the last one it
      // was carried through (never an earlier delta replayed again), in a
      // window that reached it contiguously (one carried over from a cut
      // window must not apply to a window starting further on).
      const cover = this.replayThinkingCover;
      const coverSeq = this.replayThinkingCoverSeq;
      const firstSeq = this.replayWindowFirstSeq;
      if (cover && coverSeq != null && seq > coverSeq && (firstSeq == null || firstSeq <= coverSeq + 1)
        && cover.startsWith(text)) {
        const rest = cover.slice(text.length);
        // The row holds its deltas through this one: a later window starting
        // inside it skips them.
        if (this.replayThinkingCoverSince != null) {
          this.deltaSpans.record(this.replayThinkingCoverSince, seq, this.replayThinkingCoverTsMs, this.currentEventTs);
        }
        if (rest) { this.replayThinkingCover = rest; this.replayThinkingCoverSeq = seq; }
        else this._resetThinkingCover();
        this._dropReplayedAssistantBuffer();   // covered: a gated boundary
        return;
      }
      this._resetThinkingCover();
      const since = this.pendingThinkingSince;
      if (this.currentThinking && since != null) {
        // Replay windows only: already in the open block (attach +
        // resubscribe, or a resubscribe overlapping deltas it got live).
        if (seq >= since && this.pendingThinkingLastSeq != null && seq <= this.pendingThinkingLastSeq) return;
        // The replay went back BEFORE the open block (an overlapping replay
        // from an older seq): that block is a later one — close it, it ends here.
        if (seq < since) this._flushThinking();
        // The anchor of a SEALED block (no row yet, so the persisted-row
        // check below cannot see it) is another block: a hub-side cut (a hub
        // writer, the post-subscribe `status`) left no boundary in the
        // agent's log. Joined to the open one, both entries would land and
        // the open block's row would also hold the sealed one's text.
        else if (this._sealedAnchor(seq)) this._flushThinking();
      }
      // A window starting inside a block SEALED but not landed yet (no row,
      // no span): the sealed entry holds the delta — its retry lands the
      // whole text, its holdback pins a restart below it. Without this the
      // tail opened a block of its own: a second row.
      if (!this.currentThinking && this._sealedHolds(seq)) {
        this._dropReplayedAssistantBuffer();
        return;
      }
      // A window starting INSIDE a row this process persisted (its cursor
      // was taken while the block still streamed): no row of its own, no
      // cover — the span proves it persisted. Never inside a block this
      // window opened: that block was rebuilt from its anchor, its deltas
      // belong to it. Else its own row (identity).
      const inSpan = !this.currentThinking && this.deltaSpans.covers(seq, this.currentEventTs);
      const row = inSpan ? undefined : eventRowAtSeq(this.id, seq, this.currentEventTs);
      if (inSpan || row) {
        // A persisted row is another block: the open one ends before it
        // (else later uncovered deltas would join it, out of order).
        if (this.currentThinking) this._flushThinking();
        const persisted = row ? thinkingText(row.content) : null;
        if (persisted != null && persisted.length > text.length && persisted.startsWith(text)) {
          this.replayThinkingCover = persisted.slice(text.length);
          this.replayThinkingCoverSeq = seq;
          this.replayThinkingCoverSince = seq;
          this.replayThinkingCoverTsMs = this.currentEventTs;
        }
        // The replay is at a persisted block's ANCHOR: a browser may still
        // hold that block as its open text, its cut never received — a
        // SIGTERM flush writes the row and the cut, and the process used to
        // exit before the SSE sent them. Cut it again (positional, no
        // content: a browser that had the cut changes nothing), so the next
        // replay-opened block's cut replaces only its own text. A multi-delta
        // row, or the window's first delta (one cut, not one per legacy
        // per-delta row).
        if (row && persisted != null && (persisted.length > text.length || seq === this.replayWindowFirstSeq)) {
          this._broadcast({ type: 'thinking_flushed', rowId: row.id, length: persisted.length });
        }
        this._dropReplayedAssistantBuffer();   // persisted: no buffer, no text re-sent
        return;
      }
    }
    // Order rule (Codex 16.3): text before the reasoning persists first; a
    // failed flush stops here and the replay redoes both in order.
    if (this.currentAssistant && !this._flushAssistant()) return;
    if (!this.currentThinking) {
      this._retryThinking();
      this.pendingThinkingSince = seq;
      this.pendingThinkingTsMs = this.currentEventTs;
      this.pendingThinkingFromReplay = this.isReplaying;
      // A replay REOPENS a block from its anchor (no row: the hub died
      // before writing it). A browser may still show what it got of it live
      // (its open text): it drops that before the replayed frames rebuild
      // the block — else the bubble reads it twice until the cut. A browser
      // holding no open text changes nothing.
      if (this.isReplaying) this._broadcast({ type: 'thinking_reopened' });
    } else {
      // A replayed delta extending a block opened live: its flush goes
      // through identity too (the row may exist meanwhile).
      this.pendingThinkingFromReplay ||= this.isReplaying;
    }
    this.currentThinking += text;
    this.pendingThinkingLastSeq = seq;
    this.pendingThinkingLastTsMs = this.currentEventTs;
    this._broadcast({ type: 'thinking', text, ...(this.isReplaying ? { replay: true } : {}) });
    if (this.currentThinking.length >= THINKING_ROW_MAX_CHARS) this._flushThinking();
  }

  /** True when a sealed (not yet persisted) block holds the replayed delta
   *  at `seq`: strictly after its anchor, within its last delta, at a
   *  matching ts (±1 ms) when the event carries one — the same rule as
   *  `PersistedSpans.covers`. At most 50 entries, usually none. */
  private _sealedHolds(seq: number): boolean {
    const ts = this.currentEventTs;
    return this.thinkingRetry.some((e) => e.lastSeq != null && seq > e.since && seq <= e.lastSeq
      && (ts == null || (e.tsMs != null && e.lastTsMs != null && ts >= e.tsMs - 1 && ts <= e.lastTsMs + 1)));
  }

  /** True when the replayed delta at `seq` is the FIRST delta of a sealed
   *  (not yet persisted) block: same seq, ts within ±1 ms when the event
   *  carries one (`_sealedHolds`' rule). */
  private _sealedAnchor(seq: number): boolean {
    const ts = this.currentEventTs;
    return this.thinkingRetry.some((e) => e.since === seq
      && (ts == null || (e.tsMs != null && ts >= e.tsMs - 1 && ts <= e.tsMs + 1)));
  }

  /** Close the open reasoning block: ONE `event` row `{type:'thinking',
   *  text}` stamped with the FIRST delta's seq and ts, announced as
   *  `thinking_flushed` (the hub's bubble cut). A failed insert SEALS the
   *  block (retried later, cursor held back) and never blocks the boundary
   *  that closed it. */
  private _flushThinking(): void {
    // The block's last `thinking` frame precedes its `thinking_flushed`.
    if (this.currentThinking) this._flushLiveBroadcast();
    const text = this.currentThinking;
    const since = this.pendingThinkingSince;
    const tsMs = this.pendingThinkingTsMs;
    const lastSeq = this.pendingThinkingLastSeq;
    const lastTsMs = this.pendingThinkingLastTsMs;
    const fromReplay = this.pendingThinkingFromReplay;
    // From here on no block is open (I8): the writes below cannot recurse.
    this.currentThinking = '';
    this.pendingThinkingSince = null;
    this.pendingThinkingTsMs = null;
    this.pendingThinkingLastSeq = null;
    this.pendingThinkingLastTsMs = null;
    this.pendingThinkingFromReplay = false;
    this._retryThinking();
    if (!text || since == null) return;
    // The row now holds the block's deltas: a later window starting inside
    // it skips them (`deltaSpans`).
    const persistedSpan = () => {
      if (lastSeq != null) this.deltaSpans.record(since, lastSeq, tsMs, lastTsMs);
    };
    if (fromReplay) {
      // A block rebuilt by a replay: its row may exist meanwhile (a sealed
      // retry just landed it, or an earlier pass persisted a prefix).
      const row = eventRowAtSeq(this.id, since, tsMs);
      const persisted = row ? thinkingText(row.content) : null;
      if (row && persisted != null) {
        if (persisted === text || persisted.startsWith(text)) {
          persistedSpan();
          this._releaseThinking(since);
          this._broadcast({ type: 'thinking_flushed', rowId: row.id, length: persisted.length });
          return;
        }
        if (text.startsWith(persisted)) {
          if (!this._extendThinkingRow(row.id, text)) {
            this._sealThinking(text, since, tsMs, lastSeq, lastTsMs);
            return;
          }
          persistedSpan();
          this._releaseThinking(since);
          this._broadcast({ type: 'thinking_flushed', rowId: row.id, length: text.length, content: text });
          return;
        }
        // A visible duplicate beats a loss.
        console.warn(`[replay] thinking diverged at seq ${since} in ${this.id}: inserting the replayed block`);
      }
    }
    const id = this._persist('event', { type: 'thinking', text }, {
      seq: since, tsMs, holdbackKey: `thinking:${since}`, createdAt: thinkingCreatedAt(tsMs),
    });
    if (id === false) {
      this._sealThinking(text, since, tsMs, lastSeq, lastTsMs);
      return;
    }
    persistedSpan();
    this._releaseThinking(since);
    // A block a replay rebuilt carries its text: a browser that kept the
    // pre-crash frames of this block (the hub died before its row, then
    // re-broadcast it from the replay) or missed some of them shows the
    // row's text at the cut instead of a doubled or holed bubble.
    this._broadcast({ type: 'thinking_flushed', rowId: id, length: text.length, ...(fromReplay ? { content: text } : {}) });
  }

  /** Replace a persisted thinking row's text (a replay extends a prefix it
   *  holds). Same JSON key order as an insert. False on a DB failure. */
  private _extendThinkingRow(rowId: number, text: string): boolean {
    try {
      db.update(sessionMessages)
        .set({ content: JSON.stringify({ type: 'thinking', text }) })
        .where(and(eq(sessionMessages.id, rowId), eq(sessionMessages.sessionId, this.id)))
        .run();
      return true;
    } catch (e: any) {
      this._log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
      return false;
    }
  }

  /** A block whose row could not be written: keep it for `_retryThinking`
   *  and hold the cursor back below its first seq. ONE entry per block: a
   *  replay-rebuilt copy of a sealed block replaces it when longer. Past 50
   *  sealed blocks the OLDEST is dropped from memory and KEEPS its holdback:
   *  the persisted cursor stays at or below its first seq − 1, so the next
   *  restart replays and rebuilds it exactly once (identity dedupes the
   *  rest). Never re-delivered live: a DB that failed 50 inserts in a row
   *  would fail that write too, and the re-asking machinery cost more than
   *  it saved. */
  private _sealThinking(
    text: string, since: number, tsMs: number | null, lastSeq: number | null, lastTsMs: number | null,
  ): void {
    this._holdBackAnchored(`thinking:${since}`, since);
    const same = this.thinkingRetry.find((e) => e.since === since
      && (text.startsWith(e.text) || e.text.startsWith(text)));
    if (same) {
      if (text.length > same.text.length) { same.text = text; same.lastSeq = lastSeq; same.lastTsMs = lastTsMs; }
      same.tsMs ??= tsMs;
      return;
    }
    this.thinkingRetry.push({ text, since, tsMs, lastSeq, lastTsMs });
    if (this.thinkingRetry.length <= 50) return;
    const dropped = this.thinkingRetry.shift()!;
    console.warn(`[thinking] retry cap: block ${dropped.since} left to the restart replay (${this.id})`);
  }

  /** Re-persist sealed blocks, oldest first; stops at the first failure
   *  (order). A late success broadcasts nothing (the text reached the
   *  browser live) and releases its holdback. Never called while a block is
   *  open. Idempotent: a row already at the block's seq (a replay rebuilt
   *  it) is reused or extended, never duplicated. */
  private _retryThinking(): void {
    while (this.thinkingRetry.length) {
      const sealed = this.thinkingRetry[0];
      if (!this._persistSealedThinking(sealed)) return;
      this.thinkingRetry.shift();
      if (sealed.lastSeq != null) {
        this.deltaSpans.record(sealed.since, sealed.lastSeq, sealed.tsMs, sealed.lastTsMs ?? null);
      }
      this._releaseThinking(sealed.since);
    }
  }

  /** The block starting at `since` now has its row: release its holdback —
   *  unless another sealed entry of that block still waits. A block the cap
   *  dropped is released the same way when a replay rebuilds it here. */
  private _releaseThinking(since: number): void {
    if (this.thinkingRetry.some((e) => e.since === since)) return;
    this.holdbacks.delete(`thinking:${since}`);
  }

  /** A replay window opens (`_dispatchEvent` prologue). A cover left by a
   *  window cut mid-row (AgentClient's synthetic `replay_end`) carries over
   *  only when this window resumes right where it stopped — the resume point
   *  (`replayCutSeq`, else `lastSeenSeq`) is the cover's last seq: the
   *  hub-restart cut, or an overlapping replay resumed after its cut, whose
   *  next deltas continue the covered row. Otherwise it belongs to nothing:
   *  applied by position to this window's first deltas, it would drop new
   *  reasoning (G2). A carried cover also needs the window to start right
   *  after it (`_onThinkingDelta`: a rotated log starts later). */
  private _onThinkingReplayBegin(): void {
    if (this.replayThinkingCoverSeq !== (this.replayCutSeq ?? this.lastSeenSeq)) this._resetThinkingCover();
  }

  private _resetThinkingCover(): void {
    this.replayThinkingCover = null;
    this.replayThinkingCoverSeq = null;
    this.replayThinkingCoverSince = null;
    this.replayThinkingCoverTsMs = null;
  }

  private _persistSealedThinking(sealed: { text: string; since: number; tsMs: number | null }): boolean {
    const row = eventRowAtSeq(this.id, sealed.since, sealed.tsMs);
    const persisted = row ? thinkingText(row.content) : null;
    if (row && persisted != null) {
      if (persisted.startsWith(sealed.text)) return true;
      if (sealed.text.startsWith(persisted)) return this._extendThinkingRow(row.id, sealed.text);
    }
    return this._persist('event', { type: 'thinking', text: sealed.text }, {
      seq: sealed.since, tsMs: sealed.tsMs, holdbackKey: `thinking:${sealed.since}`,
      createdAt: thinkingCreatedAt(sealed.tsMs),
    }) !== false;
  }

  // ── Background work (§14.91) ─────────────────────────────────────────────
  private _clearCodexBgChecks(): void {
    if (this.codexBgTimer) clearTimeout(this.codexBgTimer);
    this.codexBgTimer = null;
    this.codexBgChecks.clear();
    this.codexBgSeedPending = false;
  }

  private _scheduleCodexBgCheck(): void {
    if (!this.attached || this.isReplaying || this.codexBgChecking
      || this.codexBgTimer || !this.codexBgChecks.size) return;
    this.codexBgTimer = setTimeout(() => {
      this.codexBgTimer = null;
      void this._reconcileCodexBgTasks();
    }, 5_000);
    this.codexBgTimer.unref?.();
  }

  private async _reconcileCodexBgTasks(): Promise<void> {
    if (this.codexBgChecking || this.isReplaying || !this.attached
      || !this.nativeSessionId || !this.codexBgChecks.size) return;
    this.codexBgChecking = true;
    const captured = new Map([...this.codexBgChecks].slice(0, 64));
    try {
      const vps = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).get();
      const row = db.select({ config: agentSessions.providerConfig }).from(agentSessions)
        .where(eq(agentSessions.id, this.id)).get();
      if (!vps || !row) return;
      let codexHome: string | undefined;
      try { codexHome = JSON.parse(row.config ?? '{}').env?.CODEX_HOME; } catch {}
      const observations = await readCodexBgState(vps, this.nativeSessionId,
        [...captured.keys()], typeof codexHome === 'string' ? codexHome : undefined);
      if (!this.attached || this.isReplaying) return;
      for (const observation of observations) {
        const expected = captured.get(observation.taskId);
        // An activity/restart during the SSH read invalidates its observation.
        if (!expected || this.codexBgChecks.get(observation.taskId) !== expected) continue;
        const terminal = observation.status !== 'running';
        if (terminal && observation.at < expected.since) continue;
        this.hasRunningBgTasks();
        const running = this.bgRunning!.has(observation.taskId);
        if (running !== !terminal) {
          const payload = { type: 'bg_task' as const,
            kind: terminal ? 'finished' as const : 'updated' as const,
            taskId: observation.taskId, taskType: 'codex_subagent',
            status: observation.status, terminal };
          // Synthetic observations have no provider replay cursor. Only a
          // successful durable write may change liveness or clear a check.
          const observedRow = this._persist('event', payload, { seq: null });
          if (observedRow === false) continue;
          this._broadcast(withRowId(payload, observedRow));
          this._trackBgTask(observation.taskId, payload);
        }
        if (terminal) this.codexBgChecks.delete(observation.taskId);
      }
      // Round-robin bounded batches; unknown evidence never closes a task.
      for (const [id, expected] of captured) {
        if (this.codexBgChecks.get(id) !== expected) continue;
        this.codexBgChecks.delete(id);
        this.codexBgChecks.set(id, expected);
      }
    } catch (error) {
      console.warn(`[codex-background ${this.id}] ${String(error).slice(0, 200)}`);
    } finally {
      this.codexBgChecking = false;
      this._scheduleCodexBgCheck();
    }
  }

  //
  // A turn that ends while `Bash run_in_background` / a Task subagent is still
  // running goes `background` instead of green. Its response notification
  // includes the running count; a second notice follows the last task. The
  // registry is rebuilt from persisted bg_task rows (bgTaskState.ts) after a
  // hub restart, then maintained from live events.

  /** True while background work launched by this session is still running. */
  hasRunningBgTasks(): boolean {
    if (this.bgRunning == null) this.bgRunning = runningBgTasksFromDb(this.id);
    return pruneStaleBgTasks(this.bgRunning, Math.floor(Date.now() / 1000));
  }

  /** How many — the sidebar card's count. Same registry, same age cap, the
   *  composer bar's rule (`bgWorkCount`: a sub-agent's command is a step of its
   *  owner). The list GET's read: a cold registry is not folded synchronously
   *  there — 0 while it warms (cosmetic; the session's status is unchanged). */
  runningBgTaskCount(): number {
    if (this.bgRunning == null) {
      const running = runningBgTasksIfWarm(this.id);
      if (running == null) return 0;
      this.bgRunning = running;
    }
    return this.hasRunningBgTasks() ? bgWorkCount(this.id, this.bgRunning!) : 0;
  }

  /** Mirror the count onto every tab (LOW_VOLUME `session_bg_tasks`): the
   *  `bg_task` lifecycle only reaches the focused connection. */
  private _announceBgCount(): void {
    const n = this.runningBgTaskCount();
    if (n === this.bgRunningAnnounced) return;
    this.bgRunningAnnounced = n;
    this._broadcast({ type: 'session_bg_tasks', running: n });
  }

  /** null means an undated LIVE snapshot; undated replay authorizes nothing.
   * Identity dedup alone misses old hooks that originally closed zero tasks.
   * Asked only about the tasks the callers may close (this stream's running
   * set): O(running), never the session's whole bg history (G1). */
  private _bgTasksBeforeCurrentEvent(): Set<string> | null {
    if (this.currentEventSeq == null && this.currentEventTs == null) {
      return this.isReplaying ? new Set() : null;
    }
    this.bgRunning ??= runningBgTasksFromDb(this.id);
    // The answer is only ever intersected with the running set: with nothing
    // running, never fold the registry (a cold one is O(session), G1).
    if (this.bgRunning.size === 0) return new Set();
    return bgTaskIdsBeforeEventFromDb(this.id, {
      seq: this.currentEventSeq, tsMs: this.currentEventTs,
    }, this.bgRunning.keys());
  }

  /** Apply one live bg_task event to the registry. Replayed events are NOT fed
   *  here: the lazy DB load already contains them, and re-applying a
   *  started/finished PAIR in order would transiently resurrect a task that
   *  finished long ago. */
  private _trackBgTask(taskId: string | undefined, ev: { kind?: unknown; status?: unknown; terminal?: unknown }): void {
    if (!taskId) return;
    this.hasRunningBgTasks();                       // ensure loaded
    const running = this.bgRunning!;
    const before = running.size > 0;
    if (isBgTaskDone(ev)) running.delete(taskId);
    else if (!running.has(taskId)
      && (ev.kind === 'started'
        ? bgTaskRunningInDb(this.id, taskId)
        : ev.status != null || ev.terminal === false)) {
      running.set(taskId, Math.floor(Date.now() / 1000));
    }
    this._announceBgCount();
    if (running.size > 0) {
      // More work started — whatever "it's done" we had queued is void.
      this._cancelBgFinish();
      // Some providers can reveal a native background process immediately
      // after their stop frame. Do not leave the session green/auto-updatable
      // merely because that lifecycle event crossed the wire second.
      if (!before && this.status === 'active') {
        this.status = 'background';
        try {
          db.update(agentSessions).set({ status: 'background', unreadStop: 0 })
            .where(eq(agentSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'status', status: 'background' });
        // The DB marker just went to 0: every tab hears it (no stale green).
        this._broadcast({ type: 'session_unread', unread: false });
      }
      return;
    }
    if (!before) return;                            // nothing was running anyway
    this._onLastBgTaskEnded();
  }

  /** The last background task just ended. If the turn had already stopped, the
   *  session was parked in `background` — it is genuinely idle now. Shared with
   *  the `turn_end` reconciliation, which can reach this state by learning that
   *  a task we never saw finish is gone. */
  private _onLastBgTaskEnded(): void {
    if (this.status !== 'background') return;
    this.status = 'active';
    try {
      db.update(agentSessions).set({ status: 'active' })
        .where(eq(agentSessions.id, this.id)).run();
    } catch {}
    this._broadcast({ type: 'status', status: 'active' });
    this._scheduleBgFinishNotice();
  }

  /**
   * The CLI process died or was paused: its background children died with it
   * (`app/bgTasks.ts § markRunningBgTasksStale` says the same thing to the
   * chat view). Write the terminal row for each, because the registry is
   * REBUILT from those rows — without it a slept session comes back from every
   * agent update believing it still has work running, and would sit `background`
   * until the 24h age cap while blocking the auto-update quiet gate.
   */
  private _expireBgTasks(stampSeq: number | null = null, eligible: Set<string> | null = null): void {
    this._clearCodexBgChecks();
    this._cancelBgFinish();
    if (!this.hasRunningBgTasks()) return;
    const running = this.bgRunning!;
    for (const taskId of running.keys()) {
      if (eligible != null && !eligible.has(taskId)) continue;
      // 'killed', not 'stale': `app/bgTasks.ts § normStatus` only understands
      // terminal words, and an unknown one lands on 'completed' — claiming a
      // task succeeded when its process was cut is the one wrong answer.
      const payload = { type: 'bg_task' as const, kind: 'finished' as const, taskId, status: 'killed' };
      // `stampSeq` (the `ready` path) makes these rows the identity receipt of
      // the event that ordered the burial, so replaying it is a no-op. The
      // status paths pass null: they are already replay-guarded upstream.
      const buriedRow = this._persist('event', payload, { seq: stampSeq });
      if (buriedRow === false) continue;
      this._broadcast(withRowId(payload, buriedRow));
      running.delete(taskId);
    }
    this._announceBgCount();
  }

  private _cancelBgFinish(): void {
    if (this.bgFinishTimer == null) return;
    clearTimeout(this.bgFinishTimer);
    this.bgFinishTimer = null;
  }

  /**
   * Notify "really finished" a few seconds after the last background task —
   * the delay is the whole point. A finished background task typically
   * re-invokes the model (§14.54), so the session is about to go `thinking`
   * again; announcing completion in that gap is exactly the false "done" this
   * feature exists to remove. If a new turn does start, its own `stop` sends
   * the normal notification instead.
   */
  private _scheduleBgFinishNotice(): void {
    this._cancelBgFinish();
    const t = setTimeout(() => {
      this.bgFinishTimer = null;
      if (this.status !== 'active') return;         // a new turn / sleep took over
      if (this.hasRunningBgTasks()) return;         // more work showed up
      if (this.peerDrivenFinish ?? this._peerTurnFromHistory()) return;
      // Same passive marker as a normal finish (§14.47) — this IS the finish.
      // Marked BEFORE the push: in-app green never trails a push (G6).
      try {
        db.update(agentSessions).set({ unreadStop: 1 })
          .where(eq(agentSessions.id, this.id)).run();
      } catch {}
      this._broadcast({ type: 'session_unread', unread: true });
      this._maybePush({
        event: 'session_finished',
        title: `✓ ${this.vpsName} · ${this._label()}`,
        body: 'background tasks finished',
        tag: `stop-${this.id}`,
      });
      sendPlainToTelegram(
        `✓ ${this.vpsName} · ${this._label()}\nbackground tasks finished`,
        `/?session=${this.id}`, 'session_finished',
      ).catch(() => {});
    }, BG_FINISH_GRACE_MS);
    // Never hold the process open for a notification.
    (t as unknown as { unref?: () => void }).unref?.();
    this.bgFinishTimer = t;
  }

  /** Compatibility with older agents and background completion after restart.
   * Replies received by the requester still belong to its user-facing work.
   * Bound the lookup by event time so replay cannot borrow a newer input. */
  private _peerTurnFromHistory(): boolean {
    const row = db.select({ role: sessionMessages.role, content: sessionMessages.content })
      .from(sessionMessages).where(and(
        eq(sessionMessages.sessionId, this.id),
        or(eq(sessionMessages.role, 'user'), and(
          eq(sessionMessages.role, 'event'),
          sql`CASE WHEN json_valid(${sessionMessages.content}) THEN json_extract(${sessionMessages.content}, '$.type') END = 'external_message'`,
        )),
        ...(this.currentEventTs == null ? [] : [sql`${sessionMessages.tsMs} <= ${this.currentEventTs}`]),
      )).orderBy(desc(sessionMessages.tsMs), desc(sessionMessages.id)).limit(1).get();
    if (row?.role !== 'event') return false;
    try {
      const input = JSON.parse(row.content);
      return input.origin === 'charon_peer' && input.expectsReply !== false;
    } catch { return false; }
  }

  /** Explicit user/lifecycle recovery permits the daemon's active status again. */
  clearTerminalErrorLatch(): void {
    this.fatalErrorNotified = false;
    this.terminalErrorLatched = false;
    this.pendingTerminalAssistantError = null;
    this.pendingAgentError = null;
    this.pendingTurnErrorKind = null;
    this.pendingBlockingErrorRecorded = false;
    this.pendingBlockingErrorAt = null;
    this.pendingTurnAssistantSeen = false;
    this.terminalErrorText = null;
    this.terminalErrorKind = null;
  }

  /**
   * On replay_begin: reset the window's identity state. Row identity is
   * looked up per event (replayIdentity.ts) and the legacy content Sets load
   * lazily (`_legacy()`), so the only thing read here is the session's
   * pending interaction ids — two tiny indexed tables. Never a session-wide
   * scan of the messages: that cost seconds per reconnect (§14.31).
   */
  private _beginReplayIdentity(): void {
    this.legacyReplay = null;
    this.legacyToolRows = null;
    this.replayKnownPendingIds.clear();
    try {
      const perms = db.select({ id: sessionPendingPermissions.id })
        .from(sessionPendingPermissions)
        .where(eq(sessionPendingPermissions.sessionId, this.id))
        .all();
      for (const p of perms) this.replayKnownPendingIds.add(p.id);
      const qs = db.select({ id: sessionPendingQuestions.id })
        .from(sessionPendingQuestions)
        .where(eq(sessionPendingQuestions.sessionId, this.id))
        .all();
      for (const q of qs) this.replayKnownPendingIds.add(q.id);
    } catch {}
  }

  /** The turn's prompt-cache facts (lib/promptCache.ts) from its one
   *  `usage final:true`. The session state is written now and reaches every
   *  sidebar through the summary; the ledger waits for `stop`, which names the
   *  final assistant row it belongs on (usage precedes stop for every agent;
   *  the reverse order still lands, without a live frame). */
  private _recordPromptCache(ev: Extract<AgentEvent, { event: 'usage' }>): void {
    const kind = asSessionProvider(this.kind);
    if (!PROVIDERS[kind].promptCache) return;
    try {
      const row = db.select({
        model: agentSessions.model, effectiveModel: agentSessions.effectiveModel,
        providerConfig: agentSessions.providerConfig, promptCacheJson: agentSessions.promptCacheJson,
      }).from(agentSessions).where(eq(agentSessions.id, this.id)).get();
      if (!row) return;
      const previous = parsePromptCache(row.promptCacheJson);
      let state = cacheStateFromUsage(kind, ev.turn_cache, {
        previousTtlS: previous?.ttlS ?? null, model: row.model ?? null, account: accountProfileId(row.providerConfig),
      });
      // An agent too old to count requests (< 0.121.0) still says a turn just
      // used the cache: keep the last known size and TTL, restart the clock
      // at this turn's end (a few seconds late at worst).
      const endedAt = this.currentEventTs ?? Date.now();
      if (!state && !ev.turn_cache && previous && endedAt > previous.at) {
        state = {
          ...previous, at: endedAt, expiresAt: endedAt + previous.ttlS * 1000,
          model: row.model ?? null, account: accountProfileId(row.providerConfig),
        };
      }
      if (state) {
        db.update(agentSessions).set({ promptCacheJson: JSON.stringify(state) })
          .where(eq(agentSessions.id, this.id)).run();
        markSummaryDirty(this.id);
      }
      const ledger = ledgerFromUsage(kind, ev, {
        model: row.effectiveModel ?? row.model ?? null, ttlS: state?.ttlS ?? previous?.ttlS ?? null,
        tools: this._turnToolCount(),
      });
      const late = this.awaitingTurnLedger;
      this.awaitingTurnLedger = null;
      if (!ledger) return;
      if (late && Date.now() - late.at < 30_000) {
        db.update(sessionMessages).set({ turnUsageJson: JSON.stringify(ledger) })
          .where(and(eq(sessionMessages.id, late.rowId), eq(sessionMessages.sessionId, this.id))).run();
      } else {
        this.pendingTurnLedger = ledger;
      }
    } catch (e: any) {
      this._log('warn', 'sdk_error', { msg: 'prompt cache record failed', err: e?.message ?? String(e) });
    }
  }

  /** At `stop`: the held ledger onto the turn's final assistant row (the same
   *  tick publishes it on the `stop` frame). A turn without a final row drops
   *  it — it must never land on a later turn's answer. */
  private _attachTurnLedger(finalAssistantId: number | null): TurnLedger | null {
    const ledger = this.pendingTurnLedger;
    this.pendingTurnLedger = null;
    this.awaitingTurnLedger = null;
    this.turnTools = null;
    if (finalAssistantId == null) return null;
    if (!ledger) {
      this.awaitingTurnLedger = { rowId: finalAssistantId, at: Date.now() };
      return null;
    }
    try {
      db.update(sessionMessages).set({ turnUsageJson: JSON.stringify(ledger) })
        .where(and(eq(sessionMessages.id, finalAssistantId), eq(sessionMessages.sessionId, this.id))).run();
      return ledger;
    } catch (e: any) {
      this._log('warn', 'sdk_error', { msg: 'turn ledger write failed', err: e?.message ?? String(e) });
      return null;
    }
  }

  /** Tool calls of the turn in progress: tool_use rows after the last user
   *  message or the previous turn's final answer (an indexed walk back over
   *  one turn). Codex hook/auto-review rows are not the model's calls. */
  private _turnToolCount(): number {
    try {
      const start = db.select({ id: sessionMessages.id }).from(sessionMessages)
        .where(and(
          eq(sessionMessages.sessionId, this.id),
          or(eq(sessionMessages.role, 'user'), eq(sessionMessages.assistantFinal, 1)),
        ))
        .orderBy(desc(sessionMessages.id)).limit(1).get()?.id ?? 0;
      const row = db.select({ n: sql<number>`count(*)` }).from(sessionMessages)
        .where(and(
          eq(sessionMessages.sessionId, this.id),
          sql`${sessionMessages.id} > ${start}`,
          eq(sessionMessages.role, 'tool_use'),
          sql`coalesce(json_extract(${sessionMessages.content}, '$.name'), '') NOT IN ('codex_hook', 'auto_review')`,
        )).get();
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  }

  private _finalizeAssistantTurn(): number | null {
    try {
      return db.transaction((tx) => {
        const session = tx.select({ id: agentSessions.pendingAssistantMessageId })
          .from(agentSessions).where(eq(agentSessions.id, this.id)).get();
        const id = session?.id;
        if (id == null) return null;
        const candidate = tx.select({ tsMs: sessionMessages.tsMs })
          .from(sessionMessages).where(eq(sessionMessages.id, id)).get();
        // A replayed stop from an earlier turn must not promote text written
        // by a later turn while the hub was disconnected.
        if (this.currentEventTs != null && candidate?.tsMs != null && candidate.tsMs > this.currentEventTs) {
          return null;
        }
        const changed = tx.update(sessionMessages).set({ assistantFinal: 1 })
          .where(and(
            eq(sessionMessages.id, id),
            eq(sessionMessages.sessionId, this.id),
            eq(sessionMessages.role, 'assistant'),
            eq(sessionMessages.assistantFinal, 0),
          )).run().changes;
        tx.update(agentSessions).set({ pendingAssistantMessageId: null })
          .where(eq(agentSessions.id, this.id)).run();
        return changed ? id : null;
      });
    } catch (e: any) {
      this._pinEvent(this.currentEventSeq);
      this._log('warn', 'sdk_error', { msg: 'assistant finalization failed', err: e?.message ?? String(e) });
      return null;
    }
  }

  private _persist(role: string, content: any, extra?: {
    model?: string | null; seq?: number | null; tsMs?: number | null; cliUuid?: string | null;
    // The holdback a failure leaves (see `holdbacks`): a buffer flush names
    // its own source so its later success can release it.
    holdbackKey?: string;
    // Unix seconds; default = the INSERT (the column default).
    createdAt?: number;
  }): number | false {
    // I8: no row is persisted while a reasoning block is open, except that
    // block's own row — in-stream hub writers (sendUserMessage, the codex
    // background reconcile) flush it first, so its row keeps id order.
    if (this.currentThinking && !(role === 'event' && content?.type === 'thinking')) this._flushThinking();
    // Stamp the row with the seq of the event being dispatched (null for
    // hub-originated rows like 'user' — sendUserMessage runs outside
    // dispatch). Flush rows override with the FIRST DELTA's seq via
    // extra.seq — every row's seq is then its own unique identity (no
    // boundary/flush collision). This is the replay-idempotence anchor
    // (P0.3). Returns false on failure so callers (flush) can restore.
    const seq = extra && 'seq' in extra ? extra.seq ?? null : this.currentEventSeq;
    // ts_ms is THE sort key (§14.71), so it must ALWAYS be set — never leave
    // it null and let the reader guess. Preference order: an explicit stamp
    // (flush rows carry the first delta's ts), then the event being
    // dispatched, then now (hub-originated rows like 'user', and agents too
    // old to send `ts`). Wall-clock has no epochs, so unlike `seq` this stays
    // monotonic across an agent event-log reset.
    const tsMs = (extra && 'tsMs' in extra ? extra.tsMs : null) ?? this.currentEventTs ?? Date.now();
    try {
      const rawContent = typeof content === 'string' ? content : JSON.stringify(content);
      const storage = deriveMessageStorage(role, rawContent);
      const turnDriver = role === 'user' || (role === 'event' && content?.type === 'external_message');
      if (role === 'user') this.peerDrivenFinish = false;
      const values = {
        sessionId: this.id, role,
        content: rawContent,
        ...storage,
        // Each newly flushed assistant row starts as intermediate; stop
        // promotes only the final row of this turn.
        ...(role === 'assistant' ? { assistantFinal: 0 } : {}),
        ...(extra?.model ? { model: extra.model } : {}),
        ...(seq != null ? { seq } : {}),
        ...(extra?.cliUuid ? { cliUuid: extra.cliUuid } : {}),
        ...(extra?.createdAt != null ? { createdAt: extra.createdAt } : {}),
        tsMs,
      };
      if (role !== 'assistant' && !turnDriver) {
        return Number(db.insert(sessionMessages).values(values).run().lastInsertRowid);
      }
      return db.transaction((tx) => {
        const pendingId = tx.select({ id: agentSessions.pendingAssistantMessageId })
          .from(agentSessions).where(eq(agentSessions.id, this.id)).get()?.id;
        const pendingTs = pendingId == null ? null : tx.select({ tsMs: sessionMessages.tsMs })
          .from(sessionMessages).where(eq(sessionMessages.id, pendingId)).get()?.tsMs;
        const isNewest = pendingTs == null || tsMs >= pendingTs;
        // This uses the same synchronous SQLite connection as tx and still
        // participates in its transaction. Keep the shared insert path so
        // injected DB failures exercise the flush holdback invariant.
        const result = db.insert(sessionMessages).values(values).run();
        const id = Number(result.lastInsertRowid);
        if (role === 'assistant' && isNewest) {
          tx.update(agentSessions).set({ pendingAssistantMessageId: id })
            .where(eq(agentSessions.id, this.id)).run();
        } else if (isNewest && turnDriver) {
          // A fresh prompt cannot finalize a provisional answer from an
          // interrupted earlier turn.
          tx.update(agentSessions).set({ pendingAssistantMessageId: null })
            .where(eq(agentSessions.id, this.id)).run();
        }
        return id;
      });
    } catch (e: any) {
      // Hold the durable cursor back to (seq - 1): the next restart will
      // replay this event and the insert gets a second chance — without
      // this, a failed write was silently lost forever (P0.2). A buffer
      // flush names its own releasable key; any write lost while an
      // assistant buffer is open also holds that buffer's anchor
      // (`_holdBackAnchored`, `_pinEvent`).
      if (extra?.holdbackKey) { if (seq != null) this._holdBackAnchored(extra.holdbackKey, seq); }
      else this._pinEvent(seq);
      this._log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
      return false;
    }
  }

  private _log(level: 'info' | 'warn' | 'error', event: string, detail?: any): void {
    try {
      db.insert(sessionLogs).values({
        sessionId: this.id, level, event,
        detail: detail ? JSON.stringify(detail) : null,
      }).run();
    } catch {}
  }

  private _surfacePermissionRequest(
    id: string, tool: string, input: unknown, expiresAt?: number, gate: PermissionGateExtras = {},
  ): void {
    this._broadcast({
      type: 'permission_request', id, tool, input, expiresAt,
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(gate.suggestions ? { suggestions: gate.suggestions } : {}),
    });
    this._log('info', 'permission', { id, tool });
    this._maybePush({
      event: 'permission',
      title: `🔒 ${this.vpsName} · ${this._label()} : permission`,
      body: `tool ${tool} — tap to approve`,
      tag: `perm-${this.id}`,
    });
    // Telegram's "Always" is the first CLI option for Claude (hidden when the
    // CLI offers none), the native session grant elsewhere.
    const always = supportsSessionCapability(this.kind, 'permissionSuggestions')
      ? offeredSuggestions(gate.suggestions)[0]?.label ?? null
      : undefined;
    sendPermissionToTelegram(this.id, id, tool, input, { reason: gate.reason, always }).catch(() => {});
  }


  private _scheduleInteractionExpiry(
    kind: 'permission' | 'question' | 'exit_plan',
    id: string,
    expiresAt: number,
  ): void {
    const delay = Math.max(0, expiresAt * 1000 - Date.now());
    const timer = setTimeout(() => {
      const resolvedAt = Math.floor(Date.now() / 1000);
      try {
        const result = kind === 'permission'
          ? db.update(sessionPendingPermissions)
              .set({ status: 'expired', respondedAt: resolvedAt })
              .where(and(
                eq(sessionPendingPermissions.id, id),
                eq(sessionPendingPermissions.sessionId, this.id),
                eq(sessionPendingPermissions.status, 'pending'),
              )).run()
          : db.update(sessionPendingQuestions)
              .set({ status: 'expired', respondedAt: resolvedAt })
              .where(and(
                eq(sessionPendingQuestions.id, id),
                eq(sessionPendingQuestions.sessionId, this.id),
                eq(sessionPendingQuestions.status, 'pending'),
              )).run();
        if (!result.changes) return;
      } catch {
        return;
      }
      this._broadcast({ type: 'interaction_resolved', kind, id, outcome: 'expired' });
      markInteractionResolvedInTelegram(kind, id);
    }, delay);
    timer.unref?.();
  }

  /** Human-friendly session label for notifications: explicit name, else
   * the last path segment of the cwd, else a short id. */
  private _label(): string {
    if (this.name) return this.name;
    if (this.cwd) {
      const base = this.cwd.split('/').filter(Boolean).slice(-1)[0];
      if (base) return base;
    }
    return this.id.slice(0, 6);
  }

  private _maybePush(payload: { event: NotificationEvent; title: string; body: string; tag?: string }): void {
    // Push trails summary (I17, §14.108): the in-app green / "needs you" goes
    // out BEFORE the push's synchronous VAPID work — the microtask flush would
    // otherwise run after it. Every Telegram send follows a _maybePush.
    flushSummaryNow(this.id);
    // `url` is the openWindow fallback used by the service worker when no
    // Charon tab is already open. The hub is a single responsive app at `/`
    // — the HubPanel picks up `?session=…` via useSearchParams and
    // switches selectedId. When a tab IS already open, the SW prefers
    // focus+postMessage; the root layout handler (`NotificationClickHandler`)
    // then routes via Next router to `/?session=…`.
    sendPushToAll({
      ...payload,
      sessionId: this.id,
      url: `/?session=${this.id}`,
    }).catch(() => {});
  }
}

// ── Helpers: stream open/close ──────────────────────────────────────────────
function _vpsName(vpsId: string): string {
  const [row] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  return row?.name ?? vpsId.slice(0, 6);
}

/**
 * Look up an in-memory SessionStream without instantiating one if absent.
 * Use for READ paths (status snapshot for SSE init, GET /sessions/[id])
 * where a null result is fine because the caller falls back to DB rows.
 *
 * Why this matters: every GET /api/events used to call getStream()
 * for every session row, which materialized SessionStream wrappers for
 * sleeping/historical sessions that nobody was attached to. Harmless but
 * wasteful — `peek` makes the read paths zero-allocation in steady state.
 */
export function peekStream(sessionId: string): SessionStream | null {
  return streams.get(sessionId) ?? null;
}

/** A session's cold bg-task registry finished warming in the background
 *  (bgTaskState.ts): its hydrated stream seeds what attach() deferred, and the
 *  focused browser gets the full-history ACTIVE set a window GET answered
 *  `backgroundTasksPending` without (`bg_tasks_snapshot`; through the stream
 *  when one is hydrated, lane coalescer flushed first, else on the bus). */
export function bgRegistryWarmed(sessionId: string): void {
  const stream = streams.get(sessionId);
  stream?.onBgRegistryWarm();
  let tasks: ReturnType<typeof runningBgTaskDetailsIfWarm>;
  try { tasks = runningBgTaskDetailsIfWarm(sessionId); } catch { return; }
  if (!tasks) return;   // invalidated meanwhile: its next reader warms it again
  // Same fields as the window GET's answer (C14): a running task's launcher
  // command/description, which a conversation-view rebuild cannot recover
  // (no tool rows) and the registry deliberately skips. The registry is warm
  // now, so the anchors resolve (O(running) bounded seeks).
  try { tasks = withBgTaskLaunchers(sessionId, tasks); } catch { /* the task's own fields stay */ }
  if (stream) stream.broadcastBgTasksSnapshot(tasks);
  else emitGlobalSession({ type: 'bg_tasks_snapshot', tasks, sessionId } as GlobalSessionEvent);
}

/** Publish a session's token totals (a cold token fold that finished warming
 *  in the background, sessionTokenUsage.ts): through its stream when one is
 *  hydrated (lane coalescer flushed first), else straight on the bus. */
export function broadcastSessionTokenUsage(sessionId: string, usage: SessionTokenUsage): void {
  const stream = streams.get(sessionId);
  if (stream) stream.broadcastTokenUsage(usage);
  else emitGlobalSession({ type: 'session_token_usage', usage, sessionId });
}

/**
 * Look up an in-memory SessionStream, or hydrate it from DB if absent.
 * Use for LIFECYCLE / WRITE paths (input, permission/question/exit_plan
 * response, mode change, reconcile-on-reconnect): these need a live
 * SessionStream because the next step will attach/dispatch agent events.
 *
 * Returns null only if the DB row doesn't exist.
 */
export function getOrCreateStream(sessionId: string): SessionStream | null {
  let s = streams.get(sessionId);
  if (s) return s;
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
  if (!row) return null;
  s = new SessionStream({
    id: row.id, vpsId: row.vpsId,
    name: row.name, status: row.status as WorkerStatus,
    kind: (row.kind as AgentKind) ?? 'claude',
    accountProfile: accountProfileId(row.providerConfig),
    permissionMode: row.permissionMode as SessionMode,
    nativeSessionId: row.nativeSessionId,
    cwd: row.cwd,
    // Hydrate the durable-replay cursor from DB. On the next attach,
    // SessionStream will pass this as `afterSeq` to the agent so it
    // replays exactly the events we missed (agent >= 0.4.0). Null
    // means "no checkpoint yet" — falls back to ring replay.
    lastSeenSeq: row.lastSeenSeq ?? null,
    lastStopNotifiedSeq: row.lastStopNotifiedSeq ?? null,
    model: row.model ?? null,
    fallbackModel: row.fallbackModel ?? null,
    effort: row.effort ?? null,
    customEndpoint: !!connectionConfig(row.providerConfig).customEndpoint,
    // Last API-confirmed model — needed right after a Charon restart so the
    // very next assistant flush is stamped correctly (the agent won't re-emit
    // `effective_model` unless it changes).
    effectiveModel: row.effectiveModel ?? null,
  });
  streams.set(sessionId, s);
  return s;
}

/**
 * @deprecated Use `peekStream` for read paths and `getOrCreateStream` for
 * lifecycle / write paths. Kept temporarily so external imports don't break;
 * the create-on-miss behavior makes it equivalent to `getOrCreateStream`.
 * Remove once no callers remain.
 */
export function getStream(sessionId: string): SessionStream | null {
  return getOrCreateStream(sessionId);
}

export function listStreams(): SessionStream[] {
  return Array.from(streams.values());
}

// ── Gate lifecycle publication (C07, G7) ────────────────────────────────────
// Every path that removes a human gate publishes `interaction_resolved`: the
// cross-session feed is add-only and otherwise keeps a ghost "needs you".

/** Publish a gate's resolution for ANY session: through its hydrated stream
 *  (lane coalescer flushed first), else straight on the bus; then retire the
 *  Telegram card. Callers persist first (I1). */
export function publishInteractionResolved(
  sessionId: string, kind: GateKind, id: string, outcome: GateOutcome,
  extra?: { answers?: Record<string, string> | null },
): void {
  const stream = streams.get(sessionId);
  if (stream) {
    stream.publishResolution(kind, id, outcome, extra);
    return;
  }
  emitGlobalSession({ type: 'interaction_resolved', kind, id, outcome, ...(extra ?? {}), sessionId });
  try { markInteractionResolvedInTelegram(kind, id); } catch {}
}

/** Expire every pending gate whose provider deadline passed and publish each
 *  `expired` (the GET/SSE snapshots and the 30 s sweeper call this; the
 *  in-process expiry timers do not survive a hub restart). Returns the count. */
export function sweepExpiredInteractions(nowSeconds?: number): number {
  const expired = expireStalePendingInteractions(nowSeconds);
  for (const gate of expired) publishInteractionResolved(gate.sessionId, gate.kind, gate.id, 'expired');
  return expired.length;
}

/** The session left the live states (sleeping/error/killed, force-stop): its
 *  BLOCKING gates can never be answered — cancel and publish each. Async
 *  questions survive (answering one resumes the session, §14.49). Used by the
 *  lifecycle paths that may run without a hydrated stream (sleep, force-stop)
 *  and, with its own publisher, by `SessionStream._cancelBlockingGates`. */
function cancelSessionBlockingGates(
  sessionId: string,
  publish: (gate: GateRef) => void = (gate) => publishInteractionResolved(sessionId, gate.kind, gate.id, 'cancelled'),
): void {
  let cancelled: GateRef[];
  try {
    cancelled = cancelBlockingGateRows(sessionId);
  } catch (e) {
    console.warn(`[sessionOps] ${sessionId} blocking gate cancel failed:`, (e as Error)?.message ?? e);
    return;
  }
  for (const gate of cancelled) publish(gate);
}

// ── Session lifecycle (create/resume/sleep/kill/import) ─────────────────────

/**
 * Where a brand-new session goes in the sidebar: at the END of its VPS.
 *
 * `position` defaults to 0 and an untouched list sorts by `createdAt` (§14.80),
 * so a new row LOOKS last until you drag something — at which point that VPS's
 * rows become 0..n-1 and the next session, still at 0, jumps to the TOP of a
 * list it has nothing to do with. Stamping max+1 makes "new goes last" true in
 * both worlds, and costs one query.
 */

export function nextSessionPosition(vpsId: string): number {
  const [row] = db
    .select({ max: sql<number | null>`max(${agentSessions.position})` })
    .from(agentSessions)
    .where(and(
      eq(agentSessions.vpsId, vpsId),
      eq(agentSessions.archived, 0),
    ))
    .all();
  return (row?.max ?? -1) + 1;
}

/**
 * Create a DB row for a Claude session that already exists SDK-side (e.g.
 * found by /api/vps/[id]/claude/scan). The session is born 'sleeping' with
 * its claude_session_id; a later resume materializes it on the agent side
 * via start_session(claude_session_id=...).
 */
export async function importExistingSession(opts: {
  accountProfile?: string;
  vpsId: string;
  cwd: string;
  nativeSessionId: string;
  name?: string | null;
  kind?: AgentKind;
  permissionMode?: SessionMode;
}): Promise<string> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);
  const sessionId = newId();
  const kind: AgentKind = asSessionProvider(opts.kind);
  const defaultMode = resolveConfiguredSessionMode(kind);
  const handle = allocateSessionHandle(opts.vpsId, {
    id: sessionId, name: opts.name ?? null, cwd: opts.cwd,
  });
  // An IMPORTED session is a session like any other: it must inherit this
  // VPS's settings scope too, or the same transcript would run under different
  // rules depending on how it entered Charon.
  const { requireAccountProfile } = await import('./accountProfiles');
  const { defaultAccountFor } = await import('@/lib/server/accounts/store');
  const profile = requireAccountProfile(opts.vpsId, kind,
    opts.accountProfile && opts.accountProfile !== 'default' ? opts.accountProfile : defaultAccountFor(kind) ?? 'default');
  const providerConfig = resolveProviderConfig(kind, { accountProfile: profile.id, accountProfileNumber: profile.number }, vps);
  db.insert(agentSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    nativeSessionId: opts.nativeSessionId,
    cwd: opts.cwd,
    name: opts.name ?? null,
    handle,
    kind,
    providerConfig: providerConfig ? JSON.stringify(providerConfig) : null,
    status: 'sleeping',
    permissionMode: opts.permissionMode ?? defaultMode,
    position: nextSessionPosition(opts.vpsId),
  }).run();
  // Live-announce the imported session (appears on every tab/device). §14.52.
  emitGlobalSessionListChanged(sessionId);
  return sessionId;
}

/** `start_session` parent params, the parent's CURRENT handle read from DB
 *  (§14.35). Absent for a root session. */
function parentStartParams(parentId: string | null | undefined): Record<string, string | null> {
  if (!parentId) return {};
  const p = db.select({ handle: agentSessions.handle }).from(agentSessions)
    .where(eq(agentSessions.id, parentId)).get();
  return { parent_session_id: parentId, parent_handle: p?.handle ?? null };
}

export async function startNewSession(opts: {
  // Internal callers that need transactional cleanup (cross-provider fork)
  // may reserve the id before the agent call. Public create leaves it unset.
  sessionId?: string;
  vpsId: string;
  cwd: string;
  name?: string | null;
  // 'claude' (default) | 'codex'. Selects the backend + config semantics.
  kind?: AgentKind;
  // Claude: a PermissionMode. Codex: sandbox mode or combined accept-all.
  permissionMode?: SessionMode;
  // Optional config overrides. If null/undefined we fall back to the global
  // defaults (claude.default_* or codex.default_*); if those are also empty,
  // the agent passes nothing → the SDK/Codex uses its own default. Effort is
  // validated per-kind; an invalid string is silently dropped. fallbackModel
  // is Claude-only (Codex ignores it).
  model?: string | null;
  fallbackModel?: string | null;
  effort?: string | null;
  sessionConfig?: ProviderSessionConfig | null;
  /** @deprecated internal compatibility while old callers migrate. */
  providerConfig?: CodexSessionConfig | null;
  /** The session whose agent spawned this one (sub-session). */
  parentSessionId?: string | null;
}): Promise<SessionStream> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);

  const kind: AgentKind = asSessionProvider(opts.kind);
  const defaultMode = resolveConfiguredSessionMode(kind);
  const permissionMode: SessionMode = opts.permissionMode ?? defaultMode;
  const sessionId = opts.sessionId ?? newId();
  // Resolve effective config: per-session opts first, then global defaults.
  // We persist the RESOLVED values to the DB row so they survive a Charon
  // restart even if the global default changes later. (If we stored null
  // here and read the default at start time, changing the SettingsModal
  // default would silently retroactively change sessions — surprising.)
  const cfg = _resolveSessionConfig(kind, {
    model: opts.model, fallbackModel: opts.fallbackModel, effort: opts.effort,
  });
  let requestedConfig = opts.sessionConfig ?? opts.providerConfig ?? null;
  // Hub-owned accounts (§14.115): every session runs on one. No choice ⇒ the
  // provider's first usable account; a custom endpoint needs none.
  if (!(requestedConfig as { customEndpoint?: unknown } | null)?.customEndpoint
      && (!requestedConfig?.accountProfile || requestedConfig.accountProfile === 'default')) {
    const { defaultAccountFor } = await import('@/lib/server/accounts/store');
    const fallback = defaultAccountFor(kind);
    if (!fallback) throw new Error(`Add a ${providerName(kind)} account first (Accounts).`);
    requestedConfig = { ...(requestedConfig ?? {}), accountProfile: fallback };
  }
  if (requestedConfig?.accountProfile) {
    const { requireAccountProfile, readProfileStatus } = await import('./accountProfiles');
    const profile = requireAccountProfile(opts.vpsId, kind, requestedConfig.accountProfile);
    if (profile.loggedIn === false) throw new Error('This account must be signed in again (Accounts).');
    if ((await import('@/lib/server/accounts/store')).isGlobalAccountId(profile.id)) {
      // An agent predating hub accounts would read the id as an unknown local
      // profile and run signed out (§14.115).
      const client = getAgentClientForVpsId(opts.vpsId);
      if (client.status === 'connected' && client.hello && !client.hello.global_accounts) {
        throw new Error("Update this VPS's agent first — it predates hub accounts.");
      }
    }
    if (profile.number > 1 && !(await import('@/lib/server/accounts/store')).isGlobalAccountId(profile.id)) {
      const auth = await readProfileStatus(opts.vpsId, kind, profile.id);
      if (!auth.logged_in) throw new Error('Sign in to this account profile first');
    }
    requestedConfig = { ...requestedConfig, accountProfile: profile.id, accountProfileNumber: profile.number };
  }
  const providerConfig = resolveProviderConfig(kind, requestedConfig, vps);
  const customEndpoint = !!(providerConfig as any)?.customEndpoint;
  // Cursor's parameter set must match the model it runs with: an undeclared
  // knob fails every turn, and the Settings default may predate its model
  // (§14.103).
  if (kind === 'cursor' && !customEndpoint && cfg.effort) {
    cfg.effort = await adaptCursorEffortForVps(opts.vpsId, cfg.model, cfg.effort);
  }
  const effortPersist = isValidEffortForKind(cfg.effort, kind, customEndpoint) ? cfg.effort : null;
  // Allocated after the last await: nothing may yield between reading the
  // taken handles and the INSERT that claims this one (UNIQUE per VPS, §14.93).
  const handle = allocateSessionHandle(opts.vpsId, {
    id: sessionId, name: opts.name ?? null, cwd: opts.cwd,
  });

  // Insert in DB first (status 'starting' until agent confirms)
  db.insert(agentSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    cwd: opts.cwd,
    name: opts.name ?? null,
    handle,
    kind,
    status: 'starting',
    permissionMode,
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    effort: effortPersist,
    // Historical column name; the JSON is provider-neutral.
    providerConfig: providerConfig ? JSON.stringify(providerConfig) : null,
    lastUsedAt: Math.floor(Date.now() / 1000),
    position: nextSessionPosition(opts.vpsId),
    parentSessionId: opts.parentSessionId ?? null,
  }).run();

  const stream = new SessionStream({
    id: sessionId, vpsId: opts.vpsId,
    name: opts.name ?? null, status: 'starting',
    accountProfile: accountProfileId(providerConfig),
    kind,
    permissionMode,
    cwd: opts.cwd,
    nativeSessionId: null,
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    effort: effortPersist,
    customEndpoint,
  });
  streams.set(sessionId, stream);

  // IMPORTANT ORDER: start_session BEFORE subscribe.
  // The agent-side subscribe throws if the session doesn't exist yet.
  // Events emitted during start_session (`status=starting`) stay in the
  // ring buffer on the agent side and are replayed at subscribe time (replay=300).
  try {
    const client = getAgentClientForVpsId(opts.vpsId);
    await client.call('start_session', {
      session_id: sessionId,
      // 'kind' selects the backend agent-side (agent >= 0.15.0). Older agents
      // ignore the unknown param and default to Claude — but a codex-kind
      // create is gated on codexAvailable at the API route, so an old agent
      // never reaches here for a Codex session.
      kind,
      cwd: opts.cwd,
      name: opts.name ?? null,
      handle,
      permission_mode: permissionMode,
      // Pass-through to the agent. Older agents (< 0.5.0) silently ignore
      // unknown params — the SDK call falls back to its own defaults.
      model: cfg.model,
      fallback_model: cfg.fallbackModel,
      effort: effortPersist,
      session_config: runtimeConnection(providerConfig),
      // Compatibility with an older agent that only reads this key.
      codex_config: kind === 'codex' ? runtimeConnection(providerConfig) : null,
      // Stable Charon peer address. Claude also mirrors it to native --name.
      cli_name: handle,
      ...parentStartParams(opts.parentSessionId),
    });
  } catch (e: any) {
    streams.delete(sessionId);
    // Persisted AND published (R5 §7.3): the row was INSERTed `starting`.
    setSessionStatusLocal(sessionId, 'error');
    throw e;
  }
  stream.attach();
  // Live-announce the new session so every other tab/device refetches its
  // sidebar instead of waiting for the 15s poll. cf. CLAUDE.md §14.52.
  emitGlobalSessionListChanged(sessionId);
  return stream;
}

// Dedup of concurrent calls to resumeSession for the same sessionId.
// Without this, two paths (autoConnect.opportunistic + reconcileVpsAgentState
// fallback) could race on start_session and one would fail with
// "already exists" → the catch handler would demote the session to 'sleeping'
// while the other just woke it up. Cf. CLAUDE.md §14 gotcha 24.
// Next builds route and instrumentation copies of this module. They share the
// pool, so they must also share the lock around one session's resume RPC.
const resumeGlobal = globalThis as unknown as { _sessionResumes?: Map<string, Promise<SessionStream>> };
const _resumeInflight = resumeGlobal._sessionResumes ??= new Map<string, Promise<SessionStream>>();

/**
 * Resume: attempts the sequence (resume_session if the session exists on
 * the agent side, otherwise start_session with the saved claude_session_id).
 * Idempotent DB-side: leaves the status at 'active' once the agent confirms.
 * Idempotent concurrency-side too: two simultaneous calls for the same
 * session share the same promise (cf. `_resumeInflight`).
 */
export async function resumeSession(sessionId: string): Promise<SessionStream> {
  const existing = _resumeInflight.get(sessionId);
  if (existing) {
    return existing;
  }
  // Apply before owning the resume lock: applying an idle connection may itself
  // resume the session. Holding both promises would make them await each other.
  const pendingRow = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
  if (pendingRow && !pendingRow.archived && connectionConfig(pendingRow.providerConfig).pendingConnection) {
    await (await loadEndpointOps()).applyPendingEndpoint(sessionId);
    const concurrent = _resumeInflight.get(sessionId);
    if (concurrent) return concurrent;
  }
  const p = (async () => {
    const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
    if (!row) throw new Error(`session ${sessionId} not found`);
    if (row.archived) throw new Error('session is archived; unarchive it before resuming');
    // Note: the `status === 'killed'` guard was removed with the kill→delete
    // merge. A killed session no longer exists in DB; this path is dead.

    const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, row.vpsId)).all();
    if (!vps) throw new Error('vps no longer exists');

    const kind: AgentKind = (row.kind as AgentKind) ?? 'claude';
    let stream = streams.get(sessionId);
    if (!stream) {
      stream = new SessionStream({
        id: row.id, vpsId: row.vpsId,
        name: row.name, status: row.status as WorkerStatus,
        kind,
        accountProfile: accountProfileId(row.providerConfig),
        permissionMode: row.permissionMode as SessionMode,
        nativeSessionId: row.nativeSessionId,
        cwd: row.cwd,
        lastSeenSeq: row.lastSeenSeq ?? null,
        lastStopNotifiedSeq: row.lastStopNotifiedSeq ?? null,
        model: row.model ?? null,
        fallbackModel: row.fallbackModel ?? null,
        effectiveModel: row.effectiveModel ?? null,
        effort: row.effort ?? null,
        customEndpoint: !!connectionConfig(row.providerConfig).customEndpoint,
      });
      streams.set(sessionId, stream);
    } else {
    }

    const client = getAgentClientForVpsId(row.vpsId);
    if (accountProfileId(row.providerConfig) !== 'default') {
      const { readProfileStatus } = await import('./accountProfiles');
      await readProfileStatus(row.vpsId, kind, accountProfileId(row.providerConfig));
    }
    // ORDER: make sure the session exists on the agent side BEFORE subscribing
    // (otherwise the subscribe RPC throws session_not_found).
    //
    // `resolvedStatus` = the agent's AUTHORITATIVE status after the resume.
    // It is the linchpin of the noop path below: when the agent already has
    // the session running it returns {noop:true} and emits NO status event,
    // so without adopting this value the in-memory stream would keep whatever
    // stale status it had (typically 'sleeping' after a desync) forever — and
    // the /resume route would keep reporting 'sleeping'. See CLAUDE.md §14
    // gotcha 36.
    let resolvedStatus: WorkerStatus = 'starting';
    let resumedNoop = false;
    try {
      // Reassert the stable handle on every resume. Claude's native --name is
      // start-time only; Charon's common bus changes immediately.
      const rpcRes = await client.call('resume_session', {
        session_id: sessionId,
        handle: row.handle,
        cli_name: row.handle,
        session_config: withRememberedRules(kind, runtimeConnection(parseProviderConfig(row.providerConfig)), row.alwaysAllowTools),
        model: row.model, fallback_model: row.fallbackModel, effort: row.effort,
      });
      const agentStatus = (rpcRes as { status?: string } | undefined)?.status;
      if (rpcRes?.ok === false) throw new Error('agent refused to resume session');
      if (agentStatus && !['active', 'thinking', 'starting'].includes(agentStatus)) {
        throw new Error(`resume failed: agent status ${agentStatus}`);
      }
      if (agentStatus === 'active' || agentStatus === 'thinking' || agentStatus === 'starting') {
        resolvedStatus = agentStatus;
      }
      resumedNoop = (rpcRes as { noop?: unknown } | undefined)?.noop === true;
    } catch (e: any) {
      const isNotFound = /not found/i.test(e?.message ?? '') || e?.code === -32000;
      if (!isNotFound) throw e;
      // The worker that held this session's blocking gates is gone; a fresh
      // one cannot answer them (D-13 dead sessions): cancel and publish.
      cancelSessionBlockingGates(sessionId);
      // Recreate from scratch (the agent doesn't know this session). We
      // pass the persisted kind + model/fallback/effort so the resumed
      // session matches the original config — without this, a freshly
      // restarted agent would silently revert to Claude / SDK defaults for
      // every session. (§14.35 — resume MUST re-read config from DB.)
      try {
        await client.call('start_session', {
          session_id: sessionId,
          kind,
          cwd: row.cwd,
          name: row.name,
          permission_mode: row.permissionMode,
          claude_session_id: row.nativeSessionId,
          model: row.model ?? null,
          fallback_model: row.fallbackModel ?? null,
          effort: row.effort ?? null,
          session_config: withRememberedRules(kind, runtimeConnection(parseProviderConfig(row.providerConfig)), row.alwaysAllowTools),
          codex_config: kind === 'codex' ? runtimeConnection(parseProviderConfig(row.providerConfig)) : null,
          // Reassert both provider-neutral identity and Claude's native name.
          handle: row.handle,
          cli_name: row.handle,
          ...parentStartParams(row.parentSessionId),
        });
      } catch (startErr: any) {
        // If another concurrent call just created it (race between
        // two resume paths), the agent replies "already exists". In that
        // case we treat it as a success: the session is properly on the agent.
        const msg = startErr?.message ?? '';
        if (!/already exists/i.test(msg)) throw startErr;
      }
    }
    // An explicit resume is the acknowledgement/recovery boundary for a
    // connected failed-turn marker. Clear the local latch before resubscribing so
    // the daemon's authoritative active frame is accepted again.
    stream.clearTerminalErrorLatch();
    // A noop left the CLI, and every task it runs, alive: its idle `active` is
    // not "done" while that work runs (§14.91). Every hub restart resumes the
    // live sessions, so adopting it verbatim repainted them all green. A real
    // restart is different — its `ready` buries the dead CLI's tasks.
    if (resumedNoop && resolvedStatus === 'active' && stream.hasRunningBgTasks()) {
      resolvedStatus = 'background';
    }
    // If the user had already opened the SSE before the resume, attach() has
    // already tried a subscribe on the agent side that failed (session not yet
    // existing). Force a new subscribe now that it exists — but ONLY then: when
    // attach() just subscribed, a second subscribe replays the same range a
    // second time (§14.31; it once doubled a whole answer's text).
    if (!stream.attach()) client.resubscribe(sessionId);
    // Reconcile the in-memory stream + every SSE client + DB with the agent's
    // authoritative status. CRITICAL for the noop path: a session the agent
    // already considers active emits NO status event, so without this the
    // in-memory status stays pinned to its stale value (typically 'sleeping'),
    // /resume returns {status:'sleeping'}, and the UI shows the session as
    // never resuming — clicking "resume" has no visible effect. Mirrors
    // sleepSession's optimistic broadcast pattern. See CLAUDE.md §14 gotcha 36.
    stream.status = resolvedStatus;
    emitGlobalSession({ type: 'status', status: resolvedStatus, sessionId });
    // Startup is asynchronous: retain post-update intent until active/thinking
    // is confirmed. A queued start can still fail or stop (§14.62).
    db.update(agentSessions).set({ status: resolvedStatus, sleepRequested: 0,
      ...(resolvedStatus === 'starting' ? {} : { resumePending: 0 }) })
      .where(eq(agentSessions.id, sessionId)).run();
    return stream;
  })();
  _resumeInflight.set(sessionId, p);
  try {
    return await p;
  } finally {
    _resumeInflight.delete(sessionId);
  }
}

export async function sleepSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
  if (!row) return;
  // Record the DURABLE sleep intent alongside the status (cf. CLAUDE.md §14.46):
  // if the agent is down right now, this fire-and-forget sleep_session RPC may
  // never land; the agent would later restore the session as 'active' and
  // reconcileVpsAgentState would resurrect it. The flag lets reconcile honor
  // the user's intent and re-fire the sleep instead.
  db.update(agentSessions).set({ status: 'sleeping', sleepRequested: 1, resumePending: 0 })
    .where(eq(agentSessions.id, sessionId)).run();
  // Optimistic broadcast: flip the status to 'sleeping' for ALL SSE clients
  // (sidebar badges + other tabs) right away. The acting tab already updated
  // locally; this covers everyone else. We deliberately do NOT wait for the
  // agent's own status=sleeping event, which only comes back AFTER the SDK
  // teardown — session.py stop() awaits the in-flight turn (up to 5s) before
  // the RPC returns.
  const stream = streams.get(sessionId);
  if (stream) stream.status = 'sleeping';
  emitGlobalSession({ type: 'status', status: 'sleeping', sessionId });
  // The worker is being torn down: its blocking gates die with it (C07).
  cancelSessionBlockingGates(sessionId);
  // Fire the agent RPC without blocking the HTTP response on the teardown.
  // The DB + broadcast already reflect 'sleeping'; the agent stop() is
  // best-effort cleanup. Errors are logged, never surfaced (the agent may
  // simply be down).
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    client.call('sleep_session', { session_id: sessionId }).catch((e) => {
      console.warn(`[sessionOps] sleep ${sessionId}: agent call failed`, (e as Error)?.message ?? e);
    });
  } catch (e) {
    console.warn(`[sessionOps] sleep ${sessionId}: agent unreachable, DB marked anyway`);
  }
}

/**
 * Restart the SDK session IN PLACE: awaited sleep, then a normal resume.
 * THE way to apply a deferred model/effort change immediately (§14.35 —
 * the SDK binds both at client construction, so `set_model`/`set_effort`
 * only take effect at the next start). The "apply now" ↻ button next to
 * the pending badge calls this.
 *
 * Deliberately different from sleepSession(): that one fires the agent RPC
 * fire-and-forget (UI snappiness). Here we MUST await it — the agent's
 * `sleep_session` handler returns only after the SDK teardown completes,
 * and resume_session on a still-running session is a NOOP (§14.36): an
 * unawaited sleep would make the restart silently apply nothing.
 *
 * An already-stopped/unknown session agent-side (-32000/-32001) is fine:
 * we proceed straight to resume (which also handles the start_session
 * fallback and re-reads model/fallback/effort from DB).
 */
export async function restartSession(sessionId: string): Promise<SessionStream> {
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
  if (!row) throw new Error(`session ${sessionId} not found`);

  const wasRunning = ['active', 'thinking', 'starting', 'failed', 'background'].includes(row.status);
  if (wasRunning) {
    const client = getAgentClientForVpsId(row.vpsId);
    try {
      await client.call('sleep_session', { session_id: sessionId });
    } catch (e) {
      if (e instanceof AgentRpcError && (e.code === -32000 || e.code === -32001)) {
        // Session already gone agent-side — nothing to stop, resume will
        // relaunch it via start_session(claude_session_id=…).
      } else {
        throw e; // agent unreachable / timeout → surface to the caller
      }
    }
    // Bookkeeping between the two phases (mirrors sleepSession minus
    // sleepRequested — the user wants it RUNNING; setting the durable
    // sleep intent here could race reconcile into re-sleeping it). Through
    // the helper (S9): a sleep the agent never echoed (-32000/-32001) followed
    // by a failed resume must still reach every tab and the summary.
    setSessionStatusLocal(sessionId, 'sleeping');
  }

  return resumeSession(sessionId);
}

export async function forceStopSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
  if (!row) return;
  // Durable stop intent — same rationale as sleepSession (CLAUDE.md §14.46).
  db.update(agentSessions).set({ status: 'sleeping', sleepRequested: 1, resumePending: 0 })
    .where(eq(agentSessions.id, sessionId)).run();
  const stream = streams.get(sessionId);
  if (stream) {
    try {
      await stream.forceStop();
    } catch (e) {
      // S3: the DB already says `sleeping` (durable stop intent); memory and
      // every tab must too — the caller still learns the RPC failed.
      setSessionStatusLocal(sessionId, 'sleeping', { persist: false });
      throw e;
    }
  } else {
    // No stream in memory — try to reach the agent anyway
    try {
      const client = getAgentClientForVpsId(row.vpsId);
      await client.call('force_stop', { session_id: sessionId });
    } catch {
      // Agent down: DB is already 'sleeping', user can resume later. Publish
      // it (S3): no stream, so nothing else would.
      setSessionStatusLocal(sessionId, 'sleeping', { persist: false });
      return;
    }
  }
  // The forced stop landed: the worker's blocking gates died with it (C07).
  cancelSessionBlockingGates(sessionId);
}

/**
 * Kill ONE background task, leaving the session itself alone (§14.91).
 *
 * The escape hatch for the case the registry cannot detect: a task that is
 * genuinely still running but can no longer finish — a `Bash
 * run_in_background` wait-loop whose guard never becomes true, say. Nothing
 * hub-side can tell that apart from slow honest work, so this is a decision
 * only the user can make; the 24h age cap is a backstop, not an answer.
 *
 * Deliberately NOT a DB write: the hub does not mark the task dead, it asks
 * the CLI to stop it and lets the resulting terminal `bg_task` event flow back
 * through the normal path (`case 'bg_task'` → `_trackBgTask`) — which is what
 * clears the registry, drops the session out of `background` and, once the
 * last task is gone, fires the deferred "finished" notice. Writing a burial
 * row here would be a hub-side guess that the kill worked.
 */
export async function stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
  if (!row) throw new Error('session not found');
  const client = getAgentClientForVpsId(row.vpsId);
  // `stop_bg_task` is the SDK's `stop_task` — Claude-only, and the agent
  // answers -32602 for anything else. A Codex session's rows in the same bar
  // are its native background terminals reconciled into the common lifecycle
  // (§14.95), so the kill is `stop_background_terminal` and the process id is
  // already in the task id. Translated HERE, not agent-side, so it works on
  // every agent already deployed (the RPC exists since 0.53.0) instead of
  // needing a fleet rollout.
  const isCodex = row.kind === 'codex';
  const processId = isCodex ? codexTerminalProcessId(taskId) : null;
  if (isCodex && !processId) {
    // Sub-agent spawns and peer turns: real background work, but the provider
    // exposes no per-item stop. Say what DOES stop it.
    throw new Error(providerText.cannotStopItem(row.kind));
  }
  try {
    const res: any = processId
      ? await client.call('stop_background_terminal', { session_id: sessionId, process_id: processId })
      : await client.call('stop_bg_task', { session_id: sessionId, task_id: taskId });
    // The terminal RPC answers an ENVELOPE rather than raising (§14.95), and a
    // `terminated:false` is a refusal, not an ack — surfacing it is the whole
    // difference between "still running" and a button that silently did nothing.
    if (processId && res && typeof res === 'object') {
      if (res.ok === false) throw new Error(String(res.error || 'the agent refused to stop this process'));
      if (res.terminated === false) throw new Error('the process did not terminate');
    }
  } catch (e) {
    // -32601: the agent predates the RPC. Detected from the RPC error rather
    // than from vps.agentVersion, which lags a rollout (§14.76). Say what to
    // do — "no such method" in a toast is not an instruction.
    if (e instanceof AgentRpcError && e.code === -32601) {
      throw new Error(processId
        ? "this VPS's agent is too old to stop a background process — update it (needs 0.53.0)"
        : "this VPS's agent is too old to stop a task — update it (needs 0.35.0)");
    }
    throw e;
  }
}

/**
 * Permanent deletion of a session: kills on the agent side, releases the
 * stream, notifies the SSEs, and cascades the DB deletion (messages/
 * permissions/questions/logs/session row).
 *
 * Historical note: there used to be an intermediate `'killed'` state (DB
 * row kept for post-mortem inspection but resume blocked). That was a
 * UX false friend — the "pause" button in the header actually called
 * `kill`. The refactor merged this middle state with hard deletion:
 * only `sleep` is reversible now, everything else destroys the session.
 *
 * The `status='killed'` event is still emitted on the bus as a **transient
 * signal** to active SSEs (= "get out, the session no longer exists").
 * No DB row carries this status — migration 0008 purged the vestiges.
 *
 * Order of operations:
 *   1. Emit `status=killed` immediately (notify SSEs still attached
 *      before the stream is detached → don't miss the signal).
 *   2. Detach + remove the local SessionStream.
 *   3. DB cascade. The FK ON DELETE CASCADE covers messages/permissions/
 *      questions/logs from `agentSessions`, but we explicitly delete
 *      logs too as defense in depth (they existed outside the cascade
 *      historically in the code).
 *   4. Fire-and-forget `kill_session` on the agent so slow remote shutdown
 *      never holds the HTTP DELETE/modal open. If the agent is down, the next
 *      reconcile ignores the orphan (cf. `reconcileVpsAgentState`).
 *
 * `announce: false` is for a caller deleting MANY (the bulk route): it skips
 * the two list-level broadcasts — each one makes every open tab refetch the
 * whole session list — and announces once itself from the returned facts.
 * The per-session `killed` status still goes out: a view open on that session
 * must hear it whatever deleted it. Synchronous up to the agent call, so a
 * caller's check-then-delete cannot interleave with another request.
 */
export async function deleteSession(
  sessionId: string,
  opts: { announce?: boolean } = {},
): Promise<{ deleted: boolean; tabsDropped: boolean }> {
  const announce = opts.announce ?? true;
  const [row] = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).all();
  if (!row) return { deleted: false, tabsDropped: false };
  emitGlobalSession({ type: 'status', sessionId, status: 'killed' } as GlobalSessionEvent);
  const stream = streams.get(sessionId);
  if (stream) {
    stream.detach();
    streams.delete(sessionId);
  }
  // Pending gates go with the cascade: read them first, publish after (G7).
  let gates: GateRef[] = [];
  const repacked: string[] = [];
  let orphans: string[] = [];
  db.transaction((tx) => {
    gates = deleteSessionGates(sessionId);
    const siblings = tx.select({
      id: agentSessions.id, cwd: agentSessions.cwd,
      position: agentSessions.position, createdAt: agentSessions.createdAt,
      archived: agentSessions.archived,
    }).from(agentSessions).where(eq(agentSessions.vpsId, row.vpsId)).all();
    // Archived rows are absent from the sidebar and cannot anchor a path.
    const visibleSiblings = siblings.filter((sibling) => sibling.archived === 0);
    const order = sidebarOrderAfterDelete(visibleSiblings, sessionId);
    tx.delete(sessionLogs).where(eq(sessionLogs.sessionId, sessionId)).run();
    // No FK on parent_session_id: children are re-rooted here (sub-sessions).
    orphans = tx.select({ id: agentSessions.id }).from(agentSessions)
      .where(eq(agentSessions.parentSessionId, sessionId)).all().map((r) => r.id);
    if (orphans.length) {
      tx.update(agentSessions).set({ parentSessionId: null })
        .where(eq(agentSessions.parentSessionId, sessionId)).run();
    }
    tx.delete(agentSessions).where(eq(agentSessions.id, sessionId)).run();
    if (order) {
      const previousPositions = new Map(siblings.map((sibling) => [sibling.id, sibling.position]));
      const archivedOrder = siblings.filter((sibling) => sibling.archived !== 0 && sibling.id !== sessionId)
        .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((sibling) => sibling.id);
      [...order, ...archivedOrder].forEach((id, position) => {
        if (previousPositions.get(id) !== position) {
          tx.update(agentSessions).set({ position }).where(eq(agentSessions.id, id)).run();
          repacked.push(id);
        }
      });
    }
  });
  for (const gate of gates) publishInteractionResolved(sessionId, gate.kind, gate.id, 'cancelled');
  // Gone from every list (§14.108): the summary store drops it on this frame.
  emitGlobalSession({ type: 'session_summary', summary: null, sessionId });
  // The pack moved siblings' `position` (a summary fact) behind the bus (I9):
  // republish them (this tick; bulk-delete's `syncAfter('dirty')` covers them).
  for (const id of repacked) markSummaryDirty(id);
  // Re-rooted children changed `parentSessionId` (a summary fact).
  for (const id of orphans) markSummaryDirty(id);
  // Its rows went with the cascade: free the incremental folds (I11).
  invalidateSessionRowCaches(sessionId);
  // Attachment ROWS go with the FK cascade, but the hub-side blobs under
  // data/uploads/<sessionId>/ are plain files nothing else would ever collect —
  // without this they leak for the lifetime of the install. Fire-and-forget:
  // the session is already gone as far as the user is concerned, and a failed
  // unlink must not turn a delete into an error.
  void purgeSessionBlobs(sessionId);
  // Nothing is happening in a session that no longer exists. §14.88
  clearSessionActivity(sessionId);
  // The tab is a view of the session, so it goes with it — but only the tab:
  // closing a tab never deletes a session, and this is the one direction that
  // does propagate. §14.78
  let tabsDropped = false;
  try {
    tabsDropped = dropTabsForRef('session', sessionId);
    if (tabsDropped && announce) emitGlobalTabsChanged();
  } catch { /* the layout is not worth failing a delete over */ }
  // Live-announce the removal so every other tab/device drops the card. §14.52.
  if (announce) emitGlobalSessionListChanged(sessionId);
  void (async () => {
    try {
      const client = getAgentClientForVpsId(row.vpsId);
      await client.call('kill_session', { session_id: sessionId });
    } catch {
      // Agent down: Charon already deleted it; reconciliation ignores the
      // orphan (no DB row), then the next daemon restart cleans state.json.
    }
  })();
  return { deleted: true, tabsDropped };
}

/**
 * A VPS delete takes every session of that VPS with the FK cascade (vps →
 * sessions → gates/messages). Same announcements as `deleteSession` (G7):
 * the transient `killed` per session first, hydrated streams detached, the
 * pending gates read and removed in the transaction that runs `deleteRows`
 * (the caller's `DELETE vps`), then one `cancelled` per pending gate and ONE
 * `session_list_changed`. Needed because the remote `kill_session` is
 * best-effort: an unreachable agent (often why the VPS is being removed)
 * never emits the live `killed` that would have cancelled them. Returns the
 * removed session ids.
 */
export function deleteVpsSessions(vpsId: string, deleteRows: () => void): string[] {
  const ids = db.select({ id: agentSessions.id }).from(agentSessions)
    .where(eq(agentSessions.vpsId, vpsId)).all().map((row) => row.id);
  for (const sessionId of ids) {
    emitGlobalSession({ type: 'status', sessionId, status: 'killed' } as GlobalSessionEvent);
    const stream = streams.get(sessionId);
    if (stream) {
      stream.detach();
      streams.delete(sessionId);
    }
  }
  let gates: GateRef[] = [];
  db.transaction(() => {
    gates = ids.flatMap((sessionId) => deleteSessionGates(sessionId));
    deleteRows();
  });
  for (const gate of gates) publishInteractionResolved(gate.sessionId, gate.kind, gate.id, 'cancelled');
  for (const sessionId of ids) {
    // Their rows went with the cascade: free the incremental folds (I11).
    invalidateSessionRowCaches(sessionId);
    clearSessionActivity(sessionId);
  }
  emitGlobalSessionListChanged(vpsId);
  return ids;
}

// ── Charon ↔ agent reconciliation (self-healing after restart) ─────────────
// Called on every (re)connection of an AgentClient, as soon as `hello` comes
// back with the list of REALLY alive sessions on the agent side.
//
// The problem we solve: after a `systemctl restart charon`, the Next process
// restarts but the agent daemon on the VPS side keeps living with its open
// SDK sessions. On the Charon side, the DB keeps the last known status —
// typically 'thinking' for sessions that were processing a query at SIGTERM
// time. Without doing anything, these sessions stay "hanging": no
// SessionStream is attached to the agent listener, so no event reaches the
// UI, which shows an eternal spinner. The user had to do force_stop then
// resume manually to reattach.
//
// This function takes `hello.sessions` as the source of truth, and for
// each session alive on the agent side:
//   - Creates (or retrieves) the SessionStream in memory
//   - Attaches the listener to the agent's event stream (idempotent)
//   - Aligns the DB status with the one reported by the agent
//
// And for DB sessions in 'active'/'thinking'/'starting' that the agent does
// NOT know (case where the VPS agent restarted and lost its state.json):
//   - Run resumeSession() which will try resume_session, then fall back on
//     start_session(claude_session_id=...) to recreate them SDK-side.
export async function reconcileVpsAgentState(
  vpsId: string,
  liveAgentSessions: AgentSessionInfo[],
): Promise<void> {
  const agentSidMap = new Map<string, AgentSessionInfo>();
  for (const a of liveAgentSessions) agentSidMap.set(a.session_id, a);

  // 1) Sessions alive on the agent side: attach a SessionStream + sync status.
  for (const [sid, info] of agentSidMap) {
    let row: typeof agentSessions.$inferSelect | undefined;
    try {
      [row] = db.select().from(agentSessions)
        .where(eq(agentSessions.id, sid)).all();
    } catch { continue; }
    if (!row) continue;            // session unknown to Charon, we don't invent
    if (row.archived) {
      // An archived thread is intentionally absent from the live workspace.
      // A stale daemon state must never make it reappear after a reconnect.
      try {
        getAgentClientForVpsId(vpsId).call('sleep_session', { session_id: sid }).catch(() => {});
      } catch {}
      continue;
    }
    // (the old `row.status === 'killed'` guard is obsolete: the
    // kill→delete merge removed this persistent status; an existing DB
    // session is by construction non-killed.)

    const stream = getOrCreateStream(sid);  // hydrates the stream from DB if needed
    if (!stream) continue;
    // Attach the listener — this IS the missing piece after a Charon restart.
    // Without it, agent events don't reach the browser and the UI stays frozen.
    stream.ensureAttached();

    // If DB status diverges from agent (typically DB='thinking' frozen
    // while the agent is back to 'active'), realign. Don't touch if the
    // agent says 'killed' (unlikely here since it would have removed it
    // from sessions).
    const agentStatus = info.status;
    // Durable sleep intent (CLAUDE.md §14.46, RC8): the user asked this session
    // to sleep but the RPC may never have reached the agent (agent was down at
    // sleep time, then restored the session as 'active' from state.json). Don't
    // resurrect it — re-fire the sleep and keep it 'sleeping' instead of
    // realigning the DB back up to the agent's 'active'.
    if (row.sleepRequested &&
        (agentStatus === 'active' || agentStatus === 'thinking' || agentStatus === 'starting')) {
      try {
        getAgentClientForVpsId(vpsId).call('sleep_session', { session_id: sid }).catch(() => {});
      } catch {}
      if (stream.status !== 'sleeping') {
        stream.status = 'sleeping';
        emitGlobalSession({ type: 'status', sessionId: sid, status: 'sleeping' } as GlobalSessionEvent);
      }
      if (row.status !== 'sleeping') {
        try {
          db.update(agentSessions).set({ status: 'sleeping' })
            .where(eq(agentSessions.id, sid)).run();
        } catch {}
      }
      continue;
    }
    // Durable POST-UPDATE resume intent (§14.62, the mirror of the guard
    // above): an agent update SIGTERMed this session and the fire-and-forget
    // resume never completed (hub restarted mid-flow). The agent restored it
    // as 'sleeping' from state.json — bring it back up. resumeSession dedups
    // (_resumeInflight), clears the flag on success and logs.
    if (row.resumePending && !row.sleepRequested && (agentStatus === 'sleeping' || agentStatus === 'error')) {
      resumeSession(sid)
        .then(() => {
          try {
            db.insert(sessionLogs).values({
              sessionId: sid, level: 'info', event: 'resume_pending_recovered', detail: null,
            }).run();
          } catch {}
        })
        .catch((e) => {
          try {
            db.insert(sessionLogs).values({
              sessionId: sid, level: 'warn', event: 'resume_pending_recovered',
              detail: JSON.stringify({ err: e?.message ?? String(e) }),
            }).run();
          } catch {}
        });
      continue;
    }
    // Intent satisfied: the agent already reports the session running — a
    // lingering resumePending (e.g. from a FAILED update that never actually
    // stopped anything) must not resurrect it later. Clear it.
    if (row.resumePending &&
        (agentStatus === 'active' || agentStatus === 'thinking')) {
      try {
        db.update(agentSessions).set({ resumePending: 0 })
          .where(eq(agentSessions.id, sid)).run();
      } catch {}
    }
    // A synthetic Claude API/auth failure leaves the remote SDK client idle.
    // Preserve the connected `failed` marker across reconnect; a real new
    // turn (or explicit lifecycle recovery) clears it.
    if (row.status === 'failed' &&
        (agentStatus === 'active' || agentStatus === 'thinking' || agentStatus === 'starting')) {
      continue;
    }
    // Same for background work (§14.91): the daemon reports the SESSION as
    // idle-active while the tasks it spawned are still running, so adopting
    // its answer here would repaint the session green on every reconnect.
    // The registry is derived from the persisted rows, so it is still true
    // after a hub restart — and if the tasks did end meanwhile, this falls
    // through and the realign below fixes the row.
    if (row.status === 'background' && agentStatus === 'active' && stream.hasRunningBgTasks()) {
      if (stream.status !== 'background') setSessionStatusLocal(sid, 'background', { persist: false });
      continue;
    }
    // Realign when the agent's status diverges from EITHER the DB row OR the
    // in-memory stream. Checking the in-memory stream too matters: a prior
    // desync can leave the stream stuck (e.g. 'sleeping') while the DB has
    // already been pushed to match the agent — in that case
    // `agentStatus !== row.status` is false and the stale in-memory status
    // would never be corrected on reconnect. See CLAUDE.md §14 gotcha 36.
    if (agentStatus !== 'killed' && (agentStatus !== row.status || agentStatus !== stream.status)) {
      try {
        db.update(agentSessions).set({ status: agentStatus })
          .where(eq(agentSessions.id, sid)).run();
      } catch {}
      stream.status = agentStatus as WorkerStatus;
      // Emit on the bus so SSE clients see the right status immediately
      // (without depending on a future status event from the agent).
      emitGlobalSession({
        type: 'status', sessionId: sid, status: agentStatus as any,
      } as GlobalSessionEvent);
    }
  }

  // 2) DB sessions that should be running but the agent doesn't know.
  //    Typically: the VPS agent was restarted while we were down and
  //    lost its state.json (sessions persisted as 'sleeping' that are
  //    not restarted at boot). Relaunch them via resumeSession() which
  //    falls back to start_session(claude_session_id=...) if not found.
  //    Also covers 'sleeping' rows with the durable POST-UPDATE resume
  //    intent (§14.62) that the agent doesn't know at all (state lost).
  let dbRows: { id: string; status: string }[] = [];
  try {
    dbRows = db.select({ id: agentSessions.id, status: agentSessions.status })
      .from(agentSessions)
      .where(and(
        eq(agentSessions.vpsId, vpsId),
        eq(agentSessions.archived, 0),
        eq(agentSessions.sleepRequested, 0),
        or(
          inArray(agentSessions.status, ['active', 'thinking', 'starting', 'failed', 'background']),
          eq(agentSessions.resumePending, 1),
        ),
      ))
      .all() as { id: string; status: string }[];
  } catch {
    return;
  }
  for (const row of dbRows) {
    if (agentSidMap.has(row.id)) continue;  // already handled in step 1
    resumeSession(row.id)
      .then(() => {
        try {
          db.insert(sessionLogs).values({
            sessionId: row.id, level: 'info', event: 'auto_resume',
            detail: JSON.stringify({ trigger: 'reconcile', wasStatus: row.status }),
          }).run();
        } catch {}
      })
      .catch((e) => {
        try {
          db.insert(sessionLogs).values({
            sessionId: row.id, level: 'warn', event: 'auto_resume',
            detail: JSON.stringify({
              trigger: 'reconcile', wasStatus: row.status,
              err: e?.message ?? String(e),
            }),
          }).run();
        } catch {}
        // If the relaunch fails (cwd gone, SDK broken…), degrade to sleeping
        // so the UI clearly shows a manual "resume" button. Memory too (S2):
        // a hydrated stream's stale status reverted every tab on the next
        // list GET / SSE snapshot.
        setSessionStatusLocal(row.id, 'sleeping');
        // The CONNECTED agent listed its sessions without this one: no worker
        // holds its blocking gates (D-13 dead sessions). Not the
        // disconnected degrade (autoConnect), whose gates may still be live.
        cancelSessionBlockingGates(row.id);
      });
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
// When systemd / the user kills the Next process (SIGTERM or SIGINT), we
// flush to DB the reasoning block and the assistant text being accumulated in
// each SessionStream. Without this, anything streamed before the next
// boundary is lost (cf. bug observed when the app was restarted while Claude
// was still writing). The durable cursor is NOT advanced past them: the
// restart replays the block and covers/extends these partial rows (§14.31).
//
// We use a module-level flag to avoid double-registration on Next hot-reload.
declare global {
  // eslint-disable-next-line no-var
  var __charon_shutdownRegistered: boolean | undefined;
  // Set by the shutdown flush: no stream of any module copy dispatches an
  // agent event or writes a cursor after it.
  // eslint-disable-next-line no-var
  var __charon_shuttingDown: boolean | undefined;
}

/** Delay between the graceful flush and the exit. The flush's last frames
 *  (the lane text, `thinking_flushed`) are only QUEUED on the SSE streams —
 *  their bytes reach the sockets on later ticks — so a synchronous exit lost
 *  them: a browser kept the block's text without its cut, and the next
 *  replay-opened block's cut replaced both. */
export const SHUTDOWN_DRAIN_MS = 300;

/** The SIGTERM/SIGINT work (exported for tests): flush every stream, then
 *  dispatch no agent event and write no cursor — the restart replays what
 *  arrives meanwhile, from the flushed rows' anchors, as after an immediate
 *  exit — and exit once the SSE frames had time to leave. A second signal
 *  exits at once. */
export function gracefulShutdown(sig: string, exit: (code: number) => void = (code) => process.exit(code)): void {
  if (globalThis.__charon_shuttingDown) { exit(0); return; }
  globalThis.__charon_shuttingDown = true;
  try {
    for (const s of streams.values()) {
      try { s.flushPendingAssistant(); } catch {}
    }
    // eslint-disable-next-line no-console
    console.log(`[charon] graceful flush done on ${sig} — exiting in ${SHUTDOWN_DRAIN_MS} ms`);
  } finally {
    setTimeout(() => exit(0), SHUTDOWN_DRAIN_MS);
  }
}

// Skip during `next build`: the module is imported by build workers
// (SSR analysis), which receive a SIGINT/SIGTERM at the end of the phase.
// If we register the handler, we `process.exit(0)` prematurely and that
// can break the build (cf. logs `graceful flush done on SIGINT` during build).
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
if (!isBuildPhase && !globalThis.__charon_shutdownRegistered) {
  globalThis.__charon_shutdownRegistered = true;
  const onSignal = (sig: NodeJS.Signals) => gracefulShutdown(sig);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
