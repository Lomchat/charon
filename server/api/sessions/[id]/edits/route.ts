import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import type { SessionEditContent } from '@/lib/types/api';

// GET  /api/sessions/[id]/edits               — every changed file (older bundles)
// POST /api/sessions/[id]/edits {paths: [..]} — only those files (≤ MAX_PATHS)
//
// The LATEST before/after file content per modified file: the companion of
// the session GET, which STRIPS edit_snapshot content (it is re-fetched in a
// loop — CLAUDE.md §14 gotcha 41). The edits tab asks for the cards it is
// about to draw (POST, a page at a time), never for the whole session: a
// heavy session's latest-per-file content weighs megabytes, and reading +
// serializing it all on every session open blocked the hub for a second.

// Hard ceiling on the total bytes of diff content serialized in one response.
// Each snapshot is already capped at 256KB agent-side. Files beyond the budget
// come back with null content + truncated=true (the card says so).
const TOTAL_BUDGET = 16 * 1024 * 1024;
/** Paths per POST (below SQLite's 999-variable ceiling). */
export const MAX_EDIT_PATHS = 100;

function latestEditContents(id: string, paths: string[] | null): { edits: SessionEditContent[]; truncatedList: boolean } {
  // Groupwise-max: for each normalized (file_path, phase) keep only the row
  // with the highest id. Migration 0030 backfilled these columns and an index
  // (idx_…_snapshot_lookup); this avoids json_extract parsing every historical
  // file body.
  const only: SQL = paths
    ? sql`AND snapshot_file_path IN (${sql.join(paths.map((p) => sql`${p}`), sql`, `)})`
    : sql`AND snapshot_file_path IS NOT NULL`;
  const rows = db.all(sql`
    SELECT m.id AS id, m.content AS content
    FROM session_messages m
    JOIN (
      SELECT snapshot_file_path AS fp,
             snapshot_phase     AS ph,
             MAX(id)            AS mid
      FROM session_messages
      WHERE session_id = ${id}
        AND role = 'edit_snapshot'
        ${only}
      GROUP BY fp, ph
    ) latest ON m.id = latest.mid
    ORDER BY m.id ASC
  `) as Array<{ id: number; content: string }>;

  // Accumulate before/after per file_path. Rows are ASC by id, so for a file
  // edited multiple times the latest 'after' (higher id) wins, and its
  // tool_use_id is adopted as the entry id.
  const byFile = new Map<string, SessionEditContent>();
  for (const row of rows) {
    let ev: { file_path?: unknown; phase?: unknown; content?: unknown; diff?: unknown; tool_use_id?: unknown; truncated?: unknown } | null = null;
    try { ev = JSON.parse(row.content); } catch { continue; }
    if (!ev || typeof ev.file_path !== 'string') continue;
    const fp = ev.file_path;
    const cur: SessionEditContent = byFile.get(fp) ?? {
      filePath: fp,
      toolUseId: typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '',
      before: null, after: null, truncated: false,
    };
    const content = typeof ev.content === 'string' ? ev.content : null;
    // Claude: phase 'before'/'after' carry file bodies in `content`.
    // Codex: phase 'diff' carries a unified diff in `diff` (content is null);
    // surface it as `after` (before=null) so the diff card renders the patch
    // directly. cf. CLAUDE.md §14.59, §14.41.
    if (ev.phase === 'before') cur.before = content;
    else if (ev.phase === 'diff') cur.after = typeof ev.diff === 'string' ? ev.diff : null;
    else cur.after = content;
    if (ev.truncated) cur.truncated = true;
    if (typeof ev.tool_use_id === 'string' && ev.tool_use_id) cur.toolUseId = ev.tool_use_id;
    byFile.set(fp, cur);
  }

  // The byte budget. The first file is always included in full (so a single
  // huge file still shows); later files that would bust it come back nulled.
  let used = 0;
  let truncatedList = false;
  const edits: SessionEditContent[] = [];
  for (const e of byFile.values()) {
    const sz = (e.before?.length ?? 0) + (e.after?.length ?? 0);
    if (edits.length > 0 && used + sz > TOTAL_BUDGET) {
      edits.push({ filePath: e.filePath, toolUseId: e.toolUseId, before: null, after: null, truncated: true });
      truncatedList = true;
      continue;
    }
    used += sz;
    edits.push(e);
  }
  return { edits, truncatedList };
}

function answer(id: string, paths: string[] | null): Response {
  const perfStarted = performance.now();
  try {
    const body = latestEditContents(id, paths);
    const response = Response.json(body);
    const totalMs = performance.now() - perfStarted;
    response.headers.set('server-timing', `edits;dur=${totalMs.toFixed(1)}`);
    if (totalMs > 250) {
      // eslint-disable-next-line no-console
      console.warn(`[perf] edits GET ${id} ${totalMs.toFixed(1)}ms (${body.edits.length} files)`);
    }
    return response;
  } catch (e: any) {
    // A transient DB failure must be a clean retryable 503, never an
    // unhandled 500 (HTML error page → client JSON parse failure). Diffs are
    // non-critical UI; the client retries.
    // eslint-disable-next-line no-console
    console.error(`[api/sessions/${id}/edits] failed:`, e?.stack ?? e);
    return Response.json({ error: e?.message ?? String(e) }, { status: 503 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  return answer(id, null);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  let paths: unknown;
  try { paths = (await req.json())?.paths; } catch { paths = null; }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_EDIT_PATHS
    || !paths.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 4096)) {
    return Response.json({ error: `paths: 1..${MAX_EDIT_PATHS} non-empty strings` }, { status: 400 });
  }
  return answer(id, [...new Set(paths as string[])]);
}
