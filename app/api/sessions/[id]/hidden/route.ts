import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { setSessionHidden } from '@/lib/server/hub/hiddenSessions';
import { syncAfter } from '@/lib/server/sync/sessionSummaries';

/** Hide (`{hidden:true}`) or show a session, with its sub-sessions
 *  (CLAUDE.md §14.118). It keeps running either way. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (typeof body?.hidden !== 'boolean') {
    return NextResponse.json({ error: 'hidden must be true or false' }, { status: 400 });
  }
  try {
    const ids = await setSessionHidden(id, body.hidden);
    return NextResponse.json({ ok: true, hidden: body.hidden, ids, sync: syncAfter(ids) });
  } catch (e) {
    const message = (e as Error).message;
    return NextResponse.json({ error: message }, { status: message === 'session not found' ? 404 : 400 });
  }
}
