import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { getSetting } from '@/lib/server/hub/settings';
import {
  AgentClientStatus,
  AgentEvent,
  AgentHelloResult,
  AgentRpcError,
  AgentSessionInfo,
  AgentShellInfo,
  FsSearchProgressEvent,
} from './types';
// Shared SSH plumbing (options, remote python lookup, ControlMaster mux).
// Single source of truth with server.js's per-WS shell proxies — see the
// module header in sshShared.js.
import { buildAgentSshArgs } from './sshShared.js';
import { hubHooks } from './hubHooks';
import { compareVersions } from '@/lib/version';

// Progressive backoff on reconnection. Capped at 5min.
const RECONNECT_BACKOFFS_MS = [1_000, 3_000, 8_000, 20_000, 60_000, 120_000, 300_000];

// How many consecutive failed reconnects before we PERSIST agentStatus='error'.
// The SSH `--connect` proxy dropping is a TRANSPORT event — the agent daemon
// keeps running on its Unix socket and survives it. A transient drop (network
// blip, ServerAlive timeout, sshd restart) must NOT flip a healthy agent to
// 'error' (it would stick in the UI until the next SSR — there's no live push
// for agentStatus). We only flag 'error' once reconnection has genuinely failed
// this many times in a row (~1+3+8 ≈ 12s of being unreachable). 'missing' (pyz
// truly absent) is always persisted immediately. See §14 gotcha "agent in error".
const ERROR_PERSIST_AFTER_ATTEMPTS = 3;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
  /** When `timer` was (re)armed (Date.now()). */
  armedAt?: number;
  /** A `subscribe`: its session (the timer follows its replay window). */
  sessionId?: string;
  /** Runs SYNCHRONOUSLY when the answer line is parsed, before any later
   *  line of the same stdout chunk is dispatched (`resolve` only settles in a
   *  microtask, after the whole chunk). */
  onResult?: (result: any) => void;
  /** This request's own deadline; default RPC_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** First agent whose subscribe replay is back-pressured (A1): an older one
 *  queues a whole burst at once in its capped send queue. */
const BACKPRESSURED_REPLAY_VERSION = '0.103.0';

/** An RPC answer later than this is dropped (the call rejects). */
export const RPC_TIMEOUT_MS = 60_000;
/** A pending subscribe's timer is re-armed at most this often by its window. */
const SUBSCRIBE_REARM_MS = 1_000;

// ── Live agentStatus push (F1) ───────────────────────────────────────────────
// The browser used to learn `vps.agentStatus` only at SSR, so a status flip
// (agent unreachable / back up) stuck until F5. AgentClient is where the DB
// persists happen, so it is where the push must originate — but it cannot
// import the global SSE bus from sessionOps directly (import cycle:
// AgentClient ← AgentClientPool ← sessionOps). sessionOps injects the emitter
// at its module init instead.
export type VpsStatusExtra = {
  agentVersion?: string | null;
  agentPyzSha?: string | null;
  sdkVersion?: string | null;
  // Classified failure detail (schema.ts `vps.agentLastError`) — carried on
  // every emit so open tabs (DataModal health chips, wizard) can tell
  // ssh-down from daemon-down live. Explicit null on 'ok' = cleared.
  agentLastError?: string | null;
  // Codex availability (agent >= 0.15.0) — same no-clobber contract as
  // sdkVersion: key present only when the hello carried it.
  codexAvailable?: number | null;
  codexSdkVersion?: string | null;
  codexCliVersion?: string | null;
  // Cursor availability (§14.103) — same no-clobber contract again.
  cursorAvailable?: number | null;
  cursorSdkVersion?: string | null;
  cursorLoggedIn?: number | null;
  // Codex login flag — emitted by the codex/login route on a completed
  // device-code login (hello doesn't know it; the usage poll discovers it).
  codexLoggedIn?: number | null;
};
export type VpsStatusEmitter = (
  vpsId: string,
  agentStatus: 'ok' | 'missing' | 'error',
  extra?: VpsStatusExtra,
) => void;
// The slot lives in `hubHooks()` (§14.106): sessionOps wires it in whichever
// module copy loads it, and the boot (instrumentation) copy's clients — the
// ones that actually connect — must see it too.
export function setVpsStatusEmitter(fn: VpsStatusEmitter): void {
  hubHooks().vpsStatusEmitter = fn;
}
function emitVpsStatus(
  vpsId: string,
  agentStatus: 'ok' | 'missing' | 'error',
  extra?: VpsStatusExtra,
): void {
  try { hubHooks().vpsStatusEmitter?.(vpsId, agentStatus, extra); } catch {}
}

// ── Failure classification (feeds `vps.agentLastError`) ──────────────────────
// The ssh `--connect` child can die for very different reasons that the UI
// must tell apart: the VPS itself unreachable (network / host down), the SSH
// key refused, or SSH fine but the DAEMON dead (proxy exit 2 = socket absent,
// 3 = connect failed — see agent/charon_agent/client.py). OpenSSH exits 255
// for every client-level failure; remote-command exit codes pass through
// otherwise. Returns `null` for "missing" (SSH provably worked).
export function classifyAgentFailure(
  code: number | null,
  stderrTail: string,
  spawnError: string | null,
): { code: 'ssh-auth' | 'ssh-unreachable' | 'daemon-down' | 'error'; detail: string } {
  // Last meaningful stderr line (errors come last; skip the known noise).
  const line = stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning: Permanently added/i.test(l))
    .pop() ?? spawnError ?? '';
  const detail = line.slice(0, 160);
  if (code === 2 || code === 3) {
    // Exit codes of the pyz's own --connect proxy: the remote command RAN
    // (so SSH + python + pyz are all fine) but the daemon's socket is
    // absent (2) or refused (3) → the daemon is down.
    return { code: 'daemon-down', detail: detail || 'agent socket absent — daemon not running' };
  }
  const sshLevel = code === 255 || code === null; // 255 = OpenSSH client failure; null = spawn error/kill
  if (sshLevel) {
    if (/permission denied|authentication|host key verification|too many authentication|no matching|sign_and_send|publickey/i.test(line)) {
      return { code: 'ssh-auth', detail };
    }
    return { code: 'ssh-unreachable', detail: detail || 'ssh connection failed' };
  }
  return { code: 'error', detail: detail || `ssh exit ${code}` };
}

export type EventListener = (ev: AgentEvent) => void;

/**
 * Maintains a long-running SSH connection to a VPS, multiplexed as
 * line-delimited JSON-RPC with the charon-agent running there.
 *
 * - Auto-reconnect with backoff.
 * - Persistent subscriptions (auto re-subscribe after reconnect).
 * - Pending requests rejected on disconnect (the caller must retry).
 */
export class AgentClient {
  readonly vps: Vps;
  status: AgentClientStatus = 'idle';
  hello: AgentHelloResult | null = null;
  lastConnectError: string | null = null;
  // Last classification of the agent's reachability, mirroring the DB
  // `agentStatus` vocabulary ('ok' | 'missing' | 'error'). Updated on every
  // hello success and every SSH exit, even when we choose NOT to persist it
  // (transient-drop gating, see ERROR_PERSIST_AFTER_ATTEMPTS). The manual
  // "refresh agent" endpoint reads this for a definitive verdict.
  lastClassified: 'ok' | 'missing' | 'error' | null = null;
  // Companion detail for lastClassified='error', in the `vps.agentLastError`
  // format ('<code>: <stderr line>'). null for 'ok'/'missing'. Kept even when
  // the transient-drop gate skips the DB persist, so the refresh route can
  // persist a definitive verdict WITH its reason.
  lastErrorDetail: string | null = null;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextReqId = 1;
  private pending = new Map<number, Pending>();
  // session id → ids of its subscribe requests in flight. While that
  // session's replay window streams, their timer is re-armed (`_dispatchMessage`):
  // the answer follows the whole back-pressured burst (agent >= 0.103.0), and
  // a burst slower than RPC_TIMEOUT_MS to drain used to lose it — its
  // `gap`/`internal_gaps` (the `replay_gap` notice, never a silent loss) — and
  // released the reconnect chain onto the next session's burst mid-drain.
  private subscribesInFlight = new Map<string, Set<number>>();
  private readBuf = '';
  private stderrBuf = '';
  private subscribers = new Map<string, Set<EventListener>>();
  // The session_ids we've explicitly "subscribed" to, so we can
  // re-subscribe after a reconnect.
  private subscribed = new Set<string>();
  // Per-session checkpoint cursor for durable replay. Updated by
  // SessionStream via setAfterSeq(sid, seq) as events are persisted.
  // Looked up by _fireSubscribe on the next subscribe RPC (which is
  // typically issued by the resubscribe-after-reconnect path).
  // `null` means "no checkpoint yet — fall back to ring replay".
  // NOTE there is deliberately NO shell equivalent: the live shell data
  // path (shell_subscribe + output) belongs to server.js's per-WS proxies,
  // which always replay the durable-log tail from scratch. This client only
  // does the output-free lifecycle watch (watchShells below).
  private _pendingAfterSeq = new Map<string, number | null>();
  // Sessions whose replay window is OPEN on this connection: `replay_begin`
  // seen, `replay_end` not yet. The agent sends both markers in one burst, so
  // a window stays open only if the connection drops in the middle of it. The
  // stream would then stay `isReplaying` forever (pushes suppressed, frames
  // tagged replay), because a later empty subscribe sends NO markers at all.
  // We close such windows ourselves with a synthetic `replay_end` (§14.31).
  // Value = the window's number (`replayWindowSeq`), so a subscribe answer
  // can tell the window it was SENT into from one opened since.
  private replayOpen = new Map<string, number>();
  // Sessions whose seq-epoch reset was already dispatched on THIS connection
  // (`_fireSubscribe`): at most once each; cleared on every (re)connect.
  private epochResetFired = new Set<string>();
  private replayWindowSeq = 0;
  // Generation of the reconnect re-subscribe chain (`_resubscribeAll`).
  private resubscribeChain = 0;
  // While a (re)connect's chain runs: the sessions it still has to subscribe.
  // Set BEFORE the status turns 'connected': the status listeners (the
  // connected hook's reconcile) subscribe synchronously, and those subscribes
  // join this queue instead of firing in parallel with it (and the chain then
  // repeating the first one). null once the chain is done or the connection
  // is gone.
  private chainPending: Set<string> | null = null;
  // Per CONNECTION: the sessions whose subscribe RPC went out ('inflight') or
  // was answered ('ok'). The agent keeps a client's subscription until an
  // unsubscribe or the connection ends, so a cursor-less `resubscribe` of
  // such a session would only replay a range its first burst already
  // delivered. `resubscribeIfFailed`: those asked again while in flight —
  // re-fired only if that subscribe fails (sent before the session existed).
  private subscribeState = new Map<string, 'inflight' | 'ok'>();
  private resubscribeIfFailed = new Set<string>();
  // Global shell LIFECYCLE watchers (agent >= 0.8.0). Distinct from the
  // per-shell output `subscribers` above: a watcher receives shell_status /
  // shell_exit / shell_idle for ALL shells on this VPS WITHOUT the
  // high-volume shell_output byte stream. This is what backs the idle
  // "shell finished something" push/telegram notification — Charon's
  // persistent AgentClient pool registers ONE watcher per VPS and never
  // subscribes to output (avoids the double-egress that got a VPS suspended,
  // see §14 gotcha 41). Re-asserted via the `shell_watch` RPC on every
  // (re)connect when non-empty.
  private shellWatchListeners = new Set<EventListener>();
  /** Streamed searches in flight, by the hub-chosen search id (§14.84). */
  private searchListeners = new Map<string, (ev: FsSearchProgressEvent) => void>();
  // Snapshot listeners for the `shell_watch` RPC result: the agent returns
  // the list of LIVE shells when the watch is (re)armed — i.e. on every
  // (re)connect. shellNotify uses it to prune DB rows for shells the agent
  // no longer knows (VPS reboot, bash exited while Charon was away), which
  // is what stops a browser from reconnect-looping on a phantom shell.
  private shellSnapshotListeners = new Set<(shells: AgentShellInfo[]) => void>();
  private statusListeners = new Set<(s: AgentClientStatus) => void>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private aborted = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  constructor(vps: Vps, private readonly connectAfter?: Promise<void>) {
    this.vps = vps;
  }

  // ── Public API ───────────────────────────────────────────────────────────
  ready(): Promise<void> {
    if (this.status === 'connected') return Promise.resolve();
    if (this.aborted) return Promise.reject(new Error('client closed'));
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }
    if (this.status === 'idle') {
      // Start the connection in the background
      this.start().catch(() => {});
    }
    return this.readyPromise;
  }

  async call<T = any>(method: string, params: Record<string, any> = {},
                     opts?: { onResult?: (result: T) => void; timeoutMs?: number }): Promise<T> {
    if (this.aborted) throw new Error('client closed');
    if (this.status !== 'connected') {
      // Try to establish the connection if we never tried
      if (this.status === 'idle') this.start().catch(() => {});
      // Wait until connected (with 30s timeout)
      await Promise.race([
        this.ready(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`agent ${this.vps.name}: not connected (status=${this.status})`)), 30_000)
        ),
      ]);
    }
    let onResult = opts?.onResult;
    if (method === 'kill_session' && typeof params.session_id === 'string') {
      // The agent drops its subscriber set with the session (and its log):
      // forget ours, so the next resubscribe (a resume's) really goes out —
      // with the stored cursor, whose answer detects the seq-epoch reset.
      const sid = params.session_id;
      const user = onResult;
      onResult = (r: T) => { this.forgetAgentSubscription(sid); user?.(r); };
    }
    return this._writeRequest<T>(method, params, onResult, opts?.timeoutMs);
  }

  /** The agent no longer holds a subscription for this session (killed):
   *  clear the hub-side "subscribed on this connection" state, keeping the
   *  listeners and the durable cursor (`_pendingAfterSeq`). */
  forgetAgentSubscription(sessionId: string): void {
    this.subscribed.delete(sessionId);
    this.subscribeState.delete(sessionId);
    this.resubscribeIfFailed.delete(sessionId);
    this.chainPending?.delete(sessionId);
  }

  /** The connected agent back-pressures subscribe replays (>= 0.103.0): a
   *  whole-log burst cannot overflow its send queue. Unknown ⇒ false. */
  backpressuresReplay(): boolean {
    const v = this.hello?.agent_version;
    return !!v && compareVersions(v, BACKPRESSURED_REPLAY_VERSION) >= 0;
  }

  /** Write without status gate — internal use only (start/hello). */
  private _writeRequest<T = any>(method: string, params: Record<string, any> = {},
                                 onResult?: (result: T) => void, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextReqId++;
      const pending: Pending = { resolve, reject, method, onResult, timeoutMs };
      if (method === 'subscribe' && typeof params.session_id === 'string') {
        pending.sessionId = params.session_id;
        let ids = this.subscribesInFlight.get(params.session_id);
        if (!ids) this.subscribesInFlight.set(params.session_id, ids = new Set());
        ids.add(id);
      }
      this._armTimeout(id, pending);
      this.pending.set(id, pending);
      const line = JSON.stringify({ id, method, params }) + '\n';
      try {
        if (!this.child) throw new Error('no child process');
        this.child.stdin.write(line);
      } catch (e: any) {
        this._settled(id, pending);
        reject(new Error(`agent ${this.vps.name}: write failed: ${e?.message ?? e}`));
      }
    });
  }

  /** (Re)arm a request's timeout: its own deadline (default RPC_TIMEOUT_MS) from now. */
  private _armTimeout(id: number, pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.armedAt = Date.now();
    pending.timer = setTimeout(() => {
      this._settled(id, pending);
      pending.reject(new Error(`agent ${this.vps.name}: timeout on ${pending.method}`));
    }, pending.timeoutMs ?? RPC_TIMEOUT_MS);
  }

  /** The request left `pending` (answered, timed out, failed to write). */
  private _settled(id: number, pending: Pending): void {
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.sessionId == null) return;
    const ids = this.subscribesInFlight.get(pending.sessionId);
    ids?.delete(id);
    if (ids && !ids.size) this.subscribesInFlight.delete(pending.sessionId);
  }

  /**
   * Subscribe to a session's events. Idempotent — multiple listeners can
   * coexist for the same session (we deliver the same agent event to
   * each).
   *
   * `opts.afterSeq` (optional, agent >= 0.4.0): durable replay. The agent
   * will return ALL events with seq > afterSeq from its persistent event
   * log, regardless of what's in its in-memory ring. Use this on
   * resubscribe-after-restart to catch up cleanly. If omitted (or against
   * an older agent), the agent falls back to a ring-tail replay of size
   * `replay`.
   */
  subscribe(sessionId: string, listener: EventListener, opts?: { afterSeq?: number }): void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(listener);
    // If not yet subscribed on the agent side, do it
    if (!this.subscribed.has(sessionId)) {
      this.subscribed.add(sessionId);
      if (this.status === 'connected' && this.chainPending && this._hasCursor(sessionId, opts)) {
        // A fresh connection's chain owns every subscribe with a durable
        // cursor: queued, ONE at a time, with the cursor read when it fires.
        // A CURSOR-LESS one (a session created meanwhile) fires at once: the
        // agent forwards nothing until it is subscribed, and a late ring-tail
        // `replay: 300` would silently lose everything older (G2).
        if (typeof opts?.afterSeq === 'number') this._pendingAfterSeq.set(sessionId, opts.afterSeq);
        this.chainPending.add(sessionId);
      } else if (this.status === 'connected') {
        this._fireSubscribe(sessionId, opts);
      } else {
        // Save the desired afterSeq until we can issue the RPC. Re-used
        // by _onConnected when the connection settles.
        this._pendingAfterSeq.set(sessionId, opts?.afterSeq ?? null);
      }
    }
  }

  /** Retry the subscribe RPC on the agent side. Useful when a previous
   *  subscribe failed (typically: SSE opened before the session existed
   *  on the agent, then resume creates the session — the attach is not
   *  redone because it's idempotent, but the agent subscribe remains
   *  missing). */
  resubscribe(sessionId: string, opts?: { afterSeq?: number }): void {
    if (!this.subscribers.has(sessionId)) return;  // no listener → nothing to do
    if (this.status === 'connected' && typeof opts?.afterSeq !== 'number' && this.subscribed.has(sessionId)) {
      // Already subscribed on THIS connection (answered), or going out: a
      // second cursor-less subscribe would re-deliver the first one's whole
      // window over live events (an overlapping burst, §14.31).
      const state = this.subscribeState.get(sessionId);
      if (state === 'ok') return;
      if (state === 'inflight') { this.resubscribeIfFailed.add(sessionId); return; }
    }
    this.subscribed.add(sessionId);
    if (this.status === 'connected' && this.chainPending && this._hasCursor(sessionId, opts)) {
      // The running chain subscribes it from its stored cursor (a no-op when
      // it is still queued); an explicit cursor BECOMES the stored one, so
      // the chain sends exactly that range, once, in turn — never a burst in
      // parallel with the chain's (the seq-epoch reset's replay from 0).
      // Without a cursor it fires at once (see subscribe()).
      if (typeof opts?.afterSeq === 'number') this._pendingAfterSeq.set(sessionId, opts.afterSeq);
      this.chainPending.add(sessionId);
    } else if (this.status === 'connected') {
      this._fireSubscribe(sessionId, opts);
    } else {
      // Never ERASE a known cursor: a cursor-less resubscribe while
      // disconnected used to store null, and the next connect fell back to
      // `replay: 300` — a ring tail that can start below `last_seen_seq`.
      this._pendingAfterSeq.set(sessionId, opts?.afterSeq ?? this._pendingAfterSeq.get(sessionId) ?? null);
    }
  }

  /** A durable cursor is known for this subscribe (explicit or stored). */
  private _hasCursor(sessionId: string, opts?: { afterSeq?: number }): boolean {
    return typeof opts?.afterSeq === 'number' || typeof this._pendingAfterSeq.get(sessionId) === 'number';
  }

  /** Called from _onConnected to update the cursor for the next
   *  reconnect-driven subscribe. The SessionStream calls this on every
   *  event with a seq, but we throttle the syscall: only the latest
   *  value matters when we actually re-issue the RPC. */
  setAfterSeq(sessionId: string, afterSeq: number | null): void {
    this._pendingAfterSeq.set(sessionId, afterSeq);
  }

  /** Re-subscribe every session after a (re)connect, ONE AT A TIME. An agent
   *  < 0.103.0 queues a whole replay burst synchronously in its per-client
   *  send queue (10 000 events / 32 MiB); several sessions subscribed back to
   *  back add up there, and past the cap it drops the connection before
   *  writing a line — the unchanged cursors then repeat it on every reconnect
   *  (one session's burst past the cap alone still does, on those agents). A
   *  newer agent back-pressures each burst, and parked bursts share its room:
   *  stacking them only slows each down. Each subscribe answer follows its
   *  own burst, so the next request waits for it — however long the burst
   *  takes, as long as its window streams (`subscribesInFlight`). A later
   *  (re)connect or a close supersedes the chain. The queue (`chainPending`)
   *  also takes every subscribe issued while it runs — the connected hook's
   *  reconcile attaches every agent-known stream from inside the status
   *  change — so each session goes out once, in turn, with its cursor read
   *  when it fires. */
  private async _resubscribeAll(): Promise<void> {
    const chain = ++this.resubscribeChain;
    const child = this.child;
    const queue = this.chainPending ??= new Set(this.subscribed);
    while (queue.size) {
      if (chain !== this.resubscribeChain || this.child !== child || this.status !== 'connected') return;
      const sid = queue.values().next().value as string;
      queue.delete(sid);
      if (!this.subscribed.has(sid)) continue;
      await this._fireSubscribe(sid);
    }
    if (this.chainPending === queue) this.chainPending = null;
  }

  /** Issue the subscribe RPC. The promise settles (never rejects) once its
   *  answer has been handled. */
  private _fireSubscribe(sessionId: string, opts?: { afterSeq?: number }): Promise<void> {
    // Prefer the explicit opts, else fall back to the cached cursor
    // (updated by SessionStream as events are persisted).
    const afterSeq = opts?.afterSeq ?? this._pendingAfterSeq.get(sessionId) ?? null;
    // Remember an explicit cursor: a subscribe fired while CONNECTED never
    // went through _pendingAfterSeq, so the next reconnect fell back to
    // `replay:300` — a ring tail that can exceed the agent's 32MiB send
    // queue and get dropped on every reconnect, forever.
    if (typeof opts?.afterSeq === 'number') this._pendingAfterSeq.set(sessionId, opts.afterSeq);
    const params: Record<string, unknown> = { session_id: sessionId };
    if (typeof afterSeq === 'number') {
      params.after_seq = afterSeq;
    } else {
      // Backward compat with agents <0.4.0: tail of the ring.
      params.replay = 300;
    }
    // The window open when this request goes out, if any. The agent writes
    // each replay burst (begin..end) in one go on one FIFO, so the end of a
    // burst already begun precedes our answer: if that SAME window is still
    // open when the answer settles, its `replay_end` was lost.
    const windowAtSend = this.replayOpen.get(sessionId);
    const child = this.child;
    this.subscribeState.set(sessionId, 'inflight');
    type SubscribeAnswer = { ok?: boolean; replay_count?: number; status?: string;
                current_seq?: number; earliest_seq?: number | null; gap?: boolean;
                internal_gaps?: [number, number][] };
    // Seq-epoch reset: the log is READABLE (an unreadable one answers
    // `current_seq: 0, earliest_seq: null` — not a reset) and ends BELOW our
    // cursor ⇒ it was recreated and its seqs restarted at 1. Once per session
    // per connection; the stream replays it from 0 (§14.31). Dispatched
    // SYNCHRONOUSLY with the answer line (`onResult`): the agent releases the
    // live events it held behind this answer right after it, often in the
    // same stdout chunk, and those new-epoch deltas must not reach the
    // stream's old-epoch buffer first.
    let resetChecked = false;
    const checkEpochReset = (res: SubscribeAnswer | undefined) => {
      if (resetChecked) return;
      resetChecked = true;
      if (typeof afterSeq === 'number' && typeof res?.current_seq === 'number' && res.current_seq > 0
          && typeof res.earliest_seq === 'number' && res.current_seq < afterSeq
          && !this.epochResetFired.has(sessionId)) {
        this.epochResetFired.add(sessionId);
        console.warn(`[agent ${this.vps.name}] ${sessionId}: event log recreated (current_seq ${res.current_seq} < after_seq ${afterSeq})`);
        const subs3 = this.subscribers.get(sessionId);
        if (subs3) {
          const resetEv = {
            event: 'seq_epoch_reset', session_id: sessionId,
            after_seq: afterSeq, current_seq: res.current_seq,
          } as AgentEvent;
          for (const cb of [...subs3]) { try { cb(resetEv); } catch {} }
        }
      }
    };
    return this.call<SubscribeAnswer>('subscribe', params, { onResult: checkEpochReset })
      .then((res) => {
        if (this.child === child && this.subscribed.has(sessionId)) {
          this.subscribeState.set(sessionId, 'ok');
          this.resubscribeIfFailed.delete(sessionId);
        }
        // The agent sends replay markers only when the replay has items: an
        // EMPTY answer never ends a window by itself. Close a stale one, or
        // the stream stays `isReplaying` for good — but ONLY the window this
        // request was sent into. This runs in a microtask, after the whole
        // stdout chunk was dispatched: a `replay_begin` of a LATER subscribe
        // in the same chunk opens a live window that must stay open.
        if (res?.replay_count === 0 && windowAtSend !== undefined
            && this.replayOpen.get(sessionId) === windowAtSend) {
          this._closeReplayWindow(sessionId);
        }
        // Non-rotation log holes (corrupt lines / failed appends — agent
        // >= 0.20.0, complete leading/internal/trailing since 0.21.0):
        // surfaced through the SAME replay_gap path as rotation gaps (log +
        // persisted event row + UI banner), one synthetic event per range
        // (capped — a shredded log shouldn't flood the transcript).
        if (res?.internal_gaps?.length) {
          console.warn(`[agent ${this.vps.name}] ${sessionId}: event-log holes ${JSON.stringify(res.internal_gaps)}`);
          const subs2 = this.subscribers.get(sessionId);
          if (subs2) {
            for (const [from, to] of res.internal_gaps.slice(0, 3)) {
              const holeEv = {
                event: 'replay_gap', session_id: sessionId,
                after_seq: from - 1, earliest_seq: to + 1,
              } as AgentEvent;
              for (const cb of subs2) { try { cb(holeEv); } catch {} }
            }
          }
        }
        // Rotation-gap detection (agent >= 0.18.0, P0.4): the agent tells us
        // its earliest retained seq; if our cursor predates it, the events in
        // between were rotated away and can NEVER be replayed. Surface it as
        // a synthetic event so sessionOps can log/persist/warn — the RPC
        // response arrives AFTER the replay stream, so this lands post-
        // replay_end. Older agents omit `gap` → nothing fires.
        if (res?.gap && typeof afterSeq === 'number' && typeof res.earliest_seq === 'number') {
          const subs = this.subscribers.get(sessionId);
          if (subs) {
            const gapEv = {
              event: 'replay_gap', session_id: sessionId,
              after_seq: afterSeq, earliest_seq: res.earliest_seq,
            } as AgentEvent;
            for (const cb of subs) { try { cb(gapEv); } catch {} }
          }
        }
        // Normally already ran with the answer line (no-op then).
        checkEpochReset(res);
      })
      .catch((e) => {
        if (this.child === child) this.subscribeState.delete(sessionId);
        const retry = this.resubscribeIfFailed.delete(sessionId);
        // If subscribe fails (typically session_not_found), remove from
        // `subscribed` so a future subscribe will retry spontaneously.
        if (/not found/i.test(e?.message ?? '') || e?.code === -32000) {
          this.subscribed.delete(sessionId);
        }
        console.warn(`[agent ${this.vps.name}] subscribe failed: ${e?.message ?? e}`);
        // A resubscribe asked while this one was in flight (the session was
        // just created by a resume): issue it now.
        if (retry && this.child === child && this.status === 'connected') this.resubscribe(sessionId);
      });
  }

  /** Dispatch a synthetic `replay_end` for one open replay window. */
  private _closeReplayWindow(sessionId: string): void {
    this.replayOpen.delete(sessionId);
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;
    const ev = { event: 'replay_end', session_id: sessionId, synthetic: true } as AgentEvent;
    for (const cb of [...subs]) { try { cb(ev); } catch {} }
  }

  /** The connection is gone: no `replay_end` can arrive for any window it
   *  left open. Close them all (§14.31). */
  private _closeAllReplayWindows(): void {
    for (const sid of [...this.replayOpen.keys()]) this._closeReplayWindow(sid);
    this.replayOpen.clear();
  }

  /** Receive a streamed search's hits (`fs_search` with `stream_id`). Returns
   *  the detach. Nothing is subscribed agent-side: the events go to this
   *  connection because it is the one that asked. */
  onSearchProgress(searchId: string, listener: (ev: FsSearchProgressEvent) => void): () => void {
    this.searchListeners.set(searchId, listener);
    return () => {
      if (this.searchListeners.get(searchId) === listener) this.searchListeners.delete(searchId);
    };
  }

  unsubscribe(sessionId: string, listener: EventListener): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.subscribers.delete(sessionId);
      this.subscribed.delete(sessionId);
      this.subscribeState.delete(sessionId);
      this.resubscribeIfFailed.delete(sessionId);
      if (this.status === 'connected') {
        this.call('unsubscribe', { session_id: sessionId }).catch(() => {});
      }
    }
  }

  // ── Global shell lifecycle watch (agent >= 0.8.0) ─────────────────────────
  // (The old per-shell `subscribeShell`/`setShellAfterSeq` plumbing was dead
  // code — the live shell data path lives in server.js's per-WS proxies —
  // and was removed together with the vestigial `shells.last_seen_seq`
  // column, migration 0016.)
  /**
   * Register a listener for shell LIFECYCLE events (shell_status / shell_exit
   * / shell_idle) across ALL shells on this VPS, without subscribing to the
   * high-volume shell_output byte stream. Returns an unwatch function.
   *
   * Idempotent at the RPC level: the first listener fires `shell_watch`; the
   * RPC is also re-fired automatically on every (re)connect while at least
   * one listener remains. Against an agent < 0.8.0 the RPC fails with
   * method-not-found (-32601) — we swallow it so a mixed fleet degrades
   * gracefully (no idle notifications from old agents, everything else works).
   */
  watchShells(listener: EventListener): () => void {
    this.shellWatchListeners.add(listener);
    // Fire the RPC the first time we have a watcher and we're connected.
    // (On reconnect the hello path re-fires it for the whole set.)
    if (this.status === 'connected') {
      this._fireShellWatch();
    }
    return () => this.unwatchShells(listener);
  }

  unwatchShells(listener: EventListener): void {
    if (!this.shellWatchListeners.delete(listener)) return;
    if (this.shellWatchListeners.size === 0 && this.status === 'connected') {
      this.call('shell_unwatch', {}).catch(() => {});
    }
  }

  /** Listen for the live-shells snapshot returned by every (re)armed
   *  `shell_watch` RPC — i.e. on every (re)connect. Used to reconcile the
   *  `shells` DB rows against the agent's reality without an extra
   *  `shell_list` round-trip. Returns an unsubscribe function. */
  onShellSnapshot(cb: (shells: AgentShellInfo[]) => void): () => void {
    this.shellSnapshotListeners.add(cb);
    return () => this.shellSnapshotListeners.delete(cb);
  }

  private _fireShellWatch(): void {
    this.call<{ ok: boolean; shells?: AgentShellInfo[] }>('shell_watch', {})
      .then((res) => {
        const shells = Array.isArray(res?.shells) ? res.shells : [];
        for (const cb of this.shellSnapshotListeners) {
          try { cb(shells); } catch {}
        }
      })
      .catch((e) => {
        // Old agent (< 0.8.0) → method not found. Don't spam: log once at debug
        // level. The watcher stays registered so a later agent upgrade + reconnect
        // re-fires the RPC and starts delivering idle events.
        if (e?.code !== -32601) {
          console.warn(`[agent ${this.vps.name}] shell_watch failed: ${e?.message ?? e}`);
        }
      });
  }

  onStatus(cb: (s: AgentClientStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  async close(): Promise<void> {
    this.aborted = true;
    this.readyReject?.(new Error('client closed'));
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._setStatus('closed');
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.child = null;
    this.chainPending = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('client closed'));
    }
    this.pending.clear();
    this.subscribesInFlight.clear();
    this.subscribeState.clear();
    this.resubscribeIfFailed.clear();
    // A pool drop (agent update/refresh) is a disconnect too: the streams move
    // to a fresh client, which may answer with an empty replay (no markers).
    this._closeAllReplayWindows();
  }

  // ── Internals ────────────────────────────────────────────────────────────
  private _setStatus(s: AgentClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of this.statusListeners) {
      try { cb(s); } catch {}
    }
  }

  private async start(): Promise<void> {
    if (this.child) return;
    if (this.aborted) return;
    this._setStatus('connecting');
    // An update owns the transport until the replacement daemon has been
    // pinged. Polls may recreate a pooled client meanwhile; keep it parked.
    if (this.connectAfter) await this.connectAfter;
    if (this.aborted || this.child) return;
    this.readBuf = '';
    this.stderrBuf = '';

    const keyPath = getSetting('ssh.private_key_path');
    const args = buildAgentSshArgs(this.vps, { keyPath });

    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout.on('data', (b) => this._onStdout(b));
    child.stderr.on('data', (b) => {
      const s = b.toString();
      this.stderrBuf += s;
      if (this.stderrBuf.length > 64_000) {
        this.stderrBuf = this.stderrBuf.slice(-32_000);
      }
    });
    child.on('error', (e) => {
      this.lastConnectError = e.message;
      this._handleExit(null);
    });
    child.on('close', (code) => this._handleExit(code));

    // Send the hello (goes through _writeRequest to avoid a deadlock:
    // call() would await ready() which is ONLY resolved by this hello reply).
    this._writeRequest<AgentHelloResult>('hello', { client: 'charon' })
      .then((hello) => {
        this.hello = hello;
        this.reconnectAttempts = 0;
        this.lastConnectError = null;
        this.lastClassified = 'ok';
        this.lastErrorDetail = null;
        // The chain's queue exists BEFORE the status listeners run: their
        // subscribes (the connected hook's reconcile) join it (_resubscribeAll).
        this.chainPending = new Set(this.subscribed);
        this.subscribeState.clear();
        this.resubscribeIfFailed.clear();
        this.epochResetFired.clear();
        this._setStatus('connected');
        // Persist the ping side-effect: timestamp + version.
        // sdk_version: ONLY when the hello carries the key — an old agent
        // (<0.12.0) must not null-clobber a value persisted by the update
        // flow (ensureSdkLatest) or a previous new-agent hello.
        try {
          db.update(vpsTable).set({
            agentStatus: 'ok',
            agentLastError: null,
            agentVersion: hello.agent_version,
            agentPyzSha: hello.agent_pyz_sha ?? null,
            agentLastSeenAt: Math.floor(Date.now() / 1000),
            ...(hello.sdk_version !== undefined ? { sdkVersion: hello.sdk_version } : {}),
            // Codex availability (agent >= 0.15.0). Persist ONLY when the hello
            // carries the field — an old agent (< 0.15.0) omits codex_* and must
            // NOT null-clobber values written by a previous new-agent hello /
            // update flow (§14.53 no-null-clobber rule, mirrors sdk_version).
            // The DB column is a 1/0/null integer; codex_available is a boolean.
            ...(hello.codex_available !== undefined ? { codexAvailable: hello.codex_available ? 1 : 0 } : {}),
            ...(hello.codex_sdk_version !== undefined ? { codexSdkVersion: hello.codex_sdk_version } : {}),
            ...(hello.codex_cli_version !== undefined ? { codexCliVersion: hello.codex_cli_version } : {}),
            // Cursor availability (§14.103) — same rule: an agent predating the
            // probe omits cursor_* and must not blank what a newer one wrote.
            ...(hello.cursor_available !== undefined ? { cursorAvailable: hello.cursor_available ? 1 : 0 } : {}),
            ...(hello.cursor_sdk_version !== undefined ? { cursorSdkVersion: hello.cursor_sdk_version } : {}),
          }).where(eq(vpsTable.id, this.vps.id)).run();
        } catch {}
        // Live push so open tabs flip the sidebar badge without an F5
        // (mirrors the DB persist above — keep the two in lockstep).
        emitVpsStatus(this.vps.id, 'ok', {
          agentVersion: hello.agent_version,
          agentPyzSha: hello.agent_pyz_sha ?? null,
          agentLastError: null,
          ...(hello.sdk_version !== undefined ? { sdkVersion: hello.sdk_version } : {}),
          // Codex availability — mirror the DB persist above (no-clobber:
          // key present only when the hello carries it, §14.53).
          ...(hello.codex_available !== undefined ? { codexAvailable: hello.codex_available ? 1 : 0 } : {}),
          ...(hello.codex_sdk_version !== undefined ? { codexSdkVersion: hello.codex_sdk_version } : {}),
          ...(hello.codex_cli_version !== undefined ? { codexCliVersion: hello.codex_cli_version } : {}),
          ...(hello.cursor_available !== undefined ? { cursorAvailable: hello.cursor_available ? 1 : 0 } : {}),
          ...(hello.cursor_sdk_version !== undefined ? { cursorSdkVersion: hello.cursor_sdk_version } : {}),
        });
        // Re-subscribe to everything. This is the critical path for
        // "Charon was down, agent kept emitting events" — we want the
        // agent to replay from the durable log, NOT from the in-memory
        // ring (which may have rotated). _fireSubscribe consults
        // _pendingAfterSeq to choose between after_seq (durable) and
        // replay (ring tail, backward compat for old agents). One at a
        // time (see _resubscribeAll).
        void this._resubscribeAll();
        // Re-assert the global shell lifecycle watch (idle notifications).
        // Cheap, output-free; safe to re-fire on every reconnect.
        if (this.shellWatchListeners.size > 0) {
          this._fireShellWatch();
        }
        // Resolve readys
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
          this.readyPromise = null;
        }
      })
      .catch((e) => {
        this.lastConnectError = `hello failed: ${e?.message ?? e}`;
        // _handleExit will take over (child will close)
      });
  }

  private _onStdout(b: Buffer): void {
    this.readBuf += b.toString();
    let nl: number;
    while ((nl = this.readBuf.indexOf('\n')) >= 0) {
      const line = this.readBuf.slice(0, nl).trim();
      this.readBuf = this.readBuf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (e: any) {
        console.warn(`[agent ${this.vps.name}] bad json: ${line.slice(0, 200)}`);
        continue;
      }
      this._dispatchMessage(msg);
    }
  }

  private _dispatchMessage(msg: any): void {
    if (this.aborted) return; // late stdout from a client dropped for an update
    // Response (id + result/error)
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // late
      this._settled(msg.id, pending);
      if (msg.error) {
        pending.reject(new AgentRpcError(msg.error.code ?? -1, msg.error.message ?? 'rpc error'));
      } else {
        try { pending.onResult?.(msg.result); } catch {}
        pending.resolve(msg.result);
      }
      return;
    }
    // A streamed search's hits: to the route that asked, never to a session.
    if (msg.event === 'fs_search_progress') {
      if (typeof msg.search_id === 'string') {
        try { this.searchListeners.get(msg.search_id)?.(msg as FsSearchProgressEvent); } catch {}
      }
      return;
    }
    // Event (no id) — dispatch to the session's subscribers
    if (typeof msg.event === 'string') {
      const sid = msg.session_id;
      if (typeof sid !== 'string') return;
      // Global shell lifecycle watchers (agent >= 0.8.0): the agent fans
      // shell_status / shell_exit / shell_idle out to BOTH the per-shell
      // output subscribers AND the global watch set. Deliver them to our
      // watch listeners regardless of whether this client also holds a
      // per-shell subscription — the persistent pool client typically does
      // NOT subscribe to shell output (that happens in server.js's per-WS
      // proxies), it only watches lifecycle for idle notifications.
      const evName = msg.event as string;
      if (evName === 'replay_begin') this.replayOpen.set(sid, ++this.replayWindowSeq);
      // A replay window of this session is streaming: its subscribe (or one
      // queued behind it on the agent's per-session lock) is making progress.
      if (this.subscribesInFlight.has(sid) && (this.replayOpen.has(sid) || evName === 'replay_end')) {
        const now = Date.now();
        for (const id of this.subscribesInFlight.get(sid)!) {
          const p = this.pending.get(id);
          if (p && now - (p.armedAt ?? 0) >= SUBSCRIBE_REARM_MS) this._armTimeout(id, p);
        }
      }
      if (evName === 'replay_end') this.replayOpen.delete(sid);
      // A LIVE `killed` status: the agent popped this session's subscribers.
      if (evName === 'status' && msg.status === 'killed' && !this.replayOpen.has(sid)) {
        this.forgetAgentSubscription(sid);
      }
      if (
        this.shellWatchListeners.size > 0 &&
        (evName === 'shell_status' || evName === 'shell_exit' || evName === 'shell_idle')
      ) {
        for (const cb of this.shellWatchListeners) {
          try { cb(msg as AgentEvent); } catch {}
        }
      }
      const subs = this.subscribers.get(sid);
      if (!subs) return;
      for (const cb of subs) {
        try { cb(msg as AgentEvent); } catch {}
      }
    }
  }

  private _handleExit(code: number | null): void {
    if (this.aborted) return;
    const tail = this.stderrBuf.slice(-800).trim();
    const reason = `ssh exit code=${code ?? '?'}${this.lastConnectError ? ` | ${this.lastConnectError}` : ''}${tail ? ` | stderr: ${tail}` : ''}`;
    this.child = null;
    // The next connection builds its own queue from `subscribed`.
    this.chainPending = null;

    // Reject all pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`agent ${this.vps.name}: connection lost (${reason.slice(0, 300)})`));
    }
    this.pending.clear();
    this.subscribesInFlight.clear();
    this.subscribeState.clear();
    this.resubscribeIfFailed.clear();
    // Replay windows cut by the drop never get their `replay_end`.
    this._closeAllReplayWindows();

    // Classify the exit and tag the DB. 'missing' (pyz absent) is definitive
    // and persisted immediately. 'error' is only persisted once we've failed
    // to reconnect ERROR_PERSIST_AFTER_ATTEMPTS times in a row — a transient
    // SSH transport drop must not flip a healthy agent to 'error' (see the
    // const comment above). We always record the in-memory classification so
    // the manual "refresh agent" endpoint can give a definitive verdict.
    // The classified detail (ssh-auth / ssh-unreachable / daemon-down / error)
    // is persisted alongside as `agentLastError` so the UI can say WHY —
    // "VPS unreachable" vs "agent daemon stopped" (health chips, §11).
    // ⚠ Both "pyz absent" AND "--connect exit 2 (daemon socket absent)" print
    // a *not found* line and can exit 2 (python can't-open vs proxy verdict):
    //   pyz missing : "python3.12: can't open file '….pyz': No such file…"
    //   daemon down : "charon-agent: socket …agent.sock not found (daemon not started?)"
    // The old regex conflated them → a merely-stopped daemon showed as "agent
    // not installed". Disambiguate on the proxy's own message first.
    const isSocketAbsent = (code === 2 || code === 3)
      && /daemon not started|socket .*not found|charon-agent: connect failed/i.test(tail);
    const isMissing = !isSocketAbsent
      && (/No such file|introuvable|not found/i.test(tail) || code === 127);
    this.lastClassified = isMissing ? 'missing' : 'error';
    if (isMissing) {
      this.lastErrorDetail = null; // SSH provably worked — not an error detail
    } else {
      const cls = classifyAgentFailure(code, tail, this.lastConnectError);
      this.lastErrorDetail = cls.detail ? `${cls.code}: ${cls.detail}` : cls.code;
    }
    try {
      const shouldPersist = isMissing || this.reconnectAttempts >= ERROR_PERSIST_AFTER_ATTEMPTS;
      // An agent that stays down re-fails every backoff step with the SAME
      // verdict: rewriting it re-published an identical `vps_status` to every
      // tab each time, and each one re-rendered the hub. No change, no write,
      // no frame (§14.52: it is the WRITE that owes the frame).
      const [stored] = shouldPersist
        ? db.select({ agentStatus: vpsTable.agentStatus, agentLastError: vpsTable.agentLastError })
          .from(vpsTable).where(eq(vpsTable.id, this.vps.id)).all()
        : [];
      const changed = !stored || stored.agentStatus !== this.lastClassified
        || (stored.agentLastError ?? null) !== this.lastErrorDetail;
      if (shouldPersist && changed) {
        db.update(vpsTable).set({
          agentStatus: this.lastClassified,
          agentLastError: this.lastErrorDetail,
        }).where(eq(vpsTable.id, this.vps.id)).run();
        // Live push (same gating as the persist: transient drops stay silent).
        emitVpsStatus(this.vps.id, this.lastClassified, { agentLastError: this.lastErrorDetail });
      }
    } catch {}

    // If we hadn't resolved ready yet (first connect), reject.
    if (this.readyReject) {
      this.readyReject(new Error(reason));
      this.readyResolve = null;
      this.readyReject = null;
      this.readyPromise = null;
    }

    // Schedule reconnect
    this._scheduleReconnect(reason);
  }

  private _scheduleReconnect(reason: string): void {
    if (this.aborted) return;
    this.reconnectAttempts++;
    const delay = RECONNECT_BACKOFFS_MS[Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFFS_MS.length - 1)];
    this._setStatus('reconnecting');
    console.warn(`[agent ${this.vps.name}] reconnect attempt ${this.reconnectAttempts} in ${delay}ms — ${reason.slice(0, 200)}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.aborted) return;
      this.start();
    }, delay);
  }
}
