import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { activityFor } from '@/lib/server/claude/fileActivity';

// GET /api/vps/[id]/activity → who is reading/writing what, right now.
//
// The live path is the LOW_VOLUME `file_activity` SSE event; this is the
// SNAPSHOT a freshly-loaded tree needs so it isn't blind about everything that
// happened before it mounted. In-memory and short-lived on purpose: a liveness
// light, not a record. §14.88
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  return NextResponse.json({ activity: activityFor(id) });
}
