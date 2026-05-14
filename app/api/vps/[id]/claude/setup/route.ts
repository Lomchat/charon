import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

// POST /api/vps/[id]/claude/setup
// Installe claude-agent-sdk via pip --user. Renvoie stdout/stderr/code.
// (claude CLI + `claude login` restent manuels — c'est documenté.)
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Choisit le meilleur python (3.10+) puis pip --user. Timeout 2min.
  const cmd =
    'PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); ' +
    'echo "[setup] using $PY"; "$PY" -m pip install --user --upgrade claude-agent-sdk 2>&1 | tail -40; ' +
    'echo "[setup] checking import..."; "$PY" -c "import claude_agent_sdk; print(\'version:\', claude_agent_sdk.__version__)" 2>&1';
  const r = await sshExec(v, cmd, { timeoutMs: 180_000 });
  return NextResponse.json({
    ok: r.ok,
    code: r.code,
    stdout: r.stdout.slice(-4000),
    stderr: r.stderr.slice(-4000),
  });
}
