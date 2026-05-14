import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getVapidPublic } from '@/lib/server/claude/webPush';

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json({ publicKey: getVapidPublic() });
}
