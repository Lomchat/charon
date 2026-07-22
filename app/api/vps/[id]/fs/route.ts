import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec, shQuote, openSshSession, type SshSession } from '@/lib/server/claude/sshExec';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { VpsFsListResponse } from '@/lib/types/api';
import type { Vps } from '@/lib/db/schema';

// GET /api/vps/[id]/fs?path=<dir> — list the DIRECTORIES directly under
// `path` on the VPS. Backend of the NewSessionWizard path autocomplete: the
// client debounces keystrokes AND caches per directory, so this stays one
// short read-only ssh per visited dir. `path` may be absolute or
// ~-prefixed; blank/'~' → the SSH user's home. Doubles as the existence
// check on submit (`exists: false` when `cd` fails — a session cwd must be
// a real directory).

const MAX_ENTRIES = 400;

// One persistent ControlMaster per VPS, shared across fs calls (gotcha
// §14.30: drilling through dirs fires MANY short sshExecs — a fresh SSH
// handshake per keystroke is 300ms-1s+ EACH and repeated fast handshakes
// trip sshd MaxStartups / fail2ban, which reads as "autocomplete stops
// working past a few levels"). With ControlMaster=auto + ControlPersist=120
// (set inside sshExec when a session is passed), only the FIRST listing
// pays the handshake; an expired master transparently re-opens on the next
// call — no cleanup needed. Memoized on globalThis (dev hot-reload safe).
const g = globalThis as unknown as { __charonFsSshSessions?: Map<string, SshSession> };
const fsSessions = (g.__charonFsSshSessions ??= new Map<string, SshSession>());
function fsSession(v: Vps): SshSession {
  const cur = fsSessions.get(v.id);
  if (cur && cur.vps.ip === v.ip && cur.vps.sshUser === v.sshUser && cur.vps.sshPort === v.sshPort) return cur;
  const s = openSshSession(v);
  fsSessions.set(v.id, s);
  return s;
}

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

  // FAST PATH: the `list_dir` RPC over the VPS's persistent agent pipe
  // (agent >= 0.17.0, fsnav.py — ~1ms scandir, same response shape). The
  // ssh fallback below costs ~0.5s PER CALL in sshd session setup even
  // multiplexed, so the agent path is what makes autocomplete feel live.
  // Any failure (-32601 on an older agent, timeout, dead pipe) falls
  // through silently.
  try {
    const client = getAgentClientForVpsId(id);
    if (client.status === 'connected') {
      const r = await client.call<VpsFsListResponse>('list_dir', { path });
      if (r && typeof r === 'object' && r.ok) return NextResponse.json(r);
    }
  } catch { /* fall through to ssh */ }

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
  const r = await sshExec(v, script, { timeoutMs: 10_000, session: fsSession(v) });
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
