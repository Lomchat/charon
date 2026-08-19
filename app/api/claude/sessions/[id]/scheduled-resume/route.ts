import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { parseSessionError } from '@/lib/sessionError';
import { resolveResetAtMs } from '@/lib/rateLimitReset';
import {
  cancelScheduledResume, createScheduledResume,
} from '@/lib/server/agent/scheduledResume';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const sourceMessageId = Number(body.sourceMessageId);
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
    return NextResponse.json({ error: 'valid sourceMessageId required' }, { status: 400 });
  }
  const source = db.select().from(claudeSessionMessages).where(and(
    eq(claudeSessionMessages.id, sourceMessageId),
    eq(claudeSessionMessages.sessionId, id),
    eq(claudeSessionMessages.role, 'error'),
  )).get();
  const error = source ? parseSessionError(source.content) : null;
  if (!source || error?.kind !== 'rate_limit') {
    return NextResponse.json({ error: 'rate-limit error message not found' }, { status: 404 });
  }
  const resetAt = resolveResetAtMs(error.resetAt, error.message);
  if (!resetAt || resetAt > Date.now() + 370 * 24 * 3600_000) {
    return NextResponse.json({ error: 'no trustworthy reset time is available' }, { status: 409 });
  }
  try {
    const job = createScheduledResume({ sessionId: id, sourceMessageId, resetAt });
    return NextResponse.json({ ok: true, id: job.id, runAt: job.runAt, status: job.status });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const scheduleId = typeof body.scheduleId === 'string' ? body.scheduleId : '';
  if (!scheduleId) return NextResponse.json({ error: 'scheduleId required' }, { status: 400 });
  const job = cancelScheduledResume(id, scheduleId);
  if (!job) return NextResponse.json({ error: 'scheduled resume not found' }, { status: 404 });
  if (job.status !== 'cancelled') {
    return NextResponse.json({ error: 'scheduled resume is already being sent' }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
