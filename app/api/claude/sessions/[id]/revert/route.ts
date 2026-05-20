import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec, shQuote } from '@/lib/server/claude/sshExec';

// POST /api/claude/sessions/[id]/revert
// Body: { filePath: string, content: string | null }
// If content === null -> deletes the file (case of a Write that created a
// non-existent file). Otherwise writes the content (base64) to the VPS via SSH.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const filePath = String(body.filePath ?? '').trim();
  if (!filePath || !filePath.startsWith('/')) {
    return NextResponse.json({ error: 'absolute filePath required' }, { status: 400 });
  }
  const [sess] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, sess.vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // shQuote: protects against $, `, \, ', etc. in filePath (which may come
  // from an edit_snapshot whose file_path is technically controllable on the
  // VPS side). No unquoted interpolation anywhere.
  const q = shQuote(filePath);

  // Content null = delete the file (creation by Write)
  if (body.content == null) {
    const r = await sshExec(v, `rm -f -- ${q}`, { timeoutMs: 10_000 });
    return NextResponse.json({ ok: r.ok, stderr: r.stderr.slice(-200) });
  }

  // Otherwise: pipe base64 -> base64 -d > file. The base64 is safe
  // (restricted alphabet) but we still pass it via stdin to avoid the risk
  // of an argv that's too long. echo '...' is enough here because the
  // content is pure b64.
  const b64 = Buffer.from(String(body.content), 'utf8').toString('base64');
  const cmd = `mkdir -p "$(dirname ${q})" && echo ${shQuote(b64)} | base64 -d > ${q}`;
  const r = await sshExec(v, cmd, { timeoutMs: 15_000 });
  return NextResponse.json({ ok: r.ok, code: r.code, stderr: r.stderr.slice(-300) });
}
