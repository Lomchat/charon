import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { dropAgentClient, getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { armAgentClientHooks } from '@/lib/server/agent/autoConnect';

const ALLOWED = ['name', 'ip', 'sshUser', 'sshPort', 'defaultPath'] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();

  const update: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (!(k in body)) continue;
    if (k === 'sshPort') {
      const n = Number(body[k]);
      update[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 22;
    } else if (k === 'defaultPath') {
      const v = body[k];
      update[k] = v == null || String(v).trim() === '' ? null : String(v).trim();
    } else {
      update[k] = String(body[k] ?? '').trim();
    }
  }
  if (Object.keys(update).length === 0) {
    const [row] = db.select().from(vps).where(eq(vps.id, id)).all();
    return NextResponse.json(row ?? null);
  }
  // If we touch credentials/host, drop the client (it will be recreated
  // with the new values on next access).
  const credsChanged = ['ip', 'sshUser', 'sshPort'].some((k) => k in update);
  if (credsChanged) await dropAgentClient(id).catch(() => {});
  db.update(vps).set(update).where(eq(vps.id, id)).run();
  const [row] = db.select().from(vps).where(eq(vps.id, id)).all();
  // Recreate the client with the new creds + re-arm the self-healing hooks so
  // the VPS's running sessions re-attach to the live client (the dropped one
  // left their streams stranded; autoConnect won't re-run). cf. CLAUDE.md §14.51.
  if (credsChanged && row) {
    try { armAgentClientHooks(getAgentClient(row), id); } catch {}
  }
  return NextResponse.json(row);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  // Close the multiplexed SSH before deleting the VPS row
  await dropAgentClient(id).catch(() => {});
  db.delete(vps).where(eq(vps.id, id)).run();
  return NextResponse.json({ ok: true });
}
