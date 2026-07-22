import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { getSetting } from '@/lib/server/claude/settings';
import {
  AgentClientStatus,
  AgentEvent,
  AgentHelloResult,
  AgentRpcError,
  AgentSessionInfo,
  AgentShellInfo,
} from './types';
// Shared SSH plumbing (options, remote python lookup, ControlMaster mux).
// Single source of truth with server.js's per-WS shell proxies — see the
// module header in sshShared.js.
import { buildAgentSshArgs } from './sshShared.js';

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
};

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
  // Codex login flag — emitted by the codex/login route on a completed
  // device-code login (hello doesn't know it; the usage poll discovers it).
  codexLoggedIn?: number | null;
};
export type VpsStatusEmitter = (
  vpsId: string,
  agentStatus: 'ok' | 'missing' | 'error',
  extra?: VpsStatusExtra,
) => void;
let vpsStatusEmitter: VpsStatusEmitter | null = null;
export function setVpsStatusEmitter(fn: VpsStatusEmitter): void {
  vpsStatusEmitter = fn;
}
function emitVpsStatus(
  vpsId: string,
  agentStatus: 'ok' | 'missing' | 'error',
  extra?: VpsStatusExtra,
): void {
  try { vpsStatusEmitter?.(vpsId, agentStatus, extra); } catch {}
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

  constructor(vps: Vps) {
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

  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
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
    return this._writeRequest<T>(method, params);
  }

  /** Write without status gate — internal use only (start/hello). */
  private _writeRequest<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextReqId++;
      const pending: Pending = { resolve, reject, method };
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent ${this.vps.name}: timeout on ${method}`));
      }, 60_000);
      this.pending.set(id, pending);
      const line = JSON.stringify({ id, method, params }) + '\n';
      try {
        if (!this.child) throw new Error('no child process');
        this.child.stdin.write(line);
      } catch (e: any) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new Error(`agent ${this.vps.name}: write failed: ${e?.message ?? e}`));
      }
    });
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
      if (this.status === 'connected') {
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
    this.subscribed.add(sessionId);
    if (this.status === 'connected') {
      this._fireSubscribe(sessionId, opts);
    } else {
      this._pendingAfterSeq.set(sessionId, opts?.afterSeq ?? null);
    }
  }

  /** Called from _onConnected to update the cursor for the next
   *  reconnect-driven subscribe. The SessionStream calls this on every
   *  event with a seq, but we throttle the syscall: only the latest
   *  value matters when we actually re-issue the RPC. */
  setAfterSeq(sessionId: string, afterSeq: number | null): void {
    this._pendingAfterSeq.set(sessionId, afterSeq);
  }

  private _fireSubscribe(sessionId: string, opts?: { afterSeq?: number }): void {
    // Prefer the explicit opts, else fall back to the cached cursor
    // (updated by SessionStream as events are persisted).
    const afterSeq = opts?.afterSeq ?? this._pendingAfterSeq.get(sessionId) ?? null;
    const params: Record<string, unknown> = { session_id: sessionId };
    if (typeof afterSeq === 'number') {
      params.after_seq = afterSeq;
    } else {
      // Backward compat with agents <0.4.0: tail of the ring.
      params.replay = 300;
    }
    this.call<{ ok?: boolean; replay_count?: number; status?: string;
                current_seq?: number; earliest_seq?: number | null; gap?: boolean;
                internal_gaps?: [number, number][] }>('subscribe', params)
      .then((res) => {
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
      })
      .catch((e) => {
        // If subscribe fails (typically session_not_found), remove from
        // `subscribed` so a future subscribe will retry spontaneously.
        if (/not found/i.test(e?.message ?? '') || e?.code === -32000) {
          this.subscribed.delete(sessionId);
        }
        console.warn(`[agent ${this.vps.name}] subscribe failed: ${e?.message ?? e}`);
      });
  }

  unsubscribe(sessionId: string, listener: EventListener): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.subscribers.delete(sessionId);
      this.subscribed.delete(sessionId);
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
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('client closed'));
    }
    this.pending.clear();
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
        });
        // Re-subscribe to everything. This is the critical path for
        // "Charon was down, agent kept emitting events" — we want the
        // agent to replay from the durable log, NOT from the in-memory
        // ring (which may have rotated). _fireSubscribe consults
        // _pendingAfterSeq to choose between after_seq (durable) and
        // replay (ring tail, backward compat for old agents).
        for (const sid of this.subscribed) {
          this._fireSubscribe(sid);
        }
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
    // Response (id + result/error)
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // late
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new AgentRpcError(msg.error.code ?? -1, msg.error.message ?? 'rpc error'));
      } else {
        pending.resolve(msg.result);
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

    // Reject all pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`agent ${this.vps.name}: connection lost (${reason.slice(0, 300)})`));
    }
    this.pending.clear();

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
      if (shouldPersist) {
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
