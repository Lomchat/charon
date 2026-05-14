import 'server-only';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const dbPath = process.env.DATABASE_URL || './data/heimdall.db';

const globalForDb = globalThis as unknown as { _sqlite?: Database.Database };
const sqlite = globalForDb._sqlite ?? new Database(dbPath);
if (!globalForDb._sqlite) {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  globalForDb._sqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export * from './schema';
