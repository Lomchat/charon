import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { sshExec, type SshResult } from './sshExec';

// ── Types d'événements (consommés par InstallSessionView via le ring
// buffer de installSession.ts) ──────────────────────────────────────────────
export type BootstrapPhase =
  | 'verify'             // python + import SDK
  | 'detect_os'
  | 'install_python'
  | 'install_sdk'        // claude-agent-sdk (Python lib pour l'agent)
  | 'install_claude_cli' // CLI `claude` (curl install.sh — pour `claude login`)
  | 'install_agent'      // dépose le .pyz
  | 'install_service'    // unit systemd-user (ou fallback)
  | 'ping_agent'         // teste que le daemon répond
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

// L'agent et le SDK tournent toujours dans un venv dédié à ~/.charon/venv.
// Avantages : pas de conflit avec les paquets système, contourne PEP 668
// (Debian 12 / Ubuntu 23+ refusent `pip install --user` par défaut), et garde
// le même chemin python entre install, verify, ping et systemd.
const VENV_DIR = '$HOME/.charon/venv';
const VENV_PY = `${VENV_DIR}/bin/python`;
// Bash snippet qui résout le bon python : venv s'il existe, sinon le meilleur
// python système. Utilisé partout où on doit invoquer python sur le VPS.
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

// ── Helpers de détection d'erreur SSH ───────────────────────────────────────
// Une erreur SSH (connexion refusée, timeout, auth, hôte inconnu) est fatale
// pour le bootstrap : ça ne sert à rien de continuer sur les phases suivantes,
// elles vont toutes échouer pareil mais en mangeant plusieurs minutes de
// timeout. On détecte tôt et on abort proprement avec un message utile.
//
// Patterns observés en pratique (capturés depuis stderr de `ssh`) :
//   - "ssh: connect to host X port Y: Connection timed out"
//   - "ssh: connect to host X port Y: Connection refused"
//   - "ssh: connect to host X port Y: No route to host"
//   - "ssh: connect to host X port Y: Network is unreachable"
//   - "Host key verification failed."
//   - "Permission denied (publickey)" / "Permission denied (publickey,password)"
//   - "kex_exchange_identification: read: Connection reset by peer"
//   - "[timeout]" — injecté par sshExec quand le hard timeout frappe
//
// SSH exit code 255 = erreur de connexion (différent de l'exit code du
// programme distant). On l'utilise comme signal supplémentaire.
function detectSshFailure(r: SshResult): string | null {
  const blob = (r.stderr + '\n' + r.stdout);
  // Hard timeout du sshExec lui-même
  if (blob.includes('[timeout]')) return 'timeout SSH (commande pas finie à temps)';
  // Erreurs SSH classiques (préfixe `ssh:` ou patterns connus)
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/ssh: connect to host \S+ port \d+: (.+)/i, (m) => `SSH: ${m[1]}`],
    [/Host key verification failed/i, () => 'SSH : host key verification failed (clé hôte changée ou inconnue ?)'],
    [/Permission denied \(([^)]+)\)/i, (m) => `SSH : permission denied (${m[1]}) — clé ou user invalide`],
    [/kex_exchange_identification:.*Connection reset by peer/i, () => 'SSH : connexion fermée par le pair pendant le handshake (rate-limit ? firewall ?)'],
    [/Could not resolve hostname/i, () => 'SSH : nom d\'hôte introuvable (DNS ?)'],
  ];
  for (const [re, fmt] of patterns) {
    const m = blob.match(re);
    if (m) return fmt(m);
  }
  // Fallback : exit code 255 sans output identifié = SSH a planté quelque part
  if (r.code === 255 && !r.stdout.trim()) {
    return `SSH a échoué (exit 255)${r.stderr.trim() ? `: ${r.stderr.trim().slice(-160)}` : ''}`;
  }
  return null;
}

// ── Vérif Python+SDK ────────────────────────────────────────────────────────
async function tryVerify(vps: Vps): Promise<{ ok: boolean; sdk?: string; py?: string; reason: 'no_py' | 'no_sdk' | 'ok' | 'other' | 'ssh'; raw: string; sshError?: string }> {
  // On utilise le venv s'il existe, sinon le python système. Si on tombe sur
  // un python système et qu'il n'a pas le SDK, on signale 'no_sdk' → bootstrap
  // créera le venv + installera dedans. Ainsi le verify ne dépend plus du fait
  // que pip --user soit allé au bon endroit.
  const cmd =
    `PY=$(${PY_LOOKUP_VENV_OR_SYSTEM}); ` +
    `if [ -z "$PY" ]; then echo "NO_PY"; exit 10; fi; ` +
    `echo "PY=$PY"; ` +
    `"$PY" -c 'import claude_agent_sdk; print("SDK=" + str(claude_agent_sdk.__version__))' 2>&1`;
  const r = await sshExec(vps, cmd, { timeoutMs: 12_000 });
  // Détection SSH AVANT toute autre analyse : si la connexion a foiré, on n'a
  // rien d'utile dans stdout/stderr, faut abort.
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

// ── Agent : déploiement ─────────────────────────────────────────────────────
const AGENT_PYZ_PATH = path.join(process.cwd(), 'agent/dist/charon-agent.pyz');

function readAgentB64(): string {
  const buf = fs.readFileSync(AGENT_PYZ_PATH);
  return buf.toString('base64');
}

export async function installAgentPyz(vps: Vps): Promise<{ ok: boolean; detail: string }> {
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
// L'agent tourne via le python du venv ~/.charon/venv où on a installé le SDK.
// Fallback : si pour une raison X le venv n'existe pas (devrait pas arriver
// après bootstrap), on retombe sur le meilleur python système.
const SYSTEMD_UNIT = `[Unit]
Description=Charon Agent
After=default.target

[Service]
ExecStart=/bin/sh -c 'PY=%h/.charon/venv/bin/python; [ -x "$PY" ] || PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3); exec "$PY" %h/.charon/charon-agent.pyz'
Restart=on-failure
RestartSec=2
StandardOutput=append:%h/.charon/agent.log
StandardError=append:%h/.charon/agent.log

[Install]
WantedBy=default.target
`;

async function installAgentService(vps: Vps): Promise<{ ok: boolean; mode: 'systemd' | 'nohup'; detail: string }> {
  // Tentative systemd-user : drop l'unit, enable-linger, daemon-reload, restart.
  // IMPORTANT : sur un VPS frais où l'utilisateur (souvent root) n'a JAMAIS eu
  // de session interactive, le user manager systemd n'est pas démarré et le
  // bus dbus utilisateur (/run/user/$UID/bus) n'existe pas. `systemctl --user`
  // échoue alors avec "Failed to connect to bus: No such file or directory".
  // enable-linger seul ne suffit pas : il prend effet au prochain login OU
  // démarre le manager si on l'invoque APRÈS coup. On force le démarrage
  // explicite via `systemctl start user@$UID` (en root via sudo si besoin).
  const unitB64 = Buffer.from(SYSTEMD_UNIT, 'utf8').toString('base64');
  const systemdScript = [
    // Crée le dir
    'mkdir -p ~/.config/systemd/user',
    // Dépose l'unit (base64 décode depuis stdin pour les heredoc à éviter)
    `echo '${unitB64}' | base64 -d > ~/.config/systemd/user/charon-agent.service`,
    // Active le linger (survit après logout). Tente sans sudo d'abord, puis avec sudo silencieux.
    'loginctl enable-linger "$(whoami)" 2>/dev/null || sudo -n loginctl enable-linger "$(whoami)" 2>/dev/null || true',
    // Démarre EXPLICITEMENT le user manager si pas déjà actif. C'est ce qui
    // crée /run/user/$UID/bus que `systemctl --user` va contacter. Sans ça,
    // "Failed to connect to bus" sur tout VPS frais.
    'systemctl start user@$(id -u).service 2>/dev/null || sudo -n systemctl start user@$(id -u).service 2>/dev/null || true',
    // Petit délai pour laisser le bus s'ouvrir
    'sleep 0.5',
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
  // Idem que le unit systemd : on prend le venv s'il existe, sinon le python
  // système 3.10+.
  //
  // CHANGEMENTS vs la version précédente (qui était cassée) :
  //  1. Join avec '\n' au lieu de '; ' — sinon le `&` final du nohup suivi
  //     du `;` du join donne `&;` qui est une syntax error en bash.
  //  2. La ligne crontab est base64-encodée puis décodée côté VPS, plutôt
  //     que tentée avec \'...\' embeddé — bash ne supporte PAS l'escape de
  //     single-quote dans une single-quoted string ; il faut soit fermer/
  //     réouvrir ('\''), soit (plus simple) éviter la question.
  const PY_LOOKUP = '$(if [ -x $HOME/.charon/venv/bin/python ]; then echo $HOME/.charon/venv/bin/python; else command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3; fi)';
  const cronLine = `@reboot sh -c 'exec ${PY_LOOKUP} ~/.charon/charon-agent.pyz' >> ~/.charon/agent.log 2>&1 &`;
  const cronLineB64 = Buffer.from(cronLine, 'utf8').toString('base64');
  const fallbackScript = [
    // Kill l'éventuelle instance qui tourne (si on remplace le binaire)
    "pkill -f 'charon-agent.pyz' || true",
    // Lance le daemon en arrière-plan, détaché. Le `&` final est suivi d'un
    // newline (join('\n')), donc pas de `&;` foireux.
    `nohup setsid sh -c 'exec ${PY_LOOKUP} ~/.charon/charon-agent.pyz' >> ~/.charon/agent.log 2>&1 < /dev/null &`,
    "sleep 1",
    // S'assure qu'il y a une @reboot dans crontab. La ligne cron est envoyée
    // en base64 pour éviter tout enfer de quoting (les single-quotes du
    // `sh -c '...'` interne ne survivraient pas à un echo dans une autre
    // single-quoted string).
    `(crontab -l 2>/dev/null | grep -v 'charon-agent.pyz'; echo '${cronLineB64}' | base64 -d) | crontab -`,
    "echo OK_NOHUP",
  ].join('\n');
  const r2 = await sshExec(vps, fallbackScript, { timeoutMs: 15_000 });
  if (r2.ok && r2.stdout.includes('OK_NOHUP')) {
    const why = (r.stderr.slice(-200) || r.stdout.slice(-200) || 'systemd-user indispo').trim();
    return { ok: true, mode: 'nohup', detail: `fallback nohup+crontab (systemd : ${why})` };
  }
  return { ok: false, mode: 'nohup', detail: `systemd: ${r.stderr.slice(-200) || r.stdout.slice(-200)} | nohup: ${r2.stderr.slice(-200)}` };
}

export async function pingAgent(vps: Vps): Promise<{ ok: boolean; version?: string; pyzSha?: string; detail: string }> {
  // Donne un peu de temps au daemon pour démarrer
  await new Promise((r) => setTimeout(r, 800));
  // Idem : venv s'il existe, sinon python système ≥ 3.10
  const PY = `$(${PY_LOOKUP_VENV_OR_SYSTEM})`;
  const r = await sshExec(
    vps,
    `printf '{"id":1,"method":"ping"}\\n{"id":2,"method":"hello"}\\n' | ${PY} ~/.charon/charon-agent.pyz --connect`,
    { timeoutMs: 8_000 },
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
  if (!pingOk) return { ok: false, detail: 'pas de réponse pong : ' + r.stdout.slice(-300) };
  return { ok: true, version, pyzSha, detail: `agent ${version ?? '?'}${pyzSha ? ` (${pyzSha})` : ''}` };
}

// ── Update agent : déploie le pyz + restart le service + verify ────────────
// Distinct du bootstrap complet : on suppose que le venv + le SDK + l'unit
// systemd existent déjà. On veut juste swap le .pyz et redémarrer. Si le
// restart systemd échoue (fallback nohup avait été utilisé au bootstrap),
// on retombe sur pkill+nohup.
export type UpdateAgentResult = {
  ok: boolean;
  oldVersion?: string;
  newVersion?: string;
  newPyzSha?: string;
  detail: string;
};

export async function updateVpsAgent(vps: Vps): Promise<UpdateAgentResult> {
  // Step 1 : deploy
  const dep = await installAgentPyz(vps);
  if (!dep.ok) return { ok: false, detail: `deploy: ${dep.detail}` };

  // Step 2 : restart. Tente systemd-user puis fallback nohup.
  // IMPORTANT : on joint avec '\n' pour préserver la syntaxe shell (if/then/
  // else/fi). Le bug précédent joignait avec un espace, produisant du bash
  // illégal type "export FOO=bar || true if systemctl..." qui foirait silencieux.
  const restartCmd = [
    'export XDG_RUNTIME_DIR=/run/user/$(id -u) 2>/dev/null || true',
    'if systemctl --user restart charon-agent.service 2>/dev/null; then',
    '  sleep 1',
    '  if systemctl --user is-active charon-agent.service >/dev/null 2>&1; then',
    '    echo OK_SYSTEMD',
    '    exit 0',
    '  fi',
    'fi',
    '# Fallback nohup : kill l\'éventuel running et relance détaché',
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
  const rr = await sshExec(vps, restartCmd, { timeoutMs: 20_000 });
  if (!rr.ok || !(rr.stdout.includes('OK_SYSTEMD') || rr.stdout.includes('OK_NOHUP'))) {
    const tail = (rr.stderr.slice(-300) || rr.stdout.slice(-300) || `exit ${rr.code}`).trim();
    return { ok: false, detail: `restart failed: ${tail}` };
  }

  // Step 3 : ping pour récupérer la nouvelle version + sha (hello).
  // Retry une fois après 2s si le premier ping échoue — le daemon peut mettre
  // un peu de temps à ouvrir son socket selon la machine.
  let ping = await pingAgent(vps);
  if (!ping.ok) {
    await new Promise((r) => setTimeout(r, 2000));
    ping = await pingAgent(vps);
  }
  if (!ping.ok) {
    return { ok: false, detail: `ping after restart: ${ping.detail}` };
  }
  return { ok: true, newVersion: ping.version, newPyzSha: ping.pyzSha, detail: ping.detail };
}

// ── Main flow ───────────────────────────────────────────────────────────────
export async function* bootstrapVps(vps: Vps): AsyncIterable<BootstrapEvent> {
  // Phase 1 : verify direct (chemin rapide)
  yield { phase: 'verify', status: 'running', detail: 'test : python + import claude_agent_sdk' };
  let v = await tryVerify(vps);
  if (v.ok) {
    yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
  } else {
    // SSH cassé = fatal. Pas la peine de tenter les phases suivantes, elles
    // vont toutes échouer pareil en mangeant le timeout. On yield un done
    // error explicite avec le message diagnostique.
    if (v.reason === 'ssh') {
      yield { phase: 'verify', status: 'error', detail: v.sshError ?? 'SSH inaccessible' };
      yield { phase: 'done', status: 'error', detail: `connexion SSH à ${vps.sshUser}@${vps.ip}:${vps.sshPort} impossible — vérifie le VPS, la clé, le firewall` };
      return;
    }
    yield { phase: 'verify', status: 'warn', detail: v.reason === 'no_py' ? 'python3.10+ absent' : v.reason === 'no_sdk' ? 'sdk absent' : v.raw.slice(-160) };

    // Install Python si manquant
    if (v.reason === 'no_py') {
      yield { phase: 'detect_os', status: 'running' };
      const osR = await sshExec(vps, 'cat /etc/os-release 2>/dev/null', { timeoutMs: 6_000 });
      // Détection SSH au cas où la connexion s'est cassée entre verify et là
      // (transient, firewall qui drop, etc.) — pareil, on abort proprement.
      const osSsh = detectSshFailure(osR);
      if (osSsh) {
        yield { phase: 'detect_os', status: 'error', detail: osSsh };
        yield { phase: 'done', status: 'error', detail: `SSH a lâché pendant detect_os : ${osSsh}` };
        return;
      }
      const os = parseOsRelease(osR.stdout);
      yield { phase: 'detect_os', status: 'ok', detail: `${os.id} ${os.versionId} (pkg: ${os.pkgMgr})` };

      const cmd = pythonInstallCmd(os);
      if (!cmd) {
        yield { phase: 'install_python', status: 'error', detail: `OS "${os.id}" non supporté pour install auto — installe python3.10+ manuellement` };
        yield { phase: 'done', status: 'error', detail: 'OS non supporté' };
        return;
      }
      yield { phase: 'install_python', status: 'running', detail: `${os.pkgMgr} install python3.10+ — ça peut prendre 1 à 3 min` };
      const piR = await sshExec(vps, cmd, { timeoutMs: 300_000 });
      const piSsh = detectSshFailure(piR);
      if (piSsh) {
        yield { phase: 'install_python', status: 'error', detail: piSsh };
        yield { phase: 'done', status: 'error', detail: `SSH a lâché pendant install_python : ${piSsh}` };
        return;
      }
      if (!piR.ok) {
        yield { phase: 'install_python', status: 'error', detail: piR.stderr.slice(-300) || piR.stdout.slice(-300) || `exit ${piR.code}` };
        yield { phase: 'done', status: 'error', detail: 'install python a échoué' };
        return;
      }
      yield { phase: 'install_python', status: 'ok' };

      v = await tryVerify(vps);
      if (v.reason === 'ssh') {
        yield { phase: 'verify', status: 'error', detail: v.sshError ?? 'SSH inaccessible' };
        yield { phase: 'done', status: 'error', detail: `SSH inaccessible après install_python : ${v.sshError ?? ''}` };
        return;
      }
      if (!v.ok && v.reason === 'no_py') {
        yield { phase: 'install_python', status: 'error', detail: 'python introuvable même après install — chemin manquant dans PATH ?' };
        yield { phase: 'done', status: 'error', detail: 'python toujours introuvable' };
        return;
      }
    }

    // Install SDK si manquant — dans un venv dédié à ~/.charon/venv.
    // Le venv contourne PEP 668 (Debian 12 / Ubuntu 23+ refusent `pip --user`)
    // et garantit un python identique entre install / verify / ping / systemd.
    if (!v.ok) {
      yield { phase: 'install_sdk', status: 'running', detail: `venv ${VENV_DIR} + pip install claude-agent-sdk` };
      // pipefail : remonte l'exit code de pip même si on pipe vers tail (sans
      // ça, le pipeline retourne 0 même quand pip explose → bootstrap croyait
      // que ça avait marché et bouclait).
      //
      // Multi-line via '\n' (pas '; ') pour éviter le piège `&;` (cf. §14
      // piège 19) ET pour pouvoir utiliser `if/then/elif/else/fi` lisible.
      //
      // ── Auto-recovery venv (Debian/Ubuntu) ────────────────────────────
      // `python -m venv` peut échouer avec "ensurepip is not available" /
      // "No module named ensurepip" : ça arrive quand python est installé
      // mais que le paquet OS qui fournit le module venv (typiquement
      // python3.12-venv sur Ubuntu 24.04, python3.11-venv sur Debian 12,
      // etc.) manque. La phase `install_python` plus haut couvre déjà ça
      // via `apt-get install python3-venv`, MAIS elle ne tourne que quand
      // `verify` retourne `no_py`. Si python est déjà là mais que le venv
      // module manque, on arrive ici avec `no_sdk` et le venv pète.
      //
      // Donc : on tente le venv, on regarde le message d'erreur, et si
      // c'est l'ensurepip qui manque on installe `python$VER-venv` (puis
      // `python3-venv` en fallback) en best-effort, puis on retry.
      // L'ancien fallback `--without-pip` + `ensurepip --upgrade` ne marche
      // PAS dans ce cas : `ensurepip --upgrade` dépend exactement du
      // module qui manque.
      const sdkCmd = [
        `set -o pipefail`,
        `BASE=$(${PY_CHAIN} || command -v python3)`,
        `if [ -z "$BASE" ]; then echo "NO_PY"; exit 10; fi`,
        `echo "[install_sdk] base python = $BASE"`,
        // Major.minor du python utilisé (ex: "3.12"). Sert à demander le
        // bon paquet versionné à apt/dnf.
        `PY_VER=$("$BASE" -c 'import sys; print("{}.{}".format(*sys.version_info[:2]))' 2>/dev/null || echo "")`,
        `echo "[install_sdk] python version = $PY_VER"`,
        `if [ ! -x ${VENV_PY} ]; then`,
        `  echo "[install_sdk] creating venv ${VENV_DIR}"`,
        // Capture le log du venv pour pouvoir grep dessus si ça foire.
        // `|| true` pour ne pas tuer le script via pipefail/set-e.
        `  VENV_LOG=$("$BASE" -m venv ${VENV_DIR} 2>&1 || true)`,
        `  echo "$VENV_LOG" | tail -20`,
        // Si le venv n'existe pas ET que le log mentionne ensurepip :
        // c'est le paquet OS qui manque. Tente apt puis dnf en best-effort.
        `  if [ ! -x ${VENV_PY} ] && echo "$VENV_LOG" | grep -qE 'ensurepip is not available|No module named ensurepip'; then`,
        `    echo "[install_sdk] module venv manquant — auto-install du paquet OS (python$PY_VER-venv ou python3-venv)"`,
        `    if command -v apt-get >/dev/null 2>&1; then`,
        `      export DEBIAN_FRONTEND=noninteractive`,
        `      (apt-get update -y >/dev/null 2>&1 || sudo -n apt-get update -y >/dev/null 2>&1 || true)`,
        // Tente d'abord python$VER-venv (versionné, plus précis sur
        // Ubuntu 24.04 qui ship python3.12 séparé du méta python3), puis
        // python3-venv (meta). Sans/avec sudo -n. tail -15 par tentative.
        `      (apt-get install -y "python$PY_VER-venv" 2>&1 \\`,
        `        || sudo -n apt-get install -y "python$PY_VER-venv" 2>&1 \\`,
        `        || apt-get install -y python3-venv 2>&1 \\`,
        `        || sudo -n apt-get install -y python3-venv 2>&1) | tail -15`,
        `    elif command -v dnf >/dev/null 2>&1; then`,
        // Sur Fedora/RHEL le module venv est dans le paquet python3 lui-même.
        // Mais on couvre le cas où une version side-by-side (python3.11)
        // a été installée sans son sous-paquet. Best-effort.
        `      (dnf install -y "python$PY_VER" 2>&1 || sudo -n dnf install -y "python$PY_VER" 2>&1) | tail -15`,
        `    else`,
        `      echo "[install_sdk] pas de package manager apt/dnf détecté — install manuelle requise"`,
        `    fi`,
        `    echo "[install_sdk] retry venv creation"`,
        `    "$BASE" -m venv ${VENV_DIR} 2>&1 | tail -20 || true`,
        `  fi`,
        `  if [ ! -x ${VENV_PY} ]; then`,
        `    echo "[install_sdk] venv creation failed — install python$PY_VER-venv (apt) ou python3-venv manuellement"`,
        `    exit 11`,
        `  fi`,
        `fi`,
        // Upgrade pip dans le venv pour éviter les warnings/edge-cases.
        `${VENV_PY} -m pip install --quiet --upgrade pip wheel setuptools 2>&1 | tail -10`,
        // Install du SDK. Sans `| tail` cette fois — on veut l'exit code ET
        // pipefail s'occupe du reste de toute façon.
        `${VENV_PY} -m pip install --upgrade claude-agent-sdk 2>&1 | tail -40`,
        // Post-check d'import : la SEULE vraie preuve que c'est bon.
        `${VENV_PY} -c 'import claude_agent_sdk; print("[install_sdk] OK version=" + str(claude_agent_sdk.__version__))'`,
      ].join('\n');
      // 300s : on peut maintenant déclencher un apt-get update + apt-get install
      // python$VER-venv en plus du pip install si le module venv manquait.
      const sdkR = await sshExec(vps, sdkCmd, { timeoutMs: 300_000 });
      const sdkSsh = detectSshFailure(sdkR);
      if (sdkSsh) {
        yield { phase: 'install_sdk', status: 'error', detail: sdkSsh };
        yield { phase: 'done', status: 'error', detail: `SSH a lâché pendant install_sdk : ${sdkSsh}` };
        return;
      }
      const out = (sdkR.stdout + sdkR.stderr);
      const importedOk = /\[install_sdk\] OK version=/.test(out);
      if (!sdkR.ok || !importedOk) {
        yield { phase: 'install_sdk', status: 'error', detail: out.slice(-600) || `exit ${sdkR.code}` };
        yield { phase: 'done', status: 'error', detail: 'install claude-agent-sdk a échoué' };
        return;
      }
      // Récupère la version qu'on vient d'installer pour l'afficher dans le UI
      const vMatch = out.match(/\[install_sdk\] OK version=(\S+)/);
      yield { phase: 'install_sdk', status: 'ok', detail: vMatch ? `claude-agent-sdk ${vMatch[1]} dans ${VENV_DIR}` : `installé dans ${VENV_DIR}` };

      v = await tryVerify(vps);
      if (v.reason === 'ssh') {
        yield { phase: 'verify', status: 'error', detail: v.sshError ?? 'SSH inaccessible' };
        yield { phase: 'done', status: 'error', detail: `SSH inaccessible après install_sdk : ${v.sshError ?? ''}` };
        return;
      }
      if (!v.ok) {
        yield { phase: 'verify', status: 'error', detail: v.raw.slice(-200) };
        yield { phase: 'done', status: 'error', detail: 'verify post-install échoue' };
        return;
      }
      yield { phase: 'verify', status: 'ok', detail: `${v.py} · sdk ${v.sdk}` };
    }
  }

  // Phase 1.5 : install Claude CLI (`claude`) si absent.
  // C'est la CLI shell distincte du SDK Python : nécessaire pour `claude login`
  // (OAuth). L'agent peut tourner sans (il utilise le SDK Python), mais l'user
  // ne pourra pas faire `claude login` plus tard si la CLI manque. Donc on
  // l'installe systématiquement quand bootstrap, échec = warn pas fatal.
  yield { phase: 'install_claude_cli', status: 'running', detail: 'vérifie présence de la CLI claude' };
  const ccCheck = await sshExec(
    vps,
    // PATH étoffé : le shell SSH non-interactif n'a pas .bashrc, donc on
    // étend manuellement avec les paths standards où install.sh peut déposer
    // le binaire (~/.local/bin, ~/.claude/bin, /usr/local/bin).
    'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
    'if command -v claude >/dev/null 2>&1; then ' +
    '  echo "FOUND=$(command -v claude)"; ' +
    '  claude --version 2>&1 | head -1; ' +
    'else echo NOT_FOUND; fi',
    { timeoutMs: 8_000 },
  );
  const ccSsh = detectSshFailure(ccCheck);
  if (ccSsh) {
    yield { phase: 'install_claude_cli', status: 'error', detail: ccSsh };
    yield { phase: 'done', status: 'error', detail: `SSH a lâché pendant install_claude_cli : ${ccSsh}` };
    return;
  }
  const ccOut = (ccCheck.stdout + ccCheck.stderr).trim();
  if (!ccOut.includes('NOT_FOUND')) {
    // Déjà installé : on extrait le path + version pour le détail
    const found = ccOut.match(/FOUND=(\S+)/);
    const version = ccOut.split('\n').find((l) => /\d+\.\d+/.test(l));
    yield {
      phase: 'install_claude_cli',
      status: 'ok',
      detail: `${version ?? 'claude'} (${found?.[1] ?? 'déjà installé'})`,
    };
  } else {
    yield {
      phase: 'install_claude_cli',
      status: 'running',
      detail: 'curl install.sh | bash — peut prendre 30s',
    };
    // L'installer officiel d'Anthropic. -fsSL = silent + fail-on-http-error +
    // follow-redirects. On capture les 40 dernières lignes pour debug si ça
    // foire. timeout 180s pour les VPS avec une connexion lente.
    const installCcR = await sshExec(
      vps,
      'curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -40',
      { timeoutMs: 180_000 },
    );
    const installCcSsh = detectSshFailure(installCcR);
    if (installCcSsh) {
      yield { phase: 'install_claude_cli', status: 'error', detail: installCcSsh };
      yield { phase: 'done', status: 'error', detail: `SSH a lâché pendant install_claude_cli : ${installCcSsh}` };
      return;
    }
    // Re-check avec le même PATH étendu : si le binaire est dans
    // ~/.local/bin (typique de install.sh), le shell SSH non-interactif sans
    // l'extension de PATH ne le verrait pas et on warn pour rien.
    const recheck = await sshExec(
      vps,
      'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
      'if command -v claude >/dev/null 2>&1; then ' +
      '  echo "FOUND=$(command -v claude)"; ' +
      '  claude --version 2>&1 | head -1; ' +
      'else echo NOT_FOUND; fi',
      { timeoutMs: 8_000 },
    );
    const recheckOut = (recheck.stdout + recheck.stderr).trim();
    if (recheckOut.includes('NOT_FOUND')) {
      // Pas fatal : l'agent peut tourner sans la CLI claude. On warn et on
      // continue le reste du bootstrap. L'user pourra installer à la main
      // si `claude login` est nécessaire plus tard.
      const tail = (installCcR.stderr.slice(-300) || installCcR.stdout.slice(-300) || `exit ${installCcR.code}`).trim();
      yield {
        phase: 'install_claude_cli',
        status: 'warn',
        detail: `installation a échoué, mais on continue (l'agent fonctionne sans). Détail: ${tail.slice(0, 200)}`,
      };
    } else {
      const found = recheckOut.match(/FOUND=(\S+)/);
      const version = recheckOut.split('\n').find((l) => /\d+\.\d+/.test(l));
      yield {
        phase: 'install_claude_cli',
        status: 'ok',
        detail: `${version ?? 'claude'} (${found?.[1] ?? 'installé'})`,
      };
    }
  }

  // Phase 2 : install agent (drop .pyz)
  yield { phase: 'install_agent', status: 'running', detail: 'dépose ~/.charon/charon-agent.pyz' };
  const installR = await installAgentPyz(vps);
  if (!installR.ok) {
    yield { phase: 'install_agent', status: 'error', detail: installR.detail };
    yield { phase: 'done', status: 'error', detail: 'dépôt du .pyz a échoué' };
    return;
  }
  yield { phase: 'install_agent', status: 'ok', detail: installR.detail };

  // Phase 3 : install service (systemd-user puis fallback nohup)
  yield { phase: 'install_service', status: 'running', detail: 'unit systemd-user + start' };
  const svcR = await installAgentService(vps);
  if (!svcR.ok) {
    yield { phase: 'install_service', status: 'error', detail: svcR.detail };
    yield { phase: 'done', status: 'error', detail: 'install service systemd/nohup a échoué' };
    return;
  }
  yield { phase: 'install_service', status: svcR.mode === 'systemd' ? 'ok' : 'warn', detail: svcR.detail };

  // Phase 4 : ping_agent
  yield { phase: 'ping_agent', status: 'running' };
  const pingR = await pingAgent(vps);
  if (!pingR.ok) {
    yield { phase: 'ping_agent', status: 'error', detail: pingR.detail };
    yield { phase: 'done', status: 'error', detail: 'le daemon ne répond pas au ping' };
    return;
  }
  yield { phase: 'ping_agent', status: 'ok', detail: pingR.detail };

  // Persiste tout de suite la version + sha en DB. Sinon l'UI continue
  // d'afficher "agent outdated" jusqu'à ce que `AgentClient` se connecte
  // (lazy, au 1er accès — typiquement à la 1re création de session Claude),
  // et l'user clique "update agent" pour rien. Cf. AgentClient.ts § hello
  // qui fait la même update : on duplique volontairement ici pour avoir un
  // état DB cohérent dès la fin du bootstrap.
  try {
    db.update(vpsTable).set({
      agentStatus: 'ok',
      agentVersion: pingR.version ?? null,
      agentPyzSha: pingR.pyzSha ?? null,
      agentLastSeenAt: Math.floor(Date.now() / 1000),
    }).where(eq(vpsTable.id, vps.id)).run();
  } catch {}

  // Phase 5 : check claude login (warn-only).
  // PATH étendu pour trouver `claude` même si install.sh l'a mis dans
  // ~/.local/bin ou ~/.claude/bin (cf. install_claude_cli ci-dessus).
  yield { phase: 'check_login', status: 'running' };
  const lr = await sshExec(
    vps,
    'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; ' +
    'claude config get oauth.refresh_token 2>/dev/null > /dev/null && echo OK || echo MISSING',
    { timeoutMs: 8_000 },
  );
  const isLoggedIn = lr.stdout.includes('OK');
  // Persiste l'état en DB pour que la sidebar puisse masquer le bouton
  // "claude login" quand inutile (cf. Sidebar.tsx § agentReady).
  try {
    db.update(vpsTable).set({
      claudeLoggedIn: isLoggedIn ? 1 : 0,
      claudeLoggedInCheckedAt: Math.floor(Date.now() / 1000),
    }).where(eq(vpsTable.id, vps.id)).run();
  } catch {}
  if (isLoggedIn) {
    yield { phase: 'check_login', status: 'ok' };
  } else {
    yield { phase: 'check_login', status: 'warn', detail: 'pas de claude login — fais-le via le bouton "Setup login"' };
  }

  yield { phase: 'done', status: 'ok' };
}
