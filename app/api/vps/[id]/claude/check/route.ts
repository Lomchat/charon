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

  // Bash one-liner: emit lines "KEY=value" et on parse.
  //
  // Priorité au python du venv (~/.charon/venv) où bootstrap installe le SDK.
  // Si le venv n'existe pas encore, on tombe sur le meilleur python système —
  // le check signalera "sdk missing" et l'UI proposera de lancer bootstrap.
  //
  // Pour le CLI `claude` et l'auth : SSH non-interactif a un PATH minimal
  // (`/usr/local/bin:/usr/bin:/bin`). Si claude est installé via nvm,
  // npm-global ou bun, il n'est PAS dans ce PATH → "MISSING" (faux négatif).
  // On charge donc explicitement les chemins habituels + on tente un `bash -lc`
  // qui source `~/.profile` et `~/.bashrc` (et donc init nvm/volta/bun).
  const claudeLookup = [
    // Sources potentielles de PATH côté user
    '. ~/.profile 2>/dev/null',
    '. ~/.bashrc 2>/dev/null',
    // Ajoute les emplacements connus en fallback
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    // Last resort : on tente un glob sur ~/.nvm/versions/node/*/bin/claude
    'for cand in $HOME/.nvm/versions/node/*/bin/claude; do [ -x "$cand" ] && export PATH="$(dirname "$cand"):$PATH"; done',
    'command -v claude 2>/dev/null || echo MISSING',
  ].join('; ');
  const authLookup = [
    // Même PATH-loading que ci-dessus
    '. ~/.profile 2>/dev/null',
    '. ~/.bashrc 2>/dev/null',
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'for cand in $HOME/.nvm/versions/node/*/bin/claude; do [ -x "$cand" ] && export PATH="$(dirname "$cand"):$PATH"; done',
    // Si claude CLI dispo → on tente claude config get
    'if command -v claude >/dev/null 2>&1; then',
    '  claude config get oauth.refresh_token >/dev/null 2>&1 && echo OK && exit 0',
    'fi',
    // Fallback : fichier de credentials directement (selon où le CLI stocke)
    '{ [ -s "$HOME/.claude/.credentials.json" ] || [ -s "$HOME/.claude.json" ] || [ -s "$HOME/.config/claude/credentials.json" ]; } && echo OK || echo MISSING',
  ].join('; ');

  const script = [
    'if [ -x $HOME/.charon/venv/bin/python ]; then PY=$HOME/.charon/venv/bin/python; else PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); fi',
    'echo "py_path=$PY"',
    'echo "python=$($PY --version 2>&1 | head -c 100)"',
    'echo "python_ok=$($PY -c \'import sys; print(\"yes\" if sys.version_info >= (3,10) else \"warn\")\' 2>&1)"',
    `echo "claude_cli=$(${claudeLookup})"`,
    'echo "sdk=$($PY -c \'import claude_agent_sdk; print(getattr(claude_agent_sdk, \"__version__\", \"installed\"))\' 2>&1 | head -c 200)"',
    `echo "auth=$(${authLookup})"`,
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
  // `ok` = bloquant pour le UI : on n'exige QUE le SDK + python ≥ 3.10.
  // Le CLI `claude` peut être installé via nvm/bun/volta et donc invisible
  // au PATH minimal de SSH non-interactif (faux négatif) — mais la session
  // tourne quand même via le PATH élargi du systemd-user. Idem pour l'auth :
  // si le CLI n'est pas vu, on ne peut pas exécuter `claude config get`,
  // mais la session marche si les credentials existent dans ~/.claude/.
  // Ces deux infos restent exposées (cliInstalled, authOk) pour affichage
  // informatif dans le UI.
  return NextResponse.json({
    ok: sdkOk,
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
