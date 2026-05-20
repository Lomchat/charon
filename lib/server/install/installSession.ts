import 'server-only';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { bootstrapVps, type BootstrapEvent } from '@/lib/server/claude/bootstrap';
import { sendPushToAll } from '@/lib/server/claude/webPush';

// ── Install sessions — ephemeral, memory only ───────────────────────────────
// Pattern borrowed from shellSession.ts: global pool, ring buffer, SSE
// subscribers. Once Charon restarts, all in-progress installs are lost —
// the user will have to relaunch manually. This is intentional (cf.
// validated design choice: consistent with shells, simple, no DB migration
// required).
//
// At most ONE install per VPS at a time: if the user clicks "Install"
// while an install is already active for this VPS, return the existing
// one (focus).

export type InstallStatus = 'running' | 'success' | 'error';

export type InstallInfo = {
  id: string;
  vpsId: string;
  vpsName: string;
  status: InstallStatus;
  startedAt: number;
  endedAt: number | null;
  currentPhase: BootstrapEvent['phase'] | null;
  eventCount: number;
};

// Messages sent to the per-install SSE client. `replay_begin`/`replay_end`
// bracket the replay of the ring buffer (sent at subscribe). Then live.
export type InstallStreamMessage =
  | { kind: 'event'; ev: BootstrapEvent }
  | { kind: 'status'; status: InstallStatus; endedAt: number | null }
  | { kind: 'replay_begin'; count: number }
  | { kind: 'replay_end' };

type Sink = {
  id: string;
  send: (msg: InstallStreamMessage) => void;
  close: () => void;
};

const RING_MAX = 200;

class InstallSession {
  readonly id: string;
  readonly vpsId: string;
  readonly vpsName: string;
  status: InstallStatus = 'running';
  startedAt: number;
  endedAt: number | null = null;
  currentPhase: BootstrapEvent['phase'] | null = null;
  ring: BootstrapEvent[] = [];
  private subs = new Map<string, Sink>();
  // Marks the session as stopped — `start()` interrupts the for-await as
  // soon as it sees this flag. bootstrapVps does not (yet) accept a signal,
  // so we can't cleanly cancel the in-flight SSH RPC, but we at least
  // avoid processing the following yields.
  private aborted = false;
  // "End of current run" listeners — used by retry() which must wait for
  // the current run to finish before launching a new one (rare case but
  // possible if the user spams the button).
  private doneListeners = new Set<() => void>();

  constructor(id: string, vps: Vps) {
    this.id = id;
    this.vpsId = vps.id;
    this.vpsName = vps.name;
    this.startedAt = Date.now();
  }

  info(): InstallInfo {
    return {
      id: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
      status: this.status, startedAt: this.startedAt, endedAt: this.endedAt,
      currentPhase: this.currentPhase, eventCount: this.ring.length,
    };
  }

  /** Run bootstrapVps, broadcast the events, update the status at the end. */
  async run(vps: Vps): Promise<void> {
    if (this.aborted) return;
    this.status = 'running';
    this.endedAt = null;
    this._broadcastStatus();
    // Notify the global bus: install started
    emitInstallBusEvent({
      type: 'install_started',
      installId: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
      status: 'running',
    });
    try {
      for await (const ev of bootstrapVps(vps)) {
        if (this.aborted) break;
        this.currentPhase = ev.phase;
        this._addEvent(ev);
        if (ev.phase === 'done') {
          this.status = ev.status === 'ok' ? 'success' : 'error';
          this.endedAt = Date.now();
          this._broadcastStatus();
        }
      }
    } catch (e: any) {
      const errEv: BootstrapEvent = { phase: 'done', status: 'error', detail: String(e?.message ?? e) };
      this._addEvent(errEv);
      this.status = 'error';
      this.endedAt = Date.now();
      this._broadcastStatus();
    } finally {
      // If bootstrapVps returned mid-phase on error (without yielding 'done'),
      // mark manually as error.
      if (this.status === 'running' && !this.aborted) {
        this.status = 'error';
        this.endedAt = Date.now();
        const errEv: BootstrapEvent = { phase: 'done', status: 'error', detail: 'bootstrap interrupted without done phase' };
        this._addEvent(errEv);
        this._broadcastStatus();
      }
      // "End of run" notif for waiting retry()-ers.
      for (const cb of this.doneListeners) { try { cb(); } catch {} }
      this.doneListeners.clear();
      // Global notif (push + bus) if we're finished.
      if (this.status !== 'running') {
        emitInstallBusEvent({
          type: 'install_finished',
          installId: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
          status: this.status,
        });
        this._sendPush().catch(() => {});
      }
    }
  }

  /** Relaunch bootstrap. If a run is still in progress, wait for it to finish. */
  async retry(): Promise<void> {
    if (this.status === 'running') {
      await new Promise<void>((res) => this.doneListeners.add(res));
    }
    // Visual marker "── retry ──" so the user understands in the log that
    // this is a new attempt and not the continuation of the previous one.
    this._addEvent({ phase: 'verify', status: 'running', detail: '── retry ──' });
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).all();
    if (!v) {
      this._addEvent({ phase: 'done', status: 'error', detail: 'vps not found (deleted?)' });
      this.status = 'error';
      this.endedAt = Date.now();
      this._broadcastStatus();
      return;
    }
    await this.run(v);
  }

  /** Stop: close subscribers, mark aborted. The in-progress run won't
   *  actually be cancelled (the in-flight SSH continues until its timeout)
   *  but nothing more is emitted. */
  stop(): void {
    this.aborted = true;
    for (const s of this.subs.values()) {
      try { s.close(); } catch {}
    }
    this.subs.clear();
  }

  subscribe(sink: Sink): void {
    this.subs.set(sink.id, sink);
    try {
      sink.send({ kind: 'replay_begin', count: this.ring.length });
      for (const ev of this.ring) {
        sink.send({ kind: 'event', ev });
      }
      sink.send({ kind: 'replay_end' });
      sink.send({ kind: 'status', status: this.status, endedAt: this.endedAt });
    } catch {}
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  private _addEvent(ev: BootstrapEvent): void {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    for (const s of this.subs.values()) {
      try { s.send({ kind: 'event', ev }); } catch {}
    }
  }

  private _broadcastStatus(): void {
    for (const s of this.subs.values()) {
      try { s.send({ kind: 'status', status: this.status, endedAt: this.endedAt }); } catch {}
    }
  }

  private async _sendPush(): Promise<void> {
    const success = this.status === 'success';
    try {
      await sendPushToAll({
        title: success ? '✓ install OK' : '✗ install failed',
        body: `${this.vpsName} — ${success ? 'agent installed and operational' : 'see the log'}`,
        // The URL contains the installId so the service worker (sw.js) can
        // open the right session via ?install=<id> on click.
        url: '/?install=' + this.id,
        tag: 'install:' + this.vpsId,
      });
    } catch {}
  }
}

// ── Global bus for install events (cross-session notifs) ────────────────────
// Bus separate from the session-tagged bus (sessionOps.ts §
// subscribeGlobalSessionEvents) because installs have no Claude sessionId.
// The multiplexed `/api/claude/events` SSE subscribes to it in addition to
// the session bus, and forwards the events to all connections (low-volume,
// broadcast).

export type InstallBusEvent =
  | { type: 'install_started'; installId: string; vpsId: string; vpsName: string; status: InstallStatus }
  | { type: 'install_finished'; installId: string; vpsId: string; vpsName: string; status: InstallStatus };

const gBus = globalThis as unknown as { _installBusSubs?: Set<(ev: InstallBusEvent) => void> };
if (!gBus._installBusSubs) gBus._installBusSubs = new Set();
const installBusSubs: Set<(ev: InstallBusEvent) => void> = gBus._installBusSubs;

export function subscribeInstallBus(cb: (ev: InstallBusEvent) => void): () => void {
  installBusSubs.add(cb);
  return () => { installBusSubs.delete(cb); };
}

function emitInstallBusEvent(ev: InstallBusEvent): void {
  for (const cb of installBusSubs) {
    try { cb(ev); } catch {}
  }
}

// ── Global pool keyed by installId ──────────────────────────────────────────
const gPool = globalThis as unknown as { _installSessions?: Map<string, InstallSession> };
if (!gPool._installSessions) gPool._installSessions = new Map();
const pool: Map<string, InstallSession> = gPool._installSessions;

/** Start a new install for this VPS. If an install is already in progress
 *  for this VPS, return the existing one (focus, no double-run). */
export function startInstall(vpsId: string): InstallSession {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) throw new Error('vps not found');
  for (const s of pool.values()) {
    if (s.vpsId === vpsId && s.status === 'running') {
      return s;
    }
  }
  const id = crypto.randomBytes(8).toString('hex');
  const sess = new InstallSession(id, v);
  pool.set(id, sess);
  // Launch in the background — the promise is intentionally dropped, we
  // follow progress via the ring buffer.
  sess.run(v).catch(() => {});
  return sess;
}

export function getInstall(id: string): InstallSession | null {
  return pool.get(id) ?? null;
}

export function getInstallByVps(vpsId: string): InstallSession | null {
  for (const s of pool.values()) {
    if (s.vpsId === vpsId) return s;
  }
  return null;
}

export function listInstalls(): InstallSession[] {
  return Array.from(pool.values());
}

export function stopInstall(id: string): boolean {
  const s = pool.get(id);
  if (!s) return false;
  s.stop();
  pool.delete(id);
  return true;
}

export function retryInstall(id: string): InstallSession | null {
  const s = pool.get(id);
  if (!s) return null;
  s.retry().catch(() => {});
  return s;
}

export { InstallSession };
