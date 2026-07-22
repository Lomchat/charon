import 'server-only';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { AgentCodexModelsResult } from '@/lib/server/agent/types';
import { CODEX_CANONICAL_EFFORTS, type CodexModelsResponse, type CodexModelPick } from '@/lib/types/api';

// ── Codex model catalog (per-VPS, account-driven) — GET /api/codex/models ─────
//
// Source: the agent's `list_codex_models` RPC (openai_codex .models(), agent
// >= 0.15.0). Unlike Claude's hub-side seed ∪ live-catalog (modelSync.ts), the
// Codex catalog is entirely account/VPS-scoped — there's no curated seed, so we
// serve whatever the VPS's Codex login reports. Mirrors the Claude picker shape
// so the UI can reuse the same <ModelPicker>/<EffortPicker> machinery.
//
// Cache: a short in-memory per-VPS TTL (successful results only). The catalog is
// stable (changes only when the account's model access changes), and each call
// spins up a short-lived Codex app-server client agent-side — worth memoizing.
// Failures are NOT cached (so the next call retries) and degrade gracefully to
// an empty list + the canonical efforts so the picker is never empty.

const TTL_MS = 5 * 60_000;

// Full Codex effort ordering (agent/charon_agent VALID_EFFORTS) — used to sort
// the union deterministically; unknown levels are appended in first-seen order.
const CODEX_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

type CacheEntry = { at: number; data: CodexModelsResponse };
const g = globalThis as unknown as { _codexModelsCache?: Map<string, CacheEntry> };
if (!g._codexModelsCache) g._codexModelsCache = new Map();
const cache: Map<string, CacheEntry> = g._codexModelsCache;

/** Ordered union of every model's efforts ∪ the canonical Codex efforts. */
function unionEfforts(models: CodexModelPick[]): string[] {
  const set = new Set<string>(CODEX_CANONICAL_EFFORTS);
  for (const m of models) for (const e of m.efforts ?? []) if (e) set.add(e);
  const ordered = CODEX_EFFORT_ORDER.filter((e) => set.has(e));
  for (const e of set) if (!CODEX_EFFORT_ORDER.includes(e)) ordered.push(e);
  return ordered;
}

/**
 * Fetch (or serve cached) the Codex model catalog for a VPS. Never throws;
 * returns a graceful { ok:false, models:[], efforts:CANONICAL, error } when the
 * agent is unreachable, too old, not logged into Codex, or Codex is unavailable.
 */
export async function getCodexModelsForVps(vpsId: string): Promise<CodexModelsResponse> {
  const cached = cache.get(vpsId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  const fallback = (error: string): CodexModelsResponse => ({
    ok: false, models: [], efforts: [...CODEX_CANONICAL_EFFORTS], error,
  });

  let client;
  try {
    client = getAgentClientForVpsId(vpsId);
  } catch (e: any) {
    return fallback(e?.message ?? 'vps not found');
  }

  let raw: AgentCodexModelsResult;
  try {
    raw = await client.call<AgentCodexModelsResult>('list_codex_models');
  } catch (e: any) {
    return fallback(e?.message ?? String(e));
  }
  if (!raw || !raw.ok) {
    return fallback((raw as { error?: string } | undefined)?.error ?? 'codex models unavailable');
  }

  const models: CodexModelPick[] = (raw.models ?? [])
    .filter((m) => m && typeof m.id === 'string' && m.id.length > 0 && !m.hidden)
    .map((m) => ({
      id: m.id,
      label: (m.display_name && m.display_name.length > 0 ? m.display_name : m.id) as string,
      ...(m.description ? { hint: m.description } : {}),
      isDefault: !!m.is_default,
      efforts: Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string') : [],
      defaultEffort: m.default_effort ?? null,
    }));

  const data: CodexModelsResponse = { ok: true, models, efforts: unionEfforts(models) };
  cache.set(vpsId, { at: Date.now(), data });
  return data;
}
