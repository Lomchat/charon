import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { KNOWN_MODELS } from '@/lib/server/claude/knownModels';

// GET /api/claude/models
// Returns the curated list of model IDs the picker should offer. Source of
// truth: lib/server/claude/knownModels.ts. See header there for how the list
// was compiled (live introspection on a VPS, not autodiscovery).
//
// No filtering or per-VPS variants — the list is hub-global. Different VPSes
// might have different SDK versions, but the model IDs are an Anthropic-side
// concept that doesn't depend on the SDK shipped on the VPS.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json({ models: KNOWN_MODELS });
}
