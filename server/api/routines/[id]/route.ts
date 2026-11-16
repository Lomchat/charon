import { requireApiSession } from '@/lib/server/session';
import { deleteRoutine, listRoutines, parseRoutineInput, updateRoutine } from '@/lib/server/hub/routines';

/** PATCH: change any subset of a routine (§14.120). DELETE: remove it; its
 *  runs stay as ordinary sessions. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    const patch = parseRoutineInput(await req.json().catch(() => null), true);
    if (!updateRoutine(id, patch)) return Response.json({ error: 'routine not found' }, { status: 404 });
    return Response.json({ ok: true, routines: listRoutines() });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!deleteRoutine(id)) return Response.json({ error: 'routine not found' }, { status: 404 });
  return Response.json({ ok: true, routines: listRoutines() });
}
