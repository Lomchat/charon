import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { Vps } from '@/lib/db/schema';
import { sshExec } from './sshExec';

// ── Types d'événements (consommés par BootstrapBanner) ──────────────────────
export type BootstrapPhase =
  | 'verify'           // python + import SDK
  | 'detect_os'
  | 'install_python'
  | 'install_sdk'      // claude-agent-sdk
  | 'install_agent'    // dépose le .pyz
  | 'install_service'  // unit systemd-user (ou fallback)
  | 'ping_agent'       // teste que le daemon répond
  | 'check_login'      // claude login (warn-only)
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
      // Ubuntu 22.04+ / Debian 12+ ont python3 ≥ 3.10
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

// ── Vérif Python+SDK ────────────────────────────────────────────────────────
async function tryVerify(vps: Vps): Promise<{ ok: boolean; sdk?: string; py?: string; reason: 'no_py' | 'no_sdk' | 'ok' | 'other'; raw: string }> {
  const cmd =
    `PY=$(${PY_CHAIN}); ` +
    `if [ -z "$PY" ]; then echo "NO_PY"; exit 10; fi; ` +
    `echo "PY=$PY"; ` +
    `"$PY" -c 'import claude_agent_sdk; print("SDK=" + str(claude_agent_sdk.__version__))' 2>&1`;
  const r = await sshExec(vps, cmd, { timeoutMs: 12_000 });
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

// ── Agent : déploiement ─────────────────────────────────────────────────────
const AGENT_PYZ_PATH = path.join(process.cwd(), 'agent/dist/charon-agent.pyz');

function readAgentB64(): string {
  const buf = fs.readFileSync(AGENT_PYZ_PATH);
  return buf.toString('base64');
}

async function installAgentPyz(vps: Vps): Promise<{ ok: boolean; detail: string }> {
  let b64: string;
  try {
    b64 = readAgentB64();
  } catch (e: any) {
    return { ok: false, detail: `lecture du pyz local impossible : ${e?.message ?? e}` };
  }
  // Pipe le base64 via stdin pour éviter de gonfler la ligne de commande
  // (échec si la commande > ARG_MAX, ce qui arrive pour un blob de plusieurs Mo).
  const remoteCmd =
    'mkdir -p ~/.charon && ' +
    'base64 -d > ~/.charon/charon-agent.pyz.new && ' +
    'mv ~/.charon/charon-agent.pyz.new ~/.charon/charon-agent.pyz && ' +
    'chmod +x ~/.charon/charon-agent.pyz && ' +
    'echo OK';
  const r = await sshExec(vps, remoteCmd, { stdin: b64, timeoutMs: 60_000 });
  if (!r.ok || !r.stdout.includes('OK')) {
    return { ok: false, detail: (r.stderr.slice(-300) || r.stdout.slice(-300) || `exit ${r.code}`) };
  }
  return { ok: true, detail: '~/.charon/charon-agent.pyz' };
}

// ── Service systemd-user (avec fallback nohup) ──────────────────────────────
const SYSTEMD_UNIT = `[Unit]
Description=Charon Agent
After=default.target

[Service]
ExecStart=%h/.charon/charon-agent.pyz
Restart=on-failure
RestartSec=2
StandardOutput=append:%h/.charon/agent.log
StandardError=append:%h/.charon/agent.log

[Install]
WantedBy=default.target
`;

async function installAgentService(vps: Vps): Promise<{ ok: boolean; mode: 'systemd' | 'nohup'; detail: string }> {
  // Tentative systemd-user : drop l'unit, enable-linger, daemon-reload, restart.
  const unitB64 = Buffer.from(SYSTEMD_UNIT, 'utf8').toString('base64');
  const systemdScript = [
    // Crée le dir
    'mkdir -p ~/.config/systemd/user',
    // Dépose l'unit (base64 décode depuis stdin pour les heredoc à éviter)
    `echo '${unitB64}' | base64 -d > ~/.config/systemd/user/charon-agent.service`,
    // Active le linger (survit après logout). Tente sans sudo d'abord, puis avec sudo silencieux.
    'loginctl enable-linger "$(whoami)" 2>/dev/null || sudo -n loginctl enable-linger "$(whoami)" 2>/dev/null || true',
    // S'assure que XDG_RUNTIME_DIR est dispo (généralement créé automatiquement)
    'export XDG_RUNTIME_DIR=/run/user/$(id -u)',
    // Demande systemctl --user
    'systemctl --user daemon-reload',
    'systemctl --user enable charon-agent.service',
    'systemctl --user restart charon-agent.service',
    'sleep 1',
    'systemctl --user is-active charon-agent.service',
  ].join(' && ');
  const r = await sshExec(vps, systemdScript, { timeoutMs: 30_000 });
  if (r.ok && r.stdout.trim().endsWith('active')) {
    return { ok: true, mode: 'systemd', detail: 'systemd-user actif' };
  }

  // Fallback nohup : kill l'éventuel running, relance via crontab @reboot.
  const fallbackScript = [
    // Kill l'éventuelle instance qui tourne (si on remplace le binaire)
    "pkill -f '~/.charon/charon-agent.pyz' || pkill -f charon-agent.pyz || true",
    // Lance le daemon en arrière-plan, détaché
    "nohup setsid ~/.charon/charon-agent.pyz >> ~/.charon/agent.log 2>&1 < /dev/null &",
    "sleep 1",
    // S'assure qu'il y a une @reboot dans crontab
    "(crontab -l 2>/dev/null | grep -v 'charon-agent.pyz'; echo '@reboot ~/.charon/charon-agent.pyz >> ~/.charon/agent.log 2>&1 &') | crontab -",
    "echo OK_NOHUP",
  ].join('; ');
  const r2 = await sshExec(vps, fallbackScript, { timeoutMs: 15_000 });
  if (r2.ok && r2.stdout.includes('OK_NOHUP')) {
    const why = (r.stderr.slice(-200) || r.stdout.slice(-200) || 'systemd-user indispo').trim();
    return { ok: true, mode: 'nohup', detail: `fallback nohup+crontab (systemd : ${why})` };
  }
  return { ok: false, mode: 'nohup', detail: `systemd: ${r.stderr.slice(-200) || r.stdout.slice(-200)} | nohup: ${r2.stderr.slice(-200)}` };
}

async function pingAgent(vps: Vps): Promise<{ ok: boolean; version?: string; detail: string }> {
  // Donne un peu de temps au daemon pour démarrer
  await new Promise((r) => setTimeout(r, 800));
  const r = await sshExec(
    vps,
    `printf '{"id":1,"method":"ping"}\\n{"id":2,"method":"hello"}\\n' | ~/.charon/charon-agent.pyz --connect`,
    { timeoutMs: 8_000 },
  );
  if (!r.ok) {
    return { ok: false, detail: r.stderr.slice(-300) || `exit ${r.code}` };
  }
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  let version: string | undefined;
  let pingOk = false;
  for (const l of lines) {
    try {
      const msg = JSON.parse(l);
      if (msg?.result?.pong) pingOk = true;
      if (typeof msg?.result?.agent_version === 'string') version = msg.result.agent_version;
    } catch {}
  }
  if (!pingOk) return { ok: false, detail: 'pas de réponse pong : ' + r.stdout.slice(-300) };
  return { ok: true, version, detail: `agent ${version ?? '?'}` };
}

// ── Main flow ───────────────────────────────────────────────────────────────
export async function* bootstrapVps(vps: Vps): AsyncIterable<BootstrapEvent> {
  // Phase 1 : verify direct (chemin rapide)
  yield { phase: 'verify', status: 'running', detail: 'test : python + import claude_agent_sdk' };
  let v = await tryVerify(vps);
  if (v.ok) {
    yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
  } else {
    yield { phase: 'verify', status: 'warn', detail: v.reason === 'no_py' ? 'python3.10+ absent' : v.reason === 'no_sdk' ? 'sdk absent' : v.raw.slice(-160) };

    // Install Python si manquant
    if (v.reason === 'no_py') {
      yield { phase: 'detect_os', status: 'running' };
      const osR = await sshExec(vps, 'cat /etc/os-release 2>/dev/null', { timeoutMs: 6_000 });
      const os = parseOsRelease(osR.stdout);
      yield { phase: 'detect_os', status: 'ok', detail: `${os.id} ${os.versionId} (pkg: ${os.pkgMgr})` };

      const cmd = pythonInstallCmd(os);
      if (!cmd) {
        yield { phase: 'install_python', status: 'error', detail: `OS "${os.id}" non supporté pour install auto — installe python3.10+ manuellement` };
        return;
      }
      yield { phase: 'install_python', status: 'running', detail: `${os.pkgMgr} install python3.10+ — ça peut prendre 1 à 3 min` };
      const piR = await sshExec(vps, cmd, { timeoutMs: 300_000 });
      if (!piR.ok) {
        yield { phase: 'install_python', status: 'error', detail: piR.stderr.slice(-300) || piR.stdout.slice(-300) || `exit ${piR.code}` };
        return;
      }
      yield { phase: 'install_python', status: 'ok' };

      v = await tryVerify(vps);
      if (!v.ok && v.reason === 'no_py') {
        yield { phase: 'install_python', status: 'error', detail: 'python introuvable même après install — chemin manquant dans PATH ?' };
        return;
      }
    }

    // Install SDK si manquant
    if (!v.ok) {
      yield { phase: 'install_sdk', status: 'running', detail: 'pip install --user claude-agent-sdk' };
      const sdkCmd =
        `PY=$(${PY_CHAIN}); ` +
        `if [ -z "$PY" ]; then echo "NO_PY"; exit 10; fi; ` +
        `"$PY" -m pip install --user --upgrade claude-agent-sdk 2>&1 | tail -40`;
      const sdkR = await sshExec(vps, sdkCmd, { timeoutMs: 240_000 });
      if (!sdkR.ok) {
        yield { phase: 'install_sdk', status: 'error', detail: (sdkR.stdout + sdkR.stderr).slice(-400) };
        return;
      }
      yield { phase: 'install_sdk', status: 'ok' };

      v = await tryVerify(vps);
      if (!v.ok) {
        yield { phase: 'verify', status: 'error', detail: v.raw.slice(-200) };
        return;
      }
      yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
    }
  }

  // Phase 2 : install agent (drop .pyz)
  yield { phase: 'install_agent', status: 'running', detail: 'dépose ~/.charon/charon-agent.pyz' };
  const installR = await installAgentPyz(vps);
  if (!installR.ok) {
    yield { phase: 'install_agent', status: 'error', detail: installR.detail };
    return;
  }
  yield { phase: 'install_agent', status: 'ok', detail: installR.detail };

  // Phase 3 : install service (systemd-user puis fallback nohup)
  yield { phase: 'install_service', status: 'running', detail: 'unit systemd-user + start' };
  const svcR = await installAgentService(vps);
  if (!svcR.ok) {
    yield { phase: 'install_service', status: 'error', detail: svcR.detail };
    return;
  }
  yield { phase: 'install_service', status: svcR.mode === 'systemd' ? 'ok' : 'warn', detail: svcR.detail };

  // Phase 4 : ping_agent
  yield { phase: 'ping_agent', status: 'running' };
  const pingR = await pingAgent(vps);
  if (!pingR.ok) {
    yield { phase: 'ping_agent', status: 'error', detail: pingR.detail };
    return;
  }
  yield { phase: 'ping_agent', status: 'ok', detail: pingR.detail };

  // Phase 5 : check claude login (warn-only)
  yield { phase: 'check_login', status: 'running' };
  const lr = await sshExec(vps, 'claude config get oauth.refresh_token 2>/dev/null > /dev/null && echo OK || echo MISSING', { timeoutMs: 8_000 });
  if (lr.stdout.includes('OK')) {
    yield { phase: 'check_login', status: 'ok' };
  } else {
    yield { phase: 'check_login', status: 'warn', detail: 'pas de claude login — fais-le via le bouton "Setup login"' };
  }

  yield { phase: 'done', status: 'ok' };
}
