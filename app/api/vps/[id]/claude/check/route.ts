import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

// GET /api/vps/[id]/claude/check
// Vérifie que le VPS a tout ce qu'il faut pour faire tourner une session
// Claude : python3 ≥ 3.10 (ou note le warning), claude CLI, claude-agent-sdk, login fait.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Bash one-liner: emit lines "KEY=value" et on parse
  // On utilise le meme PY que le bridge (3.10+ requis pour claude-agent-sdk).
  const script = [
    'PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)',
    'echo "py_path=$PY"',
    'echo "python=$($PY --version 2>&1 | head -c 100)"',
    'echo "python_ok=$($PY -c \'import sys; print(\"yes\" if sys.version_info >= (3,10) else \"warn\")\' 2>&1)"',
    'echo "claude_cli=$(command -v claude 2>/dev/null || echo MISSING)"',
    'echo "sdk=$($PY -c \'import claude_agent_sdk; print(getattr(claude_agent_sdk, \"__version__\", \"installed\"))\' 2>&1 | head -c 200)"',
    'echo "auth=$(claude config get oauth.refresh_token 2>/dev/null > /dev/null && echo OK || echo MISSING)"',
  ].join('; ');

  const r = await sshExec(v, script, { timeoutMs: 15000 });
  if (!r.ok && !r.stdout) {
    return NextResponse.json({ ok: false, error: 'ssh failed', stderr: r.stderr });
  }
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  const sdkOk = !!out.sdk && !/Traceback|ModuleNotFoundError|No module/.test(out.sdk);
  const cliOk = !!out.claude_cli && out.claude_cli !== 'MISSING';
  const authOk = out.auth === 'OK';
  return NextResponse.json({
    ok: sdkOk && cliOk,
    python: out.python ?? null,
    pythonOk: out.python_ok === 'yes',
    pythonWarn: out.python_ok === 'warn',
    claudeCli: cliOk ? out.claude_cli : null,
    sdk: sdkOk ? out.sdk : null,
    sdkInstalled: sdkOk,
    cliInstalled: cliOk,
    authOk,
    raw: out,
  });
}
