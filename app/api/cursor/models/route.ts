import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getCursorModelsForVps } from '@/lib/server/claude/cursorModels';

// GET /api/cursor/models?vpsId=<id>
//
// Cursor model catalog for a VPS — the Cursor analog of /api/codex/models,
// sourced from the agent's `cursor_list_models` RPC. Always 200 with a
// graceful `{ ok:false, models:[], reason }` so the picker degrades to its
// last-known list instead of breaking. cf. CLAUDE.md §14.103.
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const vpsId = new URL(req.url).searchParams.get('vpsId');
  if (!vpsId) {
    return NextResponse.json(
      { ok: false, models: [], reason: 'error', error: 'vpsId required' }, { status: 400 },
    );
  }
  return NextResponse.json(await getCursorModelsForVps(vpsId));
}
