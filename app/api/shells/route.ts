import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { listShells } from '@/lib/server/shell/shellSession';

// GET /api/shells → liste tous les shells actifs (toutes VPS confondues)
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json({ shells: listShells().map((sh) => sh.info()) });
}
