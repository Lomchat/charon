import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import { randomBytes } from 'node:crypto';
import type { FsSearchFile, FsSearchQuery, FsSearchResponse, FsSearchStreamLine } from '@/lib/types/api';

// POST /api/vps/[id]/fs/search  { root, query, mode, regex?, caseSensitive?,
//                                 wholeWord?, include?, exclude?, useDefaultExcludes? }
//
// The ToolPanel's search tab (§14.84). POST, unlike its sibling reads: the
// parameters are a form of eight fields, and a regex is exactly the kind of
// string that should not have to survive two rounds of URL encoding.
//
// Thin by design — containment, the globs, the caps and the gitignore
// enumeration all live agent-side in fsnav, so there is one implementation of
// each and the route stays an auth + shape-translation layer. The only thing
// it adds is the snake_case → camelCase re-casing at the boundary.
//
// A search that timed out or hit a cap is NOT an error: it comes back ok with
// `truncated`, because "we stopped looking" and "there is nothing" have to
// look different on screen. `stream: true` answers as NDJSON (`streamed`).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let body: FsSearchQuery;
  try { body = await req.json(); } catch {
    return NextResponse.json<FsSearchResponse>({ ok: false, error: 'invalid body', files: [] }, { status: 400 });
  }
  const root = String(body?.root ?? '');
  const query = String(body?.query ?? '');
  if (!root || root.length > 4096) {
    return NextResponse.json<FsSearchResponse>({ ok: false, error: 'a root is required', files: [] }, { status: 400 });
  }
  // A query longer than this is a paste accident, and the regex it compiles to
  // is the agent's problem to run for 20 seconds.
  if (query.length > 1000) {
    return NextResponse.json<FsSearchResponse>({ ok: false, reason: 'bad_query', error: 'that search is too long', files: [] });
  }

  const client = getAgentClientForVpsId(id);
  if (!client || client.status !== 'connected') {
    return NextResponse.json<FsSearchResponse>({ ok: false, reason: 'offline', error: 'the agent is not connected', files: [] });
  }
  const rpcParams = {
    root,
    query,
    mode: body?.mode === 'file' ? 'file' : 'text',
    regex: !!body?.regex,
    case_sensitive: !!body?.caseSensitive,
    whole_word: !!body?.wholeWord,
    include: String(body?.include ?? '').slice(0, 1000),
    exclude: String(body?.exclude ?? '').slice(0, 1000),
    use_default_excludes: body?.useDefaultExcludes !== false,
  };
  if (body?.stream === true) return streamed(client, rpcParams, req.signal);
  try {
    return NextResponse.json<FsSearchResponse>(shape(await client.call<RpcSearch>('fs_search', rpcParams)));
  } catch (e: unknown) {
    return NextResponse.json<FsSearchResponse>(failure(e));
  }
}

type RpcSearch = {
  ok: boolean; error?: string; reason?: string; root?: string; mode?: string;
  files?: FsSearchFile[]; total_files?: number; total_matches?: number;
  scanned?: number; truncated?: boolean; elapsed_ms?: number; source?: string;
  streamed?: boolean; cancelled?: boolean;
};

function shape(r: RpcSearch | null | undefined): FsSearchResponse {
  return {
    ok: !!r?.ok,
    error: r?.error,
    reason: r?.reason as FsSearchResponse['reason'],
    root: r?.root,
    mode: r?.mode === 'file' ? 'file' : 'text',
    files: r?.files ?? [],
    totalFiles: r?.total_files,
    totalMatches: r?.total_matches,
    scanned: r?.scanned,
    truncated: !!r?.truncated,
    elapsedMs: r?.elapsed_ms,
    source: r?.source === 'git' ? 'git' : r?.source === 'walk' ? 'walk' : undefined,
    ...(r?.cancelled ? { cancelled: true } : {}),
  };
}

function failure(e: unknown): FsSearchResponse {
  // Version gating is method-not-found, never a version comparison: the
  // vps row lags a rollout, the -32601 does not.
  if (e instanceof AgentRpcError && e.code === -32601) {
    return {
      ok: false, reason: 'unsupported', files: [],
      error: 'this VPS runs an agent older than 0.30.0 — update it to search files',
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, reason: 'error', error: msg.slice(0, 200), files: [] };
}

/**
 * The streamed answer (`stream: true`): NDJSON, hits as the agent finds them
 * (its `fs_search_progress` events, relayed by search id), then ONE `done`
 * line with the totals. The reader going away — a newer search, a closed tab —
 * cancels the walk agent-side instead of letting it burn the box for 20s.
 * An agent older than streaming ignores the id and answers with everything at
 * once: that answer becomes a single `files` line, so the reader needs no
 * second code path.
 */
function streamed(
  client: NonNullable<ReturnType<typeof getAgentClientForVpsId>>,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Response {
  const searchId = randomBytes(12).toString('hex');
  const enc = new TextEncoder();
  let settled = false;
  let detach = () => {};
  const stop = () => {
    if (settled) return;
    settled = true;
    detach();
    client.call('fs_search_cancel', { search_id: searchId }).catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: FsSearchStreamLine) => {
        if (settled) return;
        try { controller.enqueue(enc.encode(JSON.stringify(line) + '\n')); } catch {}
      };
      detach = client.onSearchProgress(searchId, (ev) => write({
        type: 'files', files: ev.files as FsSearchFile[], scanned: ev.scanned, totalMatches: ev.total_matches,
      }));
      signal.addEventListener('abort', stop, { once: true });
      client.call<RpcSearch>('fs_search', { ...params, stream_id: searchId })
        .then((r) => {
          if (!r?.streamed && r?.files?.length) write({ type: 'files', files: r.files });
          write({ type: 'done', ...shape(r), files: [] });
        })
        .catch((e: unknown) => write({ type: 'done', ...failure(e) }))
        .finally(() => {
          signal.removeEventListener('abort', stop);
          settled = true;
          detach();
          try { controller.close(); } catch {}
        });
    },
    cancel() { stop(); },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
