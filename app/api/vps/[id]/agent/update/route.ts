import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { updateVpsAgent } from '@/lib/server/claude/bootstrap';
import { dropAgentClient } from '@/lib/server/agent/AgentClientPool';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/agent/update
// Redeploys the embedded .pyz + restarts the systemd-user service (nohup fallback).
// Returns { ok, newVersion, newPyzSha, builtPyzSha } so the UI can update
// the "out of date" badge without having to refetch.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Important: we cut the live connection BEFORE killing the process,
  // otherwise AgentClient triggers its retry-loop on a binary currently
  // being replaced -> either we read the old one (race), or we stay
  // "reconnecting" for a long time. dropAgentClient() closes and purges
  // from the pool, a new instance will be created on the next request.
  try { await dropAgentClient(v.id); } catch {}

  let result;
  try {
    result = await updateVpsAgent(v);
  } catch (e: any) {
    const detail = String(e?.stack ?? e?.message ?? e);
    console.error(`[agent/update ${v.id}] threw:`, detail);
    return NextResponse.json({ ok: false, error: `unhandled: ${detail.slice(0, 500)}` }, { status: 500 });
  }
  if (!result.ok) {
    console.error(`[agent/update ${v.id}] failed:`, result.detail);
    return NextResponse.json({ ok: false, error: result.detail }, { status: 500 });
  }

  // Persist the new version + sha (AgentClient will repersist it too
  // on the next hello, but this avoids the window where the UI still
  // sees the old one).
  try {
    db.update(vpsTable).set({
      agentVersion: result.newVersion ?? null,
      agentPyzSha: result.newPyzSha ?? null,
      agentLastSeenAt: Math.floor(Date.now() / 1000),
    }).where(eq(vpsTable.id, v.id)).run();
  } catch {}

  return NextResponse.json({
    ok: true,
    newVersion: result.newVersion ?? null,
    newPyzSha: result.newPyzSha ?? null,
    builtPyzSha: getBuiltPyzSha(),
    detail: result.detail,
  });
}
