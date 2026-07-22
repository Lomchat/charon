import 'server-only';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Vps } from '@/lib/db/schema';
// Charon-scoped known_hosts — single source shared with the agent transport
// (sshShared.js) so every connection type trusts the same host keys.
import { KNOWN_HOSTS_PATH } from '@/lib/server/agent/sshShared.js';
import { getSetting } from './settings';

const DEFAULT_SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=4',
  '-T',
];

// `ssh.private_key_path` setting, same convention as sshShared.js /
// AgentClient: explicit -i only for a non-default key. Read per call (the
// settings layer caches) so an edit applies without a restart. This was one
// of the P1.2 gaps: bootstrap/scan/check-login went through here and IGNORED
// the configured key.
export function sshKeyArgs(): string[] {
  const keyPath = getSetting('ssh.private_key_path');
  return keyPath && keyPath !== '/root/.ssh/id_rsa' ? ['-i', keyPath] : [];
}

export type SshResult = { ok: boolean; stdout: string; stderr: string; code: number | null };

// ── SSH multiplexing (ControlMaster) ────────────────────────────────────────
// Open ONE TCP connection + handshake for a whole multi-phase flow (like the
// VPS bootstrap which fires 8-13 sshExec calls in sequence). Without this,
// every phase pays the full SSH handshake cost AND can hit transient TCP
// timeouts after a long `apt-get install` (sshd MaxStartups, conntrack
// saturation, fail2ban, etc.) — observed in the wild as `Connection timed
// out` on the first post-install `verify`.
//
// Mechanism: the first `sshExec` with a `session` opens a master (via
// `-o ControlMaster=auto -o ControlPath=<sock> -o ControlPersist=120`); the
// next ones reuse the same TCP. `ControlPersist=120` keeps the master alive
// for 2min after the last client closes (covers gaps between phases).
//
// The socket lives in `tmpdir()/charon-ssh-<8hex>.sock`. Linux's sun_path
// caps at ~108 chars — `/tmp/charon-ssh-XXXXXXXX.sock` ≈ 30 chars, plenty of
// headroom. On systems where /tmp is mounted with `noexec` or weird perms,
// `tmpdir()` honors `TMPDIR` env var → falls back gracefully.
//
// Closing: `closeSshSession()` issues `ssh -O exit -S <sock>` to terminate
// the master immediately (best-effort; if it's already gone, no-op).
// ControlPersist would do it eventually anyway, but explicit close avoids
// leaving a socket file dangling on the local FS.
export type SshSession = { controlPath: string; vps: Vps };

export function openSshSession(vps: Vps): SshSession {
  // 8 hex chars is plenty for uniqueness across concurrent bootstraps.
  const id = randomBytes(4).toString('hex');
  return { controlPath: path.join(tmpdir(), `charon-ssh-${id}.sock`), vps };
}

export async function closeSshSession(session: SshSession | undefined): Promise<void> {
  if (!session) return;
  // `ssh -O exit -S <sock> <user>@<host>` cleanly shuts down the master.
  // Best-effort: if no master is running (already expired, or never opened
  // because the first command failed before the handshake), this just
  // prints "No such file or directory" — fine.
  await new Promise<void>((resolve) => {
    const args = [
      '-O', 'exit',
      '-o', `ControlPath=${session.controlPath}`,
      '-p', String(session.vps.sshPort),
      '--',
      `${session.vps.sshUser}@${session.vps.ip}`,
    ];
    const child = spawn('ssh', args, { stdio: 'ignore' });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} ; resolve(); }, 3000);
    child.on('close', () => { clearTimeout(t); resolve(); });
    child.on('error', () => { clearTimeout(t); resolve(); });
  });
}

// Quote a string so it survives intact through a POSIX shell, no matter
// which characters it contains ($, `, \, ', ", \n, ;, etc.). Mandatory
// whenever we interpolate user input or a DB value into an SSH command —
// otherwise trivial injection (`cwd = "foo$(rm -rf /)"`).
export function shQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Execute a one-shot command on the VPS. Captures stdout/stderr/code.
// timeoutMs: hard kill if not finished in time.
//
// If `opts.session` is provided, multiplexes over the session's master
// (ControlMaster=auto + ControlPath). The FIRST sshExec on a fresh session
// opens the master as a side-effect; subsequent ones piggyback on the
// existing TCP — no extra handshake, no risk of post-burst timeouts.
export function sshExec(
  vps: Vps,
  command: string,
  opts: { timeoutMs?: number; stdin?: string; session?: SshSession } = {}
): Promise<SshResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const muxOpts = opts.session
      ? [
          '-o', 'ControlMaster=auto',
          '-o', `ControlPath=${opts.session.controlPath}`,
          '-o', 'ControlPersist=120',
        ]
      : [];
    const args = [
      ...DEFAULT_SSH_OPTS,
      ...muxOpts,
      ...sshKeyArgs(),
      '-p', String(vps.sshPort),
      // `--` ends option parsing — a value starting with '-' can never be
      // parsed as an ssh option (validated upstream too, cf. vpsValidate.ts).
      '--',
      `${vps.sshUser}@${vps.ip}`,
      command,
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    let settled = false;
    const done = (r: SshResult) => { if (settled) return; settled = true; resolve(r); };
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done({ ok: false, stdout, stderr: stderr + '\n[timeout]', code: null });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); done({ ok: false, stdout, stderr: stderr + '\n' + e.message, code: null }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      done({ ok: code === 0, stdout, stderr, code });
    });
    if (opts.stdin != null) {
      try { child.stdin.write(opts.stdin); } catch {}
    }
    try { child.stdin.end(); } catch {}
  });
}
