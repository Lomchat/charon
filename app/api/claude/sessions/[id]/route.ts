import { NextResponse } from 'next/server';
import { and, desc, eq, gte, lt, lte, notInArray } from 'drizzle-orm';
import {
  db, claudeSessions, claudeSessionMessages, claudeSessionLogs, vps as vpsTable,
  claudePendingPermissions, claudePendingQuestions,
  type ClaudeSessionMessage,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { deleteSession, getStream } from '@/lib/server/agent/sessionOps';
import { focusCountFor } from '@/lib/server/agent/eventConnections';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { sshExec, shQuote } from '@/lib/server/claude/sshExec';

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
  // oldCwd vient de la DB mais la valeur d'origine est user-controlled (le
  // user choisit son cwd au new-session). claudeSessionId vient du SDK (uuid)
  // mais on quote par sécurité quand même. shQuote isole tout shell-meta.
  const oldQ = shQuote(oldSlug);
  const newQ = shQuote(newSlug);
  const sidQ = shQuote(claudeSessionId);
  // On copie au lieu de mv pour ne pas casser l'historique d'origine.
  // Si le nouveau fichier existe déjà, skip (ne pas écraser).
  const cmd =
    `OLD=~/.claude/projects/${oldQ}/${sidQ}.jsonl && ` +
    `NEW_DIR=~/.claude/projects/${newQ} && ` +
    `NEW=$NEW_DIR/${sidQ}.jsonl && ` +
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

// Rôles considérés comme "chat" pour la pagination. edit_snapshot et event
// ne comptent PAS dans la fenêtre — ils sont chargés en pièces jointes par
// range d'IDs (ils sont temporellement proches de leur tool_use). Sinon une
// session avec beaucoup d'Edit/Write inonde les 200 messages de snapshots
// (cf. piège §14 dans CLAUDE.md).
//
// 'event' contient soit `todo_update` (pas d'affichage chat — seul le
// dernier compte), soit `thinking` (affichable mais sparse). Les deux cas
// sont gérés correctement en chargement par range.
const NON_PAGINATED_ROLES: string[] = ['edit_snapshot', 'event'];

/**
 * Charge une fenêtre de messages chat (rôle ≠ edit_snapshot/event) en
 * pagination cursor-based, puis ajoute les edit_snapshot/event qui tombent
 * dans la même plage d'IDs (ils sont émis temporellement proches de leur
 * tool_use parent).
 *
 * @param before  Si fourni, fenêtre des `limit` messages dont l'id < before.
 *                Sinon (initial load), fenêtre des `limit` derniers messages.
 * @returns       messages (asc par id, chat + snapshots/events mergés),
 *                hasMore (true s'il y a des messages chat encore plus anciens),
 *                oldestChatId (id du plus ancien message CHAT renvoyé — sert
 *                de cursor pour le prochain loadMore).
 */
function loadMessageWindow(
  sessionId: string,
  limit: number,
  before: number | null,
): { messages: ClaudeSessionMessage[]; hasMore: boolean; oldestChatId: number | null } {
  // Fetch chat messages DESC, limit+1 pour détecter hasMore
  const chatRows = db.select().from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      notInArray(claudeSessionMessages.role, NON_PAGINATED_ROLES),
      before != null ? lt(claudeSessionMessages.id, before) : undefined,
    ))
    .orderBy(desc(claudeSessionMessages.id))
    .limit(limit + 1)
    .all();
  const hasMore = chatRows.length > limit;
  const window = chatRows.slice(0, limit).reverse(); // asc par id
  if (window.length === 0) {
    return { messages: [], hasMore: false, oldestChatId: null };
  }
  const minId = window[0].id;
  const maxId = window[window.length - 1].id;
  // Fetch edit_snapshot + event dans la plage du chat window. Ils sont émis
  // temporellement proches de leur tool_use (l'agent envoie tool_use →
  // edit_snapshot before/after → tool_result), donc leurs ids tombent
  // ENTRE les chat messages de la même conversation.
  const attachments = db.select().from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      gte(claudeSessionMessages.id, minId),
      lte(claudeSessionMessages.id, maxId),
      // Filter dans le code (drizzle inArray sur tuple → ok mais on a déjà le range)
    ))
    .all()
    .filter((m) => NON_PAGINATED_ROLES.includes(m.role));
  // Merge + tri par id asc
  const merged = [...window, ...attachments].sort((a, b) => a.id - b.id);
  return { messages: merged, hasMore, oldestChatId: minId };
}

// GET /api/claude/sessions/[id]
//
// Query params :
//   ?limit=N   (default 200, max 1000) — taille de la fenêtre chat
//   ?before=K  — pagination cursor : ne retourne que les messages chat dont
//                id < K. Permet le scroll-up "charger l'historique plus ancien".
//                Quand ce param est passé, la response contient la fenêtre
//                paginée mais les champs lourds (pendings, liveStatus,
//                streamingText) restent quand même renseignés pour rester
//                compatible avec le shape du type.
//
// Note : edit_snapshot et event NE COMPTENT PAS dans la limite. Ils sont
// chargés en pièces jointes par range d'IDs (cf. loadMessageWindow).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 1000);
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
  const { messages, hasMore, oldestChatId } = loadMessageWindow(id, limit, before);
  const stream = getStream(id);

  // Pendings (permission/question/exit_plan) — retournés pour que le client
  // puisse les afficher immédiatement au refetch sans devoir attendre que la
  // SSE les replay (qu'on va précisément skip pour éviter le défilage).
  const pendingPerms = db.select().from(claudePendingPermissions).where(and(
    eq(claudePendingPermissions.sessionId, id),
    eq(claudePendingPermissions.status, 'pending'),
  )).all();
  const pendingQs = db.select().from(claudePendingQuestions).where(and(
    eq(claudePendingQuestions.sessionId, id),
    eq(claudePendingQuestions.status, 'pending'),
  )).all();

  return NextResponse.json({
    session: row,
    liveStatus: stream ? stream.status : row.status,
    subscribers: focusCountFor(id),
    messages,
    hasMore,
    oldestChatId,
    // Texte assistant en cours d'accumulation (non encore persisté). Vide
    // si pas de streaming actif. Le client l'injecte dans son assistantBuf
    // pour montrer "où on en est" sans re-jouer les deltas.
    streamingText: stream?.getStreamingText() ?? '',
    pendingPermissions: pendingPerms.map((p) => {
      let input: any = {};
      try { input = JSON.parse(p.toolInput); } catch {}
      return { id: p.id, tool: p.toolName, input, createdAt: p.createdAt };
    }),
    pendingQuestions: pendingQs.filter((q) => q.kind === 'question').map((q) => {
      let payload: any = [];
      try { payload = JSON.parse(q.payload); } catch {}
      return { id: q.id, questions: payload, createdAt: q.createdAt };
    }),
    pendingExitPlans: pendingQs.filter((q) => q.kind === 'exit_plan').map((q) => {
      let payload: any = {};
      try { payload = JSON.parse(q.payload); } catch {}
      return { id: q.id, plan: payload?.plan ?? '', createdAt: q.createdAt };
    }),
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
//   suppression définitive : kill côté agent + cascade DB (messages /
//   permissions / questions / logs / row session). Plus de soft-delete
//   `?hard=1` : la fusion kill→delete a éliminé l'état intermédiaire
//   `'killed'` (cf. CLAUDE.md §10 et migration 0008). Le seul moyen de
//   "mettre en pause" une session est désormais `POST .../sleep`.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    await deleteSession(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
