import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { runAgentUpdateFlow } from '@/lib/server/claude/agentUpdate';
import { getBuiltPyzSha } from '@/lib/server/agent/builtPyzSha';
import { PROVIDER_VERSION_COLUMNS } from '@/lib/vpsRuntimeFields';

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

  // Every release line's post-update version, DERIVED from the registry — the
  // sidebar badge ORs all the staleness axes, so a line named here for three
  // backends and not the fourth left the "⇪ update" lit on a VPS that had just
  // been updated (§14.52/§14.102). `UpdateAgentResult` reports each version
  // under the same name as its column, which is what makes this loop legal.
  const row = result as unknown as Record<string, string | undefined>;
  const versions = Object.fromEntries(
    PROVIDER_VERSION_COLUMNS.map((column) => [column, row[column] ?? null]),
  );

  return NextResponse.json({
    ok: true,
    newVersion: result.newVersion ?? null,
    newPyzSha: result.newPyzSha ?? null,
    ...versions,
    builtPyzSha: getBuiltPyzSha(),
    detail: result.detail,
    // Partial failures (pip sub-steps are non-fatal): the client toasts these
    // so a relit "update" badge is never a silent mystery.
    warnings: result.warnings ?? [],
  });
}
