import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { getSetting } from '@/lib/server/claude/settings';
import { KNOWN_HOSTS_PATH, controlPath } from '@/lib/server/agent/sshShared.js';
import { readClaudeAuthStatus, type ClaudeAccount } from './claudeLoginCheck';
import { emitGlobalVpsStatus } from './sessionOps';

// ── `claude auth login` as a STRUCTURED device-code flow (§14.64) ────────────
//
// This used to be `ssh -tt <host> claude /login` streamed into an xterm: a
// slash-command inside the interactive REPL, rendered as raw VT100 bytes. The
// hub understood nothing of it — it was an SSH session in a modal.
//
// `claude auth login` is the real non-interactive entry point, and its headless
// shape is exactly Codex's device-code flow (§14.61):
//
//   Opening browser to sign in…
//   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&…
//   Paste code here if prompted >
//
// Two properties make the whole design work, both verified on the fleet:
//   1. `redirect_uri` is the HOSTED https://platform.claude.com/oauth/code/callback
//      — NOT localhost:1455 like the Codex CLI's browser flow. So a headless VPS
//      completes fine: the user authorizes on ANY device and gets a code back.
//   2. NO PTY IS NEEDED. The URL is flushed to a plain pipe in ~0.5s (measured),
//      and the code is accepted from a pipe. Hence plain stdio + `-T` below;
//      re-adding `-tt` would drag ANSI repositioning back in for nothing.
//
// Unlike Codex (whose app-server persists credentials by itself) Claude needs
// the code pasted BACK, hence `submitCode`. A wrong code is RECOVERABLE and
// costs nothing: as long as stdin stays open the CLI prints "Invalid code."
// (on STDERR — hence both pipes feed _ingest) and keeps waiting on the SAME
// authorize url, accepting codes in a loop. Verified: 3 bad codes in a row got
// 3 rejections on one live session. So we go back to 'pending' WITHOUT a new
// url. (It re-emits a fresh url only when stdin hits EOF — a shape we never
// produce here, and one that would invalidate the url the user is looking at.)
//
// Verdict is never scraped from stdout: on submit we poll
// `claude auth status --json` (authoritative, §claudeLoginCheck). Success
// persists claude_logged_in + broadcasts `vps_status` so every tab's chips and
// buttons flip live.

export type ClaudeLoginPhase = 'starting' | 'pending' | 'verifying' | 'success' | 'error';

export type ClaudeLoginStatus = {
  phase: ClaudeLoginPhase;
  /** OAuth url to open, present from 'pending' onwards. */
  url: string | null;
  /** Non-fatal on 'pending' (e.g. "Invalid code" → retry with the new url). */
  error: string | null;
  /** Account behind a successful sign-in (email / org / plan), when known. */
  account: ClaudeAccount | null;
  /** Bumps on every fresh url — lets the client tell a retry from a re-render. */
  attempt: number;
};

/** Device codes expire server-side; reap abandoned attempts (and their ssh). */
const TTL_MS = 15 * 60 * 1000;
/**
 * Remote-process reaping — see `_reapRemote` for WHY killing the local ssh is
 * not enough. Anchored on the WHOLE cmdline so it matches the CLI (argv is
 * exactly `claude auth login`) and can never match the remote shell running
 * this very command (its cmdline starts with the shell) nor the `timeout`
 * wrapper below (starts with `timeout`).
 */
const REMOTE_MATCH = '^claude auth login$';
/** A reap is best-effort plumbing: never let it linger. */
const REAP_TIMEOUT_MS = 15_000;
/** Cadence + budget of the post-submit `claude auth status` polling. */
const VERIFY_POLL_MS = 2_500;
const VERIFY_BUDGET_MS = 60_000;
/** Raw tail kept for diagnostics when the flow fails in an unexpected way. */
const TAIL_MAX = 4_000;

const RE_URL = /visit:\s*(https?:\/\/\S+)/;
const RE_INVALID = /Invalid code\./i;

/** ssh options shared by the login channel and its reaper. */
function _sshBaseArgs(v: Vps): string[] {
  const keyPath = getSetting('ssh.private_key_path');
  const keyArgs = keyPath && keyPath !== '/root/.ssh/id_rsa' ? ['-i', keyPath] : [];
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    ...keyArgs,
    '-p', String(v.sshPort),
  ];
}

class ClaudeLoginSession {
  readonly vpsId: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private tail = '';
  private phase: ClaudeLoginPhase = 'starting';
  private url: string | null = null;
  private error: string | null = null;
  private account: ClaudeAccount | null = null;
  private attempt = 0;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private vps: Vps | null = null;
  private done = false;

  constructor(vpsId: string) {
    this.vpsId = vpsId;
  }

  status(): ClaudeLoginStatus {
    return {
      phase: this.phase,
      url: this.url,
      error: this.error,
      account: this.account,
      attempt: this.attempt,
    };
  }

  start(): void {
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).all();
    if (!v) {
      this._fail('vps not found');
      return;
    }
    this.vps = v;
    const args = [
      ..._sshBaseArgs(v),
      '-o', 'ServerAliveInterval=30',
      // -T (no PTY): the flow is line-oriented on both directions. See header.
      '-T',
      '--',
      `${v.sshUser}@${v.ip}`,
      [
        // Sweep stragglers the hub could not reap (crash/restart mid-login).
        // Runs BEFORE our own CLI starts, so it can only hit dead attempts.
        `pkill -f '${REMOTE_MATCH}' 2>/dev/null || true;`,
        'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH";',
        // Belt to the reap's suspender: if the hub dies before it can kill
        // this, the CLI still self-destructs at the TTL instead of waiting on
        // stdin forever. `timeout` is coreutils, but degrade gracefully.
        `if command -v timeout >/dev/null 2>&1;`,
        `then exec timeout ${Math.ceil(TTL_MS / 1000)} claude auth login;`,
        'else exec claude auth login; fi',
      ].join(' '),
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      this._fail(`spawn failed: ${e?.message ?? e}`);
      return;
    }
    this.child = child;
    child.stdout.on('data', (b: Buffer) => this._ingest(b.toString()));
    child.stderr.on('data', (b: Buffer) => this._ingest(b.toString()));
    // EPIPE on a dying pipe is async and would otherwise hit uncaughtException
    // (same trap as sshExec, §14.53).
    child.stdin.on('error', () => {});
    child.on('error', (e) => this._fail(`ssh error: ${e.message}`));
    child.on('close', (code) => {
      this.child = null;
      if (this.done) return;
      // The CLI exits once the code is accepted (or on failure) — ask the
      // authoritative source rather than guess from the exit code.
      void this._verifyOnce(true, code);
    });
    this.ttlTimer = setTimeout(() => {
      if (!this.done) this._fail('login attempt expired — start a new one');
    }, TTL_MS);
  }

  /** Feed the pasted OAuth code to the waiting CLI, then verify. */
  submitCode(code: string): void {
    const clean = code.trim();
    if (!clean) throw new Error('code required');
    if (this.done) throw new Error('login attempt already finished');
    if (!this.child) throw new Error('login attempt is no longer running');
    this.error = null;
    this.phase = 'verifying';
    // Mark where the post-submit output starts so a stale "Invalid code."
    // from a PREVIOUS attempt can't be mistaken for this one's verdict.
    this.buf = '';
    try {
      this.child.stdin.write(`${clean}\n`);
    } catch (e: any) {
      throw new Error(`could not send the code: ${e?.message ?? e}`);
    }
    this._scheduleVerify(Date.now() + VERIFY_BUDGET_MS);
  }

  /**
   * @param reap kill the REMOTE CLI too. Skipped when a NEW attempt for this
   *   same VPS is about to start: its own in-band sweep already clears the
   *   old process, and an async reap landing a second later would shoot the
   *   fresh attempt instead.
   */
  cancel({ reap = true }: { reap?: boolean } = {}): void {
    this._cleanupTimers();
    this.done = true;
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin.end(); } catch {}
      try { c.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 1500).unref();
    }
    if (reap) this._reapRemote();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Kill the REMOTE `claude auth login`.
   *
   * Dropping the local ssh is NOT enough. With `-T` there is no PTY, so no
   * SIGHUP reaches the remote process group when the connection dies, and the
   * CLI deliberately survives stdin EOF (it re-emits a url and keeps waiting,
   * §14.64). What is left is a ~165 MB process reparented to init, waiting on
   * a pipe nobody will ever write to — measured 5× on the fleet, ~800 MB held
   * hostage, the oldest 21 h in. So every terminal path reaps explicitly.
   *
   * Best-effort by construction: piggybacks the agent's ControlMaster when one
   * is up (`ControlMaster=no` joins an existing master, else opens a plain
   * connection — no new master left behind), detached, and hard-capped so a
   * hung ssh can never hold the event loop or the caller.
   */
  private _reapRemote(): void {
    const v = this.vps;
    if (!v) return;
    try {
      const child = spawn(
        'ssh',
        [
          ..._sshBaseArgs(v),
          '-o', 'ControlMaster=no',
          '-o', `ControlPath=${controlPath(v)}`,
          '-T',
          '--',
          `${v.sshUser}@${v.ip}`,
          `pkill -f '${REMOTE_MATCH}' 2>/dev/null || true`,
        ],
        { stdio: 'ignore' },
      );
      child.on('error', () => {});
      child.unref();
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, REAP_TIMEOUT_MS).unref();
    } catch {}
  }

  private _ingest(text: string): void {
    this.buf += text;
    this.tail = (this.tail + text).slice(-TAIL_MAX);
    if (this.buf.length > 64_000) this.buf = this.buf.slice(-8_000);
    const m = this.buf.match(RE_URL);
    if (m && m[1] !== this.url) {
      this.url = m[1];
      this.attempt += 1;
      // A fresh url after a rejected code returns us to the input step.
      if (this.phase === 'starting' || this.phase === 'verifying') this.phase = 'pending';
    }
    if (RE_INVALID.test(this.buf) && !this.done) {
      this.error = 'Invalid code — make sure the FULL code was copied, then retry below.';
      this.phase = 'pending';
      this._cleanupVerify();
    }
  }

  private _scheduleVerify(deadline: number): void {
    this._cleanupVerify();
    this.verifyTimer = setTimeout(async () => {
      if (this.done) return;
      // A rejected code short-circuits the poll (handled in _ingest).
      if (this.phase !== 'verifying') return;
      const settled = await this._verifyOnce(false, null);
      if (settled || this.done) return;
      if (Date.now() >= deadline) {
        this._fail('timed out waiting for the sign-in to be confirmed');
        return;
      }
      this._scheduleVerify(deadline);
    }, VERIFY_POLL_MS);
  }

  /**
   * Ask the VPS whether the CLI is now signed in.
   * @param final true when the ssh child already exited (last word).
   * @returns whether the attempt reached a terminal phase.
   */
  private async _verifyOnce(final: boolean, exitCode: number | null): Promise<boolean> {
    if (!this.vps || this.done) return this.done;
    const st = await readClaudeAuthStatus(this.vps);
    if (this.done) return true;
    if (st.ok && st.loggedIn) {
      this._succeed(st.account);
      return true;
    }
    if (final) {
      // Exited without being signed in: surface whatever the CLI last said.
      if (RE_INVALID.test(this.tail)) {
        this._fail('Invalid code — the sign-in was rejected. Start a new attempt.');
      } else {
        const hint = this.tail.trim().split('\n').filter(Boolean).slice(-2).join(' · ').slice(-200);
        this._fail(hint || `claude auth login exited (code=${exitCode ?? '?'}) without signing in`);
      }
      return true;
    }
    return false;
  }

  private _succeed(account: ClaudeAccount | null): void {
    this._cleanupTimers();
    this.done = true;
    this.phase = 'success';
    this.error = null;
    this.account = account;
    const v = this.vps;
    if (v) {
      // Persist + broadcast: mirrors the codex login route (§14.61). The flag
      // drives the sidebar "claude login" bar, the health chips and the
      // account-usage poll (which self-gates on claudeLoggedIn).
      try {
        db.update(vpsTable)
          .set({ claudeLoggedIn: 1, claudeLoggedInCheckedAt: Math.floor(Date.now() / 1000) })
          .where(eq(vpsTable.id, v.id)).run();
      } catch {}
      if (v.agentStatus === 'ok' || v.agentStatus === 'missing' || v.agentStatus === 'error') {
        emitGlobalVpsStatus(v.id, v.agentStatus, { claudeLoggedIn: 1 });
      }
    }
    // The CLI has already written its credentials (the status probe read them
    // back) — drop the ssh, then reap in case the CLI is still sitting on the
    // prompt rather than having exited on its own.
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin.end(); } catch {}
      try { c.kill('SIGTERM'); } catch {}
    }
    this._reapRemote();
  }

  private _fail(msg: string): void {
    this._cleanupTimers();
    this.done = true;
    this.phase = 'error';
    this.error = msg;
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin.end(); } catch {}
      try { c.kill('SIGTERM'); } catch {}
    }
    // Covers the TTL path: an abandoned modal is exactly how the orphans
    // observed on the fleet were born.
    this._reapRemote();
  }

  private _cleanupVerify(): void {
    if (this.verifyTimer) { clearTimeout(this.verifyTimer); this.verifyTimer = null; }
  }

  private _cleanupTimers(): void {
    this._cleanupVerify();
    if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; }
  }
}

// Global pool (1 attempt per VPS) — survives dev hot reloads.
const g = globalThis as unknown as { _loginSessions?: Map<string, ClaudeLoginSession> };
if (!g._loginSessions) g._loginSessions = new Map();
const pool: Map<string, ClaudeLoginSession> = g._loginSessions;

/** Start a fresh attempt, cancelling any previous one for this VPS. */
export function startLoginSession(vpsId: string): ClaudeLoginSession {
  const existing = pool.get(vpsId);
  if (existing) {
    // No reap: the fresh attempt's in-band sweep kills the old CLI, and an
    // async reap would otherwise race it and shoot the new one.
    existing.cancel({ reap: false });
    pool.delete(vpsId);
  }
  const sess = new ClaudeLoginSession(vpsId);
  pool.set(vpsId, sess);
  sess.start();
  return sess;
}

export function getLoginSession(vpsId: string): ClaudeLoginSession | null {
  return pool.get(vpsId) ?? null;
}

export function stopLoginSession(vpsId: string): void {
  const s = pool.get(vpsId);
  if (s) {
    s.cancel();
    pool.delete(vpsId);
  }
}

export type { ClaudeLoginSession };
