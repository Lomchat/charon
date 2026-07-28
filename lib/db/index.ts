import 'server-only';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const dbPath = process.env.DATABASE_URL || './data/charon.db';

// `next build` must NEVER open the runtime database (§14.69).
//
// This module opens the connection at IMPORT time, and "Collecting page data"
// imports every route module in PARALLEL worker processes — so a build means N
// processes opening the same file at once and racing to convert its journal to
// WAL (an exclusive-lock operation). On ext4 that race is usually won quietly;
// on the overlayfs of a Docker image build it loses, and the whole build dies
// with `SqliteError: database is locked` / "Failed to collect page data for
// /api/claude/push/key" — a flaky red CI on a tree where nothing is wrong.
//
// No route needs a single ROW at build time (it only needs the module to
// import), so the build phase gets a throwaway in-memory DB: no file, no lock,
// no WAL conversion, no ordering to get right. As a bonus, a production build
// on the live box stops running `PRAGMA journal_mode` against the LIVE
// charon.db. NEXT_PHASE is the same build-phase guard as §14.12.
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';

const globalForDb = globalThis as unknown as { _sqlite?: Database.Database };
const sqlite = globalForDb._sqlite ?? new Database(isBuildPhase ? ':memory:' : dbPath);
if (!globalForDb._sqlite) {
  // busy_timeout FIRST: it arms the busy handler for everything that follows,
  // including the `journal_mode` switch below — which is itself a lock-taking
  // statement, so setting the timeout after it left the one operation most
  // likely to contend (first open of a fresh DB) with no retry at all.
  //
  // What it buys at runtime: if a write hits a locked DB (WAL checkpoint, an
  // external `sqlite3` CLI session, a migration), retry for up to 5s instead
  // of throwing SQLITE_BUSY immediately. Within a single Node process
  // better-sqlite3 is synchronous (no self-contention), but this protects
  // against multi-process access (CLI inspection, concurrent migrate) which
  // would otherwise surface as a random 500 on an API route.
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  globalForDb._sqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export * from './schema';
