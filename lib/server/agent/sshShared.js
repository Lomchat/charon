/**
 * Shared SSH plumbing for talking to the charon-agent over `--connect`.
 *
 * SINGLE SOURCE OF TRUTH consumed by BOTH runtimes:
 *   - `lib/server/agent/AgentClient.ts` (Next/TS — the persistent per-VPS
 *     RPC client),
 *   - `server.js` at the repo root (plain Node — the per-WebSocket shell
 *     proxies).
 *
 * Before this module each side carried its own copy of the ssh options,
 * python lookup and remote path with "keep in sync" comments — the classic
 * silent-drift hazard. Plain CommonJS (not TS) so the root `server.js` can
 * `require()` it without a build step; tsconfig has `allowJs` so the TS side
 * imports it natively.
 *
 * ControlMaster multiplexing: every connection to a given VPS shares one SSH
 * master (TCP + handshake) via a per-VPS control socket in tmpdir. First
 * client up becomes the master (`ControlMaster=auto`), later ones piggyback
 * — so opening a shell WebSocket after the persistent AgentClient is already
 * connected costs ~0 handshakes. `ControlPersist=120` keeps the master
 * daemon alive 2 min past the last channel, and that daemon is a detached
 * background process: an individual client (e.g. an AgentClient reconnect
 * cycle) dying does NOT tear down the other channels. A stale/dead control
 * socket makes ssh print a warning and fall back to a direct connection —
 * degraded latency, never an outage.
 */
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REMOTE_AGENT_PATH, agentHomeEnvPrefix } = require('./agentPaths');

/**
 * Charon-scoped known_hosts. Keeps VPS host keys out of the operator's
 * personal ~/.ssh/known_hosts and gives StrictHostKeyChecking=accept-new a
 * dedicated trust store (first-seen keys land here; a later mismatch still
 * hard-fails). ssh creates the FILE itself but not the directory — ensure it
 * exists (best-effort: on failure ssh just can't persist the key and will
 * re-accept next time, degraded but never an outage).
 */
const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.ssh', 'charon_known_hosts');
try { fs.mkdirSync(path.dirname(KNOWN_HOSTS_PATH), { recursive: true, mode: 0o700 }); } catch {}

/**
 * Pick the newest python ≥ 3.10 on the VPS (the agent uses PEP 604 syntax;
 * the pyz shebang `python3` can still be 3.9 on RHEL/CentOS).
 */
const REMOTE_PY =
  '$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3)';

/**
 * Per-VPS ControlMaster socket path. Short + deterministic: unix socket
 * paths are capped (~104 chars) and the master must be shared across
 * processes, so no PID/random in the name — a hash of the endpoint is.
 * @param {{ip: string, sshUser: string, sshPort: number|string}} vps
 */
function controlPath(vps) {
  const key = crypto
    .createHash('sha256')
    .update(`${vps.sshUser}@${vps.ip}:${vps.sshPort}`)
    .digest('hex')
    .slice(0, 12);
  return path.join(os.tmpdir(), `charon-agent-mux-${key}.sock`);
}

/**
 * Build the full `ssh` argv (minus the binary itself) for an agent
 * `--connect` proxy to this VPS.
 *
 * @param {{ip: string, sshUser: string, sshPort: number|string}} vps
 * @param {{keyPath?: string|null, serverAliveInterval?: number, serverAliveCountMax?: number}} [opts]
 *   - keyPath: explicit private key (skipped for the default id_rsa).
 *   - serverAlive*: liveness probing. The persistent AgentClient uses a
 *     relaxed 30s×4; the per-WS shell proxies use a snappier 20s×3 so a dead
 *     link surfaces fast enough for the browser to reconnect.
 * @returns {string[]}
 */
function buildAgentSshArgs(vps, opts = {}) {
  const aliveInterval = opts.serverAliveInterval ?? 30;
  const aliveCount = opts.serverAliveCountMax ?? 4;
  const keyArgs =
    opts.keyPath && opts.keyPath !== '/root/.ssh/id_rsa' ? ['-i', opts.keyPath] : [];
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', `ServerAliveInterval=${aliveInterval}`,
    '-o', `ServerAliveCountMax=${aliveCount}`,
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath(vps)}`,
    '-o', 'ControlPersist=120',
    '-T',
    ...keyArgs,
    '-p', String(vps.sshPort),
    // `--` ends option parsing: a hostile/typo'd sshUser or ip starting with
    // `-` (e.g. `-oProxyCommand=...`) can never be parsed as an ssh option.
    // Validation upstream (lib/server/vpsValidate.ts) rejects those anyway —
    // this is the belt to that suspender.
    '--',
    `${vps.sshUser}@${vps.ip}`,
    // `agentHomeEnvPrefix()` points the proxy at THIS hub's socket. It is
    // empty for the default instance (byte-identical to the pre-instance
    // command); for a namespaced hub it is load-bearing, since the agent
    // derives the socket path from CHARON_AGENT_HOME — without it we would
    // proxy into the co-tenant's daemon (§14.70).
    `exec ${agentHomeEnvPrefix()}${REMOTE_PY} ${REMOTE_AGENT_PATH} --connect`,
  ];
}

module.exports = { REMOTE_AGENT_PATH, REMOTE_PY, KNOWN_HOSTS_PATH, buildAgentSshArgs, controlPath };
