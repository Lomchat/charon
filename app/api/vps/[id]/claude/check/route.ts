import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

// GET /api/vps/[id]/claude/check
// Checks that the VPS has everything needed to run a Claude session:
// python3 >= 3.10 (or note the warning), claude CLI, claude-agent-sdk, login done.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Bash one-liner: emit lines "KEY=value" then we parse.
  //
  // Priority to the venv python (~/.charon/venv) where bootstrap installs the SDK.
  // If the venv doesn't exist yet, we fall back to the best system python —
  // the check will report "sdk missing" and the UI will offer to run bootstrap.
  //
  // For the `claude` CLI and auth: non-interactive SSH has a minimal PATH
  // (`/usr/local/bin:/usr/bin:/bin`). If claude is installed via nvm,
  // npm-global or bun, it is NOT in this PATH -> "MISSING" (false negative).
  // So we explicitly load the usual paths + we try a `bash -lc`
  // that sources `~/.profile` and `~/.bashrc` (and thus inits nvm/volta/bun).
  const claudeLookup = [
    // Potential PATH sources on the user side
    '. ~/.profile 2>/dev/null',
    '. ~/.bashrc 2>/dev/null',
    // Add known locations as fallback
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    // Last resort: try a glob on ~/.nvm/versions/node/*/bin/claude
    'for cand in $HOME/.nvm/versions/node/*/bin/claude; do [ -x "$cand" ] && export PATH="$(dirname "$cand"):$PATH"; done',
    'command -v claude 2>/dev/null || echo MISSING',
  ].join('; ');
  const authLookup = [
    // Same PATH-loading as above
    '. ~/.profile 2>/dev/null',
    '. ~/.bashrc 2>/dev/null',
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'for cand in $HOME/.nvm/versions/node/*/bin/claude; do [ -x "$cand" ] && export PATH="$(dirname "$cand"):$PATH"; done',
    // If claude CLI is available -> try claude config get
    'if command -v claude >/dev/null 2>&1; then',
    '  claude config get oauth.refresh_token >/dev/null 2>&1 && echo OK && exit 0',
    'fi',
    // Fallback: credentials file directly (depending on where the CLI stores)
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
  // `ok` = blocking for the UI: we ONLY require the SDK + python >= 3.10.
  // The `claude` CLI may be installed via nvm/bun/volta and thus invisible
  // to the minimal PATH of non-interactive SSH (false negative) — but the
  // session still runs via the broader PATH of systemd-user. Same for auth:
  // if the CLI is not visible, we cannot run `claude config get`,
  // but the session works if credentials exist in ~/.claude/.
  // These two pieces of info remain exposed (cliInstalled, authOk) for
  // informational display in the UI.
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
