import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { getSetting } from '@/lib/server/claude/settings';
import { KNOWN_HOSTS_PATH } from '@/lib/server/agent/sshShared.js';

// ── Interactive `claude login` console per VPS ───────────────────────────────
// One active session per VPS at a time (the 2nd start kills the previous one).
// stdout streamed via /api/vps/[id]/login/stream (SSE).
// stdin via POST /api/vps/[id]/login/input.

type Sink = {
  id: string;
  send: (chunk: string, kind?: 'stdout' | 'stderr' | 'meta') => void;
  close: () => void;
};

class LoginSession {
  readonly vpsId: string;
  child: ChildProcessWithoutNullStreams | null = null;
  ring: { kind: string; text: string; ts: number }[] = [];
  exitCode: number | null = null;
  exited = false;
  startedAt: number;
  private subs = new Map<string, Sink>();

  constructor(vpsId: string) {
    this.vpsId = vpsId;
    this.startedAt = Date.now();
  }

  start(): boolean {
    if (this.child) return false;
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).all();
    if (!v) {
      this._emit('meta', `[charon] vps ${this.vpsId} not found`);
      this.exited = true;
      return false;
    }
    const keyPath = getSetting('ssh.private_key_path');
    const keyArgs = keyPath && keyPath !== '/root/.ssh/id_rsa' ? ['-i', keyPath] : [];
    // -tt: force a PTY so claude login (interactive) works.
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-tt',
      ...keyArgs,
      '-p', String(v.sshPort),
      '--',
      `${v.sshUser}@${v.ip}`,
      'claude /login',
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this._emit('meta', `[charon] ssh ${v.sshUser}@${v.ip} claude login`);
    child.stdout.on('data', (b) => this._emit('stdout', b.toString()));
    child.stderr.on('data', (b) => this._emit('stderr', b.toString()));
    child.on('error', (e) => this._emit('meta', `[charon] error: ${e.message}`));
    child.on('close', (code) => {
      this.exitCode = code;
      this.exited = true;
      this._emit('meta', `[charon] ssh exited (code=${code ?? '?'})`);
      this.child = null;
      // Close all sinks after a short delay so they see the last event
      setTimeout(() => {
        for (const s of this.subs.values()) {
          try { s.close(); } catch {}
        }
        this.subs.clear();
      }, 300);
    });
    return true;
  }

  sendInput(content: string): void {
    if (!this.child) throw new Error('no active login session');
    try { this.child.stdin.write(content); } catch {}
  }

  stop(): void {
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill('SIGTERM'); } catch {}
      setTimeout(() => { if (this.child) try { this.child.kill('SIGKILL'); } catch {} }, 1500);
    }
    for (const s of this.subs.values()) {
      try { s.close(); } catch {}
    }
    this.subs.clear();
  }

  subscribe(sink: Sink): void {
    this.subs.set(sink.id, sink);
    // Replay the ring
    for (const ev of this.ring) {
      try { sink.send(ev.text, ev.kind as any); } catch {}
    }
    if (this.exited) {
      try { sink.send(`[charon] session closed`, 'meta'); } catch {}
    }
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  private _emit(kind: 'stdout' | 'stderr' | 'meta', text: string): void {
    this.ring.push({ kind, text, ts: Date.now() });
    if (this.ring.length > 200) this.ring.splice(0, this.ring.length - 200);
    for (const s of this.subs.values()) {
      try { s.send(text, kind); } catch {}
    }
  }
}

// Global pool (1 per VPS) — survives dev hot reloads
const g = globalThis as unknown as { _loginSessions?: Map<string, LoginSession> };
if (!g._loginSessions) g._loginSessions = new Map();
const pool: Map<string, LoginSession> = g._loginSessions;

export function startLoginSession(vpsId: string): LoginSession {
  // If one already exists and is running, kill it and start over
  const existing = pool.get(vpsId);
  if (existing) {
    existing.stop();
    pool.delete(vpsId);
  }
  const sess = new LoginSession(vpsId);
  pool.set(vpsId, sess);
  sess.start();
  return sess;
}

export function getLoginSession(vpsId: string): LoginSession | null {
  return pool.get(vpsId) ?? null;
}

export function stopLoginSession(vpsId: string): void {
  const s = pool.get(vpsId);
  if (s) {
    s.stop();
    pool.delete(vpsId);
  }
}

export type { LoginSession };
