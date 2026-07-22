import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { dropAgentClient, getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { armAgentClientHooks } from '@/lib/server/agent/autoConnect';
import { validateHost, validateSshUser, validatePort, validateRemotePath } from '@/lib/server/vpsValidate';

const ALLOWED = ['name', 'ip', 'sshUser', 'sshPort', 'defaultPath'] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const body = await req.json();

  // Same strict rules as POST /api/vps — these values feed ssh argvs (P1.3).
  const update: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (!(k in body)) continue;
    if (k === 'sshPort') {
      const p = validatePort(body[k]);
      if (p == null) return NextResponse.json({ error: 'invalid ssh port (1..65535)' }, { status: 400 });
      update[k] = p;
    } else if (k === 'defaultPath') {
      const p = validateRemotePath(body[k]);
      if (p === undefined) return NextResponse.json({ error: 'invalid default path' }, { status: 400 });
      update[k] = p;
    } else if (k === 'ip') {
      const h = validateHost(body[k]);
      if (!h) return NextResponse.json({ error: 'invalid host/ip' }, { status: 400 });
      update[k] = h;
    } else if (k === 'sshUser') {
      const u = validateSshUser(body[k]);
      if (!u) return NextResponse.json({ error: 'invalid ssh user' }, { status: 400 });
      update[k] = u;
    } else {
      const v = String(body[k] ?? '').trim();
      if (!v || v.length > 120) return NextResponse.json({ error: 'invalid name' }, { status: 400 });
      update[k] = v;
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
  // Best-effort REMOTE cleanup before dropping the rows (P0.6): the FK
  // cascade only deletes DB rows — without this, every claude session and
  // every detached shell holder kept running on the VPS forever, invisible
  // and unkillable from Charon. Bounded to 8s total so an unreachable VPS
  // can't wedge the delete (the user is removing it, possibly BECAUSE it's
  // unreachable).
  try {
    const { shells: shellsTable, claudeSessions } = await import('@/lib/db');
    const { getAgentClientForVpsId } = await import('@/lib/server/agent/AgentClientPool');
    const shellRows = db.select().from(shellsTable).where(eq(shellsTable.vpsId, id)).all();
    const sessRows = db.select().from(claudeSessions).where(eq(claudeSessions.vpsId, id)).all();
    if (shellRows.length || sessRows.length) {
      const client = getAgentClientForVpsId(id);
      const kills = [
        ...shellRows.map((r) => client.call('shell_kill', { shell_id: r.id }).catch(() => {})),
        ...sessRows.map((r) => client.call('kill_session', { session_id: r.id }).catch(() => {})),
      ];
      await Promise.race([
        Promise.allSettled(kills),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    }
  } catch {}
  // Close the multiplexed SSH before deleting the VPS row
  await dropAgentClient(id).catch(() => {});
  db.delete(vps).where(eq(vps.id, id)).run();
  return NextResponse.json({ ok: true });
}
