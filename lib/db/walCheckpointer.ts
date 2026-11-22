import 'server-only';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { rawSqlite } from '@/lib/db';

// WAL checkpoints OFF the event loop (CLAUDE.md §4). SQLite's auto-checkpoint
// runs inside the COMMIT that crosses the threshold, on the committing
// connection — the hub's only thread — and a checkpoint fsyncs the WAL and the
// database: 0.1–0.5 s each on a busy disk, several in a row when a burst of
// big rows lands (screenshots read by an agent, a deleted session). A worker
// thread with its OWN connection runs PASSIVE checkpoints instead (they never
// wait for readers or writers). The WAL rewinds when a write starts with every
// frame copied back, i.e. in the first pause of the writes; a burst the worker
// cannot follow grows it until then. The hub's connection keeps a far
// threshold as the safety net (an inline checkpoint: a stall, as before).

/** Checkpoint cadence of the worker. */
export const CHECKPOINT_EVERY_MS = 500;
/** The hub connection's own threshold (pages, 256 MB) while the worker runs. */
export const FALLBACK_AUTOCHECKPOINT_PAGES = 65_536;
/** …and once it is gone (lib/db/index.ts's default). */
export const DEFAULT_AUTOCHECKPOINT_PAGES = 2_000;
const RESTART_AFTER_MS = 30_000;

type CheckpointerState = { worker: Worker | null; stopped: boolean; restartTimer: ReturnType<typeof setTimeout> | null };
const g = globalThis as typeof globalThis & { __charonWalCheckpointer?: CheckpointerState };

// The worker's whole program (CJS, `eval`): no bundle, no TypeScript.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.path, { fileMustExist: true });
db.pragma('busy_timeout = 0');
db.pragma('synchronous = ' + workerData.sync);
db.pragma('journal_size_limit = ' + workerData.journalSizeLimit);
db.pragma('wal_autocheckpoint = 0');
const timer = setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); }
  catch (e) { if (!/busy|locked/i.test(String(e && e.message))) parentPort.postMessage({ error: String(e && e.message || e) }); }
}, workerData.everyMs);
parentPort.on('message', (m) => { if (m === 'stop') { clearInterval(timer); try { db.close(); } catch {} process.exit(0); } });
`;

function state(): CheckpointerState {
  return g.__charonWalCheckpointer ??= { worker: null, stopped: false, restartTimer: null };
}

/** Starts the checkpoint worker (boot). Idempotent; no-op for a non-WAL or
 *  in-memory database. */
export function startWalCheckpointer(): void {
  const st = state();
  st.stopped = false;
  if (st.worker) return;
  const sqlite = rawSqlite();
  const path = sqlite.name;
  if (!path || path === ':memory:' || sqlite.memory) return;
  if (String(sqlite.pragma('journal_mode', { simple: true })).toLowerCase() !== 'wal') return;
  // The bundle is CJS (`__filename` = dist/server/index.cjs); tsx runs ESM.
  const req = createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/index.js`);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      driver: req.resolve('better-sqlite3'),
      path,
      sync: String(sqlite.pragma('synchronous', { simple: true })),
      journalSizeLimit: Number(sqlite.pragma('journal_size_limit', { simple: true })),
      everyMs: CHECKPOINT_EVERY_MS,
    },
  });
  worker.unref();
  st.worker = worker;
  worker.on('online', () => {
    if (st.worker === worker) sqlite.pragma(`wal_autocheckpoint = ${FALLBACK_AUTOCHECKPOINT_PAGES}`);
  });
  worker.on('message', (m: { error?: string }) => {
    if (m?.error) console.warn(`[db] wal checkpoint failed: ${m.error}`);
  });
  const gone = (why: string) => {
    if (st.worker !== worker) return;
    st.worker = null;
    // Back to checkpointing on the hub's own connection until the restart.
    try { sqlite.pragma(`wal_autocheckpoint = ${DEFAULT_AUTOCHECKPOINT_PAGES}`); } catch {}
    if (st.stopped) return;
    console.warn(`[db] wal checkpointer ${why}; restarting in ${RESTART_AFTER_MS / 1000}s`);
    st.restartTimer = setTimeout(() => { st.restartTimer = null; if (!st.stopped) startWalCheckpointer(); }, RESTART_AFTER_MS);
    st.restartTimer.unref?.();
  };
  worker.on('error', (e) => gone(`failed: ${(e as Error)?.message ?? e}`));
  worker.on('exit', (code) => gone(`exited (${code})`));
}

/** Stops the worker (shutdown, tests); the hub connection checkpoints again. */
export function stopWalCheckpointer(): void {
  const st = state();
  st.stopped = true;
  if (st.restartTimer) clearTimeout(st.restartTimer);
  st.restartTimer = null;
  const w = st.worker;
  st.worker = null;
  try { rawSqlite().pragma(`wal_autocheckpoint = ${DEFAULT_AUTOCHECKPOINT_PAGES}`); } catch {}
  if (w) w.postMessage('stop');
}
