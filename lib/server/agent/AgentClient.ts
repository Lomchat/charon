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
} from './types';

// Path of the pyz on the VPS side (cf. installer)
const REMOTE_AGENT_PATH = '~/.charon/charon-agent.pyz';

const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=4',
  '-T',
];

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

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextReqId = 1;
  private pending = new Map<number, Pending>();
  private readBuf = '';
  private stderrBuf = '';
  private subscribers = new Map<string, Set<EventListener>>();
  // The session_ids we've explicitly "subscribed" to, so we can
  // re-subscribe after a reconnect.
  private subscribed = new Set<string>();
  // Same idea for shell_ids — parallel set so we can fire the right RPC
  // (`shell_subscribe` vs. `subscribe`) on reconnect. Kept separate from
  // `subscribed` because the RPC name + replay log are different.
  private subscribedShells = new Set<string>();
  // Per-session checkpoint cursor for durable replay. Updated by
  // SessionStream via setAfterSeq(sid, seq) as events are persisted.
  // Looked up by _fireSubscribe on the next subscribe RPC (which is
  // typically issued by the resubscribe-after-reconnect path).
  // `null` means "no checkpoint yet — fall back to ring replay".
  private _pendingAfterSeq = new Map<string, number | null>();
  // Parallel cursor map for shells (same semantics, separate namespace).
  private _pendingShellAfterSeq = new Map<string, number | null>();
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
    this.call('subscribe', params)
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

  // ── Shell-side subscriptions (agent >= 0.7.0) ─────────────────────────────
  // Same pattern as `subscribe`/`unsubscribe` for Claude sessions, but the
  // RPC is `shell_subscribe` / `shell_unsubscribe` (the agent's shell event
  // log lives in a separate dir). Listeners share the same `subscribers`
  // map — shell_ids and session_ids don't collide in practice (16-hex vs
  // 32-hex), and the routing layer keys by id only.
  subscribeShell(shellId: string, listener: EventListener, opts?: { afterSeq?: number }): void {
    if (!this.subscribers.has(shellId)) {
      this.subscribers.set(shellId, new Set());
    }
    this.subscribers.get(shellId)!.add(listener);
    if (!this.subscribedShells.has(shellId)) {
      this.subscribedShells.add(shellId);
      if (this.status === 'connected') {
        this._fireShellSubscribe(shellId, opts);
      } else {
        this._pendingShellAfterSeq.set(shellId, opts?.afterSeq ?? null);
      }
    } else if (opts?.afterSeq !== undefined) {
      // The shell is already subscribed but the caller wants to bump the
      // cursor (e.g. a fresh ws connection just re-asserted the latest seq).
      this._pendingShellAfterSeq.set(shellId, opts.afterSeq);
    }
  }

  unsubscribeShell(shellId: string, listener: EventListener): void {
    const set = this.subscribers.get(shellId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.subscribers.delete(shellId);
      this.subscribedShells.delete(shellId);
      if (this.status === 'connected') {
        this.call('shell_unsubscribe', { shell_id: shellId }).catch(() => {});
      }
    }
  }

  /** Update the durable-replay cursor for a shell. Called as Charon persists
   *  shell_output events; the latest value is what `_fireShellSubscribe`
   *  will pass to the agent on the next (re)subscribe. */
  setShellAfterSeq(shellId: string, afterSeq: number | null): void {
    this._pendingShellAfterSeq.set(shellId, afterSeq);
  }

  private _fireShellSubscribe(shellId: string, opts?: { afterSeq?: number }): void {
    const afterSeq = opts?.afterSeq ?? this._pendingShellAfterSeq.get(shellId) ?? null;
    const params: Record<string, unknown> = { shell_id: shellId };
    if (typeof afterSeq === 'number') params.after_seq = afterSeq;
    this.call('shell_subscribe', params).catch((e) => {
      // Shell gone on the agent (typically: agent restarted, the bash child
      // died with it). Drop the subscription so we don't keep retrying — the
      // browser will see no events and the WS handler will close.
      if (/not found/i.test(e?.message ?? '') || e?.code === -32000) {
        this.subscribedShells.delete(shellId);
      }
      console.warn(`[agent ${this.vps.name}] shell_subscribe failed: ${e?.message ?? e}`);
    });
  }

  // ── Global shell lifecycle watch (agent >= 0.8.0) ─────────────────────────
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

  private _fireShellWatch(): void {
    this.call('shell_watch', {}).catch((e) => {
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
    const keyArgs = keyPath && keyPath !== '/root/.ssh/id_rsa' ? ['-i', keyPath] : [];
    // Explicitly select the best python ≥ 3.10 available.
    // The pyz shebang is `python3` which on RHEL/CentOS is still 3.9 — not OK.
    const PY = '$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3)';
    const args = [
      ...SSH_OPTS,
      ...keyArgs,
      '-p', String(this.vps.sshPort),
      `${this.vps.sshUser}@${this.vps.ip}`,
      `exec ${PY} ${REMOTE_AGENT_PATH} --connect`,
    ];

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
        this._setStatus('connected');
        // Persist the ping side-effect: timestamp + version
        try {
          db.update(vpsTable).set({
            agentStatus: 'ok',
            agentVersion: hello.agent_version,
            agentPyzSha: hello.agent_pyz_sha ?? null,
            agentLastSeenAt: Math.floor(Date.now() / 1000),
          }).where(eq(vpsTable.id, this.vps.id)).run();
        } catch {}
        // Re-subscribe to everything. This is the critical path for
        // "Charon was down, agent kept emitting events" — we want the
        // agent to replay from the durable log, NOT from the in-memory
        // ring (which may have rotated). _fireSubscribe consults
        // _pendingAfterSeq to choose between after_seq (durable) and
        // replay (ring tail, backward compat for old agents).
        for (const sid of this.subscribed) {
          this._fireSubscribe(sid);
        }
        for (const shellId of this.subscribedShells) {
          this._fireShellSubscribe(shellId);
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
    const isMissing = /No such file|introuvable|not found/i.test(tail) || code === 127;
    this.lastClassified = isMissing ? 'missing' : 'error';
    try {
      const shouldPersist = isMissing || this.reconnectAttempts >= ERROR_PERSIST_AFTER_ATTEMPTS;
      if (shouldPersist) {
        db.update(vpsTable).set({
          agentStatus: this.lastClassified,
        }).where(eq(vpsTable.id, this.vps.id)).run();
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
