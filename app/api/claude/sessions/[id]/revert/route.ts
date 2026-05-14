import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/claude/sshExec';

// POST /api/claude/sessions/[id]/revert
// Body : { filePath: string, content: string | null }
// Si content === null → supprime le fichier (cas d'un Write qui créait un fichier
// inexistant). Sinon écrit le contenu (base64) sur le VPS via SSH.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const filePath = String(body.filePath ?? '').trim();
  if (!filePath || !filePath.startsWith('/')) {
    return NextResponse.json({ error: 'filePath absolu requis' }, { status: 400 });
  }
  const [sess] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, sess.vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Content null = supprimer le fichier (création par Write)
  if (body.content == null) {
    const r = await sshExec(v, `rm -f -- "${filePath.replace(/"/g, '\\"')}"`, { timeoutMs: 10_000 });
    return NextResponse.json({ ok: r.ok, stderr: r.stderr.slice(-200) });
  }

  // Sinon : pipe base64 → tee
  const b64 = Buffer.from(String(body.content), 'utf8').toString('base64');
  const cmd = `mkdir -p "$(dirname "${filePath.replace(/"/g, '\\"')}")" && echo '${b64}' | base64 -d > "${filePath.replace(/"/g, '\\"')}"`;
  const r = await sshExec(v, cmd, { timeoutMs: 15_000 });
  return NextResponse.json({ ok: r.ok, code: r.code, stderr: r.stderr.slice(-300) });
}
