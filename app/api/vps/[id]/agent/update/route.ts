import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { runAgentUpdateFlow } from '@/lib/server/claude/agentUpdate';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/agent/update
// ONE unified update: redeploys the embedded .pyz, upgrades claude-agent-sdk
// in the venv, restarts the service, re-arms the client hooks and re-resumes
// the sessions that were running (the whole §14.51/§14.53 dance lives in
// runAgentUpdateFlow — shared with the SDK auto-update tick).
// Returns { ok, newVersion, newPyzSha, sdkVersion, builtPyzSha } so the UI
// can clear the "out of date" badge without refetching.
// NOTE: can take minutes (pip install) — lib/api.ts gives this POST a 360s
// client timeout; a reverse-proxy with a shorter ProxyTimeout may 502 the
// response, but the flow completes server-side and the badge self-heals via
// the next `vps_status` hello.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  const result = await runAgentUpdateFlow(v);
  if (!result.ok) {
    console.error(`[agent/update ${v.id}] failed:`, result.detail);
    return NextResponse.json({ ok: false, error: result.detail }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    newVersion: result.newVersion ?? null,
    newPyzSha: result.newPyzSha ?? null,
    sdkVersion: result.sdkVersion ?? null,
    builtPyzSha: getBuiltPyzSha(),
    detail: result.detail,
  });
}
