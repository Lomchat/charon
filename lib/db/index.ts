import 'server-only';
import os from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// Opened at IMPORT time, i.e. at server boot (the bundle loads every module).
// No build step runs server code (§14.69), so only the running hub opens it.
const dbPath = process.env.DATABASE_URL || './data/charon.db';

const globalForDb = globalThis as unknown as { _sqlite?: Database.Database };
const sqlite = globalForDb._sqlite ?? new Database(dbPath);
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
  // WAL+NORMAL retains atomic/consistent commits while avoiding an fsync for
  // every small streaming event. Set CHARON_SQLITE_SYNC=FULL for hosts that
  // prefer maximum power-loss durability over event-ingest latency.
  const requestedSync = String(process.env.CHARON_SQLITE_SYNC ?? 'NORMAL').toUpperCase();
  const sync = ['OFF', 'NORMAL', 'FULL', 'EXTRA'].includes(requestedSync)
    ? requestedSync
    : 'NORMAL';
  sqlite.pragma(`synchronous = ${sync}`);
  // Every read runs ON the event loop: a page the OS dropped from its page
  // cache is a disk read inside a request (a cold session fold stalled the
  // hub 0.3–1 s; the same read from memory takes ~20 ms). mmap'd pages live
  // in that evictable OS cache, so mmap stays OFF and the hub keeps what it
  // read in its PRIVATE cache, which nothing else on the box can evict. It
  // only fills with pages actually read: up to 1/16 of RAM, 64–512 MB.
  const cacheKiB = Math.round(Math.min(512 * 1024, Math.max(64 * 1024, os.totalmem() / 1024 / 16)));
  sqlite.pragma(`cache_size = -${cacheKiB}`);
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('mmap_size = 0');
  sqlite.pragma('wal_autocheckpoint = 2000');
  sqlite.pragma('journal_size_limit = 67108864');
  // Bounded planner-stat refresh; unlike VACUUM this neither rewrites nor
  // exclusively locks the full database at process start.
  try { sqlite.pragma('optimize = 0x10002'); } catch {}
  globalForDb._sqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export function rawSqlite(): Database.Database { return sqlite; }
export * from './schema';
