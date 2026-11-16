import { requireApiSession } from '@/lib/server/session';
import { listInstalls } from '@/lib/server/install/installSession';

// GET /api/installs → lists all installs (running + finished in memory)
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return Response.json({ installs: listInstalls().map((i) => i.info()) });
}
