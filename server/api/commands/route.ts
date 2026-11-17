import { requireApiSession } from '@/lib/server/session';
import { createUserCommand, listUserCommands, parseUserCommandInput } from '@/lib/server/hub/userCommands';

/** GET: the user's own `/` commands (§14.121). POST: create one. */
export async function GET() {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  return Response.json({ commands: listUserCommands() });
}

export async function POST(req: Request) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  try {
    const id = createUserCommand(parseUserCommandInput(await req.json().catch(() => null)));
    return Response.json({ ok: true, id, commands: listUserCommands() });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 400 });
  }
}
