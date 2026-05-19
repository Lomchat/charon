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

  // Install dans un venv dédié à ~/.charon/venv. Contourne PEP 668
  // (Debian 12 / Ubuntu 23+ refusent `pip --user`) et garde un python stable
  // entre install, verify, ping et le service systemd. `set -o pipefail`
  // remonte le code de sortie réel de pip — sans ça, le pipeline `| tail`
  // gobait l'erreur et le bouton "Setup" répondait "ok" alors que pip avait
  // échoué (et le verify suivant cassait → boucle visuelle dans bootstrap).
  const VENV = '$HOME/.charon/venv';
  const VENV_PY = `${VENV}/bin/python`;
  const cmd =
    'set -o pipefail; ' +
    'BASE=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); ' +
    'if [ -z "$BASE" ]; then echo "[setup] no python ≥ 3.10 found"; exit 10; fi; ' +
    `echo "[setup] base python = $BASE"; ` +
    `if [ ! -x ${VENV_PY} ]; then ` +
    `  echo "[setup] creating venv ${VENV}"; ` +
    `  "$BASE" -m venv ${VENV} 2>&1 | tail -20 || ` +
    `  { "$BASE" -m venv --without-pip ${VENV} && ${VENV_PY} -m ensurepip --upgrade 2>&1 | tail -20; } || ` +
    `  { echo "[setup] venv creation failed — installe python3-venv (apt) ou python3X-venv (dnf)"; exit 11; }; ` +
    `fi; ` +
    `echo "[setup] using ${VENV_PY}"; ` +
    `${VENV_PY} -m pip install --quiet --upgrade pip wheel setuptools 2>&1 | tail -10; ` +
    `${VENV_PY} -m pip install --upgrade claude-agent-sdk 2>&1 | tail -40; ` +
    `echo "[setup] checking import..."; ` +
    `${VENV_PY} -c "import claude_agent_sdk; print('version:', claude_agent_sdk.__version__)" 2>&1`;
  const r = await sshExec(v, cmd, { timeoutMs: 180_000 });
  return NextResponse.json({
    ok: r.ok,
    code: r.code,
    stdout: r.stdout.slice(-4000),
    stderr: r.stderr.slice(-4000),
  });
}
