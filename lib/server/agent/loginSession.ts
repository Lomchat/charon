import 'server-only';
import { randomBytes } from 'crypto';
import { shQuote } from '@/lib/server/hub/sshExec';
import { requireAccountProfile, readProfileStatus } from './accountProfiles';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { getSetting } from '@/lib/server/hub/settings';
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
// Every attempt owns a separate remote process group and PID file. Reaping
// one profile must never kill a login being completed for another profile.
/** Attempts a crashed hub never reaped: their PID files outlive the TTL, so
 *  this can only reach those — a live attempt (any profile) is younger. */
const SWEEP_STALE_ATTEMPTS = `find /tmp -maxdepth 1 -name 'charon-login-*.pid' -mmin +${Math.ceil(TTL_MS / 60_000) + 1} 2>/dev/null | while read -r f; do pid=$(cat "$f" 2>/dev/null); case "$pid" in ''|*[!0-9]*) ;; *) case "$(ps -o args= -p "$pid" 2>/dev/null)" in *"claude auth login"*) kill -TERM -- "-$pid" 2>/dev/null ;; esac ;; esac; rm -f "$f"; done;`;
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
  readonly profile: string;
  private configDir: string | null = null;
  private remotePidFile: string | null = null;
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

  constructor(vpsId: string, profile = "default") {
    this.vpsId = vpsId;
    this.profile = profile;
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

  async start(): Promise<void> {
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).all();
    if (!v) {
      this._fail('vps not found');
      return;
    }
    this.vps = v;
    try {
      requireAccountProfile(v.id, 'claude', this.profile);
      if (this.profile !== 'default') {
        const st = await readProfileStatus(v.id, 'claude', this.profile);
        if (!st.config_dir) throw new Error('Account profile directory unavailable');
        this.configDir = st.config_dir;
      }
    } catch (e) { this._fail((e as Error).message); return; }
    if (this.done) return;
    const tag = randomBytes(8).toString('hex');
    this.remotePidFile = `/tmp/charon-login-${tag}.pid`;
    const inner = [
      'umask 077;',
      SWEEP_STALE_ATTEMPTS,
      `printf '%s' "$$" > ${shQuote(this.remotePidFile)};`,
      this.configDir ? `export CLAUDE_CONFIG_DIR=${shQuote(this.configDir)}; unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN;` : '',
      'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH";',
      `if command -v timeout >/dev/null 2>&1; then exec timeout ${Math.ceil(TTL_MS / 1000)} claude auth login; else exec claude auth login; fi`,
    ].join(' ');
    const args = [
      ..._sshBaseArgs(v),
      '-o', 'ServerAliveInterval=30',
      // -T (no PTY): the flow is line-oriented on both directions. See header.
      '-T',
      '--',
      `${v.sshUser}@${v.ip}`,
      // sshd's command is a process-group leader, so setsid forks. Wait for
      // that child: an early parent exit makes SSH close the code-input pipe.
      `exec setsid --wait sh -c ${shQuote(inner)}`,
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
   * @param reap kill this attempt's REMOTE CLI group too.
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

  /** Remote login survives local SSH exit. Reap only this attempt's group. */
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
          this.remotePidFile ? `if [ -f ${shQuote(this.remotePidFile)} ]; then pid=$(cat ${shQuote(this.remotePidFile)}); case "$pid" in ''|*[!0-9]*) ;; *) args=$(ps -o args= -p "$pid" 2>/dev/null); case "$args" in *"claude auth login"*) /bin/kill -TERM -- "-$pid" 2>/dev/null || true ;; esac ;; esac; rm -f ${shQuote(this.remotePidFile)}; fi` : 'true',
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
    const st = await readClaudeAuthStatus(this.vps, 8_000, this.profile);
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
    if (v && this.profile !== 'default') {
      void readProfileStatus(v.id, 'claude', this.profile, true).catch(() => {});
    }
    if (v && this.profile === 'default') {
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

// One attempt per VPS/profile; cancelling one must not reap another's process.
const g = globalThis as unknown as { _loginSessions?: Map<string, ClaudeLoginSession> };
if (!g._loginSessions) g._loginSessions = new Map();
const pool: Map<string, ClaudeLoginSession> = g._loginSessions;

/** Start a fresh attempt, cancelling any previous one for this VPS. */
export function startLoginSession(vpsId: string, profile = "default"): ClaudeLoginSession {
  requireAccountProfile(vpsId, 'claude', profile);
  const key = `${vpsId}:${profile}`;
  const existing = pool.get(key);
  if (existing) {
    // The private PID file keeps the old attempt's reap away from the new one.
    existing.cancel();
    pool.delete(key);
  }
  const sess = new ClaudeLoginSession(vpsId, profile);
  pool.set(key, sess);
  void sess.start();
  return sess;
}

export function getLoginSession(vpsId: string, profile = "default"): ClaudeLoginSession | null {
  return pool.get(`${vpsId}:${profile}`) ?? null;
}

export function stopLoginSession(vpsId: string, profile = "default"): void {
  const key = `${vpsId}:${profile}`;
  const s = pool.get(key);
  if (s) {
    s.cancel();
    pool.delete(key);
  }
}

export type { ClaudeLoginSession };
