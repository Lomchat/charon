import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { createAccountProfile, listAccountProfiles, removeAccountProfile, renameAccountProfile } from '@/lib/server/agent/accountProfiles';
import { isSessionProvider } from '@/lib/sessionCapabilities';

export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  return NextResponse.json({ profiles: listAccountProfiles(new URL(req.url).searchParams.get('vpsId') ?? undefined) });
}

async function mutate(req: Request, action: 'create' | 'rename' | 'remove') {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  try {
    const body = await req.json();
    if (typeof body.vpsId !== 'string' || !isSessionProvider(body.provider)) throw new Error('VPS and provider required');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (action === 'create') return NextResponse.json({ profile: await createAccountProfile(body.vpsId, body.provider, name) });
    if (typeof body.id !== 'string') throw new Error('Profile required');
    if (action === 'remove') await removeAccountProfile(body.vpsId, body.provider, body.id);
    else renameAccountProfile(body.vpsId, body.provider, body.id, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const old = (e as { code?: number }).code === -32601;
    return NextResponse.json({ error: old ? 'Update the agent to add account profiles' : (e as Error).message }, { status: old ? 409 : 400 });
  }
}
export const POST = (req: Request) => mutate(req, 'create');
export const PATCH = (req: Request) => mutate(req, 'rename');
export const DELETE = (req: Request) => mutate(req, 'remove');
