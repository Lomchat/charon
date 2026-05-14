import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudePushSubs } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// POST /api/claude/push/unsubscribe { endpoint }
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const endpoint = String(body.endpoint ?? '');
  if (!endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 });
  db.delete(claudePushSubs).where(eq(claudePushSubs.endpoint, endpoint)).run();
  return NextResponse.json({ ok: true });
}
