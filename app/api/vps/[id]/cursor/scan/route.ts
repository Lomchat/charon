import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, vps as vpsTable, vpsPaths, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { ScannedCodexSession } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Importable Cursor conversations on this VPS — the Cursor half of ResumeModal
// (§14.74). Answers the SAME row shape as claude/scan and codex/scan so one
// component renders all three.
//
// Availability is ADVISORY here too: a signed-out box still lists what it has,
// because importing a machine's history is exactly how you rescue it.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get('archived') === '1';

  // ⚠ One workspace = one agent store (§14.103), so a scan must say WHERE to
  // look: with no cwd the agent answers from the HOME store alone and a box
  // full of project conversations reports nothing to import. Charon knows the
  // candidates — the cwd of every session it drives, the VPS's known paths and
  // its default path — and it is the only side that can ORDER them by recency,
  // so it does (`lastUsedAt`), and the agent keeps that order.
  //
  // `?cwd=` scans exactly one chosen folder; `?after=` is an INCLUSIVE cursor
  // naming the first folder of the next page. The response's `nextCwd` can
  // therefore be sent back unchanged, with no skipped workspace.
  const chosen = url.searchParams.get('cwd');
  const after = url.searchParams.get('after');
  const folders = [...new Set([
    ...db.select({ cwd: claudeSessions.cwd }).from(claudeSessions)
      .where(eq(claudeSessions.vpsId, id))
      .orderBy(desc(claudeSessions.lastUsedAt), desc(claudeSessions.createdAt))
      .all().map((r) => r.cwd),
    ...db.select({ path: vpsPaths.path }).from(vpsPaths)
      .where(eq(vpsPaths.vpsId, id)).all().map((r) => r.path),
    ...(v.defaultPath ? [v.defaultPath] : []),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0))];
  const cursorIndex = after ? folders.indexOf(after) : 0;
  const start = cursorIndex >= 0 ? cursorIndex : 0;
  const cwds = chosen ? [chosen] : folders.slice(start);

  let rows: any[] = [];
  let remaining: string[] = [];
  try {
    const client = getAgentClientForVpsId(id);
    const r = await client.call<{
      ok?: boolean; agents?: any[]; error?: string; reason?: string;
      scanned?: string[]; remaining?: string[];
    }>('cursor_list_agents', { include_archived: includeArchived, cwds });
    if (!r?.ok) {
      return NextResponse.json({
        ok: false, sessions: [],
        error: r?.error ?? 'could not list Cursor conversations',
        reason: r?.reason ?? 'error',
      });
    }
    rows = r.agents ?? [];
    remaining = r.remaining ?? [];
  } catch (e: any) {
    const tooOld = e?.code === -32601;
    return NextResponse.json({
      ok: false, sessions: [], reason: tooOld ? 'unsupported' : 'error',
      error: tooOld ? 'agent too old to list Cursor conversations — update the agent'
        : String(e?.message ?? e),
    });
  }

  // Hide what Charon already drives: re-importing a live session would create a
  // second row pointing at one conversation, and both would fight to resume it.
  const known = new Set(
    db.select({ nativeId: claudeSessions.claudeSessionId })
      .from(claudeSessions).where(eq(claudeSessions.vpsId, id)).all()
      .map((r) => r.nativeId).filter(Boolean) as string[],
  );

  // Same row shape as the other two scans — `sessionId` carries the Cursor
  // AGENT id, which is what `Agent.resume` takes.
  const sessions: ScannedCodexSession[] = rows
    .filter((r) => typeof r?.id === 'string' && r.id && !known.has(r.id))
    .map((r) => ({
      sessionId: String(r.id),
      cwd: String(r.cwd || ''),
      cwdLatest: String(r.cwd || ''),
      summary: String(r.name || r.summary || '').slice(0, 200),
      aiTitle: String(r.name || '').slice(0, 200),
      lastPrompt: '',
      firstUserText: String(r.summary || '').slice(0, 400),
      // The listing carries no message count and paying for one resume per row
      // to learn it would make the tab unusable; 0 reads as "unknown" here.
      messageCount: 0,
      model: '',
      gitBranch: '',
      mtime: typeof r.updated_at === 'number' ? r.updated_at : 0,
      size: 0,
      archived: !!r.archived,
    }));

  // `folders` lets the tab offer the choice, `nextCwd` lets it continue — a
  // scan that silently stopped at a bound reads exactly like "there is nothing".
  return NextResponse.json({
    ok: true, sessions, folders,
    ...(remaining.length ? { nextCwd: remaining[0], truncated: true } : {}),
  });
}
