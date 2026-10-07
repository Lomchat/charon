import 'server-only';
import { observeModels } from './modelNotices';
import { getSetting, setSetting } from './settings';
import { CLAUDE_MODEL_ALIASES, type KnownModel } from './knownModels';
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
 *   cached API catalog plus short aliases. With no successful sync there are
 *   no suggested versioned models; the picker retains a custom-id escape hatch.
 *
 * The key is used SOLELY for this read-only catalog call. Sessions still run
 * through each VPS's Claude Code OAuth — we never route inference through it.
 */

const MODELS_API = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Per-ATTEMPT connect/response timeout. Kept short (a healthy connect returns
// in ~0.2s) so several retries fit inside the refresh route's ~30s client
// budget. The hub's outbound link to api.anthropic.com can drop TCP SYNs
// intermittently (real incident: ~25% connect success on a flaky VPS uplink,
// ICMP clean, IPv6 dead) → the fetch throws `fetch failed` (ETIMEDOUT). One
// shot then almost always failed; retrying into a fresh window turns
// ~25%/attempt into ~68% over 4 attempts (and the caller can click again).
const FETCH_TIMEOUT_MS = 6_000;
const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 500;
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

/** Preserve the API's labels, capabilities and newest-release-first order.
 * Every returned concrete model belongs to the API catalog, without a local
 * current/previous classification that could override the provider. */
function mapLive(m: LiveModel): KnownModel {
  return {
    id: m.id, label: m.display_name || m.id, group: 'current',
    efforts: extractEfforts(m.capabilities?.effort),
  };
}

/** One catalog page fetch with bounded retries. Retries on NETWORK throws
 *  (ETIMEDOUT/ENETUNREACH/abort — the flaky-egress case above) and on transient
 *  HTTP statuses (429 / 5xx); definitive statuses (401/403/other 4xx) are
 *  returned as-is so the caller surfaces the real error message (e.g. an
 *  invalid api-key must NOT be retried 4×). Worst case ≈ MAX_FETCH_ATTEMPTS ×
 *  FETCH_TIMEOUT_MS + backoffs (~25s), under the refresh route's 30s budget. */
async function fetchModelsPage(url: string, apiKey: string): Promise<Response> {
  let lastErr: unknown = new Error('models API: no attempt made');
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        signal: ctrl.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_FETCH_ATTEMPTS) {
        await res.text().catch(() => {}); // drain the body so the socket frees
        lastErr = new Error(`models API ${res.status} (transient)`);
      } else {
        return res; // 2xx, or a definitive 4xx the caller will report
      }
    } catch (e) {
      lastErr = e; // network-level failure — retry into a fresh window
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_FETCH_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch + paginate the live catalog. Throws on non-2xx (caller swallows). */
export async function fetchLiveModels(apiKey: string): Promise<KnownModel[]> {
  const out: KnownModel[] = [];
  let url = `${MODELS_API}?limit=100`;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await fetchModelsPage(url, apiKey);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`models API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: LiveModel[]; has_more?: boolean; last_id?: string | null;
    };
    for (const m of json.data ?? []) {
      if (m?.id && MODEL_ID.test(m.id)) out.push(mapLive(m));
    }
    if (!json.has_more || !json.last_id) break;
    url = `${MODELS_API}?limit=100&after_id=${encodeURIComponent(json.last_id)}`;
  }
  return out;
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

/** Payload for GET /api/claude/models: aliases + API models + the global effort union
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
  // ultracode is a Charon pseudo-effort (not a catalog level) — accept it
  // explicitly (§14.56).
  if (v === 'ultracode') return true;
  if ((CANONICAL_EFFORTS as string[]).includes(v)) return true;
  return getCatalogEffortUnion(getMergedModels()).includes(v);
}

/** Short aliases followed by the last successful API catalog in its own
 * release order. Ignore legacy CLI discoveries and local group assignments. */
export function getMergedModels(): KnownModel[] {
  let catalog: KnownModel[] = [];
  const raw = getSetting('claude.models_cache');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        catalog = parsed.filter((m): m is KnownModel => {
          if (!m || typeof m.id !== 'string' || !MODEL_ID.test(m.id)
              || typeof m.label !== 'string' || seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        }).map((m) => ({ ...m, group: 'current' }));
      }
    } catch { /* Retain aliases when the API cache is corrupt. */ }
  }
  return [...CLAUDE_MODEL_ALIASES, ...catalog];
}

export type RefreshResult = { ok: boolean; count?: number; syncedAt?: number; error?: string };

/** Force a sync now. Returns a structured result for the Settings UI. */
export async function refreshModels(): Promise<RefreshResult> {
  const apiKey = getSetting('claude.api_key');
  if (!apiKey) return { ok: false, error: 'no api key configured' };
  try {
    observeModels('claude', getMergedModels());
    const models = await fetchLiveModels(apiKey);
    const now = Date.now();
    setSetting('claude.models_cache', JSON.stringify(models));
    setSetting('claude.models_cache_at', String(now));
    observeModels('claude', getMergedModels());
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
