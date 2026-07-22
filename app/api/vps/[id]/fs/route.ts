import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec, shQuote } from '@/lib/server/claude/sshExec';

// GET /api/vps/[id]/fs?path=<dir> — list the DIRECTORIES directly under
// `path` on the VPS. Backend of the NewSessionWizard path autocomplete: the
// client debounces keystrokes AND caches per directory, so this stays one
// short read-only ssh per visited dir. `path` may be absolute or
// ~-prefixed; blank/'~' → the SSH user's home. Doubles as the existence
// check on submit (`exists: false` when `cd` fails — a session cwd must be
// a real directory).

const MAX_ENTRIES = 400;

// Shell expression for the target dir. Everything user-provided goes
// through shQuote (§13 — ssh injection); a leading ~ is expanded via an
// UNQUOTED "$HOME" so the remote shell resolves the real home.
function dirExpr(raw: string): string {
  const t = raw.trim();
  if (t === '' || t === '~' || t === '~/') return '"$HOME"';
  if (t.startsWith('~/')) return '"$HOME"/' + shQuote(t.slice(2));
  return shQuote(t);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? '';
  if (path.length > 4096) return NextResponse.json({ ok: false, error: 'path too long' }, { status: 400 });
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ ok: false, error: 'vps not found' }, { status: 404 });

  // `-p` suffixes dirs with '/', `-L` dereferences symlinks (a symlinked dir
  // gets the slash too), `-A` keeps dotdirs, `-1` one per line. Broken
  // symlinks make ls exit non-zero — harmless, stdout is still complete
  // (hence the trailing `exit 0`). First stdout line = `pwd` → canonical
  // form of `path` (~ and .. resolved), used by the client to normalize.
  const script = [
    `cd -- ${dirExpr(path)} 2>/dev/null || exit 3`,
    'pwd',
    'ls -1ApL 2>/dev/null',
    'exit 0',
  ].join('\n');
  const r = await sshExec(v, script, { timeoutMs: 10_000 });
  if (r.code === 3) return NextResponse.json({ ok: true, exists: false, resolved: null, dirs: [] });
  if (!r.ok) {
    const firstLine = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? 'ssh failed';
    // Soft failure (200): the client hides suggestions, never blocks the flow.
    return NextResponse.json({ ok: false, error: firstLine });
  }
  const lines = r.stdout.split('\n');
  const resolved = lines[0]?.trim() || null;
  const dirs = lines.slice(1)
    .filter((l) => l.endsWith('/'))
    .map((l) => l.slice(0, -1))
    .filter((n) => n !== '.' && n !== '..');
  // Plain dirs first (alphabetical), dotdirs after.
  dirs.sort((a, b) => {
    const da = a.startsWith('.') ? 1 : 0;
    const dbb = b.startsWith('.') ? 1 : 0;
    if (da !== dbb) return da - dbb;
    return a.localeCompare(b);
  });
  return NextResponse.json({
    ok: true,
    exists: true,
    resolved,
    dirs: dirs.slice(0, MAX_ENTRIES),
    truncated: dirs.length > MAX_ENTRIES,
  });
}
