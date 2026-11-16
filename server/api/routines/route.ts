import { requireApiSession } from '@/lib/server/session';
import { createRoutine, listRoutines, parseRoutineInput } from '@/lib/server/hub/routines';
import type { RoutineInput } from '@/lib/types/api';

/** GET: every routine (§14.120). POST: create one. */
export async function GET() {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  return Response.json({ routines: listRoutines() });
}

export async function POST(req: Request) {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  try {
    const input = parseRoutineInput(await req.json().catch(() => null)) as RoutineInput;
    const id = createRoutine(input);
    return Response.json({ ok: true, id, routines: listRoutines() });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? String(e) }, { status: 400 });
  }
}
