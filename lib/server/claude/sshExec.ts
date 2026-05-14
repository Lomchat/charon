import 'server-only';
import { spawn } from 'node:child_process';
import type { Vps } from '@/lib/db/schema';

const DEFAULT_SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=4',
  '-T',
];

export type SshResult = { ok: boolean; stdout: string; stderr: string; code: number | null };

// Exécute une commande one-shot sur le VPS. Capture stdout/stderr/code.
// timeoutMs : hard kill si pas terminé à temps.
export function sshExec(
  vps: Vps,
  command: string,
  opts: { timeoutMs?: number; stdin?: string } = {}
): Promise<SshResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const args = [
      ...DEFAULT_SSH_OPTS,
      '-p', String(vps.sshPort),
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
