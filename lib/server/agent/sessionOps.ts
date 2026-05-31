import 'server-only';
import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  db, claudeSessions, claudeSessionMessages,
  claudePendingPermissions, claudePendingQuestions, claudeSessionLogs,
  vps as vpsTable,
} from '@/lib/db';
import type { PermissionMode } from '@/lib/server/claude/types';
import type { WorkerEvent, WorkerStatus } from '@/lib/server/claude/types';
import { getAgentClientForVpsId } from './AgentClientPool';
import type { AgentSessionInfo } from './types';
import { sendPushToAll } from '@/lib/server/claude/webPush';
import {
  sendPermissionToTelegram, sendQuestionToTelegram, markInteractionResolvedInTelegram,
} from '@/lib/server/claude/telegram';
import { getSetting, getSettingBool } from '@/lib/server/claude/settings';
import type { AgentEvent, EffortLevel } from './types';
import type { EventListener as AgentEventListener } from './AgentClient';

// Resolve the effective (model, fallback_model, effort) for a new session:
// per-session opts win, otherwise fall back to the global defaults in
// claudeSettings, otherwise null (= let the agent pass nothing → SDK default).
// Empty string in settings is treated as "unset" so an admin can erase a
// default from the SettingsModal without nuking the row.
function _resolveClaudeConfig(opts: {
  model?: string | null;
  fallbackModel?: string | null;
  effort?: string | null;
}): { model: string | null; fallbackModel: string | null; effort: string | null } {
  const pick = (perSession: string | null | undefined, settingKey: 'claude.default_model' | 'claude.default_fallback_model' | 'claude.default_effort'): string | null => {
    if (perSession && perSession.length > 0) return perSession;
    const v = getSetting(settingKey);
    return v && v.length > 0 ? v : null;
  };
  return {
    model: pick(opts.model, 'claude.default_model'),
    fallbackModel: pick(opts.fallbackModel, 'claude.default_fallback_model'),
    effort: pick(opts.effort, 'claude.default_effort'),
  };
}

// Mirrors claude_agent_sdk.EffortLevel + the VALID_EFFORTS tuple in
// agent/charon_agent/session.py. Kept in sync with `EffortLevel` in types.ts.
const VALID_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function isValidEffort(v: string | null | undefined): v is EffortLevel {
  return typeof v === 'string' && (VALID_EFFORTS as readonly string[]).includes(v);
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

export class SessionStream {
  readonly id: string;
  readonly vpsId: string;
  status: WorkerStatus = 'starting';
  permissionMode: PermissionMode = 'normal';
  claudeSessionId: string | null = null;
  name: string | null = null;
  vpsName: string;
  cwd: string | null = null;
  // Per-session Claude model / fallback / effort. NULL = fall back to global
  // default (claudeSettings.claude.default_*) → SDK default. Source of truth
  // is the DB column; SessionStream caches it in memory for fast access and
  // because resume needs to read it before any DB roundtrip.
  model: string | null = null;
  fallbackModel: string | null = null;
  effort: EffortLevel | null = null;

  private currentAssistant = '';
  private agentListener: AgentEventListener | null = null;
  private attached = false;
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

  constructor(opts: {
    id: string; vpsId: string; vpsName: string; name: string | null;
    status: WorkerStatus; permissionMode: PermissionMode;
    claudeSessionId: string | null;
    cwd?: string | null;
    lastSeenSeq?: number | null;
    lastStopNotifiedSeq?: number | null;
    model?: string | null;
    fallbackModel?: string | null;
    effort?: string | null;
  }) {
    this.id = opts.id;
    this.vpsId = opts.vpsId;
    this.vpsName = opts.vpsName;
    this.name = opts.name;
    this.cwd = opts.cwd ?? null;
    this.status = opts.status;
    this.permissionMode = opts.permissionMode;
    this.claudeSessionId = opts.claudeSessionId;
    this.lastSeenSeq = opts.lastSeenSeq ?? null;
    this.lastPersistedSeq = this.lastSeenSeq;
    this.lastStopNotifiedSeq = opts.lastStopNotifiedSeq ?? null;
    this.model = opts.model ?? null;
    this.fallbackModel = opts.fallbackModel ?? null;
    this.effort = isValidEffort(opts.effort) ? opts.effort : null;
  }

  /** Wires the listener to the agent (idempotent).
   *  Passes `afterSeq` to the agent so it can replay missed events from
   *  its durable log (agent >= 0.4.0). For older agents this is a no-op:
   *  the client falls back to ring replay. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const client = getAgentClientForVpsId(this.vpsId);
    this.agentListener = (ev) => this._onAgentEvent(ev);
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
    if (this.lastSeenSeq == null) return;
    if (this.lastSeenSeq === this.lastPersistedSeq) return;
    try {
      db.update(claudeSessions)
        .set({ lastSeenSeq: this.lastSeenSeq })
        .where(eq(claudeSessions.id, this.id))
        .run();
      this.lastPersistedSeq = this.lastSeenSeq;
    } catch {
      // Best-effort: next event triggers another attempt. Worst case
      // we replay a few extra events on next reconnect (idempotent
      // via the existing replay-dedup path).
    }
  }

  /** Detach the listener (used on permanent kill). */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    try {
      const client = getAgentClientForVpsId(this.vpsId);
      if (this.agentListener) client.unsubscribe(this.id, this.agentListener);
    } catch {}
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
    if (!this.attached) this.attach();
  }

  /**
   * Dispatch an agent event: DB persistence + SSE broadcast.
   * Preserves the semantics of SessionWorker.handleBridgeEvent.
   */
  private _onAgentEvent(ev: AgentEvent): void {
    try {
      this._dispatchEvent(ev);
    } finally {
      // Advance the durable-replay cursor AFTER the dispatch ran. We do
      // it in `finally` so a thrown handler still advances — replaying
      // the same event would just hit the same exception. Idempotency
      // is enforced upstream by the replay dedup. `_trackSeq` is a
      // no-op for events without a seq (replay markers, old agents).
      this._trackSeq(ev);
    }
  }

  private _dispatchEvent(ev: AgentEvent): void {
    switch (ev.event) {
      case 'replay_begin':
        // We enter the replay window: the events that follow may be
        // duplicates (already persisted) OR missed events (e.g. after
        // a Charon restart, the VPS agent kept streaming while we were
        // down). Load the "already known" set and process each event
        // normally with per-event-type dedup.
        this.isReplaying = true;
        this._loadReplayDedup();
        return;
      case 'replay_end':
        this.isReplaying = false;
        this.replayKnownToolUseIds.clear();
        this.replayKnownToolResultIds.clear();
        this.replayKnownAssistantContents.clear();
        this.replayKnownThinkingContents.clear();
        this.replayKnownPendingIds.clear();
        return;
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
          console.warn(`[resume-debug] ${this.id} agent→status=${ev.status} SKIPPED (replay) @${Date.now()}`);
          break;
        }
        console.warn(`[resume-debug] ${this.id} agent→status=${ev.status} (prev=${this.status}) @${Date.now()}`);
        this.status = ev.status as WorkerStatus;
        this._broadcast({ type: 'status', status: this.status });
        try {
          db.update(claudeSessions).set({ status: ev.status })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
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
        this.currentAssistant += ev.delta;
        this._broadcast({ type: 'assistant_text', delta: ev.delta });
        break;
      case 'thinking':
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownThinkingContents.has(ev.text)) break;
        this._persist('event', { type: 'thinking', text: ev.text });
        this._broadcast({ type: 'thinking', text: ev.text });
        if (this.isReplaying) this.replayKnownThinkingContents.add(ev.text);
        break;
      case 'tool_use':
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownToolUseIds.has(String(ev.id))) break;
        this._persist('tool_use', { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        this._broadcast({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        if (this.isReplaying) this.replayKnownToolUseIds.add(String(ev.id));
        break;
      case 'tool_result':
        if (this.isReplaying && this.replayKnownToolResultIds.has(String(ev.tool_use_id))) break;
        this._persist('tool_result', { type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        this._broadcast({ type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        if (this.isReplaying) this.replayKnownToolResultIds.add(String(ev.tool_use_id));
        break;
      case 'permission_request':
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
          }).run();
        } catch {}
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
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id, sessionId: this.id, kind: 'question',
            payload: JSON.stringify(ev.questions ?? []), status: 'pending',
          }).run();
        } catch {}
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
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id, sessionId: this.id, kind: 'exit_plan',
            payload: JSON.stringify({ plan: ev.plan ?? '' }), status: 'pending',
          }).run();
        } catch {}
        this._persist('exit_plan_request', { type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        this._broadcast({ type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        this._maybePush({
          title: `📋 ${this.vpsName} · ${this._label()} : plan ready`,
          body: 'Claude finished planning — tap to approve',
          tag: `plan-${this.id}`,
        });
        break;
      case 'todo_update':
        this._persist('event', { type: 'todo_update', todos: ev.todos });
        this._broadcast({ type: 'todo_update', todos: ev.todos });
        break;
      case 'edit_snapshot':
        this._persist('edit_snapshot', { type: 'edit_snapshot', phase: ev.phase, tool_use_id: ev.tool_use_id, file_path: ev.file_path, content: ev.content, size: ev.size, truncated: ev.truncated });
        this._broadcast({ type: 'edit_snapshot', phase: ev.phase, tool_use_id: ev.tool_use_id, file_path: ev.file_path, content: ev.content, size: ev.size, truncated: ev.truncated });
        break;
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
        this.effort = isValidEffort(ev.effort) ? ev.effort : null;
        try {
          db.update(claudeSessions).set({ effort: this.effort })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({
          type: 'effort_changed',
          effort: this.effort,
          appliedAtNextStart: !!ev.applied_at_next_start,
        });
        break;
      case 'stop':
        this._flushAssistant();
        try {
          db.update(claudeSessions).set({ lastUsedAt: Math.floor(Date.now() / 1000) })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'stop', subtype: ev.subtype });
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
    await client.call('send_input', { session_id: this.id, content });
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

  async setPermissionMode(mode: PermissionMode): Promise<void> {
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
  async setEffort(effort: EffortLevel | null): Promise<void> {
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
    this.currentAssistant = '';

    if (this.isReplaying) {
      // Exact match → already in DB
      if (this.replayKnownAssistantContents.has(finalContent)) return;
      // Prefix → extend the existing partial
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
            .set({ content: finalContent })
            .where(eq(claudeSessionMessages.id, lastRows[0].id))
            .run();
          this.replayKnownAssistantContents.delete(lastRows[0].content);
          this.replayKnownAssistantContents.add(finalContent);
          return;
        }
      } catch {}
    }

    this._persist('assistant', finalContent);
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
    try {
      const rows = db.select().from(claudeSessionMessages)
        .where(eq(claudeSessionMessages.sessionId, this.id))
        .all();
      for (const r of rows) {
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

  private _persist(role: string, content: any): void {
    try {
      db.insert(claudeSessionMessages).values({
        sessionId: this.id, role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      }).run();
    } catch (e: any) {
      this._log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
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
    // Charon tab is already open. Desktop hub is `/` — the ClaudePanel
    // picks up `?session=…` via useSearchParams and switches selectedId.
    // When a tab IS already open, the SW prefers focus+postMessage; the
    // root layout handler (`NotificationClickHandler`) then routes via
    // Next router to `/m/chat?id=…` or `/?session=…` depending on whether
    // the current pathname is mobile or desktop. Mobile users with no
    // Charon tab open fall back to `/?session=…` then go through the
    // MobileRedirectPrompt — acceptable since it's an edge case.
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
    permissionMode: row.permissionMode as PermissionMode,
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
  permissionMode?: PermissionMode;
}): Promise<string> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);
  const sessionId = newId();
  db.insert(claudeSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    claudeSessionId: opts.claudeSessionId,
    cwd: opts.cwd,
    name: opts.name ?? null,
    status: 'sleeping',
    permissionMode: opts.permissionMode ?? 'normal',
  }).run();
  return sessionId;
}

export async function startNewSession(opts: {
  vpsId: string;
  cwd: string;
  name?: string | null;
  permissionMode?: PermissionMode;
  // Optional Claude config overrides. If null/undefined we fall back to the
  // global defaults (claudeSettings.claude.default_*); if those are also
  // empty, the agent passes nothing → SDK uses its own default. Effort is
  // validated; an invalid string is silently dropped.
  model?: string | null;
  fallbackModel?: string | null;
  effort?: string | null;
}): Promise<SessionStream> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);

  const sessionId = newId();
  // Resolve effective config: per-session opts first, then global defaults.
  // We persist the RESOLVED values to the DB row so they survive a Charon
  // restart even if the global default changes later. (If we stored null
  // here and read the default at start time, changing the SettingsModal
  // default would silently retroactively change sessions — surprising.)
  const cfg = _resolveClaudeConfig({
    model: opts.model, fallbackModel: opts.fallbackModel, effort: opts.effort,
  });
  const effortPersist = isValidEffort(cfg.effort) ? cfg.effort : null;

  // Insert in DB first (status 'starting' until agent confirms)
  db.insert(claudeSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    cwd: opts.cwd,
    name: opts.name ?? null,
    status: 'starting',
    permissionMode: opts.permissionMode ?? 'normal',
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    effort: effortPersist,
    lastUsedAt: Math.floor(Date.now() / 1000),
  }).run();

  const stream = new SessionStream({
    id: sessionId, vpsId: opts.vpsId, vpsName: vps.name,
    name: opts.name ?? null, status: 'starting',
    permissionMode: opts.permissionMode ?? 'normal',
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
      cwd: opts.cwd,
      name: opts.name ?? null,
      permission_mode: opts.permissionMode ?? 'normal',
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
    console.warn(`[resume-debug] ${sessionId} resumeSession() called — dedup (existing inflight) @${Date.now()}`);
    return existing;
  }
  console.warn(`[resume-debug] ${sessionId} resumeSession() called @${Date.now()}`);
  const p = (async () => {
    const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
    if (!row) throw new Error(`session ${sessionId} not found`);
    // Note: the `status === 'killed'` guard was removed with the kill→delete
    // merge. A killed session no longer exists in DB; this path is dead.

    const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, row.vpsId)).all();
    if (!vps) throw new Error('vps no longer exists');

    let stream = streams.get(sessionId);
    if (!stream) {
      console.warn(`[resume-debug] ${sessionId} creating stream from DB row (db.status=${row.status}) @${Date.now()}`);
      stream = new SessionStream({
        id: row.id, vpsId: row.vpsId, vpsName: vps.name,
        name: row.name, status: row.status as WorkerStatus,
        permissionMode: row.permissionMode as PermissionMode,
        claudeSessionId: row.claudeSessionId,
        cwd: row.cwd,
        lastSeenSeq: row.lastSeenSeq ?? null,
        lastStopNotifiedSeq: row.lastStopNotifiedSeq ?? null,
        model: row.model ?? null,
        fallbackModel: row.fallbackModel ?? null,
        effort: row.effort ?? null,
      });
      streams.set(sessionId, stream);
    } else {
      console.warn(`[resume-debug] ${sessionId} reusing existing stream (stream.status=${stream.status}, db.status=${row.status}) @${Date.now()}`);
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
      console.warn(`[resume-debug] ${sessionId} resume_session RPC OK: ${JSON.stringify(rpcRes)} @${Date.now()}`);
      const agentStatus = (rpcRes as { status?: string } | undefined)?.status;
      if (agentStatus === 'active' || agentStatus === 'thinking' || agentStatus === 'starting') {
        resolvedStatus = agentStatus;
      }
    } catch (e: any) {
      const isNotFound = /not found/i.test(e?.message ?? '') || e?.code === -32000;
      console.warn(`[resume-debug] ${sessionId} resume_session RPC threw (isNotFound=${isNotFound}): ${e?.message ?? e} @${Date.now()}`);
      if (!isNotFound) throw e;
      // Recreate from scratch (the agent doesn't know this session). We
      // pass the persisted model/fallback/effort so the resumed SDK client
      // matches the original config — without this, a freshly restarted
      // agent would silently revert to SDK defaults for every session.
      try {
        await client.call('start_session', {
          session_id: sessionId,
          cwd: row.cwd,
          name: row.name,
          permission_mode: row.permissionMode,
          claude_session_id: row.claudeSessionId,
          model: row.model ?? null,
          fallback_model: row.fallbackModel ?? null,
          effort: row.effort ?? null,
        });
        console.warn(`[resume-debug] ${sessionId} fallback start_session OK @${Date.now()}`);
      } catch (startErr: any) {
        // If another concurrent call just created it (race between
        // two resume paths), the agent replies "already exists". In that
        // case we treat it as a success: the session is properly on the agent.
        const msg = startErr?.message ?? '';
        if (!/already exists/i.test(msg)) throw startErr;
        console.warn(`[resume-debug] ${sessionId} fallback start_session: already exists → treated as OK @${Date.now()}`);
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
    db.update(claudeSessions).set({ status: resolvedStatus })
      .where(eq(claudeSessions.id, sessionId)).run();
    console.warn(`[resume-debug] ${sessionId} resumeSession() returning (stream.status=${stream.status}, DB set to '${resolvedStatus}') @${Date.now()}`);
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
  db.update(claudeSessions).set({ status: 'sleeping' })
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

export async function forceStopSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  db.update(claudeSessions).set({ status: 'sleeping' })
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
