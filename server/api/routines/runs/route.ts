import { requireApiSession } from '@/lib/server/session';
import { listRoutineRuns } from '@/lib/server/hub/routines';

/** GET: every routine run still in the database, newest first (§14.120). */
export async function GET() {
  const auth = await requireApiSession();
  if (auth instanceof Response) return auth;
  return Response.json({ runs: listRoutineRuns() });
}
