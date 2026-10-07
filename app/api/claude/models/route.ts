import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getModelsAndEfforts, refreshModelsIfStale } from '@/lib/server/claude/modelSync';

// GET /api/claude/models — short aliases plus the cached GET /v1/models
// catalog, in the API's release order. No local versioned models or CLI
// discoveries. A key-gated background refresh keeps the cache current;
// the response never blocks on the network.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  refreshModelsIfStale();
  // { models, efforts } — efforts is the global union (∪ canonical) for selects
  // with no model in scope; each model also carries its own per-model `efforts`.
  return NextResponse.json(getModelsAndEfforts());
}
