import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { sshExec } from '@/lib/server/hub/sshExec';
import { readClaudeAuthStatus } from '@/lib/server/agent/claudeLoginCheck';
import { stopLoginSession } from '@/lib/server/agent/loginSession';
import { emitGlobalVpsStatus } from '@/lib/server/agent/sessionOps';
import { providerLoginPatch } from '@/lib/sessionCapabilities';

export const runtime = 'nodejs';

// Use the CLI that owns the OAuth credential, just like the sign-in flow.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const v = db.select().from(vpsTable).where(eq(vpsTable.id, id)).get();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });
  try {
    stopLoginSession(id);
    const r = await sshExec(v,
      'PATH="$HOME/.local/bin:$HOME/.claude/bin:/usr/local/bin:$PATH"; claude auth logout',
      { timeoutMs: 20_000 });
    if (!r.ok) return NextResponse.json({ ok: false, error: 'Claude logout failed' }, { status: 502 });
    const status = await readClaudeAuthStatus(v);
    if (!status.ok || status.loggedIn) {
      return NextResponse.json({ ok: false, error: status.error ?? 'Claude is still signed in; check the VPS authentication configuration' }, { status: 502 });
    }
    const patch = providerLoginPatch('claude', 0);
    db.update(vpsTable).set(patch).where(eq(vpsTable.id, id)).run();
    if (v.agentStatus === 'ok' || v.agentStatus === 'missing' || v.agentStatus === 'error') {
      emitGlobalVpsStatus(id, v.agentStatus, patch);
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
