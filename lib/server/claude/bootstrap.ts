import 'server-only';
import type { Vps } from '@/lib/db/schema';
import { sshExec } from './sshExec';

export type BootstrapPhase =
  | 'verify'        // tentative directe : python + import du SDK
  | 'detect_os'     // /etc/os-release
  | 'install_python'
  | 'install_sdk'
  | 'check_login'   // verif `claude config` ok
  | 'done';

export type BootstrapStatus = 'running' | 'ok' | 'error' | 'warn';

export type BootstrapEvent = {
  phase: BootstrapPhase;
  status: BootstrapStatus;
  detail?: string;
};

const PY_CHAIN =
  'command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10';

type OsInfo = { id: string; versionId: string; pkgMgr: 'apt' | 'dnf' | 'yum' | 'apk' | 'pacman' | 'unknown'; sudo: boolean };

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
  return { id, versionId, pkgMgr, sudo: false };
}

function pythonInstallCmd(os: OsInfo): string | null {
  // On vise python3.10+ (requis par claude-agent-sdk).
  switch (os.pkgMgr) {
    case 'apt':
      // Ubuntu 22.04+ et Debian 12+ ont python3 >= 3.10 directement
      return 'export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y python3 python3-pip python3-venv';
    case 'dnf':
    case 'yum': {
      const cmd = os.pkgMgr === 'dnf' ? 'dnf' : 'yum';
      // RHEL 9 / Rocky 9 : python3 = 3.9, mais python3.11 dispo en package
      return `${cmd} install -y python3.11 python3.11-pip 2>/dev/null || ${cmd} install -y python3.10 python3.10-pip 2>/dev/null || ${cmd} install -y python3 python3-pip`;
    }
    case 'apk':
      return 'apk add --no-cache python3 py3-pip';
    case 'pacman':
      return 'pacman -Sy --noconfirm python python-pip';
    default:
      return null;
  }
}

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

export async function* bootstrapVps(vps: Vps): AsyncIterable<BootstrapEvent> {
  // Phase 1 : verify direct (le chemin rapide)
  yield { phase: 'verify', status: 'running', detail: 'test : python + import claude_agent_sdk' };
  let v = await tryVerify(vps);
  if (v.ok) {
    yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
    yield { phase: 'done', status: 'ok' };
    return;
  }
  yield { phase: 'verify', status: 'warn', detail: v.reason === 'no_py' ? 'python3.10+ absent' : v.reason === 'no_sdk' ? 'sdk absent' : v.raw.slice(-160) };

  // Phase 2 : install python si manquant
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
      yield { phase: 'install_python', status: 'error', detail: (piR.stderr.slice(-300) || piR.stdout.slice(-300) || `exit ${piR.code}`) };
      return;
    }
    yield { phase: 'install_python', status: 'ok' };

    // re-verify after python install
    v = await tryVerify(vps);
    if (v.ok) {
      yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
      yield { phase: 'done', status: 'ok' };
      return;
    }
    if (v.reason === 'no_py') {
      yield { phase: 'install_python', status: 'error', detail: 'python introuvable même après install — chemin manquant dans PATH ?' };
      return;
    }
  }

  // Phase 3 : install SDK
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

  // Phase 4 : re-verify
  yield { phase: 'verify', status: 'running' };
  v = await tryVerify(vps);
  if (!v.ok) {
    yield { phase: 'verify', status: 'error', detail: v.raw.slice(-200) };
    return;
  }
  yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };

  // Phase 5 : info `claude login` (non bloquant ici, le bridge se planterait plus tard sinon)
  yield { phase: 'check_login', status: 'running' };
  const lr = await sshExec(vps, 'claude config get oauth.refresh_token 2>/dev/null > /dev/null && echo OK || echo MISSING', { timeoutMs: 8_000 });
  if (lr.stdout.includes('OK')) {
    yield { phase: 'check_login', status: 'ok' };
  } else {
    yield { phase: 'check_login', status: 'warn', detail: 'pas de claude login — fais `claude login` sur le VPS manuellement' };
  }

  yield { phase: 'done', status: 'ok' };
}
