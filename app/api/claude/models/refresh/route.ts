import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { refreshModels, getModelsAndEfforts } from '@/lib/server/claude/modelSync';

// POST /api/claude/models/refresh
// Forces an immediate sync from Anthropic's GET /v1/models (requires
// `claude.api_key` in settings). Returns the result + the freshly-merged list
// so the Settings UI can report a count and the latest sync time. Used by the
// "↻ refresh model list" button. Falls through gracefully (ok:false) when no
// key is configured or the API call fails — never throws to the client.
export async function POST() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const result = await refreshModels();
  return NextResponse.json({ ...result, ...getModelsAndEfforts() });
}
