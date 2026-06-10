import 'server-only';
import { getSetting, setSetting } from './settings';
import { KNOWN_MODELS, type KnownModel } from './knownModels';
import { CANONICAL_EFFORTS } from '@/lib/types/api';

/**
 * Dynamic model-list sync from Anthropic's `GET /v1/models`.
 *
 * Why a hub-side API key (and not the per-VPS OAuth):
 *   We tested the Claude Code OAuth token (`claude config get
 *   oauth.access_token`) against `GET /v1/models` on a live VPS — it returns
 *   401 "Invalid bearer token". The models catalog endpoint only accepts a
 *   real `x-api-key`. So auto-sync is OPT-IN: set `claude.api_key` in
 *   Settings and the hub refreshes the list every 24h (and on demand). With
 *   no key, nothing breaks — `GET /api/claude/models` still serves the
 *   curated seed (knownModels.ts) and the picker keeps its custom-id escape
 *   hatch, so a brand-new model is usable the moment you type its id.
 *
 * The key is used SOLELY for this read-only catalog call. Sessions still run
 * through each VPS's Claude Code OAuth — we never route inference through it.
 */

const MODELS_API = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

// Accept ANY `claude-*` id the catalog returns. Do NOT allowlist families
// (opus|sonnet|haiku) — Anthropic ships new family names (e.g. `claude-fable-5`,
// 2026-06-07), and a hardcoded family list would silently drop them, defeating
// the entire "new models appear on their own" purpose. The catalog is already
// scoped server-side to models the key can actually call (retired claude-2.x /
// claude-3-* 404 and aren't returned), so there's no legacy junk to filter.
const MODEL_ID = /^claude-/;

type EffortCap = { supported?: boolean } & Record<string, { supported?: boolean } | unknown>;
type LiveModel = {
  id: string;
  display_name?: string;
  created_at?: string;
  capabilities?: { effort?: EffortCap } & Record<string, unknown>;
};

/** Pull the supported effort levels out of a model's `capabilities.effort`
 *  tree. Returns [] when effort is unsupported (e.g. Haiku 4.5). Canonical
 *  levels first (in order), then any NEW level the catalog introduces (e.g. a
 *  future 'extreme') appended — so a new level flows through with zero code
 *  change, exactly like a new model id. */
function extractEfforts(eff: EffortCap | undefined): string[] {
  if (!eff || !eff.supported) return [];
  const out: string[] = CANONICAL_EFFORTS.filter((l) => (eff[l] as any)?.supported);
  for (const [k, v] of Object.entries(eff)) {
    if (k === 'supported') continue;
    if (CANONICAL_EFFORTS.includes(k as any)) continue;
    if (v && typeof v === 'object' && (v as any).supported) out.push(k);
  }
  return out;
}

/** Map a `/v1/models` row to our KnownModel. The API only returns concrete
 *  versioned ids (never the `opus`/`sonnet`/`haiku` aliases), so anything not
 *  already curated lands in the 'current' group. A curated seed entry keeps
 *  its nicer label/group/hint but is enriched with the live effort list. */
function mapLive(m: LiveModel, seedById: Map<string, KnownModel>): KnownModel {
  const efforts = extractEfforts(m.capabilities?.effort);
  const seed = seedById.get(m.id);
  if (seed) return { ...seed, efforts };
  return { id: m.id, label: m.display_name || m.id, group: 'current', efforts };
}

/** Fetch + paginate the live catalog. Throws on non-2xx (caller swallows). */
export async function fetchLiveModels(apiKey: string): Promise<KnownModel[]> {
  const seedById = new Map(KNOWN_MODELS.map((m) => [m.id, m]));
  const out: KnownModel[] = [];
  let url = `${MODELS_API}?limit=100`;
  for (let i = 0; i < MAX_PAGES; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`models API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: LiveModel[]; has_more?: boolean; last_id?: string | null;
    };
    for (const m of json.data ?? []) {
      if (m?.id && MODEL_ID.test(m.id)) out.push(mapLive(m, seedById));
    }
    if (!json.has_more || !json.last_id) break;
    url = `${MODELS_API}?limit=100&after_id=${encodeURIComponent(json.last_id)}`;
  }
  return out;
}

/** Curated seed first (keeps aliases + the curated order + pins), then any
 *  live model not already in the seed appended under its group. The seed is
 *  authoritative for an id's label/group/hint; the dynamic list ADDS new ids
 *  AND enriches a seed id with its live `efforts` (so e.g. `claude-sonnet-4-6`
 *  keeps its curated label but gains the catalog's effort list). */
export function mergeModels(seed: KnownModel[], dynamic: KnownModel[]): KnownModel[] {
  const dynById = new Map(dynamic.map((m) => [m.id, m]));
  const merged = seed.map((s) => {
    const d = dynById.get(s.id);
    return d?.efforts ? { ...s, efforts: d.efforts } : s;
  });
  const seedIds = new Set(seed.map((m) => m.id));
  const extras = dynamic.filter((m) => !seedIds.has(m.id));
  return [...merged, ...extras];
}

/** Global union of every model's effort levels, canonical order first then any
 *  new catalog level appended. Empty when there's no live data. Used by the
 *  SettingsModal global-default select, which has no model in scope. */
export function getCatalogEffortUnion(models: KnownModel[]): string[] {
  const set = new Set<string>();
  for (const m of models) for (const e of m.efforts ?? []) set.add(e);
  const ordered = CANONICAL_EFFORTS.filter((l) => set.has(l)) as string[];
  for (const e of set) if (!CANONICAL_EFFORTS.includes(e as any)) ordered.push(e);
  return ordered;
}

/** Payload for GET /api/claude/models: merged models + the global effort union
 *  (falls back to the canonical list so the picker is never empty). */
export function getModelsAndEfforts(): { models: KnownModel[]; efforts: string[] } {
  const models = getMergedModels();
  const union = getCatalogEffortUnion(models);
  return { models, efforts: union.length ? union : [...CANONICAL_EFFORTS] };
}

/** Is `v` an effort level we'll accept on the per-session effort route?
 *  Canonical ∪ whatever the live catalog currently reports — so a brand-new
 *  level isn't 400'd the moment it appears. (The agent is the final gate; it
 *  drops a level its SDK doesn't know, see §14 gotcha 35.) */
export function isKnownEffort(v: string): boolean {
  if ((CANONICAL_EFFORTS as string[]).includes(v)) return true;
  return getCatalogEffortUnion(getMergedModels()).includes(v);
}

/** The list served by GET /api/claude/models: seed ∪ cached-live. */
export function getMergedModels(): KnownModel[] {
  let dynamic: KnownModel[] = [];
  const raw = getSetting('claude.models_cache');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        dynamic = parsed.filter(
          (m): m is KnownModel => m && typeof m.id === 'string' && typeof m.label === 'string',
        );
      }
    } catch {
      // Corrupt cache → ignore, serve seed only. Next refresh overwrites it.
    }
  }
  return mergeModels(KNOWN_MODELS, dynamic);
}

export type RefreshResult = { ok: boolean; count?: number; syncedAt?: number; error?: string };

/** Force a sync now. Returns a structured result for the Settings UI. */
export async function refreshModels(): Promise<RefreshResult> {
  const apiKey = getSetting('claude.api_key');
  if (!apiKey) return { ok: false, error: 'no api key configured' };
  try {
    const models = await fetchLiveModels(apiKey);
    const now = Date.now();
    setSetting('claude.models_cache', JSON.stringify(models));
    setSetting('claude.models_cache_at', String(now));
    return { ok: true, count: models.length, syncedAt: now };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

let inflight: Promise<unknown> | null = null;

/** Best-effort background refresh if the cache is older than the TTL and a
 *  key is configured. No-op otherwise. Safe to call on every boot/connect —
 *  deduped via `inflight` + gated by the timestamp. */
export function refreshModelsIfStale(): void {
  const apiKey = getSetting('claude.api_key');
  if (!apiKey) return;
  const at = Number(getSetting('claude.models_cache_at') || '0');
  if (Number.isFinite(at) && Date.now() - at < TTL_MS) return;
  if (inflight) return;
  inflight = refreshModels()
    .catch(() => {})
    .finally(() => { inflight = null; });
}
