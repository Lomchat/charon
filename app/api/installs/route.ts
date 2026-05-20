import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { listInstalls } from '@/lib/server/install/installSession';

// GET /api/installs → liste toutes les installs (running + terminées en mémoire)
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json({ installs: listInstalls().map((i) => i.info()) });
}
