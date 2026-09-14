import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClient } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';
import { providerLoginPatch } from '@/lib/sessionCapabilities';
import { invalidateCursorModels } from '@/lib/server/claude/cursorModels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cursor sign-in — the SDK's browser-LINK flow (§14.104), run headlessly on
// the VPS through the Node runtime bundled inside the cursor-sdk wheel.
//
// Closest to Claude's hosted OAuth (§14.64) and one step shorter: the user
// opens the URL on any device and there is **nothing to paste back** — the
// agent-side helper polls until the browser completes, then the SDK mints a
// named, expiring API key and stores it at ~/.cursor/sdk/auth.json, which every
// later SDK call resolves on its own. Charon never sees or stores a key.
//
//   POST   → start an attempt → { ok, loginId, url }
//   GET    ?loginId= → poll   → { ok, status: pending|success|error, error? }
//            on success: persists cursorLoggedIn=1 + broadcasts vps_status so
//            every tab's chips and ＋ buttons flip live.
//   DELETE ?loginId= → cancel (modal closed before completion). Load-bearing:
//            the helper holds the verifier that redeems the login and would
//            otherwise poll for twenty minutes against a modal nobody has open.

async function loadVps(id: string) {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  return v ?? null;
}

function mapAgentError(e: any): { status: number; error: string } {
  if (e?.code === -32601) {
    return { status: 409, error: 'agent too old for Cursor sign-in — update the agent first' };
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
    const r = await client.call<{ ok: boolean; error?: string; login_id?: string; url?: string }>(
      'cursor_login_start', {},
    );
    if (!r?.ok) return NextResponse.json({ ok: false, error: r?.error ?? 'Cursor sign-in failed to start' });
    return NextResponse.json({ ok: true, loginId: r.login_id, url: r.url });
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
    const r = await client.call<{ ok: boolean; status?: string; error?: string; url?: string }>(
      'cursor_login_status', { login_id: loginId },
    );
    if (!r?.ok) return NextResponse.json({ ok: false, error: r?.error ?? 'status failed' });
    if (r.status === 'success') {
      // Model access is account-scoped. Drop every server-side copy before a
      // picker can ask under the newly stored credential (§14.103).
      invalidateCursorModels(v.id);
      // The flag drives the ＋ Cursor buttons and the health chips; write it
      // through the registry rather than naming the columns here (§14.102).
      try {
        db.update(vpsTable)
          .set(providerLoginPatch('cursor', 1))
          .where(eq(vpsTable.id, v.id)).run();
      } catch {}
      if (v.agentStatus === 'ok') emitGlobalVpsStatus(v.id, 'ok', { cursorLoggedIn: 1 });
    }
    return NextResponse.json({ ok: true, status: r.status, url: r.url ?? null, error: r.error ?? null });
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
    await client.call('cursor_login_cancel', { login_id: loginId });
  } catch {}
  return NextResponse.json({ ok: true });
}
