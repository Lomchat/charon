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

// Chemin du pyz côté VPS (cf. installer)
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

// Backoff progressif sur reconnexion. Cap à 5min.
const RECONNECT_BACKOFFS_MS = [1_000, 3_000, 8_000, 20_000, 60_000, 120_000, 300_000];

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
};

export type EventListener = (ev: AgentEvent) => void;

/**
 * Maintient une connexion SSH long-running à un VPS, multiplexée en
 * JSON-RPC line-delimited avec le charon-agent qui tourne là-bas.
 *
 * - Auto-reconnect avec backoff.
 * - Subscriptions persistantes (re-subscribe automatique après reconnect).
 * - Pending requests rejetées à la déconnexion (le caller doit retry).
 */
export class AgentClient {
  readonly vps: Vps;
  status: AgentClientStatus = 'idle';
  hello: AgentHelloResult | null = null;
  lastConnectError: string | null = null;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextReqId = 1;
  private pending = new Map<number, Pending>();
  private readBuf = '';
  private stderrBuf = '';
  private subscribers = new Map<string, Set<EventListener>>();
  // Les session_id auxquels on a explicitement "subscribe" pour pouvoir
  // re-subscribe après un reconnect.
  private subscribed = new Set<string>();
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
      // Lance la connexion en arrière-plan
      this.start().catch(() => {});
    }
    return this.readyPromise;
  }

  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    if (this.aborted) throw new Error('client closed');
    if (this.status !== 'connected') {
      // Tente d'établir la connexion si on n'a jamais essayé
      if (this.status === 'idle') this.start().catch(() => {});
      // Attend qu'on soit connecté (avec timeout 30s)
      await Promise.race([
        this.ready(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`agent ${this.vps.name}: not connected (status=${this.status})`)), 30_000)
        ),
      ]);
    }
    return this._writeRequest<T>(method, params);
  }

  /** Écriture sans gate de status — usage interne uniquement (start/hello). */
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

  subscribe(sessionId: string, listener: EventListener): void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(listener);
    // Si pas encore subscribed côté agent, le faire
    if (!this.subscribed.has(sessionId)) {
      this.subscribed.add(sessionId);
      if (this.status === 'connected') {
        this._fireSubscribe(sessionId);
      }
    }
  }

  /** Re-tente le subscribe RPC côté agent. Utile quand un subscribe précédent
   *  a failed (typiquement : SSE ouvert avant que la session n'existe sur
   *  l'agent, puis resume qui crée la session — l'attach n'est pas refait
   *  parce qu'idempotent, mais le subscribe agent reste manquant). */
  resubscribe(sessionId: string): void {
    if (!this.subscribers.has(sessionId)) return;  // pas de listener → rien à faire
    this.subscribed.add(sessionId);
    if (this.status === 'connected') {
      this._fireSubscribe(sessionId);
    }
  }

  private _fireSubscribe(sessionId: string): void {
    this.call('subscribe', { session_id: sessionId, replay: 300 })
      .catch((e) => {
        // Si subscribe échoue (typiquement session_not_found), on retire de
        // `subscribed` pour qu'un futur subscribe ré-essaye spontanément.
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
    // Sélectionne explicitement le meilleur python ≥ 3.10 disponible.
    // Le shebang du pyz est `python3` qui sur RHEL/CentOS reste à 3.9 — pas OK.
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

    // Envoie le hello (passe par _writeRequest pour éviter le deadlock :
    // call() awaiterait ready() qui n'est résolu QUE par cette réponse hello).
    this._writeRequest<AgentHelloResult>('hello', { client: 'charon' })
      .then((hello) => {
        this.hello = hello;
        this.reconnectAttempts = 0;
        this.lastConnectError = null;
        this._setStatus('connected');
        // Persist le ping side-effect : timestamp + version
        try {
          db.update(vpsTable).set({
            agentStatus: 'ok',
            agentVersion: hello.agent_version,
            agentPyzSha: hello.agent_pyz_sha ?? null,
            agentLastSeenAt: Math.floor(Date.now() / 1000),
          }).where(eq(vpsTable.id, this.vps.id)).run();
        } catch {}
        // Re-subscribe à tout
        for (const sid of this.subscribed) {
          this.call('subscribe', { session_id: sid, replay: 300 }).catch(() => {});
        }
        // Résout les ready
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
          this.readyPromise = null;
        }
      })
      .catch((e) => {
        this.lastConnectError = `hello failed: ${e?.message ?? e}`;
        // _handleExit prendra le relais (child va close)
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
      if (!pending) return; // tardive
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new AgentRpcError(msg.error.code ?? -1, msg.error.message ?? 'rpc error'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // Event (no id) — dispatcher aux subscribers de la session
    if (typeof msg.event === 'string') {
      const sid = msg.session_id;
      if (typeof sid !== 'string') return;
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

    // Reject toutes les pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`agent ${this.vps.name}: connection lost (${reason.slice(0, 300)})`));
    }
    this.pending.clear();

    // Tag DB : missing / error selon le stderr (heuristique)
    try {
      const isMissing = /No such file|introuvable|not found/i.test(tail) || code === 127;
      db.update(vpsTable).set({
        agentStatus: isMissing ? 'missing' : 'error',
      }).where(eq(vpsTable.id, this.vps.id)).run();
    } catch {}

    // Si on n'avait pas encore résolu ready (premier connect), reject.
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
