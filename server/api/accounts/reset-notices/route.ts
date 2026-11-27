import { requireApiSession } from '@/lib/server/session';
import { markResetNoticesSeen } from '@/lib/server/accounts/resetNotices';

/** OK on the calendar's "a banked reset ends soon" notices (§14.126): gone
 *  from every browser. Answers the hub's whole acknowledged list. */
export async function POST(req: Request) {
  const auth = await requireApiSession(); if (auth instanceof Response) return auth;
  const body = await req.json().catch(() => null) as { keys?: unknown } | null;
  const keys = Array.isArray(body?.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : [];
  if (!keys.length || keys.length > 50) return Response.json({ error: 'keys required' }, { status: 400 });
  return Response.json({ ok: true, seen: markResetNoticesSeen(keys) });
}
