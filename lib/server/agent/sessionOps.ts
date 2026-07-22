import 'server-only';
import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  db, claudeSessions, claudeSessionMessages,
  claudePendingPermissions, claudePendingQuestions, claudeSessionLogs,
  vps as vpsTable,
} from '@/lib/db';
import type { PermissionMode } from '@/lib/server/claude/types';
import type { WorkerEvent, WorkerStatus, AccountUsage } from '@/lib/server/claude/types';
import { getAgentClientForVpsId } from './AgentClientPool';
import type { AgentSessionInfo } from './types';
import { sendPushToAll } from '@/lib/server/claude/webPush';
import {
  sendPermissionToTelegram, sendQuestionToTelegram, markInteractionResolvedInTelegram,
  sendPlainToTelegram,
} from '@/lib/server/claude/telegram';
import { getSetting, getSettingBool, type SettingKey } from '@/lib/server/claude/settings';
import type { AgentEvent, EffortLevel, AgentKind, AnyEffort, SessionMode } from './types';
import { AgentRpcError } from './types';
import type { AgentClient, EventListener as AgentEventListener } from './AgentClient';
import { setVpsStatusEmitter } from './AgentClient';

// Resolve the effective (model, fallback_model, effort) for a new session:
// per-session opts win, otherwise fall back to the global defaults in
// claudeSettings, otherwise null (= let the agent pass nothing → SDK default).
// Empty string in settings is treated as "unset" so an admin can erase a
// default from the SettingsModal without nuking the row.
//
// Kind-aware (multi-agent): a Codex session reads codex.default_model /
// codex.default_effort and has NO fallback-model concept; a Claude session
// keeps the existing claude.default_* keys. cf. migration-codex.md.
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
  if (kind === 'codex') {
    return {
      model: pick(opts.model, 'codex.default_model'),
      fallbackModel: null, // Codex has no fallback-model concept.
      effort: pick(opts.effort, 'codex.default_effort'),
    };
  }
  return {
    model: pick(opts.model, 'claude.default_model'),
    fallbackModel: pick(opts.fallbackModel, 'claude.default_fallback_model'),
    effort: pick(opts.effort, 'claude.default_effort'),
  };
}

// Mirrors claude_agent_sdk.EffortLevel + the VALID_EFFORTS tuple in
// agent/charon_agent/session.py. Kept in sync with `EffortLevel` in types.ts.
const VALID_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
// Codex reasoning-effort levels (agent/charon_agent/codex_session.py VALID_EFFORTS,
// mirrors CodexEffort in types.ts). Distinct from Claude's set — 'none' |
// 'minimal' | 'ultra' are Codex-only, 'ultracode' is Claude-only.
const VALID_CODEX_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function isValidEffort(v: string | null | undefined): v is EffortLevel {
  return typeof v === 'string' && (VALID_EFFORTS as readonly string[]).includes(v);
}
// Kind-aware effort validity. A Codex session's effort is validated against the
// Codex set (so 'ultra'/'none'/'minimal' aren't dropped); a Claude session uses
// the Claude set. Invalid values are dropped (persisted as null → default).
function isValidEffortForKind(v: string | null | undefined, kind: AgentKind): boolean {
  if (typeof v !== 'string') return false;
  const set = kind === 'codex' ? VALID_CODEX_EFFORTS : (VALID_EFFORTS as readonly string[]);
  return set.includes(v);
}

const newId = () => crypto.randomBytes(8).toString('hex');

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

// Charon-side ring buffer: REMOVED (cf. CLAUDE.md §14 gotcha 14). The DB
// is now the only source of truth for persisted events; the per-session
// SSE only relays live, and the client refetches via GET
// /api/claude/sessions/[id] on mount + on reconnect + on foreground return.

// ── Global session-tagged event bus ────────────────────────────────────────
// ALL events broadcast by the SessionStreams pass through this bus, tagged
// with their sessionId. The multiplexed SSE `/api/claude/events` is its only
// HTTP-side consumer — it filters by connection focus (cf.
// `eventConnections.ts` § filterAndForward).
//
// Before the refactor: one SSE per session (`/api/claude/sessions/[id]/stream`)
// + an aggregated SSE for interactions. Switching session = close+open of
// the per-session SSE = ~50-150ms of visible latency + a double mechanism to
// maintain. Now: ONE SSE per browser, focus changed via POST.
export type GlobalSessionEvent = WorkerEvent & { sessionId: string };

const gBus = globalThis as unknown as { _globalSessionSubs?: Set<(ev: GlobalSessionEvent) => void> };
if (!gBus._globalSessionSubs) gBus._globalSessionSubs = new Set();
const globalSessionSubs: Set<(ev: GlobalSessionEvent) => void> = gBus._globalSessionSubs;

export function subscribeGlobalSessionEvents(cb: (ev: GlobalSessionEvent) => void): () => void {
  globalSessionSubs.add(cb);
  return () => { globalSessionSubs.delete(cb); };
}

function emitGlobalSession(ev: GlobalSessionEvent): void {
  for (const cb of globalSessionSubs) {
    try { cb(ev); } catch {}
  }
}

/**
 * Fan a persistent SHELL's live lifecycle status onto the global SSE bus so
 * every browser tab can color the shell's tab/dot — blue "thinking" while it
 * streams output (status='busy'), neutral when idle/at-prompt ('active'),
 * gray when bash ended ('exited'). `sessionId` is the shell id (shells are
 * 16-hex, sessions 32-hex → no collision in the shared bus keyspace).
 *
 * Source: the persistent AgentClient's output-free `shell_watch` → shellNotify.
 * Classed LOW_VOLUME in eventConnections.ts so it reaches ALL connections
 * regardless of focus (shells are not the SSE's "focused session"). This is
 * intentionally NOT on the per-WS shell output path (that would re-egress
 * bytes; cf. §14 gotcha 41) — it's a tiny lifecycle ping.
 */
export function emitGlobalShellStatus(shellId: string, status: 'active' | 'busy' | 'exited'): void {
  emitGlobalSession({ type: 'shell_status', status, sessionId: shellId });
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
    agentLastError?: string | null; codexAvailable?: number | null; codexSdkVersion?: string | null;
    codexLoggedIn?: number | null;
  },
): void {
  emitGlobalSession({
    type: 'vps_status',
    agentStatus,
    agentVersion: extra?.agentVersion,
    agentPyzSha: extra?.agentPyzSha,
    sdkVersion: extra?.sdkVersion,
    // Health-chip fields (§11 vpsHealth): classified failure + codex
    // availability/login. Same "key present ⇔ known" contract as sdkVersion —
    // ClaudePanel patches only defined keys (no-clobber, §14.53).
    agentLastError: extra?.agentLastError,
    codexAvailable: extra?.codexAvailable,
    codexSdkVersion: extra?.codexSdkVersion,
    codexLoggedIn: extra?.codexLoggedIn,
    sessionId: vpsId,
  });
}
setVpsStatusEmitter(emitGlobalVpsStatus);

// ── "Finished, unread" marker (CLAUDE.md §14.47) ────────────────────────────
// To decide whether a finishing turn should light the sidebar marker, we need
// to know if the user is currently VIEWING the session — OR was within the last
// few seconds (an agent often finishes a beat after you switch away; that turn
// shouldn't green a session you were just reading). That truth lives in
// eventConnections (wasRecentlyViewed = focusCountFor + a recency grace), which
// already imports THIS module — so to dodge a hard import cycle we reuse the
// setVpsStatusEmitter injection trick: eventConnections wires this slot at its
// module load. Null until then → default "not focused" (safe: no SSE open ⇒
// nobody's watching).
let sessionFocusChecker: ((sessionId: string) => boolean) | null = null;
export function setSessionFocusChecker(fn: (sessionId: string) => boolean): void {
  sessionFocusChecker = fn;
}

/**
 * Clear a session's durable "finished, unread" marker
 * (claudeSessions.unreadStop → 0) and mirror it live to every tab via the
 * `session_unread` bus event. Called when the user opens/focuses the session
 * (POST /api/claude/focus). Idempotent + cheap: only writes/emits when the row
 * was actually unread, so re-focusing or switching between already-read
 * sessions never spams the bus.
 */
export function markSessionRead(sessionId: string): void {
  try {
    const res = db.update(claudeSessions).set({ unreadStop: 0 })
      .where(and(eq(claudeSessions.id, sessionId), eq(claudeSessions.unreadStop, 1)))
      .run();
    if (((res as { changes?: number }).changes ?? 0) > 0) {
      emitGlobalSession({ type: 'session_unread', unread: false, sessionId });
    }
  } catch {}
}

/**
 * Announce that the SET of Claude sessions changed (created / imported /
 * deleted) so every connected browser refetches GET /api/claude/sessions and
 * updates its sidebar + tab bar live — across tabs AND devices (a session
 * started on a phone shows up on the desktop without the 15s poll or an F5).
 * Charon-internal synthetic event, classed LOW_VOLUME in eventConnections so it
 * reaches every connection regardless of SSE focus. cf. CLAUDE.md §14.52.
 */
export function emitGlobalSessionListChanged(sessionId: string): void {
  emitGlobalSession({ type: 'session_list_changed', sessionId });
}

/**
 * Fan a VPS's account-usage gauges onto the global bus (sessionId = vpsId).
 * Source: usagePoll.ts (the `get_usage` RPC poll). Classed LOW_VOLUME in
 * eventConnections so every tab's header widget updates regardless of SSE focus
 * (usage is account-global, not focus-scoped). cf. CLAUDE.md §14.58.
 */
export function emitGlobalAccountUsage(vpsId: string, usage: AccountUsage): void {
  emitGlobalSession({ type: 'account_usage', sessionId: vpsId, ...usage } as GlobalSessionEvent);
}

// Post-stop usage-refresh trigger, injected by usagePoll.ts at its import time
// (one-directional to dodge the import cycle: this module owns the bus + the
// `stop` handler; usagePoll owns the poll). Null until usagePoll is loaded
// (autoConnect imports it at boot) → the `stop` handler no-ops safely. §14.58.
let usagePollTrigger: ((vpsId: string) => void) | null = null;
export function setUsagePollTrigger(fn: (vpsId: string) => void): void {
  usagePollTrigger = fn;
}

// Parallel trigger for the Codex account-usage poll (a Codex session's `stop`
// moved the Codex quota, not the Claude one). Same injection pattern; wired by
// usagePoll.ts. Null until loaded → the `stop` handler no-ops safely. §14.58.
let codexUsagePollTrigger: ((vpsId: string) => void) | null = null;
export function setCodexUsagePollTrigger(fn: (vpsId: string) => void): void {
  codexUsagePollTrigger = fn;
}

export class SessionStream {
  readonly id: string;
  readonly vpsId: string;
  // Agent-type discriminator: 'claude' (default) | 'codex'. Determines config
  // resolution (which default_* keys), effort validity, sandbox-mode semantics
  // and which start_session kind the agent gets. Persisted in claudeSessions.kind.
  readonly kind: AgentKind = 'claude';
  status: WorkerStatus = 'starting';
  // For a Codex session this holds a sandbox mode ('read-only' |
  // 'workspace-write' | 'full-access'); for Claude a permission mode. Typed as
  // the Claude subset for the existing broadcast plumbing (BridgeEvent is
  // locked to PermissionMode) — codex values pass through at runtime.
  permissionMode: PermissionMode = 'normal';
  claudeSessionId: string | null = null;
  name: string | null = null;
  vpsName: string;
  cwd: string | null = null;
  // Per-session model / fallback / effort. NULL = fall back to the global
  // default (claude.default_* or codex.default_*) → agent/SDK default. Source
  // of truth is the DB column; SessionStream caches it in memory for fast access
  // and because resume needs to read it before any DB roundtrip. `effort` is the
  // AnyEffort superset (Claude or Codex level, per `kind`). `fallbackModel` is
  // unused for Codex.
  model: string | null = null;
  fallbackModel: string | null = null;
  effort: AnyEffort | null = null;
  // The model Anthropic actually used on the last AssistantMessage. Captured
  // from the `effective_model` event (agent >= 0.6.0), persisted in
  // claude_sessions.effective_model (the agent only re-emits on CHANGE, so a
  // Charon restart would otherwise lose it until the next model switch) and
  // hydrated back in getOrCreateStream. Stamped onto every flushed assistant
  // message row (claude_session_messages.model) so each bubble can display
  // the true speaking model. Distinct from the configured `model` above:
  // aliases resolve, fallback_model can kick in, SDK may pick a default.
  effectiveModel: string | null = null;

  private currentAssistant = '';
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
  private alwaysAllow = new Set<string>();
  // True while we're processing events replayed by the agent (between
  // replay_begin and replay_end). During this window, we dedupe each event
  // against the DB to avoid re-persisting content already known. The goal:
  // after a Charon restart (where the VPS agent kept streaming events we
  // didn't see), pick up ONLY the missing events without duplicating what's
  // already in the DB.
  private isReplaying = false;
  // Sets loaded at replay_begin from the DB for fast dedup.
  private replayKnownToolUseIds: Set<string> = new Set();
  private replayKnownToolResultIds: Set<string> = new Set();
  private replayKnownAssistantContents: Set<string> = new Set();
  private replayKnownThinkingContents: Set<string> = new Set();
  private replayKnownPendingIds: Set<string> = new Set();

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

  // ── Replay exactness (P0.2/P0.3) ──────────────────────────────────────
  // `currentEventSeq`: seq of the event being dispatched RIGHT NOW (null
  // outside dispatch). Stamped onto every message row _persist writes —
  // the per-row identity that replaces content-based dedup.
  private currentEventSeq: number | null = null;
  // First seq of the still-unflushed assistant accumulation. The DURABLE
  // cursor is held back to (pendingAssistantSince - 1): after a hard crash
  // the whole unflushed text is re-delivered and rebuilt instead of losing
  // the first seconds of a turn (the old cursor advanced past deltas whose
  // text only lived in this process's memory).
  private pendingAssistantSince: number | null = null;
  // Seq of the earliest event whose _persist FAILED (DB error). Holds the
  // durable cursor back so the next restart replays it and the row gets a
  // second chance — the seq-gate makes the re-delivery of everything else
  // idempotent. Cleared only by process restart (intentional: the row is
  // missing until then).
  private persistHoldbackSeq: number | null = null;
  // SET of the seqs stamped on this session's persisted rows, loaded at
  // replay_begin. A replayed event is skipped only when ITS OWN seq has a
  // row — NOT when it merely precedes the max. (First version used
  // MAX(seq): Codex's counter-review showed that a failed persist at seq N
  // followed by a successful one at N+1 made the holdback replay N… only
  // for the MAX-gate to swallow it. A max proves nothing about the seqs
  // below it precisely in the failure case the holdback exists for.)
  private replayPersistedSeqs: Set<number> | null = null;

  constructor(opts: {
    id: string; vpsId: string; vpsName: string; name: string | null;
    status: WorkerStatus; permissionMode: SessionMode;
    claudeSessionId: string | null;
    kind?: AgentKind;
    cwd?: string | null;
    lastSeenSeq?: number | null;
    lastStopNotifiedSeq?: number | null;
    model?: string | null;
    fallbackModel?: string | null;
    effort?: string | null;
    effectiveModel?: string | null;
  }) {
    this.id = opts.id;
    this.vpsId = opts.vpsId;
    this.vpsName = opts.vpsName;
    this.name = opts.name;
    this.cwd = opts.cwd ?? null;
    this.kind = opts.kind ?? 'claude';
    this.status = opts.status;
    this.permissionMode = opts.permissionMode as PermissionMode;
    this.claudeSessionId = opts.claudeSessionId;
    this.lastSeenSeq = opts.lastSeenSeq ?? null;
    this.lastPersistedSeq = this.lastSeenSeq;
    this.lastStopNotifiedSeq = opts.lastStopNotifiedSeq ?? null;
    this.model = opts.model ?? null;
    this.fallbackModel = opts.fallbackModel ?? null;
    this.effort = isValidEffortForKind(opts.effort, this.kind) ? (opts.effort as AnyEffort) : null;
    this.effectiveModel = opts.effectiveModel ?? null;
  }

  /** Wires the listener to the agent (idempotent).
   *  Passes `afterSeq` to the agent so it can replay missed events from
   *  its durable log (agent >= 0.4.0). For older agents this is a no-op:
   *  the client falls back to ring replay. */
  attach(): void {
    const client = getAgentClientForVpsId(this.vpsId);
    // Already correctly subscribed to the CURRENT client → nothing to do.
    if (this.attached && this.attachedClient === client) return;
    // Either never attached, or attached to a now-dead client (the pool
    // recreated it on agent update/refresh — its subscribers map is empty and
    // our old listener went down with it). (Re)subscribe to the live client.
    // Reuse the SAME listener reference so re-subscribing to the same client is
    // deduped by the AgentClient's Set; a fresh closure would double-fire.
    // cf. CLAUDE.md §14.51.
    if (!this.agentListener) this.agentListener = (ev) => this._onAgentEvent(ev);
    this.attached = true;
    this.attachedClient = client;
    client.subscribe(this.id, this.agentListener,
      this.lastSeenSeq != null ? { afterSeq: this.lastSeenSeq } : undefined,
    );
  }

  /** Advance the durable-replay cursor. Called from _onAgentEvent
   *  AFTER the event has been processed (persisted in DB), so we never
   *  advance past an event we haven't actually saved. */
  private _trackSeq(ev: AgentEvent): void {
    const seq = (ev as { seq?: unknown }).seq;
    if (typeof seq !== 'number') return; // old agent or replay marker
    if (this.lastSeenSeq != null && seq <= this.lastSeenSeq) return;
    this.lastSeenSeq = seq;
    // Notify the AgentClient so a future reconnect uses the new cursor.
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
    // Persist the HELD-BACK cursor, not the raw lastSeenSeq: everything
    // beyond _durableCursor() has effects (unflushed assistant text, a
    // failed row insert) that only live in this process's memory — a crash
    // must replay those events, and the seq-gate absorbs the overlap.
    const cursor = this._durableCursor();
    if (cursor == null) return;
    if (cursor === this.lastPersistedSeq) return;
    try {
      db.update(claudeSessions)
        .set({ lastSeenSeq: cursor })
        .where(eq(claudeSessions.id, this.id))
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
    // Cancel the pending seq-persist timer — no more events are coming.
    // We don't bother flushing one last time: the seq will be irrelevant
    // after the session is deleted (agent will tear down its log too).
    if (this.persistSeqTimer) {
      clearTimeout(this.persistSeqTimer);
      this.persistSeqTimer = null;
    }
  }

  /** Assistant text currently being accumulated (since the last flush).
   *  Exposed so the GET API can pass it to the client → lets the UI
   *  resume an "in-progress" streaming without having to re-listen
   *  to deltas that have already passed (and already perceived as "scrolling"). */
  getStreamingText(): string {
    return this.currentAssistant;
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
    const seq = (ev as { seq?: unknown }).seq;
    this.currentEventSeq = typeof seq === 'number' ? seq : null;
    try {
      this._dispatchEvent(ev);
    } finally {
      this.currentEventSeq = null;
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
    if (this.pendingAssistantSince != null) {
      cursor = Math.min(cursor, this.pendingAssistantSince - 1);
    }
    if (this.persistHoldbackSeq != null) {
      cursor = Math.min(cursor, this.persistHoldbackSeq - 1);
    }
    return cursor;
  }

  /** During replay: TRUE if a row stamped with THIS event's seq already
   *  exists. Dedup by IDENTITY — replaces the content-based Sets for
   *  seq-carrying agents; the Sets remain as fallback for events without
   *  seq / rows stamped before the seq column existed. Row-writing events
   *  are atomic per event (see the interaction transactions), so "a row
   *  with my seq exists" ⟹ "my persistence completed". */
  private _replayAlreadyPersisted(ev: AgentEvent): boolean {
    if (!this.isReplaying) return false;
    const seq = (ev as { seq?: unknown }).seq;
    return typeof seq === 'number'
      && this.replayPersistedSeqs != null
      && this.replayPersistedSeqs.has(seq);
  }

  /** When a replayed FLUSH-BOUNDARY event is identity-gated, the deltas
   *  replayed just before it may already live in their flush row — but
   *  ONLY discard the buffer if that flush row actually exists. Flush rows
   *  are stamped with the FIRST DELTA's seq (pendingAssistantSince), so
   *  the check is exact: row present → text persisted → drop; row absent
   *  (the flush failed pre-crash) → KEEP the buffer, a later ungated
   *  boundary will flush it (slightly late in chronology, never lost). */
  private _dropReplayedAssistantBuffer(): void {
    if (this.pendingAssistantSince != null
        && this.replayPersistedSeqs?.has(this.pendingAssistantSince)) {
      this.currentAssistant = '';
      this.pendingAssistantSince = null;
    }
  }

  private _dispatchEvent(ev: AgentEvent): void {
    switch (ev.event) {
      case 'replay_begin':
        // We enter the replay window: the events that follow may be
        // duplicates (already persisted) OR missed events (e.g. after
        // a Charon restart, the VPS agent kept streaming while we were
        // down). Primary dedup = the seq-gate (_replayAlreadyPersisted,
        // fed by MAX(seq) of the stamped rows); the content Sets are the
        // legacy fallback for seq-less events / pre-seq rows.
        this.isReplaying = true;
        this._loadReplayDedup();
        return;
      case 'replay_end':
        this.isReplaying = false;
        this.replayPersistedSeqs = null;
        this.replayKnownToolUseIds.clear();
        this.replayKnownToolResultIds.clear();
        this.replayKnownAssistantContents.clear();
        this.replayKnownThinkingContents.clear();
        this.replayKnownPendingIds.clear();
        return;
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
          const upd: { status: string; sleepRequested?: number } =
            ev.status === 'sleeping' ? { status: ev.status, sleepRequested: 0 } : { status: ev.status };
          db.update(claudeSessions).set(upd)
            .where(eq(claudeSessions.id, this.id)).run();
        } catch (e) {
          // P7 (CLAUDE.md §14.45): surface instead of swallowing. _trackSeq
          // still advances the durable cursor, but the agent's post-replay
          // status frame + reconcileVpsAgentState re-assert the truth on the
          // next (re)connect, so one failed write is recovered, not lost.
          console.error(`[sessionOps] ${this.id} status db.update('${ev.status}') failed:`, (e as Error)?.message ?? e);
        }
        break;
      case 'ready':
        this._broadcast({ type: 'ready' });
        break;
      case 'session_id':
        this.claudeSessionId = ev.claude_session_id;
        try {
          db.update(claudeSessions).set({ claudeSessionId: ev.claude_session_id })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'session_id', id: ev.claude_session_id });
        break;
      case 'assistant_text':
        // No identity gate here: deltas never write their own row (their
        // text lands in the flush row stamped with the BOUNDARY event's
        // seq), so a delta seq can never be in replayPersistedSeqs. Deltas
        // replayed under an already-persisted flush are discarded when the
        // gated boundary arrives (_dropReplayedAssistantBuffer).
        // Crash protection: remember where the unflushed accumulation
        // starts — the durable cursor never advances past it (P0.2).
        if (this.pendingAssistantSince == null && typeof ev.seq === 'number') {
          this.pendingAssistantSince = ev.seq;
        }
        this.currentAssistant += ev.delta;
        this._broadcast({ type: 'assistant_text', delta: ev.delta });
        break;
      case 'thinking':
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownThinkingContents.has(ev.text)) break;
        this._persist('event', { type: 'thinking', text: ev.text });
        this._broadcast({ type: 'thinking', text: ev.text });
        if (this.isReplaying) this.replayKnownThinkingContents.add(ev.text);
        break;
      case 'tool_use':
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownToolUseIds.has(String(ev.id))) break;
        this._persist('tool_use', { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        this._broadcast({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        if (this.isReplaying) this.replayKnownToolUseIds.add(String(ev.id));
        break;
      case 'tool_result':
        if (this._replayAlreadyPersisted(ev)) break;
        if (this.isReplaying && this.replayKnownToolResultIds.has(String(ev.tool_use_id))) break;
        this._persist('tool_result', { type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        this._broadcast({ type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        if (this.isReplaying) this.replayKnownToolResultIds.add(String(ev.tool_use_id));
        break;
      case 'permission_request':
        // NO identity gate-break here (Codex 13.2.C): a permission writes
        // NO message row — but its preceding FLUSH does, stamped with THIS
        // event's seq. Breaking on that row would skip the pending insert
        // when it's the piece that failed. Discard the replayed buffer if
        // the flush row exists, then let the pendingIds dedup decide.
        if (this._replayAlreadyPersisted(ev)) this._dropReplayedAssistantBuffer();
        if (this.alwaysAllow.has(ev.tool)) {
          // Auto-allow: forward to the agent immediately
          this.respondPermission(ev.id, true).catch(() => {});
          return;
        }
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
        try {
          db.insert(claudePendingPermissions).values({
            id: ev.id,
            sessionId: this.id,
            toolName: ev.tool,
            toolInput: JSON.stringify(ev.input ?? {}),
            status: 'pending',
          }).onConflictDoNothing().run();
        } catch (e) {
          // A REAL insert failure (not a dup — onConflictDoNothing absorbs
          // those): hold the cursor back and STOP — the replay after
          // restart redoes this event whole (broadcasting a card that
          // wouldn't survive a refetch would just mislead the user).
          const seq = this.currentEventSeq;
          if (seq != null && (this.persistHoldbackSeq == null || seq < this.persistHoldbackSeq)) {
            this.persistHoldbackSeq = seq;
          }
          this._log('warn', 'sdk_error', { msg: 'pending perm insert failed', err: (e as Error)?.message });
          break;
        }
        this._broadcast({ type: 'permission_request', id: ev.id, tool: ev.tool, input: ev.input });
        this._log('info', 'permission', { id: ev.id, tool: ev.tool });
        this._maybePush({
          title: `🔒 ${this.vpsName} · ${this._label()} : permission`,
          body: `tool ${ev.tool} — tap to approve`,
          tag: `perm-${this.id}`,
        });
        sendPermissionToTelegram(this.id, ev.id, ev.tool, ev.input).catch(() => {});
        break;
      case 'user_question':
        // Identity gate on the event's OWN row: it is inserted AFTER the
        // pending (break-on-failure order below), so its presence proves
        // the pending write completed too — no transaction needed.
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id, sessionId: this.id, kind: 'question',
            payload: JSON.stringify(ev.questions ?? []), status: 'pending',
          }).onConflictDoNothing().run();
        } catch (e) {
          // Real failure → holdback + stop; replay redoes pending AND row.
          const seq = this.currentEventSeq;
          if (seq != null && (this.persistHoldbackSeq == null || seq < this.persistHoldbackSeq)) {
            this.persistHoldbackSeq = seq;
          }
          this._log('warn', 'sdk_error', { msg: 'pending question insert failed', err: (e as Error)?.message });
          break;
        }
        this._persist('user_question', { type: 'user_question', id: ev.id, questions: ev.questions });
        this._broadcast({ type: 'user_question', id: ev.id, questions: ev.questions });
        this._maybePush({
          title: `❓ ${this.vpsName} · ${this._label()} : question`,
          body: `${ev.questions[0]?.question ?? 'user question'}`,
          tag: `q-${this.id}`,
        });
        sendQuestionToTelegram(this.id, ev.id, ev.questions ?? []).catch(() => {});
        break;
      case 'exit_plan_request':
        // Same pending-then-row break-on-failure ordering as user_question.
        if (this._replayAlreadyPersisted(ev)) { this._dropReplayedAssistantBuffer(); break; }
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id, sessionId: this.id, kind: 'exit_plan',
            payload: JSON.stringify({ plan: ev.plan ?? '' }), status: 'pending',
          }).onConflictDoNothing().run();
        } catch (e) {
          const seq = this.currentEventSeq;
          if (seq != null && (this.persistHoldbackSeq == null || seq < this.persistHoldbackSeq)) {
            this.persistHoldbackSeq = seq;
          }
          this._log('warn', 'sdk_error', { msg: 'pending exit_plan insert failed', err: (e as Error)?.message });
          break;
        }
        this._persist('exit_plan_request', { type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        this._broadcast({ type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        this._maybePush({
          title: `📋 ${this.vpsName} · ${this._label()} : plan ready`,
          body: 'Claude finished planning — tap to approve',
          tag: `plan-${this.id}`,
        });
        break;
      case 'todo_update':
        if (this._replayAlreadyPersisted(ev)) break;
        this._persist('event', { type: 'todo_update', todos: ev.todos });
        this._broadcast({ type: 'todo_update', todos: ev.todos });
        break;
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
        };
        this._persist('event', payload);
        this._broadcast(payload);
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
        this._persist('edit_snapshot', snap);
        this._broadcast(snap as unknown as WorkerEvent);
        break;
      }
      case 'mode_changed':
        this.permissionMode = ev.mode as PermissionMode;
        try {
          db.update(claudeSessions).set({ permissionMode: ev.mode })
            .where(eq(claudeSessions.id, this.id)).run();
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
          db.update(claudeSessions).set({
            model: this.model, fallbackModel: this.fallbackModel,
          }).where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({
          type: 'model_changed',
          model: this.model,
          fallbackModel: this.fallbackModel,
          appliedAtNextStart: !!ev.applied_at_next_start,
        });
        break;
      case 'effort_changed':
        this.effort = isValidEffortForKind(ev.effort, this.kind) ? (ev.effort as AnyEffort) : null;
        try {
          db.update(claudeSessions).set({ effort: this.effort })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
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
          // relabel text the previous model produced.
          this._flushAssistant();
          this.effectiveModel = ev.model;
          try {
            db.update(claudeSessions).set({ effectiveModel: ev.model })
              .where(eq(claudeSessions.id, this.id)).run();
          } catch {}
          this._broadcast({ type: 'effective_model', model: ev.model });
        }
        break;
      case 'usage':
        // Transient LIVE token counter for the current turn (§14.50). The agent
        // emits it broadcast-only (no durable log, no seq), throttled. No DB
        // write — just fan it out to the focused SSE conn (it's high-volume →
        // focused-only via eventConnections) so the ThinkingBar can show a
        // growing "↑ N tokens". Never replayed (not in the durable log).
        this._broadcast({
          type: 'usage',
          output_tokens: ev.output_tokens,
          input_tokens: ev.input_tokens,
          cache_read_tokens: ev.cache_read_tokens,
          final: ev.final,
          duration_ms: ev.duration_ms,
          cost_usd: ev.cost_usd,
        });
        break;
      case 'stop':
        this._flushAssistant();
        try {
          db.update(claudeSessions).set({ lastUsedAt: Math.floor(Date.now() / 1000) })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'stop', subtype: ev.subtype });
        // A turn finished → the account quota just moved; refresh the usage
        // gauges (debounced + endpoint-rate-limit-aware in usagePoll). Live
        // stops only — a reconnect replay of old stops must not spam the
        // /usage endpoint. cf. CLAUDE.md §14.58.
        if (!this.isReplaying) {
          try {
            if (this.kind === 'codex') codexUsagePollTrigger?.(this.vpsId);
            else usagePollTrigger?.(this.vpsId);
          } catch {}
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
        {
          const stopSeq = typeof ev.seq === 'number' ? ev.seq : null;
          const isNewFinish = stopSeq == null
            ? !this.isReplaying
            : (this.lastStopNotifiedSeq == null || stopSeq > this.lastStopNotifiedSeq);
          if (!this.isReplaying && isNewFinish) {
            this._maybePush({
              title: `✓ ${this.vpsName} · ${this._label()}`,
              body: 'Claude finished its response',
              tag: `stop-${this.id}`,
            });
            // Mirror the "finished" notification to Telegram (plain text, no
            // buttons — stop isn't interactive). Telegram is an INDEPENDENT
            // channel: gated ONLY by telegram.enabled (checked inside
            // sendPlainToTelegram→configured()), NOT by notif.global_enabled
            // (that's the browser/push master). The isNewFinish seq-dedup
            // already prevents reconnect/replay storms. No-op if Telegram is
            // off/unconfigured. (CLAUDE.md §7)
            sendPlainToTelegram(
              `✓ ${this.vpsName} · ${this._label()}\nClaude finished its response`,
              `/?session=${this.id}`,
            ).catch(() => {});
          }
          // Passive in-app "finished, unread" marker (CLAUDE.md §14.47). Light
          // it on a genuinely-new finish UNLESS the user is currently viewing
          // the session. Unlike the push above we do NOT require !isReplaying:
          // a finish first learned about via replay (Charon was down when the
          // agent finished) is a real unread finish, and a silent DB flag has
          // no notification-storm concern. The seq dedup in `isNewFinish` + the
          // advance below keep later reconnect-replays from re-marking it.
          if (isNewFinish) {
            const beingViewed = sessionFocusChecker?.(this.id) ?? false;
            if (!beingViewed) {
              try {
                db.update(claudeSessions).set({ unreadStop: 1 })
                  .where(eq(claudeSessions.id, this.id)).run();
              } catch {}
              this._broadcast({ type: 'session_unread', unread: true });
            }
          }
          if (stopSeq != null && (this.lastStopNotifiedSeq == null || stopSeq > this.lastStopNotifiedSeq)) {
            this.lastStopNotifiedSeq = stopSeq;
            try {
              db.update(claudeSessions).set({ lastStopNotifiedSeq: stopSeq })
                .where(eq(claudeSessions.id, this.id)).run();
            } catch {}
          }
        }
        break;
      case 'interrupted':
        this._broadcast({ type: 'mode_changed', mode: this.permissionMode }); // free-form
        break;
      case 'error':
        this._log('error', 'sdk_error', { msg: ev.msg, fatal: !!ev.fatal });
        this._broadcast({ type: 'error', msg: ev.msg, fatal: ev.fatal });
        break;
    }
  }

  // ── Actions (forwarded to the agent) ─────────────────────────────────────
  async sendUserMessage(content: string): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    this._persist('user', content);
    const now = Math.floor(Date.now() / 1000);
    this._broadcast({ type: 'user_echo', content, createdAt: now });
    this.status = 'thinking';
    this._broadcast({ type: 'status', status: 'thinking' });
    // Idempotency key (P1.1): the agent (>= 0.19.0) records the id once the
    // input was ACCEPTED and answers {duplicate:true} on a re-send — so the
    // ambiguous-timeout case ("did my prompt land?") can be retried without
    // ever executing the prompt twice. Older agents ignore the extra param
    // (retry then risks a duplicate, same as before — strictly no worse).
    const params = {
      session_id: this.id, content,
      client_message_id: crypto.randomUUID(),
    };
    try {
      await client.call('send_input', params);
    } catch (e) {
      const msg = String((e as { message?: unknown })?.message ?? e);
      // AMBIGUOUS timeout: the RPC may or may not have been delivered.
      // Retry once with the SAME id — the agent-side dedup makes this safe.
      if (/timeout on send_input/i.test(msg)) {
        await client.call('send_input', params);
        return;
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
      if (!/not running|not found|dead|-3200[01]/i.test(msg)) throw e;
      try {
        await resumeSession(this.id);   // starts/resumes the SDK session (re-reads model/effort, §14.35)
        await client.call('send_input', params);
      } catch (resumeErr) {
        this.status = 'sleeping';
        this._broadcast({ type: 'status', status: 'sleeping' });
        throw resumeErr;
      }
    }
  }

  async sendInterrupt(): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('interrupt', { session_id: this.id });
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
  // mode (read-only / workspace-write / full-access). Passed straight to the
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

  async respondPermission(permId: string, allow: boolean, always = false): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    try {
      const [row] = db.select().from(claudePendingPermissions)
        .where(eq(claudePendingPermissions.id, permId)).all();
      if (row && always && allow) this.alwaysAllow.add(row.toolName);
      db.update(claudePendingPermissions)
        .set({ status: allow ? 'allowed' : 'denied', respondedAt: Math.floor(Date.now() / 1000) })
        .where(eq(claudePendingPermissions.id, permId)).run();
    } catch {}
    await client.call('respond_permission', { session_id: this.id, perm_id: permId, allow });
    this._broadcast({ type: 'interaction_resolved', kind: 'permission', id: permId });
    markInteractionResolvedInTelegram('permission', permId);
  }

  async respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    try {
      db.update(claudePendingQuestions).set({
        status: answers ? 'answered' : 'cancelled',
        answers: answers ? JSON.stringify(answers) : null,
        respondedAt: Math.floor(Date.now() / 1000),
      }).where(eq(claudePendingQuestions.id, qid)).run();
    } catch {}
    await client.call('respond_question', { session_id: this.id, q_id: qid, answers });
    this._broadcast({ type: 'interaction_resolved', kind: 'question', id: qid });
    markInteractionResolvedInTelegram('question', qid);
  }

  async respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback = ''): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    try {
      db.update(claudePendingQuestions).set({
        status: 'answered',
        answers: JSON.stringify({ decision, feedback }),
        respondedAt: Math.floor(Date.now() / 1000),
      }).where(eq(claudePendingQuestions.id, qid)).run();
    } catch {}
    await client.call('respond_exit_plan', { session_id: this.id, q_id: qid, decision, feedback });
    this._broadcast({ type: 'interaction_resolved', kind: 'exit_plan', id: qid });
  }

  // ── Privates ─────────────────────────────────────────────────────────────
  private _broadcast(ev: WorkerEvent): void {
    // Push all events on the global bus — the multiplexed /events SSE
    // handles the fan-out + filter by connection focus. Tag with sessionId
    // so consumers know which session it came from.
    emitGlobalSession({ ...ev, sessionId: this.id } as GlobalSessionEvent);
  }

  /**
   * Flush the assistant text currently being accumulated (currentAssistant):
   * persist an 'assistant' message in DB and reset the buffer. To be called
   * before any event that interrupts the assistant text (tool_use, thinking,
   * permission_request, etc.) — otherwise the text written BEFORE the tool
   * would be concatenated with the text AFTER and inserted as a single block
   * at the end (on `stop`), breaking chronological order on reload.
   *
   * During a replay, we're more careful:
   *  - If the accumulated content already exists in DB → skip (already persisted).
   *  - If the LAST assistant line in DB is a prefix of the accumulated content
   *    → it's a partial flushed by SIGTERM, extend the line instead of
   *    inserting a new one (otherwise we'd have a partial + a complete in DB).
   *  - Otherwise → normal insert.
   */
  private _flushAssistant(): void {
    if (!this.currentAssistant) return;
    const finalContent = this.currentAssistant;
    // The flush row is stamped with the FIRST delta's seq — the row's
    // identity is the accumulation start (unique: a delta belongs to
    // exactly one accumulation, and deltas write no other row). Captured
    // BEFORE clearing so a failed insert can restore both buffer and
    // holdback (Codex 13.2.B: the old code forgot the buffer start before
    // knowing whether the insert succeeded — a failed flush lost the
    // whole turn text).
    const flushSeq = this.pendingAssistantSince;
    this.currentAssistant = '';
    this.pendingAssistantSince = null;

    if (this.isReplaying) {
      if (flushSeq != null && this.replayPersistedSeqs != null && this.replayPersistedSeqs.size > 0) {
        // IDENTITY path (rows are seq-stamped): the flush row's identity is
        // the FIRST delta's seq. Row present → this exact accumulation is
        // already persisted (possibly as a SIGTERM partial → prefix-extend
        // below). Row absent → genuinely new: identical TEXT from another
        // turn must NOT suppress it — the original P0.3 "Done." bug lived
        // in the content check of the else-branch, still reachable through
        // the ungated stop/effective_model flushes until this fix.
        // (Transition caveat: rows persisted pre-0023 are unstamped, so a
        // replay straddling the deploy boundary can fall through to insert;
        // one-shot window, accepted.)
        if (this.replayPersistedSeqs.has(flushSeq)) {
          try {
            const [row] = db.select().from(claudeSessionMessages)
              .where(and(
                eq(claudeSessionMessages.sessionId, this.id),
                eq(claudeSessionMessages.seq, flushSeq),
                eq(claudeSessionMessages.role, 'assistant'),
              ))
              .limit(1).all();
            if (row && finalContent.startsWith(row.content) && finalContent.length > row.content.length) {
              // SIGTERM partial: the persisted row holds a strict prefix of
              // the re-accumulated text — extend it in place.
              db.update(claudeSessionMessages)
                .set({ content: finalContent, ...(this.effectiveModel ? { model: this.effectiveModel } : {}) })
                .where(eq(claudeSessionMessages.id, row.id))
                .run();
            }
          } catch {}
          return;
        }
        // fall through → INSERT below (identity says: not persisted)
      } else {
        // LEGACY path (agents without seq / pre-0023 rows): content dedup +
        // prefix-extend — the historical behavior, imperfect on identical
        // answers but the only signal available.
        if (this.replayKnownAssistantContents.has(finalContent)) return;
        try {
          const lastRows = db.select().from(claudeSessionMessages)
            .where(and(
              eq(claudeSessionMessages.sessionId, this.id),
              eq(claudeSessionMessages.role, 'assistant'),
            ))
            .orderBy(desc(claudeSessionMessages.id))
            .limit(1).all();
          if (lastRows.length > 0 &&
              finalContent.startsWith(lastRows[0].content) &&
              finalContent.length > lastRows[0].content.length) {
            db.update(claudeSessionMessages)
              // Re-stamp the model too: the partial may predate the model column
              // (or a SIGTERM flush that raced the effective_model event).
              .set({ content: finalContent, ...(this.effectiveModel ? { model: this.effectiveModel } : {}) })
              .where(eq(claudeSessionMessages.id, lastRows[0].id))
              .run();
            this.replayKnownAssistantContents.delete(lastRows[0].content);
            this.replayKnownAssistantContents.add(finalContent);
            return;
          }
        } catch {}
      }
    }

    // Stamp the row with the model that actually produced this text (per-
    // message attribution — the effective_model handler flushes BEFORE
    // switching, so buffered text never gets relabeled by a newer model).
    const ok = this._persist('assistant', finalContent, { model: this.effectiveModel, seq: flushSeq });
    if (!ok) {
      // RESTORE (Codex 13.2.B): keep the text in the buffer — the next
      // boundary retries the flush with possibly more text (chronology
      // slightly late, never lost) — and pin the durable cursor at the
      // FIRST delta so a crash replays the whole accumulation.
      this.currentAssistant = finalContent;
      this.pendingAssistantSince = flushSeq;
      if (flushSeq != null && (this.persistHoldbackSeq == null || flushSeq < this.persistHoldbackSeq)) {
        this.persistHoldbackSeq = flushSeq;
      }
      return;
    }
    if (this.isReplaying) this.replayKnownAssistantContents.add(finalContent);
  }

  /** Public variant for graceful shutdown: persists without broadcasting. */
  flushPendingAssistant(): void {
    this._flushAssistant();
  }

  /**
   * On replay_begin: load from the DB the IDs/contents already known to
   * dedupe each event during the replay window.
   */
  private _loadReplayDedup(): void {
    this.replayKnownToolUseIds.clear();
    this.replayKnownToolResultIds.clear();
    this.replayKnownAssistantContents.clear();
    this.replayKnownThinkingContents.clear();
    this.replayKnownPendingIds.clear();
    // Primary gate: the SET of stamped row seqs (collected in the row loop
    // below — same query the content Sets already need). NULL/empty (fresh
    // DB / rows all pre-seq-column) → the content Sets carry the dedup
    // alone, exactly the pre-2026-07 behavior.
    this.replayPersistedSeqs = new Set<number>();
    try {
      const rows = db.select().from(claudeSessionMessages)
        .where(eq(claudeSessionMessages.sessionId, this.id))
        .all();
      for (const r of rows) {
        if (typeof r.seq === 'number') this.replayPersistedSeqs.add(r.seq);
        try {
          if (r.role === 'tool_use') {
            const p = JSON.parse(r.content);
            if (p?.id) this.replayKnownToolUseIds.add(String(p.id));
          } else if (r.role === 'tool_result') {
            const p = JSON.parse(r.content);
            if (p?.tool_use_id) this.replayKnownToolResultIds.add(String(p.tool_use_id));
          } else if (r.role === 'assistant') {
            this.replayKnownAssistantContents.add(r.content);
          } else if (r.role === 'thinking') {
            this.replayKnownThinkingContents.add(r.content);
          } else if (r.role === 'event') {
            // old 'thinking' events (before the dedicated role) are sometimes stored here
            try {
              const p = JSON.parse(r.content);
              if (p?.type === 'thinking' && typeof p.text === 'string') {
                this.replayKnownThinkingContents.add(p.text);
              }
            } catch {}
          }
        } catch {}
      }
      const perms = db.select({ id: claudePendingPermissions.id })
        .from(claudePendingPermissions)
        .where(eq(claudePendingPermissions.sessionId, this.id))
        .all();
      for (const p of perms) this.replayKnownPendingIds.add(p.id);
      const qs = db.select({ id: claudePendingQuestions.id })
        .from(claudePendingQuestions)
        .where(eq(claudePendingQuestions.sessionId, this.id))
        .all();
      for (const q of qs) this.replayKnownPendingIds.add(q.id);
    } catch {}
  }

  private _persist(role: string, content: any, extra?: { model?: string | null; seq?: number | null }): boolean {
    // Stamp the row with the seq of the event being dispatched (null for
    // hub-originated rows like 'user' — sendUserMessage runs outside
    // dispatch). Flush rows override with the FIRST DELTA's seq via
    // extra.seq — every row's seq is then its own unique identity (no
    // boundary/flush collision). This is the replay-idempotence anchor
    // (P0.3). Returns false on failure so callers (flush) can restore.
    const seq = extra && 'seq' in extra ? extra.seq ?? null : this.currentEventSeq;
    try {
      db.insert(claudeSessionMessages).values({
        sessionId: this.id, role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        // Only assistant rows carry a model stamp (see _flushAssistant).
        ...(extra?.model ? { model: extra.model } : {}),
        ...(seq != null ? { seq } : {}),
      }).run();
      return true;
    } catch (e: any) {
      // Hold the durable cursor back to (seq - 1): the next restart will
      // replay this event and the insert gets a second chance — without
      // this, a failed write was silently lost forever (P0.2).
      if (seq != null && (this.persistHoldbackSeq == null || seq < this.persistHoldbackSeq)) {
        this.persistHoldbackSeq = seq;
      }
      this._log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
      return false;
    }
  }

  private _log(level: 'info' | 'warn' | 'error', event: string, detail?: any): void {
    try {
      db.insert(claudeSessionLogs).values({
        sessionId: this.id, level, event,
        detail: detail ? JSON.stringify(detail) : null,
      }).run();
    } catch {}
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

  private _maybePush(payload: { title: string; body: string; tag?: string }): void {
    if (!getSettingBool('notif.global_enabled')) return;
    // `url` is the openWindow fallback used by the service worker when no
    // Charon tab is already open. The hub is a single responsive app at `/`
    // — the ClaudePanel picks up `?session=…` via useSearchParams and
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
 * Why this matters: every GET /api/claude/events used to call getStream()
 * for every session row, which materialized SessionStream wrappers for
 * sleeping/historical sessions that nobody was attached to. Harmless but
 * wasteful — `peek` makes the read paths zero-allocation in steady state.
 */
export function peekStream(sessionId: string): SessionStream | null {
  return streams.get(sessionId) ?? null;
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
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return null;
  s = new SessionStream({
    id: row.id, vpsId: row.vpsId, vpsName: _vpsName(row.vpsId),
    name: row.name, status: row.status as WorkerStatus,
    kind: (row.kind as AgentKind) ?? 'claude',
    permissionMode: row.permissionMode as SessionMode,
    claudeSessionId: row.claudeSessionId,
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

// ── Session lifecycle (create/resume/sleep/kill/import) ─────────────────────

/**
 * Create a DB row for a Claude session that already exists SDK-side (e.g.
 * found by /api/vps/[id]/claude/scan). The session is born 'sleeping' with
 * its claude_session_id; a later resume materializes it on the agent side
 * via start_session(claude_session_id=...).
 */
export async function importExistingSession(opts: {
  vpsId: string;
  cwd: string;
  claudeSessionId: string;
  name?: string | null;
  kind?: AgentKind;
  permissionMode?: SessionMode;
}): Promise<string> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);
  const sessionId = newId();
  const kind: AgentKind = opts.kind === 'codex' ? 'codex' : 'claude';
  const defaultMode: SessionMode = kind === 'codex' ? 'workspace-write' : 'normal';
  db.insert(claudeSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    claudeSessionId: opts.claudeSessionId,
    cwd: opts.cwd,
    name: opts.name ?? null,
    kind,
    status: 'sleeping',
    permissionMode: opts.permissionMode ?? defaultMode,
  }).run();
  // Live-announce the imported session (appears on every tab/device). §14.52.
  emitGlobalSessionListChanged(sessionId);
  return sessionId;
}

export async function startNewSession(opts: {
  vpsId: string;
  cwd: string;
  name?: string | null;
  // 'claude' (default) | 'codex'. Selects the backend + config semantics.
  kind?: AgentKind;
  // Claude: a PermissionMode. Codex: a CodexSandboxMode (the sandbox level).
  permissionMode?: SessionMode;
  // Optional config overrides. If null/undefined we fall back to the global
  // defaults (claude.default_* or codex.default_*); if those are also empty,
  // the agent passes nothing → the SDK/Codex uses its own default. Effort is
  // validated per-kind; an invalid string is silently dropped. fallbackModel
  // is Claude-only (Codex ignores it).
  model?: string | null;
  fallbackModel?: string | null;
  effort?: string | null;
}): Promise<SessionStream> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);

  const kind: AgentKind = opts.kind === 'codex' ? 'codex' : 'claude';
  const defaultMode: SessionMode = kind === 'codex' ? 'workspace-write' : 'normal';
  const permissionMode: SessionMode = opts.permissionMode ?? defaultMode;
  const sessionId = newId();
  // Resolve effective config: per-session opts first, then global defaults.
  // We persist the RESOLVED values to the DB row so they survive a Charon
  // restart even if the global default changes later. (If we stored null
  // here and read the default at start time, changing the SettingsModal
  // default would silently retroactively change sessions — surprising.)
  const cfg = _resolveSessionConfig(kind, {
    model: opts.model, fallbackModel: opts.fallbackModel, effort: opts.effort,
  });
  const effortPersist = isValidEffortForKind(cfg.effort, kind) ? cfg.effort : null;

  // Insert in DB first (status 'starting' until agent confirms)
  db.insert(claudeSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    cwd: opts.cwd,
    name: opts.name ?? null,
    kind,
    status: 'starting',
    permissionMode,
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    effort: effortPersist,
    lastUsedAt: Math.floor(Date.now() / 1000),
  }).run();

  const stream = new SessionStream({
    id: sessionId, vpsId: opts.vpsId, vpsName: vps.name,
    name: opts.name ?? null, status: 'starting',
    kind,
    permissionMode,
    cwd: opts.cwd,
    claudeSessionId: null,
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    effort: effortPersist,
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
      permission_mode: permissionMode,
      // Pass-through to the agent. Older agents (< 0.5.0) silently ignore
      // unknown params — the SDK call falls back to its own defaults.
      model: cfg.model,
      fallback_model: cfg.fallbackModel,
      effort: effortPersist,
    });
  } catch (e: any) {
    streams.delete(sessionId);
    db.update(claudeSessions).set({ status: 'error' })
      .where(eq(claudeSessions.id, sessionId)).run();
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
const _resumeInflight = new Map<string, Promise<SessionStream>>();

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
  const p = (async () => {
    const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
    if (!row) throw new Error(`session ${sessionId} not found`);
    // Note: the `status === 'killed'` guard was removed with the kill→delete
    // merge. A killed session no longer exists in DB; this path is dead.

    const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, row.vpsId)).all();
    if (!vps) throw new Error('vps no longer exists');

    const kind: AgentKind = (row.kind as AgentKind) ?? 'claude';
    let stream = streams.get(sessionId);
    if (!stream) {
      stream = new SessionStream({
        id: row.id, vpsId: row.vpsId, vpsName: vps.name,
        name: row.name, status: row.status as WorkerStatus,
        kind,
        permissionMode: row.permissionMode as SessionMode,
        claudeSessionId: row.claudeSessionId,
        cwd: row.cwd,
        lastSeenSeq: row.lastSeenSeq ?? null,
        lastStopNotifiedSeq: row.lastStopNotifiedSeq ?? null,
        model: row.model ?? null,
        fallbackModel: row.fallbackModel ?? null,
        effectiveModel: row.effectiveModel ?? null,
        effort: row.effort ?? null,
      });
      streams.set(sessionId, stream);
    } else {
    }

    const client = getAgentClientForVpsId(row.vpsId);
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
    try {
      const rpcRes = await client.call('resume_session', { session_id: sessionId });
      const agentStatus = (rpcRes as { status?: string } | undefined)?.status;
      if (agentStatus === 'active' || agentStatus === 'thinking' || agentStatus === 'starting') {
        resolvedStatus = agentStatus;
      }
    } catch (e: any) {
      const isNotFound = /not found/i.test(e?.message ?? '') || e?.code === -32000;
      if (!isNotFound) throw e;
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
          claude_session_id: row.claudeSessionId,
          model: row.model ?? null,
          fallback_model: row.fallbackModel ?? null,
          effort: row.effort ?? null,
        });
      } catch (startErr: any) {
        // If another concurrent call just created it (race between
        // two resume paths), the agent replies "already exists". In that
        // case we treat it as a success: the session is properly on the agent.
        const msg = startErr?.message ?? '';
        if (!/already exists/i.test(msg)) throw startErr;
      }
    }
    stream.attach();
    // If the user had already opened the SSE before the resume, attach() has
    // already tried a subscribe on the agent side that failed (session not yet
    // existing). Force a new subscribe now that it exists.
    client.resubscribe(sessionId);
    // Reconcile the in-memory stream + every SSE client + DB with the agent's
    // authoritative status. CRITICAL for the noop path: a session the agent
    // already considers active emits NO status event, so without this the
    // in-memory status stays pinned to its stale value (typically 'sleeping'),
    // /resume returns {status:'sleeping'}, and the UI shows the session as
    // never resuming — clicking "resume" has no visible effect. Mirrors
    // sleepSession's optimistic broadcast pattern. See CLAUDE.md §14 gotcha 36.
    stream.status = resolvedStatus;
    emitGlobalSession({ type: 'status', status: resolvedStatus, sessionId });
    // Resuming clears any durable sleep intent (the user/reconcile explicitly
    // wants this session running again). cf. CLAUDE.md §14.46.
    db.update(claudeSessions).set({ status: resolvedStatus, sleepRequested: 0 })
      .where(eq(claudeSessions.id, sessionId)).run();
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
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  // Record the DURABLE sleep intent alongside the status (cf. CLAUDE.md §14.46):
  // if the agent is down right now, this fire-and-forget sleep_session RPC may
  // never land; the agent would later restore the session as 'active' and
  // reconcileVpsAgentState would resurrect it. The flag lets reconcile honor
  // the user's intent and re-fire the sleep instead.
  db.update(claudeSessions).set({ status: 'sleeping', sleepRequested: 1 })
    .where(eq(claudeSessions.id, sessionId)).run();
  // Optimistic broadcast: flip the status to 'sleeping' for ALL SSE clients
  // (sidebar badges + other tabs) right away. The acting tab already updated
  // locally; this covers everyone else. We deliberately do NOT wait for the
  // agent's own status=sleeping event, which only comes back AFTER the SDK
  // teardown — session.py stop() awaits the in-flight turn (up to 5s) before
  // the RPC returns.
  const stream = streams.get(sessionId);
  if (stream) stream.status = 'sleeping';
  emitGlobalSession({ type: 'status', status: 'sleeping', sessionId });
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
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) throw new Error(`session ${sessionId} not found`);

  const wasRunning = ['active', 'thinking', 'starting'].includes(row.status);
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
    // sleep intent here could race reconcile into re-sleeping it).
    try {
      db.update(claudeSessions).set({ status: 'sleeping' })
        .where(eq(claudeSessions.id, sessionId)).run();
    } catch {}
    const stream = streams.get(sessionId);
    if (stream) stream.status = 'sleeping';
  }

  return resumeSession(sessionId);
}

export async function forceStopSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  // Durable stop intent — same rationale as sleepSession (CLAUDE.md §14.46).
  db.update(claudeSessions).set({ status: 'sleeping', sleepRequested: 1 })
    .where(eq(claudeSessions.id, sessionId)).run();
  const stream = streams.get(sessionId);
  if (stream) {
    await stream.forceStop();
  } else {
    // No stream in memory — try to reach the agent anyway
    try {
      const client = getAgentClientForVpsId(row.vpsId);
      await client.call('force_stop', { session_id: sessionId });
    } catch {
      // Agent down: DB is already 'sleeping', user can resume later
    }
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
 *      questions/logs from `claudeSessions`, but we explicitly delete
 *      logs too as defense in depth (they existed outside the cascade
 *      historically in the code).
 *   4. Best-effort: call `kill_session` on the agent side so it forgets
 *      the session. If the agent is down, never mind — the next reconcile
 *      will ignore orphan sessions (cf. `reconcileVpsAgentState`).
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  emitGlobalSession({ type: 'status', sessionId, status: 'killed' } as GlobalSessionEvent);
  const stream = streams.get(sessionId);
  if (stream) {
    stream.detach();
    streams.delete(sessionId);
  }
  db.delete(claudeSessionLogs).where(eq(claudeSessionLogs.sessionId, sessionId)).run();
  db.delete(claudeSessions).where(eq(claudeSessions.id, sessionId)).run();
  // Live-announce the removal so every other tab/device drops the card. §14.52.
  emitGlobalSessionListChanged(sessionId);
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    await client.call('kill_session', { session_id: sessionId });
  } catch (e) {
    // Agent down: the session is already deleted on the Charon side, the
    // agent may still have an orphan in its state.json — will be ignored
    // by reconcileVpsAgentState (no DB row), then cleaned at its next restart.
  }
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
  agentSessions: AgentSessionInfo[],
): Promise<void> {
  const agentSidMap = new Map<string, AgentSessionInfo>();
  for (const a of agentSessions) agentSidMap.set(a.session_id, a);

  // 1) Sessions alive on the agent side: attach a SessionStream + sync status.
  for (const [sid, info] of agentSidMap) {
    let row: typeof claudeSessions.$inferSelect | undefined;
    try {
      [row] = db.select().from(claudeSessions)
        .where(eq(claudeSessions.id, sid)).all();
    } catch { continue; }
    if (!row) continue;            // session unknown to Charon, we don't invent
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
          db.update(claudeSessions).set({ status: 'sleeping' })
            .where(eq(claudeSessions.id, sid)).run();
        } catch {}
      }
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
        db.update(claudeSessions).set({ status: agentStatus })
          .where(eq(claudeSessions.id, sid)).run();
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
  let dbRows: { id: string; status: string }[] = [];
  try {
    dbRows = db.select({ id: claudeSessions.id, status: claudeSessions.status })
      .from(claudeSessions)
      .where(and(
        eq(claudeSessions.vpsId, vpsId),
        inArray(claudeSessions.status, ['active', 'thinking', 'starting']),
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
          db.insert(claudeSessionLogs).values({
            sessionId: row.id, level: 'info', event: 'auto_resume',
            detail: JSON.stringify({ trigger: 'reconcile', wasStatus: row.status }),
          }).run();
        } catch {}
      })
      .catch((e) => {
        try {
          db.insert(claudeSessionLogs).values({
            sessionId: row.id, level: 'warn', event: 'auto_resume',
            detail: JSON.stringify({
              trigger: 'reconcile', wasStatus: row.status,
              err: e?.message ?? String(e),
            }),
          }).run();
          // If the relaunch fails (cwd gone, SDK broken…), degrade to sleeping
          // so the UI clearly shows a manual "resume" button.
          db.update(claudeSessions).set({ status: 'sleeping' })
            .where(eq(claudeSessions.id, row.id)).run();
          emitGlobalSession({
            type: 'status', sessionId: row.id, status: 'sleeping',
          } as GlobalSessionEvent);
        } catch {}
      });
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
// When systemd / the user kills the Next process (SIGTERM or SIGINT), we
// flush to DB the assistant text being accumulated in each SessionStream.
// Without this, any assistant text streamed before the next `stop` is lost
// (cf. bug observed when the app was restarted while Claude was still
// writing).
//
// We use a module-level flag to avoid double-registration on Next hot-reload.
declare global {
  // eslint-disable-next-line no-var
  var __charon_shutdownRegistered: boolean | undefined;
}
// Skip during `next build`: the module is imported by build workers
// (SSR analysis), which receive a SIGINT/SIGTERM at the end of the phase.
// If we register the handler, we `process.exit(0)` prematurely and that
// can break the build (cf. logs `graceful flush done on SIGINT` during build).
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
if (!isBuildPhase && !globalThis.__charon_shutdownRegistered) {
  globalThis.__charon_shutdownRegistered = true;
  const onSignal = (sig: NodeJS.Signals) => {
    try {
      for (const s of streams.values()) {
        try { s.flushPendingAssistant(); } catch {}
      }
      // eslint-disable-next-line no-console
      console.log(`[charon] graceful flush done on ${sig} — exiting`);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
