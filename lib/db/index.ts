import 'server-only';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const dbPath = process.env.DATABASE_URL || './data/charon.db';

const globalForDb = globalThis as unknown as { _sqlite?: Database.Database };
const sqlite = globalForDb._sqlite ?? new Database(dbPath);
if (!globalForDb._sqlite) {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // busy_timeout: if a write hits a locked DB (WAL checkpoint, an external
  // `sqlite3` CLI session, a migration), retry for up to 5s instead of
  // throwing SQLITE_BUSY immediately. Within a single Node process
  // better-sqlite3 is synchronous (no self-contention), but this protects
  // against multi-process access (CLI inspection, concurrent migrate) which
  // would otherwise surface as a random 500 on an API route.
  sqlite.pragma('busy_timeout = 5000');
  globalForDb._sqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export * from './schema';
