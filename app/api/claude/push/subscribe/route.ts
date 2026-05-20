import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, claudePushSubs } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// POST /api/claude/push/subscribe
// Body: { endpoint, keys: { p256dh, auth }, userAgent? }
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const endpoint = String(body.endpoint ?? '');
  const p256dh = String(body?.keys?.p256dh ?? '');
  const auth = String(body?.keys?.auth ?? '');
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: 'endpoint+keys required' }, { status: 400 });
  }
  const ua = body.userAgent ? String(body.userAgent) : null;
  // Upsert on endpoint
  const [existing] = db.select().from(claudePushSubs).where(eq(claudePushSubs.endpoint, endpoint)).all();
  if (existing) {
    db.update(claudePushSubs)
      .set({ p256dh, authKey: auth, userAgent: ua })
      .where(eq(claudePushSubs.id, existing.id)).run();
    return NextResponse.json({ ok: true, id: existing.id, updated: true });
  }
  const id = crypto.randomBytes(8).toString('hex');
  db.insert(claudePushSubs).values({
    id, endpoint, p256dh, authKey: auth, userAgent: ua,
  }).run();
  return NextResponse.json({ ok: true, id });
}
