import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { listShells } from '@/lib/server/shell/shellSession';

// GET /api/shells → lists all active shells (across all VPS)
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json({ shells: listShells() });
}
