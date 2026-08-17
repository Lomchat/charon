import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import {
  preferredSessionHandle, slugifyHandle, uniqueSessionHandle,
} from '@/lib/sessionHandle';

type HandleSeed = {
  id: string;
  name?: string | null;
  cwd?: string | null;
};

/** Allocate a stable handle while preserving every address already issued on
 * this VPS. The UNIQUE(vps_id, handle) index remains the final race guard. */
export function allocateSessionHandle(vpsId: string, seed: HandleSeed): string {
  const rows = db.select({ handle: claudeSessions.handle })
    .from(claudeSessions)
    .where(eq(claudeSessions.vpsId, vpsId))
    .all();
  const taken = new Set(rows.map((r) => r.handle).filter((v): v is string => !!v));
  return uniqueSessionHandle(preferredSessionHandle(seed), taken);
}

/** Backfill pre-handle rows once at boot. Existing values are immutable: a
 * newcomer takes the suffix, never an incumbent, including archived/sleeping
 * sessions that may return later. */
export function ensureSessionHandles(): void {
  const rows = db.select({
    id: claudeSessions.id,
    vpsId: claudeSessions.vpsId,
    name: claudeSessions.name,
    cwd: claudeSessions.cwd,
    handle: claudeSessions.handle,
  }).from(claudeSessions)
    .orderBy(asc(claudeSessions.createdAt), asc(claudeSessions.id))
    .all();
  const takenByVps = new Map<string, Set<string>>();
  for (const row of rows) {
    let taken = takenByVps.get(row.vpsId);
    if (!taken) {
      taken = new Set();
      takenByVps.set(row.vpsId, taken);
    }
    if (row.handle) {
      taken.add(row.handle);
      continue;
    }
    const handle = uniqueSessionHandle(preferredSessionHandle(row), taken);
    db.update(claudeSessions).set({ handle })
      .where(eq(claudeSessions.id, row.id)).run();
    taken.add(handle);
  }
}

/** Strict user-facing handle normalization. `@` is accepted for copy/paste;
 * spaces/accents become the same safe form used during automatic allocation. */
export function normalizeSessionHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return slugifyHandle(value.trim().replace(/^@/, '')) || null;
}
