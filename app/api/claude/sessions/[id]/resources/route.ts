import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';
import { parseProviderConfig, restartSession } from '@/lib/server/agent/sessionOps';
import type { ClaudeSessionConfig } from '@/lib/types/api';

async function rowFor(id: string) {
  return db.select().from(claudeSessions).where(eq(claudeSessions.id, id)).get() ?? null;
}

async function listResources(id: string, kind: string, forceReload: boolean) {
  try {
    return await callSessionRpc(id, 'session_resources', { force_reload: forceReload });
  } catch (error: any) {
    // Rolling fleet compatibility: Codex resources shipped before the common
    // method. Claude has no honest fallback on an old agent.
    if (kind === 'codex' && /-32601|unknown method|no such method/i.test(String(error?.message || error))) {
      return callSessionRpc(id, 'codex_resources', { force_reload: forceReload });
    }
    throw error;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  try {
    return NextResponse.json(await listResources(
      id, row.kind, new URL(req.url).searchParams.get('force') === '1',
    ));
  } catch (error: any) {
    const message = String(error?.message || error);
    return NextResponse.json({ ok: false, error: message, reason: /-32601/.test(message) ? 'unsupported' : undefined });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const row = await rowFor(id);
  if (!row) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 256) : '';
  const path = typeof body?.path === 'string' ? body.path.trim().slice(0, 8192) : '';
  if (typeof body?.enabled !== 'boolean' || (!name && !path)) {
    return NextResponse.json({ error: 'name/path and enabled required' }, { status: 400 });
  }

  if (row.kind === 'codex') {
    if (!path) return NextResponse.json({ error: 'skill path required' }, { status: 400 });
    const result = await callSessionRpc(id, 'set_codex_skill', { path, enabled: body.enabled });
    return NextResponse.json(result, { status: result?.ok ? 200 : result?.reason === 'unsupported' ? 501 : 400 });
  }

  try {
    const inventory = await listResources(id, row.kind, true) as {
      skills?: Array<{ name?: string; enabled?: boolean }>;
    };
    const discovered = (inventory.skills ?? [])
      .map((skill) => skill.name).filter((value): value is string => !!value);
    const target = name || (inventory.skills ?? []).find((skill: any) => skill.path === path)?.name || '';
    if (!target || !discovered.includes(target)) {
      return NextResponse.json({ error: 'skill is no longer available' }, { status: 409 });
    }
    const current = (parseProviderConfig(row.codexConfig) ?? {}) as ClaudeSessionConfig;
    const selected = new Set(
      Array.isArray(current.skills) ? current.skills
        : current.skills === 'all' || current.skills == null ? discovered : [],
    );
    if (body.enabled) selected.add(target); else selected.delete(target);
    const next: ClaudeSessionConfig = { ...current, skills: [...selected].sort() };
    db.update(claudeSessions).set({ codexConfig: JSON.stringify(next) })
      .where(eq(claudeSessions.id, id)).run();

    let applied = false;
    let warning: string | undefined;
    if (['active', 'failed', 'background'].includes(row.status)) {
      try {
        await restartSession(id);
        applied = true;
      } catch (error: any) {
        warning = `saved; restart failed: ${String(error?.message || error)}`;
      }
    }
    return NextResponse.json({ ok: true, enabled: body.enabled, applied, warning });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 400 });
  }
}
