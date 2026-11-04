import { NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { db, agentSessions, sessionNotificationSettings, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

/** Include eligible default sessions too: only this browser knows its local exceptions. */
export async function GET() {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const rows = db.select({ id: agentSessions.id, name: agentSessions.name, cwd: agentSessions.cwd,
    status: agentSessions.status, vpsName: vps.name, telegram: sessionNotificationSettings.telegram })
    .from(agentSessions).innerJoin(vps, eq(vps.id, agentSessions.vpsId))
    .leftJoin(sessionNotificationSettings, eq(sessionNotificationSettings.sessionId, agentSessions.id))
    .where(and(eq(agentSessions.archived, 0), ne(agentSessions.status, 'killed'))).all();
  return NextResponse.json(rows.map(({ telegram, ...session }) => ({ ...session, telegramException: telegram !== null })));
}
