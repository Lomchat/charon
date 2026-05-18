import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db, claudeSessions, claudeSessionMessages, claudeSessionLogs, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { killSession, getStream } from '@/lib/server/agent/sessionOps';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { sshExec } from '@/lib/server/claude/sshExec';

/**
 * Le SDK Claude stocke chaque session dans
 *   ~/.claude/projects/<slug>/<uuid>.jsonl
 * où <slug> est dérivé du cwd en remplaçant '/' par '-'. Pour résumer une
 * session après un changement de cwd, on doit déplacer le .jsonl vers le
 * nouveau slug. Best-effort : si ça échoue, le SDK ne trouvera pas la
 * conversation et la session sera "fresh" (perd la mémoire Claude mais
 * notre historique en DB reste affichable).
 */
async function relocateJsonl(
  vpsRow: typeof vpsTable.$inferSelect,
  claudeSessionId: string,
  oldCwd: string,
  newCwd: string,
): Promise<{ ok: boolean; detail: string }> {
  const slugify = (p: string) => p.replace(/\//g, '-');
  const oldSlug = slugify(oldCwd);
  const newSlug = slugify(newCwd);
  if (oldSlug === newSlug) return { ok: true, detail: 'same slug' };
  // On copie au lieu de mv pour ne pas casser l'historique d'origine.
  // Si le nouveau fichier existe déjà, skip (ne pas écraser).
  const cmd =
    `OLD=~/.claude/projects/${oldSlug}/${claudeSessionId}.jsonl && ` +
    `NEW_DIR=~/.claude/projects/${newSlug} && ` +
    `NEW=$NEW_DIR/${claudeSessionId}.jsonl && ` +
    `if [ ! -f "$OLD" ]; then echo "JSONL_NOT_FOUND_AT_OLD"; exit 1; fi && ` +
    `mkdir -p "$NEW_DIR" && ` +
    `if [ ! -f "$NEW" ]; then cp "$OLD" "$NEW"; fi && ` +
    `echo OK`;
  const r = await sshExec(vpsRow, cmd, { timeoutMs: 10_000 });
  if (r.ok && r.stdout.includes('OK')) {
    return { ok: true, detail: `copied ${oldSlug} → ${newSlug}` };
  }
  return { ok: false, detail: r.stderr.slice(-200) || r.stdout.slice(-200) || `exit ${r.code}` };
}

// GET /api/claude/sessions/[id]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);
  const messages = db.select().from(claudeSessionMessages)
    .where(eq(claudeSessionMessages.sessionId, id))
    .orderBy(asc(claudeSessionMessages.id))
    .all()
    .slice(-limit);
  const stream = getStream(id);
  return NextResponse.json({
    session: row,
    liveStatus: stream ? stream.status : row.status,
    subscribers: stream ? stream.subscribersCount() : 0,
    messages,
  });
}

// PATCH /api/claude/sessions/[id]
//
// Champs autorisés : name, color, cwd.
//
// Cas spécial cwd : le cwd est utilisé à l'instant du start_session côté
// agent — modifier la valeur en DB ne suffit pas si l'agent a déjà une
// instance en mémoire (qui garde son ancien cwd). Donc :
//   - on update la DB
//   - on kill l'instance agent (silencieux si elle n'existe pas)
//   - on reset le status DB à 'sleeping' pour que l'UI propose un resume
//     (qui recréera proprement la session avec le nouveau cwd)
const ALLOWED_PATCH = ['name', 'color', 'cwd'] as const;
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();
  const update: Record<string, unknown> = {};
  for (const k of ALLOWED_PATCH) {
    if (!(k in body)) continue;
    const v = body[k];
    update[k] = v == null || v === '' ? null : String(v).trim();
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
    return NextResponse.json(row ?? null);
  }

  const [before] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!before) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const cwdChanged = 'cwd' in update && update.cwd !== before.cwd;

  let relocateNote: string | undefined;
  // Si cwd change : kill côté agent + reset status DB à 'sleeping' +
  // relocate le JSONL côté VPS pour que le SDK retrouve la conversation
  if (cwdChanged) {
    update.status = 'sleeping';
    try {
      const client = getAgentClientForVpsId(before.vpsId);
      await client.call('kill_session', { session_id: id }).catch(() => {});
    } catch {
      // Pas d'agent client — on continue, ça repartira au resume
    }
    // Relocate JSONL (best-effort)
    if (before.claudeSessionId) {
      const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, before.vpsId)).all();
      if (v) {
        const r = await relocateJsonl(v, before.claudeSessionId, before.cwd, String(update.cwd));
        relocateNote = (r.ok ? '✓ ' : '⚠ ') + r.detail;
        db.insert(claudeSessionLogs).values({
          sessionId: id, level: r.ok ? 'info' : 'warn',
          event: 'cwd_change',
          detail: JSON.stringify({ from: before.cwd, to: update.cwd, relocate: r }),
        }).run();
      }
    }
  }

  db.update(claudeSessions).set(update).where(eq(claudeSessions.id, id)).run();
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  return NextResponse.json(relocateNote ? { ...row, _relocateNote: relocateNote } : row);
}

// DELETE /api/claude/sessions/[id]
//   par défaut : kill (status='killed') — le row reste en DB pour l'historique
//   ?hard=1   : suppression complète (cascade messages/permissions/logs)
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const url = new URL(req.url);
  const hard = url.searchParams.get('hard') === '1';
  try {
    await killSession(id);
    if (hard) {
      db.delete(claudeSessionLogs).where(eq(claudeSessionLogs.sessionId, id)).run();
      db.delete(claudeSessions).where(eq(claudeSessions.id, id)).run();
    }
    return NextResponse.json({ ok: true, hard });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
