import { eq } from 'drizzle-orm';
import { db, pushSubs } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';

// POST /api/push/unsubscribe { endpoint }
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const endpoint = String(body.endpoint ?? '');
  if (!endpoint) return Response.json({ error: 'endpoint required' }, { status: 400 });
  db.delete(pushSubs).where(eq(pushSubs.endpoint, endpoint)).run();
  return Response.json({ ok: true });
}
