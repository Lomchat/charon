import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, agentSessions, vpsPaths, vps as vpsTable } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { listAgentClients } from '@/lib/server/agent/AgentClientPool';
import {
  filterRankFiles, longestTerm, queryTerms, selectSearchRoots, MAX_FILE_HITS, MAX_SEARCH_ROOTS,
  type RootCandidate,
} from '@/lib/server/hub/fileSearchRoots';
import type { FileSearchHit, FileSearchResponse } from '@/lib/types/api';

// POST /api/search/files  { q }  — the global palette's "Files" section.
//
// Fan-out of the agent's `fs_search` (mode 'file') over the project roots of
// CONNECTED VPSes. Roots are chosen here from the DB (registered paths + the
// cwds of sessions used in the last 30 days), never from the request. A root
// that has not answered within the deadline is dropped and counted, never
// awaited: "we did not look everywhere" is reported, not hidden.
const ROOT_DEADLINE_MS = 2500;
const PER_VPS_CONCURRENCY = 4;
// Whole-request budget: queued roots that never got a slot by then are skipped.
const TOTAL_BUDGET_MS = 6000;
const RECENT_S = 30 * 24 * 3600;

type RpcFiles = { ok?: boolean; files?: Array<{ path: string; size?: number; mtime?: number }>; truncated?: boolean; streamed?: boolean };
type FoundFile = { path: string; size?: number; mtime?: number };

// One fan-out per hub at a time (§14.106): a newer request aborts the previous
// one, and an abort / deadline cancels the agent-side walks (fs_search_cancel).
const gs = globalThis as unknown as { __charonFileSearchPrev?: AbortController };

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  let body: { q?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const q = String(body?.q ?? '').slice(0, 200);
  gs.__charonFileSearchPrev?.abort();
  const ctl = new AbortController();
  gs.__charonFileSearchPrev = ctl;
  const onAbort = () => ctl.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await run(q, ctl.signal);
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    if (gs.__charonFileSearchPrev === ctl) gs.__charonFileSearchPrev = undefined;
  }
}

async function run(q: string, signal: AbortSignal) {
  const terms = queryTerms(q);
  const empty: FileSearchResponse = { files: [], rootsSearched: 0, rootsSkipped: 0, truncated: false };
  if (!terms.length || longestTerm(terms).length < 2) return NextResponse.json(empty);

  const clients = new Map(
    listAgentClients().filter((c) => c.status === 'connected').map((c) => [c.vps.id, c] as const),
  );
  if (clients.size === 0) return NextResponse.json(empty);

  const since = Math.floor(Date.now() / 1000) - RECENT_S;
  const cands: RootCandidate[] = [];
  for (const p of db.select().from(vpsPaths).all()) {
    cands.push({ vpsId: p.vpsId, path: p.path, usedAt: p.createdAt });
  }
  const sess = db.select({
    vpsId: agentSessions.vpsId, cwd: agentSessions.cwd,
    lastUsedAt: agentSessions.lastUsedAt, createdAt: agentSessions.createdAt,
  }).from(agentSessions)
    .where(eq(agentSessions.archived, 0))
    .all();
  for (const r of sess) {
    const usedAt = r.lastUsedAt ?? r.createdAt;
    if (usedAt >= since) cands.push({ vpsId: r.vpsId, path: r.cwd, usedAt });
  }
  const names = new Map(db.select({ id: vpsTable.id, name: vpsTable.name }).from(vpsTable).all().map((v) => [v.id, v.name]));

  const eligible = cands.filter((c) => clients.has(c.vpsId));
  const allRoots = selectSearchRoots(eligible, Infinity);
  const roots = allRoots.slice(0, MAX_SEARCH_ROOTS);
  const term = longestTerm(terms);
  const hits: FileSearchHit[] = [];
  let rootsSearched = 0;
  let rootsSkipped = allRoots.length - roots.length;
  let truncated = false;
  let open = true; // a late answer must not touch the result after we returned

  const queues = new Map<string, RootCandidate[]>();
  for (const r of roots) {
    const l = queues.get(r.vpsId) ?? [];
    l.push(r);
    queues.set(r.vpsId, l);
  }
  const started = Date.now();
  const searchRoot = async (r: RootCandidate) => {
    if (signal.aborted || Date.now() - started > TOTAL_BUDGET_MS) { rootsSkipped++; return; }
    const client = clients.get(r.vpsId)!;
    const searchId = randomBytes(12).toString('hex');
    const streamed: FoundFile[] = [];
    const detach = client.onSearchProgress(searchId, (ev) => { streamed.push(...(ev.files as FoundFile[])); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const late = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), ROOT_DEADLINE_MS);
      onAbort = () => res(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const call = client.call<RpcFiles>('fs_search', {
      root: r.path, query: term, mode: 'file', regex: false, case_sensitive: false,
      whole_word: false, include: '', exclude: '', use_default_excludes: true,
      max_results: MAX_FILE_HITS * 4, stream_id: searchId,
    }).catch(() => undefined);
    const res = await Promise.race([call, late]);
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    detach();
    if (!res) client.call('fs_search_cancel', { search_id: searchId }).catch(() => {});
    if (!open || signal.aborted) { if (open) rootsSkipped++; return; }
    if (!res || !res.ok) { rootsSkipped++; return; }
    rootsSearched++;
    if (res.truncated) truncated = true;
    for (const f of res.streamed ? streamed : (res.files ?? [])) {
      hits.push({ vpsId: r.vpsId, vpsName: names.get(r.vpsId) ?? r.vpsId, root: r.path, path: f.path, size: f.size ?? 0, mtime: f.mtime ?? 0 });
    }
  };
  await Promise.all([...queues.values()].map(async (list) => {
    const next = [...list];
    await Promise.all(Array.from({ length: Math.min(PER_VPS_CONCURRENCY, next.length) }, async () => {
      for (let r = next.shift(); r; r = next.shift()) await searchRoot(r);
    }));
  }));
  open = false;

  const files = filterRankFiles(hits, terms, MAX_FILE_HITS);
  return NextResponse.json<FileSearchResponse>({ files, rootsSearched, rootsSkipped, truncated });
}
