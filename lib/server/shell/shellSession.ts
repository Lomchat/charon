import 'server-only';
import crypto from 'node:crypto';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { eq } from 'drizzle-orm';
import { db, shells as shellsTable, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { sshExec, shQuote } from '@/lib/server/claude/sshExec';

// ── Persistent SSH shells, backed by remote tmux sessions ────────────────────
//
// The terminal itself lives in a `tmux` session on the VPS named
// `charon-<id>`. Charon ATTACHES to it over SSH (via node-pty so TERM + the
// window size forward correctly) and streams it to the browser; it does NOT
// own the terminal. Consequences:
//
//   1. Persistence across Charon restart: the tmux session keeps running on
//      the VPS. The `shells` DB row is just the index; on restart we re-list
//      and re-attach (lazily, on demand). reconcileShellsOnBoot() prunes rows
//      whose tmux session has disappeared.
//   2. Recoverable from the server directly: a human can run
//      `tmux attach -t charon-<id>` and share the exact same terminal.
//   3. Survives network blips: if the SSH attach drops but the tmux session
//      is still alive, we re-attach automatically (while a viewer is present).
//
// The shell only really ends when the inner shell exits (the tmux session
// dies) or the user explicitly closes it (`tmux kill-session` + DB delete).

const ATTACH_SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  // Detect a dead connection fast so we can re-attach (3 × 20s ≈ 60s).
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
  '-tt', // force a remote PTY — tmux refuses to attach without a terminal
];

// Self-healing tmux install, prepended to the attach command so it's race-free
// (no concurrent apt lock with a fire-and-forget install) and also covers cold
// re-attach after a Charon restart. When tmux is already present (the common
// case + every re-attach) this is a single cheap `command -v` and falls through
// to `exec tmux`. Install output (first time only) shows in the terminal, then
// tmux's full-screen redraw takes over.
const TMUX_ENSURE =
  'if ! command -v tmux >/dev/null 2>&1; then ' +
  'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y tmux || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y tmux; }; ' +
  'elif command -v dnf >/dev/null 2>&1; then dnf install -y tmux; ' +
  'elif command -v yum >/dev/null 2>&1; then yum install -y tmux; ' +
  'elif command -v apk >/dev/null 2>&1; then apk add --no-cache tmux; ' +
  'elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm tmux; ' +
  'fi; fi';

const RING_MAX = 600;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_REATTACH = 12;
const EXIT_GRACE_MS = 30_000;

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
  name: string | null;
  color: string | null;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
};

class ShellSession {
  readonly id: string;
  readonly vpsId: string;
  readonly tmuxName: string;
  vpsName: string;
  cwd: string | null;
  name: string | null;
  color: string | null;
  startedAt: number;

  private pty: IPty | null = null;
  private attaching = false;
  private stopping = false;
  exited = false;
  exitCode: number | null = null;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;
  private ring: { kind: string; text: string }[] = [];
  private subs = new Map<string, Sink>();
  private reattachAttempts = 0;
  private reattachTimer: NodeJS.Timeout | null = null;

  constructor(row: { id: string; vpsId: string; tmuxName: string; cwd: string | null; name: string | null; color: string | null; createdAt: number; vpsName: string }) {
    this.id = row.id;
    this.vpsId = row.vpsId;
    this.tmuxName = row.tmuxName;
    this.cwd = row.cwd;
    this.name = row.name;
    this.color = row.color;
    this.startedAt = row.createdAt * 1000;
    this.vpsName = row.vpsName;
  }

  // True only when an SSH attach is live (or being established) — NOT for an
  // instance merely hydrated from DB to serve a list/info call. Used by the
  // boot reconcile to avoid pruning a shell that's actively connected (covers
  // the race where a freshly-started shell's tmux session isn't listable yet).
  get attached(): boolean {
    return this.pty !== null || this.attaching;
  }

  info(): ShellInfo {
    return {
      id: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
      cwd: this.cwd, name: this.name, color: this.color,
      startedAt: this.startedAt,
      exited: this.exited, exitCode: this.exitCode,
    };
  }

  private loadVps(): Vps | null {
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).all();
    return v ?? null;
  }

  // Spawn (or re-spawn) the SSH+tmux attach. Idempotent: no-op if already
  // attached / attaching / exited.
  ensureAttach(): void {
    if (this.exited || this.stopping || this.pty || this.attaching) return;
    this.attaching = true;
    const v = this.loadVps();
    if (!v) {
      this.attaching = false;
      this._fail('vps not found');
      return;
    }
    // `new-session -A` = attach if exists, else create. `-c` only applies at
    // creation; harmless on re-attach. `exec` avoids a leftover login shell.
    const remote =
      `${TMUX_ENSURE}; exec tmux -u new-session -A -s ${shQuote(this.tmuxName)}` +
      (this.cwd ? ` -c ${shQuote(this.cwd)}` : '');
    const args = [
      ...ATTACH_SSH_OPTS,
      '-p', String(v.sshPort),
      `${v.sshUser}@${v.ip}`,
      remote,
    ];
    try {
      const p = ptySpawn('ssh', args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      this.pty = p;
      this.attaching = false;
      if (this.reattachAttempts === 0) {
        this._emit('meta', `[charon] attaching to ${v.sshUser}@${v.ip} · tmux:${this.tmuxName}${this.cwd ? ` · cwd=${this.cwd}` : ''}\n`);
      }
      p.onData((d: string) => {
        // Real data flowing → the connection is healthy; reset the backoff.
        this.reattachAttempts = 0;
        this._emit('stdout', d);
      });
      p.onExit(({ exitCode }) => { this.pty = null; this._onAttachExit(exitCode); });
    } catch (e: any) {
      this.attaching = false;
      this.pty = null;
      this._fail(e?.message ?? String(e));
    }
  }

  // The SSH attach ended. Two very different cases:
  //   - the tmux session still exists → we were just detached (network drop,
  //     ServerAlive timeout) → re-attach while a viewer is present.
  //   - the tmux session is gone → the inner shell exited → the shell ended.
  private async _onAttachExit(code: number | null): Promise<void> {
    if (this.stopping || this.exited) return;
    const v = this.loadVps();
    if (!v) { this._markExited(code); return; }
    let alive = false;
    try {
      const r = await sshExec(v, `tmux has-session -t ${shQuote(this.tmuxName)} 2>/dev/null`, { timeoutMs: 12_000 });
      alive = r.ok;
    } catch {
      // SSH itself failed (VPS unreachable). Assume the session is alive and
      // let the re-attach backoff handle it — do NOT declare the shell dead
      // just because the network hiccuped.
      alive = true;
    }
    if (this.stopping || this.exited) return;
    if (alive) {
      this.reattachAttempts++;
      if (this.subs.size > 0 && this.reattachAttempts <= MAX_REATTACH) {
        const delay = Math.min(1000 * this.reattachAttempts, 8000);
        this._emit('meta', `\n[charon] connection lost — reattaching (${this.reattachAttempts})…\n`);
        this._scheduleReattach(delay);
      } else if (this.subs.size > 0) {
        this._emit('meta', `\n[charon] could not reattach — the tmux session is still alive on the VPS. Close and reopen to retry.\n`);
      }
      // No subscribers: leave pty null; a later subscribe() re-attaches lazily.
    } else {
      this._markExited(code);
    }
  }

  private _scheduleReattach(delayMs: number): void {
    if (this.reattachTimer || this.exited || this.stopping) return;
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      if (this.subs.size > 0) this.ensureAttach();
    }, delayMs);
  }

  private _markExited(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this._emit('meta', `\n[charon] shell exited (code=${code ?? '?'})\n`);
    // Keep around briefly so late subscribers see the exit, then purge the
    // pool + DB row (the tmux session is already gone).
    setTimeout(() => {
      for (const s of this.subs.values()) { try { s.close(); } catch {} }
      this.subs.clear();
      try { db.delete(shellsTable).where(eq(shellsTable.id, this.id)).run(); } catch {}
      pool.delete(this.id);
    }, EXIT_GRACE_MS);
  }

  private _fail(msg: string): void {
    this._emit('meta', `\n[charon] attach error: ${msg}\n`);
    this.reattachAttempts++;
    if (this.subs.size > 0 && this.reattachAttempts <= MAX_REATTACH) {
      this._scheduleReattach(Math.min(1500 * this.reattachAttempts, 8000));
    }
  }

  sendInput(content: string): void {
    this.ensureAttach();
    if (!this.pty) return; // attach in progress; the user can retry a keystroke
    try { this.pty.write(content); } catch {}
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.cols = Math.max(2, Math.min(500, Math.floor(cols)));
    this.rows = Math.max(2, Math.min(300, Math.floor(rows)));
    if (this.pty) { try { this.pty.resize(this.cols, this.rows); } catch {} }
  }

  // Explicit close: kill the tmux session on the VPS, tear down the attach,
  // delete the DB row.
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reattachTimer) { clearTimeout(this.reattachTimer); this.reattachTimer = null; }
    const v = this.loadVps();
    if (v) {
      try { await sshExec(v, `tmux kill-session -t ${shQuote(this.tmuxName)} 2>/dev/null`, { timeoutMs: 10_000 }); } catch {}
    }
    if (this.pty) { try { this.pty.kill(); } catch {} this.pty = null; }
    for (const s of this.subs.values()) { try { s.close(); } catch {} }
    this.subs.clear();
    try { db.delete(shellsTable).where(eq(shellsTable.id, this.id)).run(); } catch {}
    pool.delete(this.id);
  }

  subscribe(sink: Sink): void {
    this.subs.set(sink.id, sink);
    for (const ev of this.ring) {
      try { sink.send(ev.text, ev.kind as any); } catch {}
    }
    if (this.exited) {
      try { sink.send(`[charon] shell already exited (code=${this.exitCode ?? '?'})`, 'meta'); } catch {}
      return;
    }
    // A viewer showed up — make sure we're attached (covers post-restart cold
    // hydration and re-attach after an idle network drop).
    this.reattachAttempts = 0;
    this.ensureAttach();
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  private _emit(kind: 'stdout' | 'stderr' | 'meta', text: string): void {
    this.ring.push({ kind, text });
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    for (const s of this.subs.values()) {
      try { s.send(text, kind); } catch {}
    }
  }
}

// Global pool keyed by shellId. Survives HMR in dev (memoized on globalThis).
const g = globalThis as unknown as { _shellSessions?: Map<string, ShellSession> };
if (!g._shellSessions) g._shellSessions = new Map();
const pool: Map<string, ShellSession> = g._shellSessions;

function vpsNameOf(vpsId: string): string {
  const [v] = db.select({ name: vpsTable.name }).from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  return v?.name ?? '?';
}

// Get the live session for an id, hydrating from DB if it's not in the pool
// (e.g. after a Charon restart). Does NOT spawn the attach — that happens
// lazily on subscribe/input/resize. Returns null if there's no such shell.
function getOrHydrate(id: string): ShellSession | null {
  const existing = pool.get(id);
  if (existing) return existing;
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, id)).all();
  if (!row) return null;
  const s = new ShellSession({ ...row, vpsName: vpsNameOf(row.vpsId) });
  pool.set(id, s);
  return s;
}

// ── Public API (consumed by the /api/shells* routes) ─────────────────────────

export function startShell(vpsId: string, cwd: string | null): ShellSession {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) throw new Error('vps not found');
  const id = crypto.randomBytes(8).toString('hex');
  const tmuxName = `charon-${id}`;
  const cleanCwd = cwd && cwd.trim() ? cwd.trim() : null;
  db.insert(shellsTable).values({ id, vpsId, tmuxName, cwd: cleanCwd, name: null, color: null }).run();
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, id)).all();
  const s = new ShellSession({ ...row!, vpsName: v.name });
  pool.set(id, s);
  s.ensureAttach();
  return s;
}

export function getShell(id: string): ShellSession | null {
  return getOrHydrate(id);
}

export function listShells(): ShellSession[] {
  // DB is the source of truth (so persisted shells show up after a restart).
  const rows = db.select().from(shellsTable).all();
  return rows.map((row) => getOrHydrate(row.id)).filter((s): s is ShellSession => !!s);
}

export async function stopShell(id: string): Promise<boolean> {
  const s = getOrHydrate(id);
  if (!s) return false;
  await s.stop();
  return true;
}

// At boot: drop DB rows whose tmux session no longer exists on the VPS (the
// inner shell exited while Charon was down, or the VPS rebooted). Best-effort
// and per-VPS: if a VPS is unreachable we leave its rows untouched (the drop
// might be transient). Does NOT spawn attaches — those are lazy.
export async function reconcileShellsOnBoot(): Promise<void> {
  let rows: { id: string; vpsId: string; tmuxName: string }[];
  try {
    rows = db.select({ id: shellsTable.id, vpsId: shellsTable.vpsId, tmuxName: shellsTable.tmuxName }).from(shellsTable).all();
  } catch { return; }
  if (rows.length === 0) return;
  const byVps = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byVps.get(r.vpsId) ?? [];
    arr.push(r);
    byVps.set(r.vpsId, arr);
  }
  await Promise.all(Array.from(byVps.entries()).map(async ([vpsId, vpsRows]) => {
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
    if (!v) {
      // VPS was deleted; the FK cascade should already have removed the rows,
      // but clean up just in case.
      for (const r of vpsRows) { try { db.delete(shellsTable).where(eq(shellsTable.id, r.id)).run(); } catch {} }
      return;
    }
    const res = await sshExec(v, "tmux ls -F '#{session_name}' 2>/dev/null || true", { timeoutMs: 12_000 });
    // We append `|| true`, so a connected run ALWAYS exits 0 (even with no tmux
    // server → empty list). Any non-zero exit means SSH itself failed (255) or
    // we timed out (null) → the VPS is unreachable → leave the rows untouched
    // (the disappearance might be transient). Only prune on a real, empty list.
    if (res.code !== 0) return;
    const live = new Set(res.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    for (const r of vpsRows) {
      // Prune iff the tmux session is gone AND we're not actively attached
      // (a hydrated-for-listing pool entry must NOT block pruning — only a
      // live/attaching one does, to cover the just-started-shell race).
      if (!live.has(r.tmuxName) && !pool.get(r.id)?.attached) {
        try { db.delete(shellsTable).where(eq(shellsTable.id, r.id)).run(); } catch {}
        pool.delete(r.id); // drop any stale hydrated instance so it can't resurrect the session
      }
    }
  }));
}

export type { ShellSession };
