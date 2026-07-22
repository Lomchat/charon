import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Codex ChatGPT DEVICE-CODE login (agent >= 0.16.0) — the in-hub `codex
// login` equivalent of the Claude LoginConsole, minus the PTY: the flow is
// pure copy-paste (open verification_url on any device, type user_code; the
// VPS's codex app-server persists ~/.codex/auth.json itself on completion).
//   POST   → start an attempt → { ok, loginId, verificationUrl, userCode }
//   GET    ?loginId= → poll   → { ok, status: pending|success|error, error? }
//            on success: persists vps.codexLoggedIn=1 + broadcasts vps_status
//            so every tab's chips/buttons flip live (§14.61).
//   DELETE ?loginId= → cancel the attempt (modal closed before completion).
// Agent < 0.16.0 → -32601 → mapped to a clear "update the agent" error.

async function loadVps(id: string) {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  return v ?? null;
}

function mapAgentError(e: any): { status: number; error: string } {
  if (e?.code === -32601) {
    return { status: 409, error: 'agent too old for codex login — update the agent first' };
  }
  return { status: 502, error: String(e?.message ?? e) };
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const v = await loadVps(id);
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  try {
    const client = getAgentClient(v);
    const r = await client.call<{ ok: boolean; error?: string; login_id?: string; verification_url?: string; user_code?: string }>('codex_login_start', {});
    if (!r?.ok) return NextResponse.json({ ok: false, error: r?.error ?? 'codex login start failed' });
    return NextResponse.json({
      ok: true,
      loginId: r.login_id,
      verificationUrl: r.verification_url,
      userCode: r.user_code,
    });
  } catch (e: any) {
    const m = mapAgentError(e);
    return NextResponse.json({ ok: false, error: m.error }, { status: m.status });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const v = await loadVps(id);
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  const loginId = new URL(req.url).searchParams.get('loginId') ?? '';
  try {
    const client = getAgentClient(v);
    const r = await client.call<{ ok: boolean; status?: string; error?: string }>('codex_login_status', { login_id: loginId });
    if (!r?.ok) return NextResponse.json({ ok: false, error: r?.error ?? 'status failed' });
    if (r.status === 'success') {
      // Persist + broadcast: the login flag drives the ＋Codex buttons, the
      // health chips AND re-enables the codex usage poll (it skips
      // codexLoggedIn===0 VPSes). Mirrors usagePoll's setCodexLoggedIn.
      try {
        db.update(vpsTable)
          .set({ codexLoggedIn: 1, codexLoggedInCheckedAt: Math.floor(Date.now() / 1000) })
          .where(eq(vpsTable.id, v.id)).run();
      } catch {}
      if (v.agentStatus === 'ok') {
        emitGlobalVpsStatus(v.id, 'ok', { codexLoggedIn: 1 });
      }
    }
    return NextResponse.json({ ok: true, status: r.status, error: r.error ?? null });
  } catch (e: any) {
    const m = mapAgentError(e);
    return NextResponse.json({ ok: false, error: m.error }, { status: m.status });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const v = await loadVps(id);
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  const loginId = new URL(req.url).searchParams.get('loginId') ?? '';
  try {
    const client = getAgentClient(v);
    await client.call('codex_login_cancel', { login_id: loginId });
  } catch {}
  return NextResponse.json({ ok: true });
}
