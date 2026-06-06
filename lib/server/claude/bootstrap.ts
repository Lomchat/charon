import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { sshExec, openSshSession, closeSshSession, type SshResult, type SshSession } from './sshExec';

// ── Event types (consumed by InstallSessionView via the ring buffer of
// installSession.ts) ────────────────────────────────────────────────────────
export type BootstrapPhase =
  | 'verify'             // python + SDK import
  | 'detect_os'
  | 'install_python'
  | 'install_sdk'        // claude-agent-sdk (Python lib for the agent)
  | 'install_claude_cli' // `claude` CLI (curl install.sh — for `claude login`)
  | 'install_agent'      // drops the .pyz
  | 'install_service'    // systemd-user unit (or fallback)
  | 'ping_agent'         // tests that the daemon responds
  | 'check_login'        // claude login (warn-only)
  | 'done';

export type BootstrapStatus = 'running' | 'ok' | 'error' | 'warn';

export type BootstrapEvent = {
  phase: BootstrapPhase;
  status: BootstrapStatus;
  detail?: string;
};

// ── Helpers OS ──────────────────────────────────────────────────────────────
const PY_CHAIN =
  'command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10';

// The agent and the SDK always run in a dedicated venv at ~/.charon/venv.
// Benefits: no conflict with system packages, works around PEP 668
// (Debian 12 / Ubuntu 23+ refuse `pip install --user` by default), and
// keeps the same python path across install, verify, ping and systemd.
const VENV_DIR = '$HOME/.charon/venv';
const VENV_PY = `${VENV_DIR}/bin/python`;
// Bash snippet that resolves the right python: venv if it exists, otherwise
// the best system python. Used everywhere we have to invoke python on the VPS.
const PY_LOOKUP_VENV_OR_SYSTEM =
  `if [ -x ${VENV_PY} ]; then echo ${VENV_PY}; ` +
  `else command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3; fi`;

type OsInfo = { id: string; versionId: string; pkgMgr: 'apt' | 'dnf' | 'yum' | 'apk' | 'pacman' | 'unknown' };

function parseOsRelease(content: string): OsInfo {
  const map: Record<string, string> = {};
  for (const l of content.split('\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) map[m[1].toLowerCase()] = m[2].replace(/^"(.*)"$/, '$1');
  }
  const id = (map.id ?? 'unknown').toLowerCase();
  const versionId = map.version_id ?? '';
  let pkgMgr: OsInfo['pkgMgr'] = 'unknown';
  if (['ubuntu', 'debian', 'pop', 'linuxmint', 'raspbian'].includes(id)) pkgMgr = 'apt';
  else if (['rhel', 'centos', 'rocky', 'almalinux', 'fedora', 'amzn'].includes(id)) pkgMgr = 'dnf';
  else if (id === 'alpine') pkgMgr = 'apk';
  else if (['arch', 'manjaro', 'endeavouros'].includes(id)) pkgMgr = 'pacman';
  return { id, versionId, pkgMgr };
}

function pythonInstallCmd(os: OsInfo): string | null {
  switch (os.pkgMgr) {
    case 'apt':
      // Ubuntu 22.04+ / Debian 12+ have python3 ≥ 3.10
      return 'export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y python3 python3-pip python3-venv';
    case 'dnf':
    case 'yum': {
      const cmd = os.pkgMgr === 'dnf' ? 'dnf' : 'yum';
      return `${cmd} install -y python3.11 python3.11-pip 2>/dev/null || ${cmd} install -y python3.10 python3.10-pip 2>/dev/null || ${cmd} install -y python3 python3-pip`;
    }
    case 'apk': return 'apk add --no-cache python3 py3-pip';
    case 'pacman': return 'pacman -Sy --noconfirm python python-pip';
    default: return null;
  }
}

// ── SSH error detection helpers ─────────────────────────────────────────────
// An SSH error (connection refused, timeout, auth, unknown host) is fatal
// for the bootstrap: no point continuing to the next phases, they'll all
// fail the same way while eating several minutes of timeout. We detect
// early and abort cleanly with a useful message.
//
// Patterns observed in practice (captured from `ssh` stderr):
//   - "ssh: connect to host X port Y: Connection timed out"
//   - "ssh: connect to host X port Y: Connection refused"
//   - "ssh: connect to host X port Y: No route to host"
//   - "ssh: connect to host X port Y: Network is unreachable"
//   - "Host key verification failed."
//   - "Permission denied (publickey)" / "Permission denied (publickey,password)"
//   - "kex_exchange_identification: read: Connection reset by peer"
//   - "[timeout]" — injected by sshExec when the hard timeout fires
//
// SSH exit code 255 = connection error (different from the exit code of
// the remote program). We use it as an additional signal.
function detectSshFailure(r: SshResult): string | null {
  const blob = (r.stderr + '\n' + r.stdout);
  // Hard timeout of sshExec itself
  if (blob.includes('[timeout]')) return 'SSH timeout (command did not finish in time)';
  // Classic SSH errors (prefix `ssh:` or known patterns)
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/ssh: connect to host \S+ port \d+: (.+)/i, (m) => `SSH: ${m[1]}`],
    [/Host key verification failed/i, () => 'SSH: host key verification failed (host key changed or unknown?)'],
    [/Permission denied \(([^)]+)\)/i, (m) => `SSH: permission denied (${m[1]}) — invalid key or user`],
    [/kex_exchange_identification:.*Connection reset by peer/i, () => 'SSH: connection closed by peer during handshake (rate-limit? firewall?)'],
    [/Could not resolve hostname/i, () => 'SSH: hostname not found (DNS?)'],
  ];
  for (const [re, fmt] of patterns) {
    const m = blob.match(re);
    if (m) return fmt(m);
  }
  // Fallback: exit code 255 with no identified output = SSH crashed somewhere
  if (r.code === 255 && !r.stdout.trim()) {
    return `SSH failed (exit 255)${r.stderr.trim() ? `: ${r.stderr.trim().slice(-160)}` : ''}`;
  }
  return null;
}

// ── Python+SDK verification ─────────────────────────────────────────────────
async function tryVerify(vps: Vps, session?: SshSession): Promise<{ ok: boolean; sdk?: string; py?: string; reason: 'no_py' | 'no_sdk' | 'ok' | 'other' | 'ssh'; raw: string; sshError?: string }> {
  // Use the venv if it exists, otherwise the system python. If we fall on
  // a system python without the SDK, we signal 'no_sdk' → bootstrap will
  // create the venv + install in it. This way the verify no longer depends
  // on whether pip --user landed in the right spot.
  const cmd =
    `PY=$(${PY_LOOKUP_VENV_OR_SYSTEM}); ` +
    `if [ -z "$PY" ]; then echo "NO_PY"; exit 10; fi; ` +
    `echo "PY=$PY"; ` +
    `"$PY" -c 'import claude_agent_sdk; print("SDK=" + str(claude_agent_sdk.__version__))' 2>&1`;
  const r = await sshExec(vps, cmd, { timeoutMs: 12_000, session });
  // SSH detection BEFORE any other analysis: if the connection failed, we
  // have nothing useful in stdout/stderr, must abort.
  const sshErr = detectSshFailure(r);
  if (sshErr) return { ok: false, reason: 'ssh', raw: (r.stdout + r.stderr).trim(), sshError: sshErr };
  const out = (r.stdout + r.stderr).trim();
  if (out.includes('NO_PY')) return { ok: false, reason: 'no_py', raw: out };
  const pyMatch = out.match(/PY=(\S+)/);
  const sdkMatch = out.match(/SDK=(\S+)/);
  if (sdkMatch && pyMatch) return { ok: true, sdk: sdkMatch[1], py: pyMatch[1], reason: 'ok', raw: out };
  if (out.includes("No module named 'claude_agent_sdk'") || out.includes('ModuleNotFoundError')) {
    return { ok: false, reason: 'no_sdk', py: pyMatch?.[1], raw: out };
  }
  return { ok: false, reason: 'other', py: pyMatch?.[1], raw: out };
}

// ── Agent: deployment ───────────────────────────────────────────────────────
const AGENT_PYZ_PATH = path.join(process.cwd(), 'agent/dist/charon-agent.pyz');

function readAgentB64(): string {
  const buf = fs.readFileSync(AGENT_PYZ_PATH);
  return buf.toString('base64');
}

export async function installAgentPyz(vps: Vps, session?: SshSession): Promise<{ ok: boolean; detail: string }> {
  let b64: string;
  try {
    b64 = readAgentB64();
  } catch (e: any) {
    return { ok: false, detail: `cannot read local pyz: ${e?.message ?? e}` };
  }
  // Pipe the base64 via stdin to avoid bloating the command line (fails
  // if the command > ARG_MAX, which happens for a multi-MB blob).
  const remoteCmd =
    'mkdir -p ~/.charon && ' +
    'base64 -d > ~/.charon/charon-agent.pyz.new && ' +
    'mv ~/.charon/charon-agent.pyz.new ~/.charon/charon-agent.pyz && ' +
    'chmod +x ~/.charon/charon-agent.pyz && ' +
    'echo OK';
  const r = await sshExec(vps, remoteCmd, { stdin: b64, timeoutMs: 60_000, session });
  if (!r.ok || !r.stdout.includes('OK')) {
    return { ok: false, detail: (r.stderr.slice(-300) || r.stdout.slice(-300) || `exit ${r.code}`) };
  }
  return { ok: true, detail: '~/.charon/charon-agent.pyz' };
}

// ── systemd-user service (with nohup fallback) ──────────────────────────────
// The agent runs via the python from the venv ~/.charon/venv where we
// installed the SDK. Fallback: if for some reason the venv doesn't exist
// (shouldn't happen after bootstrap), we fall back to the best system python.
const SYSTEMD_UNIT = `[Unit]
Description=Charon Agent
After=default.target

[Service]
ExecStart=/bin/sh -c 'PY=%h/.charon/venv/bin/python; [ -x "$PY" ] || PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3); exec "$PY" %h/.charon/charon-agent.pyz'
Restart=always
RestartSec=2
StandardOutput=append:%h/.charon/agent.log
StandardError=append:%h/.charon/agent.log

[Install]
WantedBy=default.target
`;

async function installAgentService(vps: Vps, session?: SshSession): Promise<{ ok: boolean; mode: 'systemd' | 'nohup'; detail: string }> {
  // Try systemd-user: drop the unit, enable-linger, daemon-reload, restart.
  // IMPORTANT: on a fresh VPS where the user (often root) has NEVER had
  // an interactive session, the systemd user manager is not started and
  // the user dbus bus (/run/user/$UID/bus) doesn't exist. `systemctl --user`
  // then fails with "Failed to connect to bus: No such file or directory".
  // enable-linger alone is not enough: it takes effect at the next login OR
  // starts the manager if invoked AFTER. We force explicit startup via
  // `systemctl start user@$UID` (as root via sudo if needed).
  const unitB64 = Buffer.from(SYSTEMD_UNIT, 'utf8').toString('base64');
  const systemdScript = [
    // Create the dir
    'mkdir -p ~/.config/systemd/user',
    // Drop the unit (base64 decode from stdin to avoid heredocs)
    `echo '${unitB64}' | base64 -d > ~/.config/systemd/user/charon-agent.service`,
    // Enable linger (survives after logout). Try without sudo first, then with silent sudo.
    'loginctl enable-linger "$(whoami)" 2>/dev/null || sudo -n loginctl enable-linger "$(whoami)" 2>/dev/null || true',
    // EXPLICITLY start the user manager if not already active. This is what
    // creates /run/user/$UID/bus that `systemctl --user` will contact.
    // Without this, "Failed to connect to bus" on any fresh VPS.
    'systemctl start user@$(id -u).service 2>/dev/null || sudo -n systemctl start user@$(id -u).service 2>/dev/null || true',
    // Small delay to let the bus open
    'sleep 0.5',
    // Make sure XDG_RUNTIME_DIR is available (usually created automatically)
    'export XDG_RUNTIME_DIR=/run/user/$(id -u)',
    // Ask systemctl --user
    'systemctl --user daemon-reload',
    'systemctl --user enable charon-agent.service',
    'systemctl --user restart charon-agent.service',
    'sleep 1',
    'systemctl --user is-active charon-agent.service',
  ].join(' && ');
  const r = await sshExec(vps, systemdScript, { timeoutMs: 30_000, session });
  if (r.ok && r.stdout.trim().endsWith('active')) {
    return { ok: true, mode: 'systemd', detail: 'systemd-user active' };
  }

  // Nohup fallback: kill any running instance, relaunch via crontab @reboot.
  // Same as the systemd unit: use the venv if it exists, otherwise the
  // system python 3.10+.
  //
  // CHANGES vs the previous (broken) version:
  //  1. Join with '\n' instead of '; ' — otherwise the final `&` of nohup
  //     followed by the `;` of the join produces `&;` which is a bash
  //     syntax error.
  //  2. The crontab line is base64-encoded then decoded on the VPS side,
  //     rather than attempted with embedded \'...\' — bash does NOT support
  //     escaping a single quote inside a single-quoted string; you have to
  //     either close/reopen ('\''), or (simpler) avoid the question.
  const PY_LOOKUP = '$(if [ -x $HOME/.charon/venv/bin/python ]; then echo $HOME/.charon/venv/bin/python; else command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3; fi)';
  const cronLine = `@reboot sh -c 'exec ${PY_LOOKUP} ~/.charon/charon-agent.pyz' >> ~/.charon/agent.log 2>&1 &`;
  const cronLineB64 = Buffer.from(cronLine, 'utf8').toString('base64');
  const fallbackScript = [
    // Kill any running instance (if we're replacing the binary)
    "pkill -f 'charon-agent.pyz' || true",
    // Launch the daemon in the background, detached. The final `&` is
    // followed by a newline (join('\n')), so no broken `&;`.
    `nohup setsid sh -c 'exec ${PY_LOOKUP} ~/.charon/charon-agent.pyz' >> ~/.charon/agent.log 2>&1 < /dev/null &`,
    "sleep 1",
    // Make sure there's a @reboot in crontab. The cron line is sent as
    // base64 to avoid any quoting hell (the single-quotes of the inner
    // `sh -c '...'` wouldn't survive an echo inside another single-quoted
    // string).
    `(crontab -l 2>/dev/null | grep -v 'charon-agent.pyz'; echo '${cronLineB64}' | base64 -d) | crontab -`,
    "echo OK_NOHUP",
  ].join('\n');
  const r2 = await sshExec(vps, fallbackScript, { timeoutMs: 15_000, session });
  if (r2.ok && r2.stdout.includes('OK_NOHUP')) {
    const why = (r.stderr.slice(-200) || r.stdout.slice(-200) || 'systemd-user unavailable').trim();
    return { ok: true, mode: 'nohup', detail: `nohup+crontab fallback (systemd: ${why})` };
  }
  return { ok: false, mode: 'nohup', detail: `systemd: ${r.stderr.slice(-200) || r.stdout.slice(-200)} | nohup: ${r2.stderr.slice(-200)}` };
}

export async function pingAgent(vps: Vps, session?: SshSession): Promise<{ ok: boolean; version?: string; pyzSha?: string; detail: string }> {
  // Give the daemon a bit of time to start
  await new Promise((r) => setTimeout(r, 800));
  // Same: venv if it exists, otherwise system python ≥ 3.10
  const PY = `$(${PY_LOOKUP_VENV_OR_SYSTEM})`;
  const r = await sshExec(
    vps,
    `printf '{"id":1,"method":"ping"}\\n{"id":2,"method":"hello"}\\n' | ${PY} ~/.charon/charon-agent.pyz --connect`,
    { timeoutMs: 8_000, session },
  );
  if (!r.ok) {
    return { ok: false, detail: r.stderr.slice(-300) || `exit ${r.code}` };
  }
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  let version: string | undefined;
  let pyzSha: string | undefined;
  let pingOk = false;
  for (const l of lines) {
    try {
      const msg = JSON.parse(l);
      if (msg?.result?.pong) pingOk = true;
      if (typeof msg?.result?.agent_version === 'string') version = msg.result.agent_version;
      if (typeof msg?.result?.agent_pyz_sha === 'string') pyzSha = msg.result.agent_pyz_sha;
    } catch {}
  }
  if (!pingOk) return { ok: false, detail: 'no pong response: ' + r.stdout.slice(-300) };
  return { ok: true, version, pyzSha, detail: `agent ${version ?? '?'}${pyzSha ? ` (${pyzSha})` : ''}` };
}

// ── Update agent: deploy the pyz + restart the service + verify ────────────
// Distinct from the full bootstrap: we assume the venv + SDK + systemd unit
// already exist. We just want to swap the .pyz and restart. If the systemd
// restart fails (nohup fallback was used at bootstrap), we fall back on
// pkill+nohup.
export type UpdateAgentResult = {
  ok: boolean;
  oldVersion?: string;
  newVersion?: string;
  newPyzSha?: string;
  detail: string;
};

export async function updateVpsAgent(vps: Vps): Promise<UpdateAgentResult> {
  // Multiplex all 3 phases (deploy + restart + ping) over a single SSH
  // master. Saves ~3 handshakes and avoids the post-burst "Connection
  // timed out" trap (cf. bootstrapVps below).
  const session = openSshSession(vps);
  try {
    // Step 1: deploy
    const dep = await installAgentPyz(vps, session);
    if (!dep.ok) return { ok: false, detail: `deploy: ${dep.detail}` };

    // Step 2: restart. Try systemd-user then nohup fallback.
    // IMPORTANT: join with '\n' to preserve shell syntax (if/then/else/fi).
    // The previous bug joined with a space, producing illegal bash like
    // "export FOO=bar || true if systemctl..." that silently failed.
    const restartCmd = [
      'export XDG_RUNTIME_DIR=/run/user/$(id -u) 2>/dev/null || true',
      'if systemctl --user restart charon-agent.service 2>/dev/null; then',
      '  sleep 1',
      '  if systemctl --user is-active charon-agent.service >/dev/null 2>&1; then',
      '    echo OK_SYSTEMD',
      '    exit 0',
      '  fi',
      'fi',
      '# Nohup fallback: kill any running instance and relaunch detached',
      'pkill -f charon-agent.pyz 2>/dev/null || true',
      'sleep 0.5',
      'if [ -x "$HOME/.charon/venv/bin/python" ]; then',
      '  PY="$HOME/.charon/venv/bin/python"',
      'else',
      '  PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)',
      'fi',
      'if [ -z "$PY" ]; then',
      '  echo "NO_PYTHON" >&2',
      '  exit 11',
      'fi',
      'nohup setsid "$PY" "$HOME/.charon/charon-agent.pyz" >> "$HOME/.charon/agent.log" 2>&1 < /dev/null &',
      'sleep 1',
      'echo OK_NOHUP',
    ].join('\n');
    const rr = await sshExec(vps, restartCmd, { timeoutMs: 20_000, session });
    if (!rr.ok || !(rr.stdout.includes('OK_SYSTEMD') || rr.stdout.includes('OK_NOHUP'))) {
      const tail = (rr.stderr.slice(-300) || rr.stdout.slice(-300) || `exit ${rr.code}`).trim();
      return { ok: false, detail: `restart failed: ${tail}` };
    }

    // Step 3: ping to get the new version + sha (hello).
    // Retry once after 2s if the first ping fails — the daemon can take a
    // little time to open its socket depending on the machine.
    let ping = await pingAgent(vps, session);
    if (!ping.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      ping = await pingAgent(vps, session);
    }
    if (!ping.ok) {
      return { ok: false, detail: `ping after restart: ${ping.detail}` };
    }
    return { ok: true, newVersion: ping.version, newPyzSha: ping.pyzSha, detail: ping.detail };
  } finally {
    await closeSshSession(session);
  }
}

// ── Ensure the agent daemon is running (START-if-not-running) ──────────────
// Used by the manual "refresh agent" endpoint (POST /api/vps/[id]/agent/refresh)
// when a plain reconnect fails: the SSH `--connect` proxy exits 2 when the
// daemon's socket is absent (daemon dead). We then (re)start the daemon —
// but ONLY if it isn't already running, so we NEVER kill a live daemon's
// in-flight SDK turns. (The common "refresh" case is a transient transport
// drop where the daemon is alive; the route tries a bare reconnect FIRST and
// only calls this on failure.) This is `start`, not `restart`. Idempotent.
export type EnsureRunningResult = { ok: boolean; mode: 'already' | 'systemd' | 'nohup' | 'failed'; detail: string };
export async function ensureAgentRunning(vps: Vps): Promise<EnsureRunningResult> {
  const cmd = [
    'export XDG_RUNTIME_DIR=/run/user/$(id -u) 2>/dev/null || true',
    // Already running? Leave it strictly alone (don't disturb live sessions).
    "if pgrep -f 'charon-agent\\.pyz$' >/dev/null 2>&1 || systemctl --user is-active charon-agent.service >/dev/null 2>&1; then echo ALREADY; exit 0; fi",
    // systemd-user `start` (a no-op if somehow active; never `restart`).
    'if systemctl --user start charon-agent.service 2>/dev/null; then',
    '  sleep 1',
    '  if systemctl --user is-active charon-agent.service >/dev/null 2>&1; then echo OK_SYSTEMD; exit 0; fi',
    'fi',
    // nohup fallback (same PY resolution as install/update).
    'if [ -x "$HOME/.charon/venv/bin/python" ]; then PY="$HOME/.charon/venv/bin/python"; else PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); fi',
    '[ -z "$PY" ] && { echo NO_PYTHON >&2; exit 11; }',
    'nohup setsid "$PY" "$HOME/.charon/charon-agent.pyz" >> "$HOME/.charon/agent.log" 2>&1 < /dev/null &',
    'sleep 1',
    'echo OK_NOHUP',
  ].join('\n');
  const r = await sshExec(vps, cmd, { timeoutMs: 15_000 });
  const out = r.stdout;
  if (out.includes('ALREADY')) return { ok: true, mode: 'already', detail: 'daemon already running' };
  if (out.includes('OK_SYSTEMD')) return { ok: true, mode: 'systemd', detail: 'started via systemd --user' };
  if (out.includes('OK_NOHUP')) return { ok: true, mode: 'nohup', detail: 'started via nohup fallback' };
  const tail = (r.stderr.slice(-300) || out.slice(-300) || `exit ${r.code}`).trim();
  return { ok: false, mode: 'failed', detail: tail };
}

// ── Main flow ───────────────────────────────────────────────────────────────
export async function* bootstrapVps(vps: Vps): AsyncIterable<BootstrapEvent> {
  // Multiplex ALL phases over a single SSH master (cf. sshExec.ts §
  // SshSession). Why: every `sshExec` spawns a fresh `ssh` process, so
  // without multiplexing each phase pays a full TCP+SSH handshake. After
  // a long phase like `install_sdk` (apt-get + pip, 60-180s), the next
  // handshake can hit transient `Connection timed out` (sshd MaxStartups,
  // conntrack saturation, fail2ban, swap, etc.). With ControlMaster=auto,
  // the first call opens the master; the rest piggyback on the same TCP.
  // Closed in `finally` so the socket file doesn't leak.
  const session = openSshSession(vps);
  try {
    yield* bootstrapVpsInner(vps, session);
  } finally {
    await closeSshSession(session);
  }
}

async function* bootstrapVpsInner(vps: Vps, session: SshSession): AsyncIterable<BootstrapEvent> {
  // Phase 1: direct verify (fast path)
  yield { phase: 'verify', status: 'running', detail: 'test: python + import claude_agent_sdk' };
  let v = await tryVerify(vps, session);
  if (v.ok) {
    yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
  } else {
    // Broken SSH = fatal. No point trying the next phases, they'll all
    // fail the same way and eat the timeout. Yield an explicit done
    // error with the diagnostic message.
    if (v.reason === 'ssh') {
      yield { phase: 'verify', status: 'error', detail: v.sshError ?? 'SSH unreachable' };
      yield { phase: 'done', status: 'error', detail: `cannot SSH to ${vps.sshUser}@${vps.ip}:${vps.sshPort} — check the VPS, the key, the firewall` };
      return;
    }
    yield { phase: 'verify', status: 'warn', detail: v.reason === 'no_py' ? 'python3.10+ missing' : v.reason === 'no_sdk' ? 'sdk missing' : v.raw.slice(-160) };

    // Install Python if missing
    if (v.reason === 'no_py') {
      yield { phase: 'detect_os', status: 'running' };
      const osR = await sshExec(vps, 'cat /etc/os-release 2>/dev/null', { timeoutMs: 6_000, session });
      // SSH detection in case the connection broke between verify and here
      // (transient, firewall dropping, etc.) — same, abort cleanly.
      const osSsh = detectSshFailure(osR);
      if (osSsh) {
        yield { phase: 'detect_os', status: 'error', detail: osSsh };
        yield { phase: 'done', status: 'error', detail: `SSH dropped during detect_os: ${osSsh}` };
        return;
      }
      const os = parseOsRelease(osR.stdout);
      yield { phase: 'detect_os', status: 'ok', detail: `${os.id} ${os.versionId} (pkg: ${os.pkgMgr})` };

      const cmd = pythonInstallCmd(os);
      if (!cmd) {
        yield { phase: 'install_python', status: 'error', detail: `OS "${os.id}" not supported for auto install — install python3.10+ manually` };
        yield { phase: 'done', status: 'error', detail: 'unsupported OS' };
        return;
      }
      yield { phase: 'install_python', status: 'running', detail: `${os.pkgMgr} install python3.10+ — may take 1 to 3 min` };
      const piR = await sshExec(vps, cmd, { timeoutMs: 300_000, session });
      const piSsh = detectSshFailure(piR);
      if (piSsh) {
        yield { phase: 'install_python', status: 'error', detail: piSsh };
        yield { phase: 'done', status: 'error', detail: `SSH dropped during install_python: ${piSsh}` };
        return;
      }
      if (!piR.ok) {
        yield { phase: 'install_python', status: 'error', detail: piR.stderr.slice(-300) || piR.stdout.slice(-300) || `exit ${piR.code}` };
        yield { phase: 'done', status: 'error', detail: 'python install failed' };
        return;
      }
      yield { phase: 'install_python', status: 'ok' };

      v = await tryVerify(vps, session);
      if (v.reason === 'ssh') {
        yield { phase: 'verify', status: 'error', detail: v.sshError ?? 'SSH unreachable' };
        yield { phase: 'done', status: 'error', detail: `SSH unreachable after install_python: ${v.sshError ?? ''}` };
        return;
      }
      if (!v.ok && v.reason === 'no_py') {
        yield { phase: 'install_python', status: 'error', detail: 'python not found even after install — path missing in PATH?' };
        yield { phase: 'done', status: 'error', detail: 'python still not found' };
        return;
      }
    }

    // Install SDK if missing — in a dedicated venv at ~/.charon/venv.
    // The venv works around PEP 668 (Debian 12 / Ubuntu 23+ refuse `pip --user`)
    // and guarantees a consistent python across install / verify / ping / systemd.
    if (!v.ok) {
      yield { phase: 'install_sdk', status: 'running', detail: `venv ${VENV_DIR} + pip install claude-agent-sdk` };
      // pipefail: bubble up pip's exit code even when we pipe to tail
      // (without it, the pipeline returns 0 even when pip explodes →
      // bootstrap thought it worked and looped).
      //
      // Multi-line via '\n' (not '; ') to avoid the `&;` gotcha (cf. §14
      // gotcha 19) AND to be able to use readable `if/then/elif/else/fi`.
      //
      // ── venv auto-recovery (Debian/Ubuntu) ────────────────────────────
      // `python -m venv` can fail with "ensurepip is not available" /
      // "No module named ensurepip": that happens when python is installed
      // but the OS package providing the venv module (typically
      // python3.12-venv on Ubuntu 24.04, python3.11-venv on Debian 12,
      // etc.) is missing. The `install_python` phase above already covers
      // this via `apt-get install python3-venv`, BUT it only runs when
      // `verify` returns `no_py`. If python is already there but the venv
      // module is missing, we arrive here with `no_sdk` and the venv breaks.
      //
      // So: try the venv, look at the error message, and if it's the
      // ensurepip missing one, install `python$VER-venv` (then
      // `python3-venv` as fallback) best-effort, then retry. The old
      // fallback `--without-pip` + `ensurepip --upgrade` does NOT work
      // in this case: `ensurepip --upgrade` depends exactly on the module
      // that's missing.
      const sdkCmd = [
        `set -o pipefail`,
        `BASE=$(${PY_CHAIN} || command -v python3)`,
        `if [ -z "$BASE" ]; then echo "NO_PY"; exit 10; fi`,
        `echo "[install_sdk] base python = $BASE"`,
        // Major.minor of the python in use (e.g. "3.12"). Used to request
        // the right versioned package from apt/dnf.
        `PY_VER=$("$BASE" -c 'import sys; print("{}.{}".format(*sys.version_info[:2]))' 2>/dev/null || echo "")`,
        `echo "[install_sdk] python version = $PY_VER"`,
        // ── venv health check ──────────────────────────────────────────
        // The naive check `[ ! -x ${VENV_PY} ]` is NOT enough: on
        // Debian/Ubuntu when the `python$VER-venv` OS package is missing,
        // `python -m venv` partially creates the directory (the bin/python
        // symlink IS dropped) but `ensurepip` fails, leaving pip
        // uninstalled. So bin/python exists & is executable, but
        // `python -m pip` crashes with "No module named pip". Subsequent
        // runs would skip the auto-install entirely (binary exists → block
        // skipped) and fail straight away on `pip install`.
        //
        // Real test: does `python -m pip --version` work in the venv? If
        // not, the venv is broken — we wipe it, install the OS package,
        // and recreate from scratch.
        `VENV_OK=0`,
        `if [ -x ${VENV_PY} ] && ${VENV_PY} -m pip --version >/dev/null 2>&1; then`,
        `  VENV_OK=1`,
        `  echo "[install_sdk] venv healthy (pip available)"`,
        `fi`,
        `if [ "$VENV_OK" != "1" ]; then`,
        `  if [ -d ${VENV_DIR} ]; then`,
        `    echo "[install_sdk] venv broken or missing pip — wipe and recreate"`,
        `    rm -rf ${VENV_DIR}`,
        `  fi`,
        `  echo "[install_sdk] creating venv ${VENV_DIR}"`,
        // Capture the venv log so we can grep on it if it fails.
        // `|| true` to not kill the script via pipefail/set-e.
        `  VENV_LOG=$("$BASE" -m venv ${VENV_DIR} 2>&1 || true)`,
        `  echo "$VENV_LOG" | tail -20`,
        // Re-check health: pip must work, not just bin/python exist.
        `  VENV_HEALTHY=0`,
        `  if [ -x ${VENV_PY} ] && ${VENV_PY} -m pip --version >/dev/null 2>&1; then VENV_HEALTHY=1; fi`,
        // Auto-install the OS venv package if it's still broken AND the
        // symptom matches ("ensurepip is not available" OR pip missing
        // after bin/python exists — both point to the same root cause).
        `  if [ "$VENV_HEALTHY" != "1" ] && \\`,
        `     ( echo "$VENV_LOG" | grep -qE 'ensurepip is not available|No module named ensurepip' \\`,
        `       || ( [ -x ${VENV_PY} ] && ! ${VENV_PY} -m pip --version >/dev/null 2>&1 ) ); then`,
        `    echo "[install_sdk] venv module missing — auto-install OS package (python$PY_VER-venv or python3-venv)"`,
        `    if command -v apt-get >/dev/null 2>&1; then`,
        `      export DEBIAN_FRONTEND=noninteractive`,
        `      (apt-get update -y >/dev/null 2>&1 || sudo -n apt-get update -y >/dev/null 2>&1 || true)`,
        // Try python$VER-venv first (versioned, more accurate on
        // Ubuntu 24.04 which ships python3.12 separate from the python3
        // meta), then python3-venv (meta). Without/with sudo -n. tail -15
        // per attempt.
        `      (apt-get install -y "python$PY_VER-venv" 2>&1 \\`,
        `        || sudo -n apt-get install -y "python$PY_VER-venv" 2>&1 \\`,
        `        || apt-get install -y python3-venv 2>&1 \\`,
        `        || sudo -n apt-get install -y python3-venv 2>&1) | tail -15`,
        `    elif command -v dnf >/dev/null 2>&1; then`,
        // On Fedora/RHEL the venv module is in the python3 package itself.
        // But we cover the case where a side-by-side version (python3.11)
        // was installed without its sub-package. Best-effort.
        `      (dnf install -y "python$PY_VER" 2>&1 || sudo -n dnf install -y "python$PY_VER" 2>&1) | tail -15`,
        `    else`,
        `      echo "[install_sdk] no apt/dnf package manager detected — manual install required"`,
        `    fi`,
        // After installing the OS package, wipe any broken half-venv and
        // recreate from scratch. A partial venv left over from the
        // ensurepip failure won't self-heal — we need a fresh one.
        `    echo "[install_sdk] wipe partial venv and retry creation"`,
        `    rm -rf ${VENV_DIR}`,
        `    "$BASE" -m venv ${VENV_DIR} 2>&1 | tail -20 || true`,
        `  fi`,
        // Final health gate: bin/python AND pip must both work.
        `  if [ ! -x ${VENV_PY} ] || ! ${VENV_PY} -m pip --version >/dev/null 2>&1; then`,
        `    echo "[install_sdk] venv creation failed — install python$PY_VER-venv (apt) or python3-venv manually"`,
        `    exit 11`,
        `  fi`,
        `fi`,
        // Upgrade pip inside the venv to avoid warnings/edge-cases.
        `${VENV_PY} -m pip install --quiet --upgrade pip wheel setuptools 2>&1 | tail -10`,
        // Install the SDK. No `| tail` this time — we want the exit code
        // AND pipefail takes care of the rest anyway.
        `${VENV_PY} -m pip install --upgrade claude-agent-sdk 2>&1 | tail -40`,
        // Post-import check: the ONLY real proof that it works.
        `${VENV_PY} -c 'import claude_agent_sdk; print("[install_sdk] OK version=" + str(claude_agent_sdk.__version__))'`,
      ].join('\n');
      // 300s: we can now trigger an apt-get update + apt-get install
      // python$VER-venv on top of the pip install if the venv module was
      // missing.
      const sdkR = await sshExec(vps, sdkCmd, { timeoutMs: 300_000, session });
      const sdkSsh = detectSshFailure(sdkR);
      if (sdkSsh) {
        yield { phase: 'install_sdk', status: 'error', detail: sdkSsh };
        yield { phase: 'done', status: 'error', detail: `SSH dropped during install_sdk: ${sdkSsh}` };
        return;
      }
      const out = (sdkR.stdout + sdkR.stderr);
      const importedOk = /\[install_sdk\] OK version=/.test(out);
      if (!sdkR.ok || !importedOk) {
        yield { phase: 'install_sdk', status: 'error', detail: out.slice(-600) || `exit ${sdkR.code}` };
        yield { phase: 'done', status: 'error', detail: 'claude-agent-sdk install failed' };
        return;
      }
      // Get the version we just installed to show in the UI
      const vMatch = out.match(/\[install_sdk\] OK version=(\S+)/);
      yield { phase: 'install_sdk', status: 'ok', detail: vMatch ? `claude-agent-sdk ${vMatch[1]} in ${VENV_DIR}` : `installed in ${VENV_DIR}` };

      v = await tryVerify(vps, session);
      if (v.reason === 'ssh') {
        yield { phase: 'verify', status: 'error', detail: v.sshError ?? 'SSH unreachable' };
        yield { phase: 'done', status: 'error', detail: `SSH unreachable after install_sdk: ${v.sshError ?? ''}` };
        return;
      }
      if (!v.ok) {
        yield { phase: 'verify', status: 'error', detail: v.raw.slice(-200) };
        yield { phase: 'done', status: 'error', detail: 'post-install verify fails' };
        return;
      }
      yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
    }
  }

  // Phase 1.5: install Claude CLI (`claude`) if missing.
  // This is the shell CLI distinct from the Python SDK: required for
  // `claude login` (OAuth). The agent can run without it (it uses the
  // Python SDK), but the user won't be able to run `claude login` later
  // if the CLI is missing. So we install it systematically at bootstrap,
  // failure = warn not fatal.
  yield { phase: 'install_claude_cli', status: 'running', detail: 'checking for the claude CLI' };
  const ccCheck = await sshExec(
    vps,
    // Extended PATH: the non-interactive SSH shell has no .bashrc, so we
    // manually extend with the standard paths where install.sh might drop
    // the binary (~/.local/bin, ~/.claude/bin, /usr/local/bin).
    'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
    'if command -v claude >/dev/null 2>&1; then ' +
    '  echo "FOUND=$(command -v claude)"; ' +
    '  claude --version 2>&1 | head -1; ' +
    'else echo NOT_FOUND; fi',
    { timeoutMs: 8_000, session },
  );
  const ccSsh = detectSshFailure(ccCheck);
  if (ccSsh) {
    yield { phase: 'install_claude_cli', status: 'error', detail: ccSsh };
    yield { phase: 'done', status: 'error', detail: `SSH dropped during install_claude_cli: ${ccSsh}` };
    return;
  }
  const ccOut = (ccCheck.stdout + ccCheck.stderr).trim();
  if (!ccOut.includes('NOT_FOUND')) {
    // Already installed: extract the path + version for the detail
    const found = ccOut.match(/FOUND=(\S+)/);
    const version = ccOut.split('\n').find((l) => /\d+\.\d+/.test(l));
    yield {
      phase: 'install_claude_cli',
      status: 'ok',
      detail: `${version ?? 'claude'} (${found?.[1] ?? 'already installed'})`,
    };
  } else {
    yield {
      phase: 'install_claude_cli',
      status: 'running',
      detail: 'curl install.sh | bash — may take 30s',
    };
    // Anthropic's official installer. -fsSL = silent + fail-on-http-error +
    // follow-redirects. We capture the last 40 lines for debug if it fails.
    // 180s timeout for VPS with a slow connection.
    const installCcR = await sshExec(
      vps,
      'curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -40',
      { timeoutMs: 180_000, session },
    );
    const installCcSsh = detectSshFailure(installCcR);
    if (installCcSsh) {
      yield { phase: 'install_claude_cli', status: 'error', detail: installCcSsh };
      yield { phase: 'done', status: 'error', detail: `SSH dropped during install_claude_cli: ${installCcSsh}` };
      return;
    }
    // Re-check with the same extended PATH: if the binary is in
    // ~/.local/bin (typical for install.sh), the non-interactive SSH shell
    // without the PATH extension wouldn't see it and we'd warn for nothing.
    const recheck = await sshExec(
      vps,
      'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
      'if command -v claude >/dev/null 2>&1; then ' +
      '  echo "FOUND=$(command -v claude)"; ' +
      '  claude --version 2>&1 | head -1; ' +
      'else echo NOT_FOUND; fi',
      { timeoutMs: 8_000, session },
    );
    const recheckOut = (recheck.stdout + recheck.stderr).trim();
    if (recheckOut.includes('NOT_FOUND')) {
      // Not fatal: the agent can run without the claude CLI. We warn and
      // continue the rest of the bootstrap. The user can install manually
      // if `claude login` is needed later.
      const tail = (installCcR.stderr.slice(-300) || installCcR.stdout.slice(-300) || `exit ${installCcR.code}`).trim();
      yield {
        phase: 'install_claude_cli',
        status: 'warn',
        detail: `install failed, continuing anyway (the agent works without it). Detail: ${tail.slice(0, 200)}`,
      };
    } else {
      const found = recheckOut.match(/FOUND=(\S+)/);
      const version = recheckOut.split('\n').find((l) => /\d+\.\d+/.test(l));
      yield {
        phase: 'install_claude_cli',
        status: 'ok',
        detail: `${version ?? 'claude'} (${found?.[1] ?? 'installed'})`,
      };
    }
  }

  // Phase 2: install agent (drop .pyz)
  yield { phase: 'install_agent', status: 'running', detail: 'dropping ~/.charon/charon-agent.pyz' };
  const installR = await installAgentPyz(vps, session);
  if (!installR.ok) {
    yield { phase: 'install_agent', status: 'error', detail: installR.detail };
    yield { phase: 'done', status: 'error', detail: '.pyz drop failed' };
    return;
  }
  yield { phase: 'install_agent', status: 'ok', detail: installR.detail };

  // Phase 3: install service (systemd-user then nohup fallback)
  yield { phase: 'install_service', status: 'running', detail: 'systemd-user unit + start' };
  const svcR = await installAgentService(vps, session);
  if (!svcR.ok) {
    yield { phase: 'install_service', status: 'error', detail: svcR.detail };
    yield { phase: 'done', status: 'error', detail: 'systemd/nohup service install failed' };
    return;
  }
  yield { phase: 'install_service', status: svcR.mode === 'systemd' ? 'ok' : 'warn', detail: svcR.detail };

  // Phase 4: ping_agent
  yield { phase: 'ping_agent', status: 'running' };
  const pingR = await pingAgent(vps, session);
  if (!pingR.ok) {
    yield { phase: 'ping_agent', status: 'error', detail: pingR.detail };
    yield { phase: 'done', status: 'error', detail: 'the daemon is not responding to ping' };
    return;
  }
  yield { phase: 'ping_agent', status: 'ok', detail: pingR.detail };

  // Persist the version + sha to DB immediately. Otherwise the UI keeps
  // showing "agent outdated" until `AgentClient` connects (lazy, on 1st
  // access — typically at the 1st Claude session creation), and the user
  // clicks "update agent" for nothing. Cf. AgentClient.ts § hello which
  // does the same update: we deliberately duplicate here to have a
  // consistent DB state from the end of the bootstrap.
  try {
    db.update(vpsTable).set({
      agentStatus: 'ok',
      agentVersion: pingR.version ?? null,
      agentPyzSha: pingR.pyzSha ?? null,
      agentLastSeenAt: Math.floor(Date.now() / 1000),
    }).where(eq(vpsTable.id, vps.id)).run();
  } catch {}

  // Phase 5: check claude login (warn-only).
  // Extended PATH to find `claude` even if install.sh put it in
  // ~/.local/bin or ~/.claude/bin (cf. install_claude_cli above).
  yield { phase: 'check_login', status: 'running' };
  const lr = await sshExec(
    vps,
    'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
    'claude config get oauth.refresh_token 2>/dev/null > /dev/null && echo OK || echo MISSING',
    { timeoutMs: 8_000, session },
  );
  const isLoggedIn = lr.stdout.includes('OK');
  // Persist the state to DB so the sidebar can hide the "claude login"
  // button when not needed (cf. Sidebar.tsx § agentReady).
  try {
    db.update(vpsTable).set({
      claudeLoggedIn: isLoggedIn ? 1 : 0,
      claudeLoggedInCheckedAt: Math.floor(Date.now() / 1000),
    }).where(eq(vpsTable.id, vps.id)).run();
  } catch {}
  if (isLoggedIn) {
    yield { phase: 'check_login', status: 'ok' };
  } else {
    yield { phase: 'check_login', status: 'warn', detail: 'no claude login — do it via the "Setup login" button' };
  }

  yield { phase: 'done', status: 'ok' };
}
