import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';

// Helpers to manage the local agent — the one running on the dashboard's
// machine (not on a remote VPS). No SSH here, everything is local.
//
// Assumed layout:
//   ~/.charon/charon-agent.pyz   ← deployed
//   ~/.charon/venv/bin/python    ← venv interpreter (created at bootstrap)
//   ~/.config/systemd/user/charon-agent.service  ← unit
//
// Status:
//   - sha of the local pyz: computeFileSha12()
//   - service running: systemctl --user is-active

const LOCAL_PYZ = path.join(os.homedir(), '.charon', 'charon-agent.pyz');
const DASHBOARD_PYZ = path.join(process.cwd(), 'agent/dist/charon-agent.pyz');

function computeFileSha12(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export type LocalAgentStatus = {
  installed: boolean;
  deployedPyzSha: string | null;
  builtPyzSha: string | null;
  outOfDate: boolean;
  serviceActive: boolean | null;  // null = systemctl unavailable / error
};

function execLocal(cmd: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number) => { if (done) return; done = true; resolve({ code, stdout, stderr }); };
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-1); }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => { clearTimeout(t); finish(code ?? 0); });
    child.on('error', () => { clearTimeout(t); finish(-1); });
  });
}

export async function getLocalAgentStatus(): Promise<LocalAgentStatus> {
  const deployedPyzSha = computeFileSha12(LOCAL_PYZ);
  const builtPyzSha = computeFileSha12(DASHBOARD_PYZ);
  const installed = deployedPyzSha !== null;
  const outOfDate = installed && builtPyzSha !== null && deployedPyzSha !== builtPyzSha;

  let serviceActive: boolean | null = null;
  try {
    const r = await execLocal('systemctl', ['--user', 'is-active', 'charon-agent.service'], 4000);
    if (r.code === 0) serviceActive = r.stdout.trim() === 'active';
    else if (r.code === 3) serviceActive = false;  // inactive
    else serviceActive = null;
  } catch {
    serviceActive = null;
  }

  return { installed, deployedPyzSha, builtPyzSha, outOfDate, serviceActive };
}

export type LocalUpdateResult = {
  ok: boolean;
  newPyzSha?: string;
  serviceActive?: boolean;
  detail: string;
};

// Copy the built pyz over the deployed pyz, then restart systemd-user. If
// the service doesn't exist, try nohup. Returns the post-deploy sha.
export async function updateLocalAgent(): Promise<LocalUpdateResult> {
  try {
    if (!fs.existsSync(DASHBOARD_PYZ)) {
      return { ok: false, detail: `built pyz not found: ${DASHBOARD_PYZ}` };
    }
    // Make sure ~/.charon exists
    fs.mkdirSync(path.dirname(LOCAL_PYZ), { recursive: true });
    // Atomic: copyFileSync to .new then rename
    const tmp = LOCAL_PYZ + '.new';
    fs.copyFileSync(DASHBOARD_PYZ, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, LOCAL_PYZ);
  } catch (e: any) {
    return { ok: false, detail: `copy failed: ${e?.message ?? e}` };
  }

  // Restart systemd-user. If it fails, fallback to nohup so we don't leave
  // the user with an up-to-date but stopped agent.
  const r = await execLocal('systemctl', ['--user', 'restart', 'charon-agent.service'], 15000);
  let serviceActive: boolean;
  if (r.code === 0) {
    // Check that it's actually active
    await new Promise((res) => setTimeout(res, 800));
    const chk = await execLocal('systemctl', ['--user', 'is-active', 'charon-agent.service'], 4000);
    serviceActive = chk.code === 0 && chk.stdout.trim() === 'active';
  } else {
    // Fallback: pkill + nohup via shell
    await execLocal('pkill', ['-f', 'charon-agent.pyz'], 4000);
    const venvPy = path.join(os.homedir(), '.charon', 'venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    const sh = await execLocal(
      'sh',
      [
        '-c',
        `nohup setsid ${py} ${LOCAL_PYZ} >> $HOME/.charon/agent.log 2>&1 < /dev/null &`,
      ],
      5000,
    );
    if (sh.code !== 0) {
      return { ok: false, detail: `restart failed: ${r.stderr.slice(-200) || r.stdout.slice(-200)} | nohup: ${sh.stderr.slice(-200)}` };
    }
    serviceActive = false;  // not via systemd
  }

  const newPyzSha = computeFileSha12(LOCAL_PYZ);
  return {
    ok: true,
    newPyzSha: newPyzSha ?? undefined,
    serviceActive,
    detail: `local agent updated${newPyzSha ? ` (${newPyzSha})` : ''}`,
  };
}
