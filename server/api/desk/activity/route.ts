import { requireApiSession } from '@/lib/server/session';
import { activitySnapshot, markWatched } from '@/lib/server/hub/sessionActivity';

// GET /api/desk/activity → what every session is doing right now.
//
// The live path is the LOW `session_activity` frame; this is the snapshot a
// freshly opened desk needs, and its heartbeat: the hub publishes those frames
// only while a desk keeps asking (lib/server/hub/sessionActivity.ts).
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  markWatched();
  return Response.json({ activity: activitySnapshot() });
}
