import { requireApiSession } from '@/lib/server/session';
import { getModelNotices, markModelsSeen } from '@/lib/server/hub/modelNotices';
import { isSessionProvider } from '@/lib/sessionCapabilities';

export async function GET() {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  return Response.json(getModelNotices());
}

export async function POST(req: Request) {
  const session = await requireApiSession();
  if (session instanceof Response) return session;
  const body = await req.json().catch(() => null);
  if (!body || !isSessionProvider(body.provider)
      || !Array.isArray(body.ids) || body.ids.length > 1000
      || !body.ids.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
    return Response.json({ error: 'provider and model ids required' }, { status: 400 });
  }
  return Response.json(markModelsSeen(body.provider, body.ids));
}
