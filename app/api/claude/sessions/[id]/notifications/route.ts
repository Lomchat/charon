import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions, sessionNotificationSettings } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { normalizeChannelNotifications } from '@/lib/notificationPreferences';
import { sessionTelegramNotifications, telegramNotificationDefaults } from '@/lib/server/claude/sessionNotifications';
import { emitGlobalSettingsChanged } from '@/lib/server/agent/sessionOps';

type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, { params }: Context) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!db.select({ id: claudeSessions.id }).from(claudeSessions).where(eq(claudeSessions.id, id)).get())
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  return NextResponse.json({ telegram: sessionTelegramNotifications(id), defaults: telegramNotificationDefaults() });
}
export async function PUT(req: Request, { params }: Context) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!db.select({ id: claudeSessions.id }).from(claudeSessions).where(eq(claudeSessions.id, id)).get())
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('telegram' in body) || (body.telegram !== null && (typeof body.telegram !== 'object' || typeof body.telegram.enabled !== 'boolean')))
    return NextResponse.json({ error: 'telegram preferences or null required' }, { status: 400 });
  if (body.telegram === null) db.delete(sessionNotificationSettings).where(eq(sessionNotificationSettings.sessionId, id)).run();
  else {
    const telegram = JSON.stringify(normalizeChannelNotifications(body.telegram));
    db.insert(sessionNotificationSettings).values({ sessionId: id, telegram })
      .onConflictDoUpdate({ target: sessionNotificationSettings.sessionId, set: { telegram } }).run();
  }
  emitGlobalSettingsChanged();
  return NextResponse.json({ telegram: sessionTelegramNotifications(id), defaults: telegramNotificationDefaults() });
}
