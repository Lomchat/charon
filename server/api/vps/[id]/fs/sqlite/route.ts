import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { fileToolCall, rootAndPath } from '@/lib/server/hub/fileToolsRpc';

export const dynamic = 'force-dynamic';

// POST /api/vps/[id]/fs/sqlite  { root, path, op: 'schema' | 'query', sql?, params?, limit? }
//
// A SQLite file, READ-ONLY (§14.112): the agent opens it `mode=ro` behind an
// authorizer that refuses writes, ATTACH and writing pragmas, one statement
// per call, bounded in rows, cell size and wall clock. POST because a query
// is a body, not a URL.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  }
  const at = rootAndPath(body);
  if (!at) return NextResponse.json({ ok: false, error: 'root and path are required' }, { status: 400 });
  if (body.op === 'schema') return fileToolCall(id, 'sqlite_schema', at);
  if (body.op !== 'query' || typeof body.sql !== 'string' || body.sql.length > 100_000) {
    return NextResponse.json({ ok: false, error: 'op must be schema or query (with sql)' }, { status: 400 });
  }
  const sqlParams = Array.isArray(body.params)
    ? body.params.filter((p) => p === null || ['string', 'number'].includes(typeof p))
    : [];
  return fileToolCall(id, 'sqlite_query', {
    ...at, sql: body.sql, params: sqlParams, limit: Number(body.limit) || 200,
  }, {
    map: (r) => {
      const { elapsed_ms: elapsedMs, ...rest } = r;
      return { ...rest, elapsedMs };
    },
  });
}
