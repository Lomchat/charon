import 'server-only';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { CursorModel, CursorModelsResponse } from '@/lib/types/api';
import { getCursorPricing } from './cursorPricing';
import { getSetting, setSetting } from './settings';
import { priceFor } from '@/lib/modelPricing';

// Cursor's model catalog for one VPS.
//
// ACCOUNT-driven and per-box, like Codex's (§14.59) and unlike Claude's, which
// needs a hub-side API key (§14.43): whatever account that VPS is signed in as
// decides what it may run.
//
// The reasoning axis is PER MODEL (`effortAxis:'model'`): each row carries its
// own parameter definitions, which is what the effort control fills itself from
// once a model is picked — the picker here lists one row per MODEL, never one
// per variant (a variant has no id; its params ARE its identity, §14.103).
//
// Prices do NOT come from this catalog — `/v1/models` carries none. They are
// joined on below from the published pricing document (`cursorPricing.ts`).
//
// Never throws: these render beside a chat, so a failure comes back as
// `{ ok:false, reason }` and the picker keeps whatever it had (§14.95).

type Entry = { at: number; data: CursorModelsResponse };
const g = globalThis as unknown as {
  _cursorModels?: Map<string, Entry>;
  _cursorModelsInflight?: Map<string, Promise<CursorModelsResponse>>;
  _cursorModelsEpoch?: number;
  _cursorModelsGenerations?: Map<string, number>;
};
const cache = g._cursorModels ??= new Map<string, Entry>();
const inflight = g._cursorModelsInflight ??= new Map<string, Promise<CursorModelsResponse>>();
const generations = g._cursorModelsGenerations ??= new Map<string, number>();

function generation(vpsId: string): string {
  return `${g._cursorModelsEpoch ?? 0}:${generations.get(vpsId) ?? 0}`;
}

// When a copy is old enough to be refreshed — NOT how long it may be shown.
// Listing this catalog launches the SDK bridge (a Node process), which takes
// seconds, so a known-stale answer is always served immediately and the refresh
// runs behind it (§14.43's shape). A reader never waits for a catalog we
// already have.
const TTL_MS = 10 * 60 * 1000;

// ── Surviving a restart ─────────────────────────────────────────────────────
// The in-memory map dies on every deploy, and Charon deploys often, so "open
// the picker" meant "launch a bridge and wait" over and over. The last good
// catalog per VPS is persisted, bounded because one is ~60KB: the boxes you
// actually pick models on are a handful, and an unbounded map would grow one
// settings row to megabytes of JSON rewritten on every refresh.
const MAX_STORED = 4;

type StoredCatalog = { at: number; models: CursorModel[] };

function readStore(): Record<string, StoredCatalog> {
  try {
    const raw = getSetting('cursor.models_cache');
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, StoredCatalog> : {};
  } catch { return {}; }
}

function writeStore(vpsId: string, models: CursorModel[]): void {
  try {
    const store = readStore();
    store[vpsId] = { at: Date.now(), models };
    // Newest first, oldest evicted.
    const kept = Object.entries(store)
      .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
      .slice(0, MAX_STORED);
    setSetting('cursor.models_cache', JSON.stringify(Object.fromEntries(kept)));
  } catch { /* a cache that cannot be written is still a working catalog */ }
}

function clearStore(vpsId?: string): void {
  try {
    if (!vpsId) {
      setSetting('cursor.models_cache', '');
      return;
    }
    const store = readStore();
    delete store[vpsId];
    setSetting('cursor.models_cache', Object.keys(store).length ? JSON.stringify(store) : '');
  } catch { /* persistent cache cleanup must not break account operations */ }
}

/** The persisted copy, if any. Priceless by construction — see `withPrices`. */
function stored(vpsId: string): { at: number; models: CursorModel[] } | null {
  const hit = readStore()[vpsId];
  if (!hit || !Array.isArray(hit.models) || !hit.models.length) return null;
  return { at: hit.at ?? 0, models: hit.models };
}

/**
 * Join the price table onto a catalog.
 *
 * Prices come from a DIFFERENT source than the catalog (a public doc, not the
 * account's API — §14.103), with its own TTL, so they are attached on READ
 * rather than stored alongside: a rate can never outlive the table it came
 * from, and a docs outage costs a column rather than the model list.
 */
async function withPrices(models: CursorModel[]): Promise<CursorModel[]> {
  try {
    const table = await getCursorPricing();
    return models.map((m) => ({ ...m, ...priceFor(table, m.label, m.id) }));
  } catch {
    return models; // a price is a nice-to-have; the catalog is not
  }
}

export function invalidateCursorModels(vpsId?: string): void {
  if (vpsId) {
    generations.set(vpsId, (generations.get(vpsId) ?? 0) + 1);
    cache.delete(vpsId);
    // The promise cannot be cancelled, but removing its single-flight entry
    // lets the new account start a fresh request immediately. Its generation
    // check below prevents the old answer from being stored afterwards.
    inflight.delete(vpsId);
    clearStore(vpsId);
  } else {
    g._cursorModelsEpoch = (g._cursorModelsEpoch ?? 0) + 1;
    generations.clear();
    cache.clear();
    inflight.clear();
    clearStore();
  }
}

/**
 * The catalog for one VPS.
 *
 * Answers from cache whenever one exists — memory, then the persisted copy —
 * and refreshes behind the answer when it is stale. Only a hub that has NEVER
 * seen this box's catalog waits for the bridge.
 */
export async function getCursorModelsForVps(vpsId: string): Promise<CursorModelsResponse> {
  let hit = cache.get(vpsId);
  if (!hit) {
    const beforeRead = generation(vpsId);
    const disk = stored(vpsId);
    if (disk) {
      hit = { at: disk.at, data: { ok: true, models: await withPrices(disk.models) } };
      // Pricing is async. A login/logout may invalidate the account while it
      // is being joined; restart the read instead of reviving that account's
      // persisted catalog.
      if (generation(vpsId) !== beforeRead) return getCursorModelsForVps(vpsId);
      cache.set(vpsId, hit);
    }
  }
  if (hit) {
    if (Date.now() - hit.at >= TTL_MS) void refreshCursorModelsForVps(vpsId);
    return hit.data;
  }
  return refreshCursorModelsForVps(vpsId);
}

/** Ask the box itself. Single-flight per VPS: the watcher and a picker opening
 *  at the same moment must not launch two bridges. */
export function refreshCursorModelsForVps(vpsId: string): Promise<CursorModelsResponse> {
  const running = inflight.get(vpsId);
  if (running) return running;
  const startedAt = generation(vpsId);
  let p: Promise<CursorModelsResponse>;
  p = fetchCursorModels(vpsId, startedAt).finally(() => {
    // An invalidation can install a newer single-flight while this one is
    // finishing. Never let the older finally delete the newer request.
    if (inflight.get(vpsId) === p) inflight.delete(vpsId);
  });
  inflight.set(vpsId, p);
  return p;
}

async function fetchCursorModels(vpsId: string, startedAt: string): Promise<CursorModelsResponse> {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) return { ok: false, models: [], reason: 'error', error: 'vps not found' };
  // Checked BEFORE calling, like the git chip (§14.76): a picker must never
  // hang a render waiting on a box we already know is unreachable.
  if (v.agentStatus !== 'ok') {
    return { ok: false, models: [], reason: 'offline', error: 'agent not connected' };
  }

  let data: CursorModelsResponse;
  try {
    const client = getAgentClientForVpsId(vpsId);
    const r = await client.call<{ ok?: boolean; models?: CursorModel[]; reason?: string; error?: string }>(
      'cursor_list_models', {},
    );
    data = r?.ok
      ? { ok: true, models: Array.isArray(r.models) ? r.models : [] }
      : { ok: false, models: [], reason: r?.reason ?? 'error', error: r?.error ?? 'catalog unavailable' };
  } catch (e: any) {
    // -32601 = an agent that predates the method, not a broken account.
    const unsupported = e?.code === -32601;
    data = {
      ok: false, models: [],
      reason: unsupported ? 'unsupported' : 'error',
      error: unsupported ? 'agent too old to list Cursor models' : String(e?.message ?? e),
    };
  }
  // Prices come from a DIFFERENT source than the catalog (a public doc, not the
  // account's API — §14.103), so they are joined here rather than agent-side:
  // one hub-wide table serves every VPS, and a docs outage costs a column, not
  // the model list.
  if (data.ok && data.models.length) data = { ...data, models: await withPrices(data.models) };
  // Only a SUCCESSFUL catalog is cached: caching the failure would keep the
  // picker empty for ten minutes after a sign-in that just fixed it. A failure
  // also leaves the PERSISTED copy alone, so a signed-out moment cannot erase a
  // catalog that was right yesterday (§14.72e).
  if (data.ok && generation(vpsId) === startedAt) {
    cache.set(vpsId, { at: Date.now(), data });
    // Stored without prices: they come from a separate source with its own TTL
    // and are re-joined on read, so a stale rate can never outlive its table.
    writeStore(vpsId, data.models.map(({ price, fastPrice, ...m }) => m));
  } else if (!data.ok && generation(vpsId) === startedAt) {
    // Nothing fresh, but a remembered catalog still beats an empty picker.
    const known = cache.get(vpsId);
    if (known) return known.data;
    const disk = stored(vpsId);
    if (disk) return { ok: true, models: await withPrices(disk.models) };
  }
  return data;
}
