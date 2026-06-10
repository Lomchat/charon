import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getModelsAndEfforts, refreshModelsIfStale } from '@/lib/server/claude/modelSync';

// GET /api/claude/models
// Returns the model IDs the picker should offer: the curated seed
// (lib/server/claude/knownModels.ts) UNION the live catalog cached from
// Anthropic's GET /v1/models (lib/server/claude/modelSync.ts) when a hub-side
// API key is configured. With no key it's just the seed — nothing breaks.
//
// Side effect: kicks a best-effort, throttled (24h TTL) background refresh so
// the list stays current without anyone editing code. The response itself is
// served from cache (never blocks on the network).
//
// Hub-global, no per-VPS variants — model IDs are an Anthropic-side concept
// independent of the SDK version shipped on each VPS.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  refreshModelsIfStale();
  // { models, efforts } — efforts is the global union (∪ canonical) for selects
  // with no model in scope; each model also carries its own per-model `efforts`.
  return NextResponse.json(getModelsAndEfforts());
}
