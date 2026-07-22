import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import type { ClaudeEditContent } from '@/lib/types/api';

// GET /api/claude/sessions/[id]/edits
//
// Lazy, per-session-view fetch of the LATEST before/after file content per
// modified file. This is the companion to the bandwidth fix in the main
// session GET (which now STRIPS edit_snapshot content because it is fetched in
// a 5s loop — cf. CLAUDE.md §14 gotcha 41). Diff content lives here instead:
// it is requested on demand (when the client's edits Map has files whose
// content was stripped) and is tiny because it returns only the latest
// snapshot per (file_path, phase) — typically a handful of files, not the
// thousands of historical snapshots a busy session accumulates.
//
// Example bandwidth: the worst session (5ad5a9687ae66c5f) was ~88 MB returned
// in full on every loop iteration; its latest-per-file content is ~577 KB,
// fetched ONCE per session view. That is the whole point.

// Hard ceiling on the total bytes of diff content we will serialize in one
// response, so this endpoint can never itself become a bandwidth blowup for a
// pathological session with hundreds of distinct large files. Each snapshot is
// already capped at 256KB agent-side; 16MB covers ~30-60 fully-changed files.
// Files beyond the budget come back with null content + truncated=true (the
// client marks them "attempted" and shows an empty/loading diff card).
const TOTAL_BUDGET = 16 * 1024 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  try {
    // Groupwise-max: for each (file_path, phase) keep only the row with the
    // highest id (the most recent snapshot). This mirrors what
    // rebuildStateFromMessages computes client-side (latest before + latest
    // after, independently per phase → the most recent edit's diff).
    const rows = db.all(sql`
      SELECT m.id AS id, m.content AS content
      FROM claude_session_messages m
      JOIN (
        SELECT json_extract(content, '$.file_path') AS fp,
               json_extract(content, '$.phase')     AS ph,
               MAX(id)                              AS mid
        FROM claude_session_messages
        WHERE session_id = ${id} AND role = 'edit_snapshot'
        GROUP BY fp, ph
      ) latest ON m.id = latest.mid
      ORDER BY m.id ASC
    `) as Array<{ id: number; content: string }>;

    // Accumulate before/after per file_path. Rows are ASC by id, so for a file
    // edited multiple times the latest 'after' (higher id) wins, and its
    // tool_use_id is adopted as the entry id.
    type Accum = ClaudeEditContent;
    const byFile = new Map<string, Accum>();
    for (const row of rows) {
      let ev: { file_path?: unknown; phase?: unknown; content?: unknown; diff?: unknown; tool_use_id?: unknown; truncated?: unknown } | null = null;
      try { ev = JSON.parse(row.content); } catch { continue; }
      if (!ev || typeof ev.file_path !== 'string') continue;
      const fp = ev.file_path;
      const cur: Accum = byFile.get(fp) ?? {
        filePath: fp,
        toolUseId: typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '',
        before: null, after: null, truncated: false,
      };
      const content = typeof ev.content === 'string' ? ev.content : null;
      // Claude: phase 'before'/'after' carry file bodies in `content`.
      // Codex: phase 'diff' carries a unified diff in `diff` (content is null);
      // surface it as `after` (before=null) so the diff card renders the patch
      // directly. cf. migration-codex.md, §14.41.
      if (ev.phase === 'before') cur.before = content;
      else if (ev.phase === 'diff') cur.after = typeof ev.diff === 'string' ? ev.diff : null;
      else cur.after = content;
      if (ev.truncated) cur.truncated = true;
      if (typeof ev.tool_use_id === 'string' && ev.tool_use_id) cur.toolUseId = ev.tool_use_id;
      byFile.set(fp, cur);
    }

    // Apply the byte budget. The first file is always included in full (so a
    // single huge file still shows); subsequent files that would bust the
    // budget come back with content nulled.
    let used = 0;
    let truncatedList = false;
    const edits: ClaudeEditContent[] = [];
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

    return NextResponse.json({ edits, truncatedList });
  } catch (e: any) {
    // Same rationale as the main session GET: a transient DB failure must be a
    // clean retryable 503, never an unhandled 500 (HTML error page → client
    // JSON parse failure). Diffs are non-critical UI; the client retries.
    // eslint-disable-next-line no-console
    console.error(`[api/claude/sessions/${id}/edits GET] failed:`, e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 503 });
  }
}
