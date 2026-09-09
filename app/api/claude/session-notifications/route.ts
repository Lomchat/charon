import { NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { db, claudeSessions, sessionNotificationSettings, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

/** Include eligible default sessions too: only this browser knows its local exceptions. */
export async function GET() {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const rows = db.select({ id: claudeSessions.id, name: claudeSessions.name, cwd: claudeSessions.cwd,
    status: claudeSessions.status, vpsName: vps.name, telegram: sessionNotificationSettings.telegram })
    .from(claudeSessions).innerJoin(vps, eq(vps.id, claudeSessions.vpsId))
    .leftJoin(sessionNotificationSettings, eq(sessionNotificationSettings.sessionId, claudeSessions.id))
    .where(and(eq(claudeSessions.archived, 0), ne(claudeSessions.status, 'killed'))).all();
  return NextResponse.json(rows.map(({ telegram, ...session }) => ({ ...session, telegramException: telegram !== null })));
}
