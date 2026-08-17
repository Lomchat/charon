import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db, claudeSessionMessages, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { invalidateGitStatus } from '@/lib/server/claude/git';

type Snapshot = {
  file_path?: unknown;
  phase?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  truncated?: unknown;
};

function parseSnapshot(content: string): Snapshot | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed as Snapshot : null;
  } catch {
    return null;
  }
}

/** Restore the latest exact Claude edit snapshot.
 *
 * The client chooses only a path. Before/after bodies come from trusted DB
 * snapshots, never from the request, and the after-body SHA is an atomic
 * precondition on fs_write/fs_delete. A later agent edit therefore produces
 * `stale` instead of being overwritten or deleted. The agent also contains
 * every path under the session cwd. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const filePath = typeof body?.filePath === 'string' ? body.filePath.trim().slice(0, 8192) : '';
  if (!filePath) return NextResponse.json({ ok: false, error: 'filePath required' }, { status: 400 });

  const [session] = db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!session) return NextResponse.json({ ok: false, error: 'session not found' }, { status: 404 });
  if (session.kind !== 'claude') {
    return NextResponse.json({ ok: false, error: 'Codex patch reverts are not available' }, { status: 400 });
  }

  const [afterRow] = db.select().from(claudeSessionMessages).where(and(
    eq(claudeSessionMessages.sessionId, id),
    eq(claudeSessionMessages.role, 'edit_snapshot'),
    eq(claudeSessionMessages.snapshotFilePath, filePath),
    eq(claudeSessionMessages.snapshotPhase, 'after'),
  )).orderBy(desc(claudeSessionMessages.id)).limit(1).all();
  const after = afterRow ? parseSnapshot(afterRow.content) : null;
  if (!afterRow || !after) {
    return NextResponse.json({ ok: false, error: 'no completed edit snapshot exists for this file' }, { status: 409 });
  }

  const toolId = afterRow.snapshotToolUseId;
  const beforeWhere = [
    eq(claudeSessionMessages.sessionId, id),
    eq(claudeSessionMessages.role, 'edit_snapshot'),
    eq(claudeSessionMessages.snapshotFilePath, filePath),
    eq(claudeSessionMessages.snapshotPhase, 'before'),
    lt(claudeSessionMessages.id, afterRow.id),
    ...(toolId ? [eq(claudeSessionMessages.snapshotToolUseId, toolId)] : []),
  ];
  const [beforeRow] = db.select().from(claudeSessionMessages)
    .where(and(...beforeWhere)).orderBy(desc(claudeSessionMessages.id)).limit(1).all();
  const before = beforeRow ? parseSnapshot(beforeRow.content) : null;
  if (!beforeRow || !before) {
    return NextResponse.json({ ok: false, error: 'the matching before snapshot is missing' }, { status: 409 });
  }
  if (after.truncated || before.truncated || afterRow.snapshotTruncated || beforeRow.snapshotTruncated) {
    return NextResponse.json({ ok: false, error: 'snapshot is truncated; refusing an unsafe partial revert' }, { status: 409 });
  }
  const afterContent = typeof after.content === 'string' ? after.content : after.content === null ? null : undefined;
  const beforeContent = typeof before.content === 'string' ? before.content : before.content === null ? null : undefined;
  if (afterContent === undefined || beforeContent === undefined) {
    return NextResponse.json({ ok: false, error: 'snapshot content is invalid' }, { status: 409 });
  }
  const expectedSha256 = afterContent === null ? ''
    : createHash('sha256').update(afterContent, 'utf8').digest('hex');

  try {
    const client = getAgentClientForVpsId(session.vpsId);
    const result = beforeContent === null
      ? await client.call<{ ok?: boolean; error?: string; reason?: string }>('fs_delete', {
        root: session.cwd, path: filePath, recursive: false,
        expected_sha256: expectedSha256,
      })
      : await client.call<{ ok?: boolean; error?: string; reason?: string }>('fs_write', {
        root: session.cwd, path: filePath, content: beforeContent,
        expected_sha256: expectedSha256,
      });
    if (!result?.ok) {
      return NextResponse.json({ ok: false, ...result }, {
        status: result?.reason === 'stale' ? 409 : 400,
      });
    }
    invalidateGitStatus(session.vpsId, session.cwd);
    return NextResponse.json({
      ok: true, action: beforeContent === null ? 'deleted' : 'restored', filePath,
    });
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      return NextResponse.json({ ok: false, reason: 'unsupported', error: 'update this VPS agent to revert safely' }, { status: 501 });
    }
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
