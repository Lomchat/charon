import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshKeyArgs } from '@/lib/server/claude/sshExec';
import { KNOWN_HOSTS_PATH } from '@/lib/server/agent/sshShared.js';

function testSsh(user: string, host: string, port: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      // Custom key (ssh.private_key_path) — P1.2: the connection test must
      // exercise the SAME auth the real connections use.
      ...sshKeyArgs(),
      '-p', String(port),
      '--',
      `${user}@${host}`,
      'true'
    ];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    let settled = false;
    const settle = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {}; settle({ ok: false, error: 'timeout' }); }, 10000);
    child.on('error', (e) => { clearTimeout(killer); settle({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) settle({ ok: true });
      else {
        const firstLine = stderr.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? `exit ${code}`;
        settle({ ok: false, error: firstLine });
      }
    });
  });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ ok: false, error: 'vps not found' }, { status: 404 });
  const result = await testSsh(v.sshUser, v.ip, v.sshPort);
  return NextResponse.json(result);
}
