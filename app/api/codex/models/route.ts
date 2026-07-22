import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getCodexModelsForVps } from '@/lib/server/claude/codexModels';
import { CODEX_CANONICAL_EFFORTS } from '@/lib/types/api';

// GET /api/codex/models?vpsId=<id>
//
// Codex model catalog for a VPS (account-driven, per-VPS) — the Codex analog of
// GET /api/claude/models, sourced from the agent's list_codex_models RPC
// (openai_codex .models()). Short in-memory per-VPS TTL cache lives in the
// helper. Always returns 200 with a graceful { ok:false, models:[],
// efforts:CANONICAL } when Codex is unavailable/unreachable so the picker never
// breaks. cf. migration-codex.md.
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const url = new URL(req.url);
  const vpsId = url.searchParams.get('vpsId');
  if (!vpsId) {
    return NextResponse.json(
      { ok: false, models: [], efforts: [...CODEX_CANONICAL_EFFORTS], error: 'vpsId required' },
      { status: 400 },
    );
  }
  const data = await getCodexModelsForVps(vpsId);
  return NextResponse.json(data);
}
