import 'server-only';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { rawSqlite } from '@/lib/db';
import { RENDER_NULL_ROLES, TECHNICAL_ROLES, type TranscriptView } from '@/lib/transcriptRows';
import type { SessionSearchHit, SessionTranscriptSearchResponse } from '@/lib/types/api';

// One session's search (the magnifier of its header): FTS5 over
// `session_messages_fts` (migration 0030; every row but `edit_snapshot` and
// `event`), restricted to that session and to the rows its transcript VIEW
// draws. Run OFF the event loop: better-sqlite3 is synchronous, and a short
// prefix over the whole index ("a"*) costs ~0.6 s — a worker thread with its
// own read-only connection answers instead, one query at a time (§14.128).
// A ":memory:" database (tests) has no file to share: inline then.

/** Hits counted per search; `results` returns the newest RESULTS_SHOWN. */
export const SEARCH_CAP = 500;
export const RESULTS_SHOWN = 200;
const QUERY_TIMEOUT_MS = 20_000;
const MAX_TERMS = 16;

/** The words of `q` (letters, digits, `_`): what the index tokenizes. */
export function searchTerms(q: string): string[] {
  return q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_TERMS) ?? [];
}

/** A term is a prefix from 2 characters on ("a"* would expand to most of the
 *  index). Terms carry no quote: FTS operators in the input stay inert. */
const term = (t: string, last: boolean) => (last && t.length >= 2 ? '*' : '');

/** The words in order, the last one a prefix: `"tok1 tok2 tok"*`. */
export function phraseQuery(terms: string[]): string {
  return `"${terms.join(' ')}"${term(terms[terms.length - 1]!, true)}`;
}

/** Every word anywhere in the row, each a prefix. */
export function wordsQuery(terms: string[]): string {
  return terms.map((t) => `"${t}"${term(t, true)}`).join(' AND ');
}

/** Roles a view never draws (the hit would lead nowhere). */
function hiddenRoles(view: TranscriptView): string[] {
  return view === 'conversation' ? [...TECHNICAL_ROLES, ...RENDER_NULL_ROLES] : [...RENDER_NULL_ROLES];
}

// Newest first; snippet markers \u0002 … \u0003 (never in text a user reads).
const SQL = `
SELECT m.id AS id, m.role AS role,
       snippet(session_messages_fts, 3, char(2), char(3), '…', 14) AS snippet,
       coalesce(m.ts_ms, m.created_at * 1000) AS tsMs
FROM session_messages_fts f
JOIN session_messages m ON m.id = f.rowid
WHERE session_messages_fts MATCH ? AND f.session_id = ?
  AND m.role NOT IN (SELECT value FROM json_each(?))
ORDER BY tsMs DESC, m.id DESC
LIMIT ?`;

type Job = { fts: string; sessionId: string; hidden: string; limit: number };

// The worker's whole program (CJS, `eval`): no bundle, no TypeScript.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const stmt = db.prepare(workerData.sql);
parentPort.on('message', (m) => {
  if (m === 'stop') { try { db.close(); } catch {} process.exit(0); }
  try { parentPort.postMessage({ id: m.id, rows: stmt.all(m.fts, m.sessionId, m.hidden, m.limit) }); }
  catch (e) { parentPort.postMessage({ id: m.id, error: String(e && e.message || e) }); }
});
`;

type Pending = { resolve: (rows: SessionSearchHit[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type SearchState = { worker: Worker | null; next: number; pending: Map<number, Pending> };
const g = globalThis as typeof globalThis & { __charonTranscriptSearch?: SearchState };
function state(): SearchState {
  return g.__charonTranscriptSearch ??= { worker: null, next: 1, pending: new Map() };
}

function worker(): Worker | null {
  const st = state();
  if (st.worker) return st.worker;
  const sqlite = rawSqlite();
  const path = sqlite.name;
  if (!path || path === ':memory:' || sqlite.memory) return null;
  // The bundle is CJS (`__filename` = dist/server/index.cjs); tsx runs ESM.
  const req = createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/index.js`);
  const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { driver: req.resolve('better-sqlite3'), path, sql: SQL } });
  w.unref();
  st.worker = w;
  w.on('message', (m: { id: number; rows?: SessionSearchHit[]; error?: string }) => {
    const p = st.pending.get(m.id);
    if (!p) return;
    st.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.rows ?? []);
  });
  const gone = (why: string) => {
    if (st.worker !== w) return;
    st.worker = null;
    for (const [id, p] of st.pending) { clearTimeout(p.timer); p.reject(new Error(why)); st.pending.delete(id); }
  };
  w.on('error', (e) => { console.warn(`[search] worker failed: ${e.message}`); gone('search worker failed'); });
  w.on('exit', () => gone('search worker exited'));
  return w;
}

function run(job: Job): Promise<SessionSearchHit[]> {
  const w = worker();
  if (!w) {
    // No file to share (tests): inline.
    return Promise.resolve(rawSqlite().prepare(SQL).all(job.fts, job.sessionId, job.hidden, job.limit) as SessionSearchHit[]);
  }
  const st = state();
  const id = st.next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.pending.delete(id);
      reject(new Error('search timed out'));
    }, QUERY_TIMEOUT_MS);
    st.pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, ...job });
  });
}

/** `q` in session `sessionId`, as its `view` draws it: the phrase first, then
 *  — nothing found, several words — every word anywhere. */
export async function searchSessionTranscript(sessionId: string, q: string, view: TranscriptView): Promise<SessionTranscriptSearchResponse> {
  const terms = searchTerms(q);
  if (!terms.length) return { results: [], total: 0, cap: SEARCH_CAP, mode: 'none' };
  const hidden = JSON.stringify(hiddenRoles(view));
  let mode: SessionTranscriptSearchResponse['mode'] = 'phrase';
  let rows = await run({ fts: phraseQuery(terms), sessionId, hidden, limit: SEARCH_CAP });
  if (!rows.length && terms.length > 1) {
    mode = 'words';
    rows = await run({ fts: wordsQuery(terms), sessionId, hidden, limit: SEARCH_CAP });
  }
  return { results: rows.slice(0, RESULTS_SHOWN), total: rows.length, cap: SEARCH_CAP, mode };
}

