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
// Redéploie le .pyz embarqué + restart le service systemd-user (fallback nohup).
// Renvoie { ok, newVersion, newPyzSha, builtPyzSha } pour que l'UI mette
// à jour le badge "out of date" sans avoir à refetch.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Important : on coupe la connexion live AVANT de killer le process,
  // sinon AgentClient déclenche son retry-loop sur un binaire en cours
  // de remplacement → soit on lit l'ancien (race), soit on reste "reconnecting"
  // longtemps. dropAgentClient() ferme et purge du pool, une nouvelle
  // instance sera créée à la prochaine demande.
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

  // Persiste la nouvelle version + sha (AgentClient le repersistera aussi
  // au prochain hello, mais on évite la fenêtre où l'UI voit encore l'ancien).
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
