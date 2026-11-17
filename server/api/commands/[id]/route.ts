import { requireApiSession } from '@/lib/server/session';
import {
  deleteUserCommand, listUserCommands, parseUserCommandInput, updateUserCommand,
} from '@/lib/server/hub/userCommands';

/** PATCH: change a user command (any subset). DELETE: remove it. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    updateUserCommand(id, parseUserCommandInput(await req.json().catch(() => null), true));
    return Response.json({ ok: true, commands: listUserCommands() });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  deleteUserCommand(id);
  return Response.json({ ok: true, commands: listUserCommands() });
}
