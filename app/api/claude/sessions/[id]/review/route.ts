import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { callSessionRpc } from '@/lib/server/claude/sessionRpc';

type Target =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const target = body?.target as Target | undefined;
  if (!target || !['uncommittedChanges', 'baseBranch', 'commit', 'custom'].includes(target.type)) {
    return NextResponse.json({ error: 'invalid review target' }, { status: 400 });
  }
  if (target.type === 'baseBranch' && !target.branch?.trim()) {
    return NextResponse.json({ error: 'branch required' }, { status: 400 });
  }
  if (target.type === 'commit' && !target.sha?.trim()) {
    return NextResponse.json({ error: 'commit sha required' }, { status: 400 });
  }
  if (target.type === 'custom' && !target.instructions?.trim()) {
    return NextResponse.json({ error: 'review instructions required' }, { status: 400 });
  }
  const delivery = body?.delivery === 'detached' ? 'detached' : 'inline';
  const result = await callSessionRpc(id, 'review_session', { target, delivery });
  return NextResponse.json(result, { status: result?.ok ? 200 : result?.reason === 'unsupported' ? 501 : 400 });
}
