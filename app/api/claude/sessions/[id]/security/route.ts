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
  const [row] = db.select({ codexConfig: claudeSessions.codexConfig, status: claudeSessions.status })
    .from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  let configured: CodexSessionConfig = {};
  try { configured = row.codexConfig ? JSON.parse(row.codexConfig) : {}; } catch {}
  const running = ['active', 'thinking', 'starting', 'background'].includes(row.status);
  const runtime = running
    ? await callSessionRpc(id, 'codex_security_status', { force_reload: forceReload })
    : { ok: false, reason: 'sleeping', error: 'session is not running' };
  if (runtime?.ok) return NextResponse.json(runtime);
  // Reviewer is durable session config, not live telemetry. Keep it visible
  // while sleeping/offline/on an old agent; profiles/denials simply wait for
  // a runtime that can enumerate them.
  return NextResponse.json({
    ok: true,
    reviewer: configured.approvalsReviewer === 'auto_review' ? 'auto_review' : 'user',
    permission_profile: typeof configured.permissionProfile === 'string'
      ? configured.permissionProfile : null,
    profiles: [], denials: [], applied: false,
    runtime_reason: runtime?.reason,
    runtime_error: runtime?.error,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const parsed = await req.json().catch(() => ({}));
  const body = parsed && typeof parsed === 'object' ? parsed : {};
  if (body?.action === 'approve_denial') {
    const reviewId = typeof body.reviewId === 'string' ? body.reviewId.trim() : '';
    if (!reviewId) return NextResponse.json({ error: 'reviewId required' }, { status: 400 });
    const result = await callSessionRpc(id, 'approve_codex_denial', { review_id: reviewId });
    return NextResponse.json(result, { status: result?.ok ? 200 : 400 });
  }

  // Reviewer and profile are independent controls in the UI. Accept a partial
  // patch and fill the other field from durable config so a stale inspector
  // cannot accidentally undo a reviewer change made beside the composer.
  const [row] = db.select({ codexConfig: claudeSessions.codexConfig, status: claudeSessions.status })
    .from(claudeSessions).where(eq(claudeSessions.id, id)).all();
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  let current: CodexSessionConfig = {};
  try { current = row.codexConfig ? JSON.parse(row.codexConfig) : {}; } catch {}

  const hasReviewer = Object.prototype.hasOwnProperty.call(body, 'reviewer');
  const reviewer = hasReviewer
    ? (body?.reviewer === 'auto_review' ? 'auto_review' : body?.reviewer === 'user' ? 'user' : null)
    : current.approvalsReviewer === 'auto_review' ? 'auto_review' : 'user';
  const hasProfile = Object.prototype.hasOwnProperty.call(body, 'permissionProfile');
  const permissionProfile = hasProfile
    ? (body?.permissionProfile == null ? null
      : typeof body.permissionProfile === 'string' ? body.permissionProfile.trim().slice(0, 256) : undefined)
    : typeof current.permissionProfile === 'string' ? current.permissionProfile : null;
  if (!reviewer || permissionProfile === undefined || (!hasReviewer && !hasProfile)) {
    return NextResponse.json({ error: 'provide a valid reviewer or permissionProfile' }, { status: 400 });
  }
  // Agent state survives daemon restarts, while this copy is what recreates a
  // missing agent session after a VPS/hub restart. Keep both sources aligned.
  current.approvalsReviewer = reviewer;
  current.permissionProfile = permissionProfile || null;
  db.update(claudeSessions).set({ codexConfig: JSON.stringify(current) })
    .where(eq(claudeSessions.id, id)).run();
  const running = ['active', 'thinking', 'starting', 'background'].includes(row.status);
  const result = running
    ? await callSessionRpc(id, 'set_codex_security', {
      reviewer, permission_profile: permissionProfile || null,
    })
    : { ok: false, reason: 'sleeping', error: 'session is not running' };
  if (result?.ok) return NextResponse.json(result);
  // Sleeping/offline/old-agent sessions still accept the durable setting. It
  // is passed through start_session on resume or after the agent upgrades.
  return NextResponse.json({
    ok: true, reviewer, permission_profile: permissionProfile || null,
    profiles: [], denials: [], applied: false,
    runtime_reason: result?.reason, runtime_error: result?.error,
  });
}
