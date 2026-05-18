import 'server-only';
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { getSetting } from '@/lib/server/claude/settings';

// ── Sessions SSH "shells" — légères, ephémères ───────────────────────────────
// Une fois perdue (Charon restart, SSH drop, kill explicite), elle est perdue.
// Pas de resume. Pas de DB. Pool en mémoire seulement. Multi-shells par VPS OK.

const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-tt',  // force PTY (interactive shell)
];

type Sink = {
  id: string;
  send: (chunk: string, kind?: 'stdout' | 'stderr' | 'meta') => void;
  close: () => void;
};

export type ShellInfo = {
  id: string;
  vpsId: string;
  vpsName: string;
  cwd: string | null;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
};

class ShellSession {
  readonly id: string;
  readonly vpsId: string;
  readonly vpsName: string;
  readonly cwd: string | null;
  child: ChildProcessWithoutNullStreams | null = null;
  ring: { kind: string; text: string; ts: number }[] = [];
  exitCode: number | null = null;
  exited = false;
  startedAt: number;
  private subs = new Map<string, Sink>();

  constructor(id: string, vps: Vps, cwd: string | null) {
    this.id = id;
    this.vpsId = vps.id;
    this.vpsName = vps.name;
    this.cwd = cwd;
    this.startedAt = Date.now();
  }

  info(): ShellInfo {
    return {
      id: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
      cwd: this.cwd, startedAt: this.startedAt,
      exited: this.exited, exitCode: this.exitCode,
    };
  }

  start(vps: Vps): boolean {
    if (this.child) return false;
    const keyPath = getSetting('ssh.private_key_path');
    const keyArgs = keyPath && keyPath !== '/root/.ssh/id_rsa' ? ['-i', keyPath] : [];
    // Si cwd fourni : on lance un bash login dans ce dir, sinon le shell par défaut.
    const remoteCmd = this.cwd
      ? `cd ${shellQuote(this.cwd)} && exec $SHELL -l`
      : 'exec $SHELL -l';
    const args = [
      ...SSH_OPTS,
      ...keyArgs,
      '-p', String(vps.sshPort),
      `${vps.sshUser}@${vps.ip}`,
      remoteCmd,
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this._emit('meta', `[charon] ssh ${vps.sshUser}@${vps.ip}${this.cwd ? ` · cwd=${this.cwd}` : ''}\n`);
    child.stdout.on('data', (b) => this._emit('stdout', b.toString()));
    child.stderr.on('data', (b) => this._emit('stderr', b.toString()));
    child.on('error', (e) => this._emit('meta', `[charon] error: ${e.message}\n`));
    child.on('close', (code) => {
      this.exitCode = code;
      this.exited = true;
      this._emit('meta', `\n[charon] ssh exited (code=${code ?? '?'})\n`);
      this.child = null;
      // Garde le shell un peu pour que les late subscribers voient l'exit
      setTimeout(() => {
        for (const s of this.subs.values()) {
          try { s.close(); } catch {}
        }
        this.subs.clear();
        // Et purge du pool après 30s
        setTimeout(() => { pool.delete(this.id); }, 30_000);
      }, 500);
    });
    return true;
  }

  sendInput(content: string): void {
    if (!this.child) throw new Error('shell not running');
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
    for (const ev of this.ring) {
      try { sink.send(ev.text, ev.kind as any); } catch {}
    }
    if (this.exited) {
      try { sink.send(`[charon] shell already exited (code=${this.exitCode ?? '?'})`, 'meta'); } catch {}
    }
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  private _emit(kind: 'stdout' | 'stderr' | 'meta', text: string): void {
    this.ring.push({ kind, text, ts: Date.now() });
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500);
    for (const s of this.subs.values()) {
      try { s.send(text, kind); } catch {}
    }
  }
}

function shellQuote(s: string): string {
  // Quote simple pour cwd : on entoure de '...' et on escape les single quotes.
  // Marche pour les chemins normaux ; si l'utilisateur met du shell injection
  // dans son cwd, eh bah il le mérite (il a un accès SSH root déjà).
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Pool global keyed par shellId (UUID). Multi-shells par VPS supportés.
const g = globalThis as unknown as { _shellSessions?: Map<string, ShellSession> };
if (!g._shellSessions) g._shellSessions = new Map();
const pool: Map<string, ShellSession> = g._shellSessions;

export function startShell(vpsId: string, cwd: string | null): ShellSession {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) throw new Error('vps not found');
  const id = crypto.randomBytes(8).toString('hex');
  const s = new ShellSession(id, v, cwd && cwd.trim() ? cwd.trim() : null);
  pool.set(id, s);
  s.start(v);
  return s;
}

export function getShell(id: string): ShellSession | null {
  return pool.get(id) ?? null;
}

export function listShells(): ShellSession[] {
  return Array.from(pool.values());
}

export function stopShell(id: string): boolean {
  const s = pool.get(id);
  if (!s) return false;
  s.stop();
  pool.delete(id);
  return true;
}

export type { ShellSession };
