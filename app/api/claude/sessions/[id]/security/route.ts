import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import type { CodexSessionConfig } from '@/lib/types/api';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const forceReload = new URL(req.url).searchParams.get('force') === '1';
  return NextResponse.json(await callSessionRpc(id, 'codex_security_status', {
    force_reload: forceReload,
  }));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body?.action === 'approve_denial') {
    const reviewId = typeof body.reviewId === 'string' ? body.reviewId.trim() : '';
    if (!reviewId) return NextResponse.json({ error: 'reviewId required' }, { status: 400 });
    const result = await callSessionRpc(id, 'approve_codex_denial', { review_id: reviewId });
    return NextResponse.json(result, { status: result?.ok ? 200 : 400 });
  }

  const reviewer = body?.reviewer === 'auto_review' ? 'auto_review'
    : body?.reviewer === 'user' ? 'user' : null;
  const permissionProfile = body?.permissionProfile == null ? null
    : typeof body.permissionProfile === 'string' ? body.permissionProfile.trim().slice(0, 256) : undefined;
  if (!reviewer || permissionProfile === undefined) {
    return NextResponse.json({ error: 'invalid reviewer or permissionProfile' }, { status: 400 });
  }
  const result = await callSessionRpc(id, 'set_codex_security', {
    reviewer, permission_profile: permissionProfile || null,
  });
  if (!result?.ok) return NextResponse.json(result, { status: result?.reason === 'unsupported' ? 501 : 400 });

  // Agent state survives daemon restarts, while this copy is what recreates a
  // missing agent session after a VPS/hub restart. Keep both sources aligned.
  const [row] = db.select({ codexConfig: claudeSessions.codexConfig })
    .from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  let current: CodexSessionConfig = {};
  try { current = row?.codexConfig ? JSON.parse(row.codexConfig) : {}; } catch {}
  current.approvalsReviewer = reviewer;
  current.permissionProfile = permissionProfile || null;
  db.update(claudeSessions).set({ codexConfig: JSON.stringify(current) })
    .where(eq(claudeSessions.id, id)).run();
  return NextResponse.json(result);
}
